/**
 * Run exactly one task by id, the way the Campaign Director runs it.
 *
 * `npm run tick` runs whatever is next. `npm run prospect` and `npm run scout`
 * mean one account and one contact, and must not quietly start other people's
 * research on the way. This is the Director's inner step - run the agent, record
 * its spend, escalate on failure, apply the result and mark the task done - for
 * a task chosen by hand. It never dials, and it does not replace the Director's
 * tick: the follow-on tasks it queues wait for the next one.
 */

import type { AgentJournal } from '../agents/journal.js';
import { runAgent } from '../agents/runner.js';
import type { Blackboard } from '../blackboard/client.js';
import type { EscalationRepository, SpendLedger, TaskRepository } from '../blackboard/repositories.js';
import type { TaskRegistry } from '../orchestrator/registry.js';

export interface RunTaskDeps {
  db: Blackboard;
  tasks: TaskRepository;
  escalations: EscalationRepository;
  spend: SpendLedger;
  journal: AgentJournal;
  registry: TaskRegistry;
  now?: () => Date;
}

export type RunTaskResult =
  | { status: 'done'; usd: number; followOn: number }
  | { status: 'escalated'; usd: number; reason: string }
  | { status: 'unknown-kind' };

export async function runTaskOnce(deps: RunTaskDeps, taskId: string): Promise<RunTaskResult> {
  const now = deps.now ?? ((): Date => new Date());
  const task = await deps.tasks.get(taskId);
  if (task === null) throw new Error(`no task ${taskId}`);
  const kind = deps.registry.get(task.kind);
  if (kind === undefined) return { status: 'unknown-kind' };

  await deps.tasks.markRunning(task.id, now());
  const outcome = await runAgent(kind.agent, task.payload, {
    taskId: task.id,
    journal: deps.journal,
    now: () => now().getTime()
  });
  await deps.spend.record('llm', outcome.spend.usd, now(), task.id, kind.agent.contract.name);

  if (outcome.status === 'escalated') {
    const reason = `${outcome.failure.kind}: ${outcome.failure.message}`;
    await deps.tasks.markStopped(task.id, 'escalated', reason, now());
    await deps.escalations.open(
      {
        level: outcome.escalatesTo,
        reason: `${kind.agent.contract.name} could not complete ${task.kind}: ${outcome.failure.message}`,
        detail: { kind: outcome.failure.kind, ...outcome.failure.detail },
        taskId: task.id,
        ...(task.contactId !== null ? { contactId: task.contactId } : {})
      },
      now()
    );
    return { status: 'escalated', usd: outcome.spend.usd, reason };
  }

  const followOn = await kind.apply(outcome.output, { db: deps.db, task, now: now() });
  for (const spec of followOn) await deps.tasks.create(spec);
  await deps.tasks.markDone(task.id, outcome.output, now());
  return { status: 'done', usd: outcome.spend.usd, followOn: followOn.length };
}
