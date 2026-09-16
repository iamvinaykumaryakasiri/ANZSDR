import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineAgent, type Agent, type AgentTool } from '../../src/agents/contract.js';
import { InMemoryJournal } from '../../src/agents/journal.js';
import { runAgent } from '../../src/agents/runner.js';

const inputSchema = z.object({ name: z.string().min(1) });
const outputSchema = z.object({ greeting: z.string().min(1), score: z.number().int() });

type In = z.infer<typeof inputSchema>;
type Out = z.infer<typeof outputSchema>;

const echoTool: AgentTool = {
  name: 'echo',
  description: 'echoes',
  input: z.object({ text: z.string() }),
  usdPerCall: 0.25,
  handler: async (args) => (args as { text: string }).text.toUpperCase()
};

function agentThat(
  handler: Parameters<typeof defineAgent<In, Out>>[1],
  overrides: Partial<Agent<In, Out>['contract']> = {}
): Agent<In, Out> {
  return defineAgent<In, Out>(
    {
      name: 'test-agent',
      role: 'test.md',
      model: 'claude-sonnet-4-6',
      input: inputSchema,
      output: outputSchema,
      tools: [echoTool],
      budget: { maxTurns: 2, maxTokens: 1000, maxWallClockMs: 5000, maxUsd: 1 },
      escalatesTo: 'orchestrator',
      ...overrides
    },
    handler
  );
}

const opts = () => ({ taskId: 'task-1', journal: new InMemoryJournal() });

describe('runAgent: the happy path', () => {
  it('validates input, runs, validates output and journals the whole thing', async () => {
    const journal = new InMemoryJournal();
    const agent = agentThat(async (ctx) => {
      ctx.charge({ tokensIn: 10, tokensOut: 5, usd: 0.01 });
      ctx.note(`greeting ${ctx.input.name}`);
      return { greeting: `hello ${ctx.input.name}`, score: 1 };
    });

    const outcome = await runAgent(agent, { name: 'Priya' }, { taskId: 'task-1', journal });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.output.greeting).toBe('hello Priya');
    expect(outcome.spend.turns).toBe(1);
    expect(outcome.spend.usd).toBeCloseTo(0.01);
    expect(journal.starts).toHaveLength(1);
    expect(journal.finishes[0]?.status).toBe('succeeded');
    expect(journal.traces.map((t) => t.summary)).toContain('greeting Priya');
  });

  it('strips anything the output schema does not declare', async () => {
    const agent = agentThat(async () => ({ greeting: 'hi', score: 1, secret: 'leaked' }) as never);
    const outcome = await runAgent(agent, { name: 'x' }, opts());
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.output).toEqual({ greeting: 'hi', score: 1 });
  });
});

describe('runAgent: fails closed', () => {
  it('escalates off-contract input without ever calling the handler', async () => {
    const handler = vi.fn();
    const agent = agentThat(handler as never);
    const outcome = await runAgent(agent, { name: '' }, opts());

    expect(handler).not.toHaveBeenCalled();
    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.failure.kind).toBe('input-contract');
  });

  it('gives an off-contract answer exactly one more chance', async () => {
    let attempt = 0;
    const agent = agentThat(async () => {
      attempt += 1;
      return attempt === 1 ? ({ greeting: 'hi' } as never) : { greeting: 'hi', score: 2 };
    });

    const journal = new InMemoryJournal();
    const outcome = await runAgent(agent, { name: 'x' }, { taskId: 'task-1', journal });

    expect(attempt).toBe(2);
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.validationFailures).toBe(1);
    expect(journal.traces.some((t) => t.kind === 'rejected' && t.summary.includes('retrying once'))).toBe(true);
  });

  it('escalates rather than return a malformed result when it fails twice', async () => {
    const journal = new InMemoryJournal();
    const agent = agentThat(async () => ({ greeting: 42, score: 'nope' }) as never);
    const outcome = await runAgent(agent, { name: 'x' }, { taskId: 'task-1', journal });

    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.failure.kind).toBe('output-contract');
    expect(outcome.validationFailures).toBe(2);
    // Nothing malformed is handed back, and nothing malformed is recorded as output.
    expect(outcome).not.toHaveProperty('output');
    expect(journal.finishes[0]?.output).toBeUndefined();
    expect(journal.finishes[0]?.status).toBe('escalated');
  });

  it('escalates an unhandled error instead of improvising', async () => {
    const agent = agentThat(async () => {
      throw new Error('the search provider is down');
    });
    const outcome = await runAgent(agent, { name: 'x' }, opts());
    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.failure.kind).toBe('unhandled');
    expect(outcome.failure.message).toBe('the search provider is down');
  });

  it('carries the contract\'s escalation target', async () => {
    const agent = agentThat(async () => ({}) as never, { escalatesTo: 'human' });
    const outcome = await runAgent(agent, { name: 'x' }, opts());
    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.escalatesTo).toBe('human');
  });
});

describe('runAgent: tools are the only way out', () => {
  it('lets a handler use a tool its contract declares', async () => {
    const agent = agentThat(async (ctx) => ({
      greeting: await ctx.call<string>('echo', { text: 'hi' }),
      score: 1
    }));
    const outcome = await runAgent(agent, { name: 'x' }, opts());
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.output.greeting).toBe('HI');
    expect(outcome.spend.usd).toBeCloseTo(0.25);
  });

  it('refuses a tool the contract does not declare', async () => {
    const agent = agentThat(async (ctx) => {
      await ctx.call('send-email', { to: 'someone' });
      return { greeting: 'hi', score: 1 };
    });
    const outcome = await runAgent(agent, { name: 'x' }, opts());
    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.failure.kind).toBe('tool-contract');
    expect(outcome.failure.message).toContain('no tool "send-email"');
  });

  it('refuses tool arguments that do not match the tool\'s schema', async () => {
    const agent = agentThat(async (ctx) => {
      await ctx.call('echo', { text: 99 });
      return { greeting: 'hi', score: 1 };
    });
    const outcome = await runAgent(agent, { name: 'x' }, opts());
    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.failure.kind).toBe('tool-contract');
  });
});

describe('runAgent: budget', () => {
  it('escalates rather than continue past the turn budget', async () => {
    const journal = new InMemoryJournal();
    const agent = agentThat(async (ctx) => {
      ctx.charge({ tokensIn: 1 });
      ctx.charge({ tokensIn: 1 });
      ctx.charge({ tokensIn: 1 }); // budget is two turns
      return { greeting: 'hi', score: 1 };
    });
    const outcome = await runAgent(agent, { name: 'x' }, { taskId: 'task-1', journal });

    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.failure.kind).toBe('budget');
    expect(outcome.failure.message).toContain('3 turns');
    expect(journal.finishes[0]?.status).toBe('budget-exceeded');
  });

  it('escalates on the token budget', async () => {
    const agent = agentThat(async (ctx) => {
      ctx.charge({ tokensIn: 900, tokensOut: 900 });
      return { greeting: 'hi', score: 1 };
    });
    const outcome = await runAgent(agent, { name: 'x' }, opts());
    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.failure.message).toContain('tokens');
  });

  it('escalates when tool calls spend past the dollar budget', async () => {
    const agent = agentThat(async (ctx) => {
      for (let i = 0; i < 5; i++) await ctx.call('echo', { text: 'x' });
      return { greeting: 'hi', score: 1 };
    });
    const outcome = await runAgent(agent, { name: 'x' }, opts());
    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.failure.kind).toBe('budget');
    expect(outcome.failure.message).toContain('$');
  });

  it('stops a handler that runs past its wall clock, even if it never yields a result', async () => {
    const agent = agentThat(
      async () => new Promise<Out>(() => {
        /* never resolves */
      }),
      { budget: { maxTurns: 2, maxTokens: 1000, maxWallClockMs: 30, maxUsd: 1 } }
    );
    const outcome = await runAgent(agent, { name: 'x' }, opts());
    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.failure.kind).toBe('budget');
    expect(outcome.failure.message).toContain('wall-clock');
  });

  it('aborts the signal it handed the handler when time runs out', async () => {
    let aborted = false;
    const agent = agentThat(
      async (ctx) =>
        new Promise<Out>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ greeting: 'too late', score: 0 });
          });
        }),
      { budget: { maxTurns: 2, maxTokens: 1000, maxWallClockMs: 30, maxUsd: 1 } }
    );
    await runAgent(agent, { name: 'x' }, opts());
    expect(aborted).toBe(true);
  });
});
