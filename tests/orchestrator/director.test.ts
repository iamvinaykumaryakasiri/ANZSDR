/**
 * Phase 2 acceptance.
 *
 *   A task runs end to end with full trace, a deliberately malformed sub-agent
 *   output fails closed, and a budget breach escalates rather than continuing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAgent } from '../../src/agents/contract.js';
import { prospectorContract, type ProspectorInput, type ProspectorOutput } from '../../src/agents/prospector/contract.js';
import { prospectAccountKind, PROSPECT_ACCOUNT, RESEARCH_CONTACT } from '../../src/orchestrator/kinds.js';
import { harness, prospectTaskSpec, type Harness } from '../support/harness.js';

let open: Harness[] = [];
afterEach(async () => {
  for (const h of open) await h.close();
  open = [];
});

async function fresh(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await harness(options);
  open.push(h);
  return h;
}

describe('a task runs end to end with a full trace', () => {
  it('prospects an account, queues research per contact, and finishes the chain', async () => {
    const h = await fresh();
    const seed = await h.tasks.create(prospectTaskSpec(h));

    const first = await h.director.tick();

    expect(first.succeeded).toBeGreaterThanOrEqual(1);
    expect(first.escalated).toBe(0);
    expect(first.stopped).toBeNull();

    // Prospector's two qualifying people became contacts; the recruiter did not.
    const contacts = await h.db.contact.findMany({ orderBy: { apolloId: 'asc' } });
    expect(contacts.map((c) => c.apolloId)).toEqual(['apollo-1', 'apollo-2']);
    expect(contacts.every((c) => c.status === 'researched')).toBe(true);

    // Each one has a dossier, and every hook in it points at a source.
    const dossiers = await h.db.dossier.findMany();
    expect(dossiers).toHaveLength(2);
    for (const d of dossiers) {
      const hooks = JSON.parse(d.hooks) as Array<{ sourceUrl: string }>;
      expect(hooks.length).toBeGreaterThan(0);
      for (const hook of hooks) expect(hook.sourceUrl).toMatch(/^https:\/\//);
      expect(JSON.parse(d.unverified)).toContain('a rumour about cost pressure in technology');
    }

    // The trace reads as a story, in order, without opening any JSON.
    const trace = await h.trace.forTask(seed.id);
    const summaries = trace.map((t) => `${t.actor}: ${t.summary}`);
    expect(summaries.some((s) => s.startsWith('campaign-director: running prospect-account'))).toBe(true);
    expect(summaries.some((s) => s.includes('found 3 people'))).toBe(true);
    expect(summaries.some((s) => s.includes('2 passed the ICP threshold'))).toBe(true);
    expect(summaries.some((s) => s.includes(`queued 2 ${RESEARCH_CONTACT} task(s)`))).toBe(true);

    // Every run is accounted for, with what it cost.
    const runs = await h.db.agentRun.findMany();
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
    expect(runs.every((r) => r.finishedAt !== null)).toBe(true);
    expect(await h.spend.totalThisWeek(new Date())).toBeCloseTo(first.usdSpent, 6);
    expect(first.usdSpent).toBeGreaterThan(0);

    const tasks = await h.db.task.findMany();
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
  });

  it('logs a one-line rationale for every decision, including doing nothing', async () => {
    const h = await fresh();
    const report = await h.director.tick();
    expect(report.decisions).toEqual(['nothing runnable; standing by']);
    expect(report.ranTasks).toBe(0);
  });

  it('holds everything while the kill switch is tripped', async () => {
    const h = await fresh();
    await h.tasks.create(prospectTaskSpec(h));
    await h.killSwitch.trip('operator', 'Vinay pressed Stop All', new Date());

    const report = await h.director.tick();
    expect(report.ranTasks).toBe(0);
    expect(report.stopped).toContain('kill switch is tripped');
    expect(report.stopped).toContain('Vinay pressed Stop All');
    expect(await h.db.contact.count()).toBe(0);
  });
});

describe('a malformed sub-agent output fails closed', () => {
  it('escalates, writes nothing to the blackboard, and blocks what depended on it', async () => {
    const h = await fresh({
      overrides: (registry) => {
        // A Prospector that returns something off-contract, every time.
        const broken = defineAgent<ProspectorInput, ProspectorOutput>(
          prospectorContract([]),
          async () =>
            ({
              accountId: 'a1',
              prospects: [{ firstName: 'Priya', icpScore: 'very high' }],
              searchedAt: 'yesterday'
            }) as never
        );
        registry.register(prospectAccountKind(broken));
      }
    });

    const seed = await h.tasks.create(prospectTaskSpec(h));
    const report = await h.director.tick();

    expect(report.escalated).toBe(1);
    expect(report.succeeded).toBe(0);

    const task = await h.tasks.get(seed.id);
    expect(task?.status).toBe('escalated');
    expect(task?.result).toBeNull();
    expect(task?.lastError).toContain('output-contract');

    // Nothing off-contract reached the blackboard.
    expect(await h.db.contact.count()).toBe(0);
    expect(await h.db.dossier.count()).toBe(0);

    // It was tried twice and then stopped, rather than retried forever.
    const run = await h.db.agentRun.findFirstOrThrow();
    expect(run.validationFailures).toBe(2);
    expect(run.status).toBe('escalated');
    expect(run.output).toBeNull();

    const escalations = await h.escalations.list('open');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.level).toBe('orchestrator');
    expect(escalations[0]?.reason).toContain('off-contract');

    // A follow-on task that depended on it is blocked, not left pending.
    const dependent = await h.tasks.create({ kind: RESEARCH_CONTACT, payload: {}, dependsOn: [seed.id] });
    expect(await h.tasks.nextRunnable(new Date())).toBeNull();
    expect((await h.tasks.get(dependent.id))?.status).toBe('blocked');
  });
});

describe('a budget breach escalates rather than continuing', () => {
  it('stops the run at the ceiling and records what it had spent', async () => {
    const h = await fresh({
      overrides: (registry) => {
        const contract = prospectorContract([]);
        const greedy = defineAgent<ProspectorInput, ProspectorOutput>(
          { ...contract, budget: { ...contract.budget, maxTurns: 2 } },
          async (ctx) => {
            ctx.charge({ tokensIn: 100, usd: 0.01 });
            ctx.charge({ tokensIn: 100, usd: 0.01 });
            ctx.charge({ tokensIn: 100, usd: 0.01 }); // one turn too many
            return { accountId: 'a1', prospects: [], rejected: [], searchedAt: new Date().toISOString() };
          }
        );
        registry.register(prospectAccountKind(greedy));
      }
    });

    const seed = await h.tasks.create(prospectTaskSpec(h));
    const report = await h.director.tick();

    expect(report.escalated).toBe(1);
    expect(report.decisions.some((d) => d.includes('escalated to orchestrator rather than continuing'))).toBe(true);

    const run = await h.db.agentRun.findFirstOrThrow();
    expect(run.status).toBe('budget-exceeded');
    expect(run.turns).toBe(3);
    expect(run.output).toBeNull();
    // What it managed to spend before being stopped is still on the ledger.
    expect(await h.spend.totalThisWeek(new Date())).toBeCloseTo(0.03, 6);

    expect((await h.tasks.get(seed.id))?.status).toBe('escalated');
    expect((await h.escalations.list('open'))[0]?.reason).toContain('turns');
  });

  it('will not start work it cannot afford to finish', async () => {
    const h = await fresh({ weeklyUsdCeiling: 0.2 });
    await h.tasks.create(prospectTaskSpec(h));

    const report = await h.director.tick();
    expect(report.ranTasks).toBe(0);
    expect(report.stopped).toContain('could cost up to $0.50');
    expect(report.stopped).toContain('$0.20 remains');
  });

  it('stops once the week\'s ceiling is already spent', async () => {
    const h = await fresh({ weeklyUsdCeiling: 1 });
    await h.spend.record('llm', 1.25, new Date());
    await h.tasks.create(prospectTaskSpec(h));

    const report = await h.director.tick();
    expect(report.ranTasks).toBe(0);
    expect(report.stopped).toContain('against a $1.00 ceiling');
  });
});

describe('safety', () => {
  it('trips the kill switch on the third escalation of the day, without being asked', async () => {
    const h = await fresh({
      overrides: (registry) => {
        const broken = defineAgent<ProspectorInput, ProspectorOutput>(
          prospectorContract([]),
          async () => ({}) as never
        );
        registry.register(prospectAccountKind(broken));
      }
    });

    for (let i = 0; i < 3; i++) await h.tasks.create(prospectTaskSpec(h));
    const report = await h.director.tick();

    expect(report.escalated).toBe(3);
    expect(report.stopped).toContain('kill switch tripped automatically');
    expect((await h.killSwitch.state()).trippedBy).toBe('escalation-threshold');

    // And the next tick does nothing at all until a human clears it.
    await h.tasks.create(prospectTaskSpec(h));
    const next = await h.director.tick();
    expect(next.ranTasks).toBe(0);
    expect(next.stopped).toContain('kill switch is tripped');
  });

  it('halts and trips when it loses contact with the blackboard', async () => {
    const h = await fresh();
    await h.tasks.create(prospectTaskSpec(h));
    await h.db.$disconnect();
    // Point the client at a path it cannot use, the way a lost volume would.
    Object.defineProperty(h.db, '$queryRawUnsafe', {
      value: async () => {
        throw new Error('database is gone');
      }
    });

    const report = await h.director.tick();
    expect(report.stopped).toContain('blackboard is unreachable');
    expect((await h.killSwitch.state()).trippedBy).toBe('blackboard-unreachable');
  });

  it('escalates to a human when nothing knows how to do the work', async () => {
    const h = await fresh();
    await h.tasks.create({ kind: 'send-carrier-pigeon', payload: {}, campaignId: h.campaignId });

    const report = await h.director.tick();
    expect(report.escalated).toBe(1);
    const escalation = (await h.escalations.list('open'))[0];
    expect(escalation?.level).toBe('human');
    expect(escalation?.reason).toContain('send-carrier-pigeon');
  });

  it('takes on only as much work as one tick allows', async () => {
    const h = await fresh({ maxTasksPerTick: 1 });
    await h.tasks.create(prospectTaskSpec(h));

    const first = await h.director.tick();
    expect(first.ranTasks).toBe(1);
    expect(await h.db.dossier.count()).toBe(0);

    await h.director.tick();
    await h.director.tick();
    expect(await h.db.dossier.count()).toBe(2);
  });
});

describe('the director cannot dial', () => {
  it('exposes no way to place a call', () => {
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(harness));
    expect(surface.join(' ')).not.toMatch(/dial|call/i);
    expect(z.string().safeParse(PROSPECT_ACCOUNT).success).toBe(true);
  });
});
