/**
 * The only way to run a sub-agent.
 *
 * Three guarantees, and they are the reason handlers are never called directly:
 *
 * 1. Input is validated before the handler sees it, and output is validated
 *    before anyone else does. A handler that returns something off-contract
 *    gets one more attempt and is then escalated. Malformed output is never
 *    returned to the caller - the run fails closed.
 * 2. Budget is metered continuously. A breach throws, and a throw becomes an
 *    escalation rather than a truncated answer.
 * 3. A handler can only reach the tools its contract declares, with arguments
 *    that match those tools' schemas.
 *
 * A sub-agent that exceeds budget, fails validation twice, or hits an unhandled
 * state escalates. It never improvises.
 */

import { randomUUID } from 'node:crypto';
import type { Agent, AgentContext, AgentTool, EscalationTarget, Spend } from './contract.js';
import { ZERO_SPEND } from './contract.js';
import { BudgetMeter, type Clock } from './budget.js';
import { AgentFailure, BudgetExceeded } from './errors.js';
import type { AgentJournal, TraceInput } from './journal.js';

/** Two attempts: the brief escalates on the second contract failure, not the first. */
const MAX_OUTPUT_ATTEMPTS = 2;

export interface RunOptions {
  taskId: string;
  journal: AgentJournal;
  runId?: string;
  now?: Clock;
  /** Overrides the wall-clock race, for tests that need to drive time by hand. */
  sleep?: (ms: number) => Promise<void>;
}

export type AgentOutcome<O> =
  | {
      status: 'succeeded';
      runId: string;
      output: O;
      spend: Spend;
      validationFailures: number;
    }
  | {
      status: 'escalated';
      runId: string;
      failure: AgentFailure;
      escalatesTo: EscalationTarget;
      spend: Spend;
      validationFailures: number;
    };

function findTool(tools: AgentTool[], name: string): AgentTool | undefined {
  return tools.find((t) => t.name === name);
}

export async function runAgent<I, O>(
  agent: Agent<I, O>,
  rawInput: unknown,
  options: RunOptions
): Promise<AgentOutcome<O>> {
  const { contract } = agent;
  const runId = options.runId ?? randomUUID();
  const { journal, taskId } = options;
  const meter = new BudgetMeter(contract.budget, options.now);

  await journal.startRun({ runId, taskId, agent: contract.name, input: rawInput });

  const pending: TraceInput[] = [];
  const note = (summary: string, detail?: Record<string, unknown>): void => {
    pending.push({
      taskId,
      agentRunId: runId,
      actor: contract.name,
      kind: 'note',
      summary,
      ...(detail !== undefined ? { detail } : {})
    });
  };
  const flush = async (): Promise<void> => {
    while (pending.length > 0) await journal.trace(pending.shift() as TraceInput);
  };

  let validationFailures = 0;

  const escalate = async (failure: AgentFailure): Promise<AgentOutcome<O>> => {
    note(`escalating to ${contract.escalatesTo}: ${failure.message}`, failure.detail);
    await flush();
    await journal.trace({
      taskId,
      agentRunId: runId,
      actor: contract.name,
      kind: 'escalated',
      summary: `${contract.name} escalated to ${contract.escalatesTo} (${failure.kind}): ${failure.message}`,
      detail: failure.detail,
      usd: meter.spend.usd
    });
    await journal.finishRun({
      runId,
      status: failure.kind === 'budget' ? 'budget-exceeded' : 'escalated',
      error: `${failure.kind}: ${failure.message}`,
      spend: meter.spend,
      validationFailures
    });
    return {
      status: 'escalated',
      runId,
      failure,
      escalatesTo: contract.escalatesTo,
      spend: meter.spend,
      validationFailures
    };
  };

  const parsedInput = contract.input.safeParse(rawInput);
  if (!parsedInput.success) {
    return escalate(
      new AgentFailure('input-contract', `input does not match ${contract.name}'s contract`, {
        issues: parsedInput.error.issues
      })
    );
  }

  let lastOutputIssues: unknown = null;

  for (let attempt = 1; attempt <= MAX_OUTPUT_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const context: AgentContext<I> = {
      input: parsedInput.data,
      signal: controller.signal,
      note,
      charge: (usage) => {
        meter.chargeTurn(usage);
      },
      call: async <T,>(toolName: string, args: unknown): Promise<T> => {
        const tool = findTool(contract.tools, toolName);
        if (tool === undefined) {
          throw new AgentFailure('tool-contract', `${contract.name} has no tool "${toolName}"`, {
            available: contract.tools.map((t) => t.name)
          });
        }
        const parsedArgs = tool.input.safeParse(args);
        if (!parsedArgs.success) {
          throw new AgentFailure('tool-contract', `arguments for "${toolName}" do not match its schema`, {
            issues: parsedArgs.error.issues
          });
        }
        if (tool.usdPerCall !== undefined) meter.chargeUsd(tool.usdPerCall);
        return (await tool.handler(parsedArgs.data)) as T;
      }
    };

    let timer: NodeJS.Timeout | undefined;
    let raw: unknown;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new BudgetExceeded(
              'maxWallClockMs',
              `ran past its ${contract.budget.maxWallClockMs}ms wall-clock budget`,
              { spend: meter.spend }
            )
          );
        }, meter.remainingMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      raw = await Promise.race([agent.handler(context), deadline]);
      meter.assertWithinBudget();
    } catch (error) {
      if (error instanceof AgentFailure) return escalate(error);
      return escalate(
        new AgentFailure('unhandled', error instanceof Error ? error.message : String(error), {
          attempt
        })
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const parsedOutput = contract.output.safeParse(raw);
    if (parsedOutput.success) {
      note(`returned output matching ${contract.name}'s contract`);
      await flush();
      await journal.finishRun({
        runId,
        status: 'succeeded',
        output: parsedOutput.data,
        spend: meter.spend,
        validationFailures
      });
      return {
        status: 'succeeded',
        runId,
        output: parsedOutput.data,
        spend: meter.spend,
        validationFailures
      };
    }

    validationFailures += 1;
    lastOutputIssues = parsedOutput.error.issues;
    await journal.trace({
      taskId,
      agentRunId: runId,
      actor: contract.name,
      kind: 'rejected',
      summary:
        attempt < MAX_OUTPUT_ATTEMPTS
          ? `output did not match ${contract.name}'s contract; retrying once`
          : `output did not match ${contract.name}'s contract on the second attempt`,
      detail: { issues: parsedOutput.error.issues, attempt }
    });
  }

  return escalate(
    new AgentFailure(
      'output-contract',
      `${contract.name} returned output off-contract ${validationFailures} times`,
      { issues: lastOutputIssues }
    )
  );
}

export { ZERO_SPEND };
