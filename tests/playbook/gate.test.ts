import { describe, expect, it } from 'vitest';
import {
  armRates,
  compareArms,
  decideTest,
  monitorPromotion,
  preflightVariant,
  simulationReasons,
  STAGE_ORDER,
  type ArmEvidence,
  type PreflightDeps
} from '../../src/playbook/gate.js';
import type { PlaybookContent } from '../../src/playbook/schema.js';
import { SCENARIO_KINDS } from '../../src/playbook/simulation-types.js';
import { fisherGreater, newcombeDifference, rate, wilson } from '../../src/playbook/stats.js';
import { claimIndex, coachConfig, GOOD_HOOK, GOOD_VALUE, passingReport, reviewer, simulator } from './support.js';

describe('statistics', () => {
  it('Fisher exact one-sided matches values worked by hand', () => {
    // All 3 successes in A: C(10,3) / C(20,3) = 120 / 1140.
    expect(fisherGreater(3, 10, 0, 10)).toBeCloseTo(120 / 1140, 10);
    // 6 successes, A has 5 or 6 of them: (6*2002 + 1001) / C(20,10).
    expect(fisherGreater(5, 10, 1, 10)).toBeCloseTo(13013 / 184756, 10);
    expect(fisherGreater(0, 10, 0, 10)).toBe(1);
    expect(fisherGreater(0, 0, 3, 10)).toBe(1);
    expect(fisherGreater(0, 10, 4, 10)).toBeCloseTo(1, 10);
  });

  it('intervals behave at the edges', () => {
    expect(wilson(0, 0)).toEqual({ lower: 0, upper: 1 });
    expect(wilson(5, 10).lower).toBeCloseTo(0.2366, 3);
    expect(wilson(5, 10).upper).toBeCloseTo(0.7634, 3);
    expect(wilson(0, 10).lower).toBe(0);
    const diff = newcombeDifference(10, 40, 2, 40);
    expect(diff.lower).toBeGreaterThan(0);
    expect(diff.upper).toBeGreaterThan(diff.lower);
    expect(rate(1, 0)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Preflight                                                           */
/* ------------------------------------------------------------------ */

function deps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    claims: claimIndex(),
    markets: ['AU', 'NZ'],
    reviewer: reviewer(),
    proposerInstanceId: 'proposer-1',
    simulator: simulator(),
    champions: {},
    ...over
  };
}

const stageOf = (r: Awaited<ReturnType<typeof preflightVariant>>) => r.failedAt;

describe('preflight: a variant passes all six stages in order, or stops at the first that fails', () => {
  it('passes a good variant through every stage', async () => {
    const report = await preflightVariant(GOOD_HOOK, deps());
    expect(report.verdict).toBe('pass');
    expect(report.stages.map((s) => [s.stage, s.status])).toEqual(STAGE_ORDER.map((s) => [s, 'passed']));
    expect(report.content).toEqual(GOOD_HOOK);
    expect(report.slot).toBe('hook');
    expect(report.reasons).toEqual([]);
  });

  it('stops at the immutable module, naming what was attempted, and runs nothing after it', async () => {
    const sim = simulator();
    const rev = reviewer();
    const report = await preflightVariant({ ...GOOD_HOOK, opening: [{ id: 'identity', text: 'Hi.' }] }, deps({ simulator: sim, reviewer: rev }));
    expect(report.verdict).toBe('reject');
    expect(stageOf(report)).toBe('immutable-module');
    expect(report.reasons[0]).toContain('"opening"');
    expect(report.reasons[0]).toContain('ai-disclosure');
    expect(report.stages.slice(1).every((s) => s.status === 'skipped')).toBe(true);
    expect(sim.calls).toBe(0);
    expect(rev.prompts).toHaveLength(0);
  });

  it('rejects malformed shape at the schema stage', async () => {
    const report = await preflightVariant({ slot: 'hook', template: 'no placeholder in this hook phrasing at all' }, deps());
    expect(stageOf(report)).toBe('schema');
    expect(report.content).toBeNull();
    const nothing = await preflightVariant(undefined, deps());
    expect(nothing.reasons[0]).toContain('(variant)');
  });

  it('works one slot at a time', async () => {
    const report = await preflightVariant(GOOD_HOOK, deps({ expectedSlot: 'transition' }));
    expect(stageOf(report)).toBe('schema');
    expect(report.slot).toBe('hook');
    expect(report.reasons[0]).toContain('one slot at a time');
    expect((await preflightVariant(GOOD_HOOK, deps({ expectedSlot: 'hook' }))).verdict).toBe('pass');
  });

  it('rejects at the linter, quoting what matched where there is a match', async () => {
    const bad: PlaybookContent = { slot: 'transition', template: 'Is this a good time? Could we chat in 6 weeks?' };
    const report = await preflightVariant(bad, deps());
    expect(stageOf(report)).toBe('linter');
    expect(report.reasons.some((r) => r.includes('("6")'))).toBe(true);
    expect(report.reasons.some((r) => r.includes('one question') || r.includes('one at a time'))).toBe(true);
  });

  it('rejects at the claim check, with and without a matched phrase', async () => {
    const bad: PlaybookContent = { slot: 'value-statement', template: '{{claim:no.such.claim}} We built things for others, you know.' };
    const report = await preflightVariant(bad, deps());
    expect(stageOf(report)).toBe('claims');
    expect(report.reasons.some((r) => r.includes('not in the claim index'))).toBe(true);
    expect(report.reasons.some((r) => r.includes('("We built")'))).toBe(true);
  });

  it('refuses a reviewer that is the proposer', async () => {
    const report = await preflightVariant(GOOD_HOOK, deps({ reviewer: reviewer(undefined, 'proposer-1') }));
    expect(stageOf(report)).toBe('compliance-review');
    expect(report.reasons[0]).toContain('same instance');
  });

  it('fails closed when the reviewer errors, returns a non-verdict, or says no', async () => {
    const throws = { instanceId: 'r', review: async () => Promise.reject(new Error('timed out')) };
    expect((await preflightVariant(GOOD_HOOK, deps({ reviewer: throws }))).reasons[0]).toContain('timed out');
    const strange = { instanceId: 'r', review: async () => Promise.reject('plain string') };
    expect((await preflightVariant(GOOD_HOOK, deps({ reviewer: strange }))).reasons[0]).toContain('plain string');

    const garbage = await preflightVariant(GOOD_HOOK, deps({ reviewer: reviewer({ nope: true }) }));
    expect(garbage.reasons).toEqual(['the reviewer returned something that was not a verdict']);

    const says = await preflightVariant(
      GOOD_HOOK,
      deps({ reviewer: reviewer({ compliant: false, violations: [{ rule: 'pressure', quote: 'x', why: 'it pushes' }] }) })
    );
    expect(says.reasons).toEqual(['pressure: "x" - it pushes']);

    const silent = await preflightVariant(GOOD_HOOK, deps({ reviewer: reviewer({ compliant: false, violations: [] }) }));
    expect(silent.reasons[0]).toContain('without saying why');

    // "compliant" with violations listed is not compliant.
    const contradictory = await preflightVariant(
      GOOD_HOOK,
      deps({ reviewer: reviewer({ compliant: true, violations: [{ rule: 'a', quote: 'b', why: 'c' }] }) })
    );
    expect(stageOf(contradictory)).toBe('compliance-review');
  });

  it('never shows the reviewer the proposer\'s rationale: it sees the rendered wording and the rules', async () => {
    const rev = reviewer();
    await preflightVariant(GOOD_VALUE, deps({ reviewer: rev }));
    expect(rev.prompts[0]).toContain('Carlyle Group');
    expect(rev.prompts[0]).toContain('RULES THE WORDING MUST NOT BREAK');
    expect(rev.prompts[0]).not.toContain('rationale');
  });

  it('rejects when the simulation cannot run, misses a scenario kind, fails one, or loses the opening', async () => {
    const throws = { run: async () => Promise.reject(new Error('no model')) };
    expect((await preflightVariant(GOOD_HOOK, deps({ simulator: throws }))).reasons[0]).toContain('no model');
    const strange = { run: async () => Promise.reject('boom') };
    expect((await preflightVariant(GOOD_HOOK, deps({ simulator: strange }))).reasons[0]).toContain('boom');

    const missing = passingReport();
    missing.scenarios = missing.scenarios.filter((s) => s.kind !== 'regulator');
    const r1 = await preflightVariant(GOOD_HOOK, deps({ simulator: simulator(missing) }));
    expect(stageOf(r1)).toBe('simulation');
    expect(r1.reasons).toEqual(['the simulation ran no "regulator" scenario, and every kind is required']);

    const failing = passingReport();
    failing.scenarios[0] = { id: 'hostile-1', kind: 'hostile', passed: false, failures: ['asked a question after being told to stop'] };
    expect((await preflightVariant(GOOD_HOOK, deps({ simulator: simulator(failing) }))).reasons[0]).toContain('asked a question');

    const crowded = { ...passingReport(), openingIntact: false };
    expect((await preflightVariant(GOOD_HOOK, deps({ simulator: simulator(crowded) }))).reasons[0]).toContain('frozen opening');
  });

  it('requires every scenario kind, as data', () => {
    const empty = { scenarios: [], openingIntact: true };
    expect(simulationReasons(empty)).toHaveLength(SCENARIO_KINDS.length);
    expect(simulationReasons(passingReport())).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

const T = coachConfig().promotion;

function arm(over: Partial<ArmEvidence> = {}): ArmEvidence {
  return { eligible: 40, completed: 40, requests: 4, sentimentKnown: 40, negative: 4, defective: 0, hardFailures: 0, ...over };
}

describe('deciding a test', () => {
  it('promotes a significant, meaningful lift with no degradation anywhere', () => {
    const d = decideTest(arm({ requests: 2 }), arm({ requests: 10 }), T);
    expect(d.decision).toBe('promote');
    expect(d.reasons[0]).toContain('5.0%');
    expect(d.comparison.lift).toBeCloseTo(0.2, 5);
    expect(d.comparison.liftP).toBeLessThan(0.05);
    expect(d.comparison.liftInterval.lower).toBeGreaterThan(0);
  });

  it('will not decide on fewer than the floor of completed conversations per arm', () => {
    const both = decideTest(arm({ completed: 10, requests: 0 }), arm({ completed: 10, requests: 9 }), T);
    expect(both.decision).toBe('continue');
    expect(both.reasons[0]).toContain('champion has 10 of 30');
    expect(both.reasons[0]).toContain('challenger has 10 of 30');
    expect(decideTest(arm({ completed: 29 }), arm({ requests: 12 }), T).reasons[0]).toContain('champion has 29');
    expect(decideTest(arm({ requests: 0 }), arm({ completed: 29, requests: 12 }), T).reasons[0]).toContain('challenger has 29');
    // Thirty exactly is enough to decide on.
    expect(decideTest(arm({ eligible: 30, completed: 30, requests: 1, sentimentKnown: 30, negative: 3 }), arm({ eligible: 30, completed: 30, requests: 10, sentimentKnown: 30, negative: 3 }), T).decision).toBe('promote');
  });

  it('a lift that is not significant, or not big enough, is not promoted', () => {
    const noisy = decideTest(arm({ requests: 4 }), arm({ requests: 6 }), T);
    expect(noisy.decision).toBe('continue');
    expect(noisy.reasons[0]).toContain('short of the 5.0% lift');
    const small = decideTest(arm({ eligible: 400, completed: 400, requests: 40, sentimentKnown: 400, negative: 40 }), arm({ eligible: 400, completed: 400, requests: 54, sentimentKnown: 400, negative: 40 }), { ...T, maxConversationsPerArm: 1000 });
    expect(small.comparison.lift).toBeCloseTo(0.035, 5);
    expect(small.decision).toBe('continue');
  });

  it('withdraws a challenger for a missing disclosure at any sample size', () => {
    const d = decideTest(arm(), arm({ completed: 2, hardFailures: 1 }), T);
    expect(d.decision).toBe('withdraw');
    expect(d.reasons[0]).toContain('disclosure-missing');
  });

  it('withdraws a challenger that degrades completion, sentiment or defect rate, even while winning', () => {
    const winning = { requests: 12 };
    const completion = decideTest(arm(), arm({ ...winning, completed: 30 }), T);
    expect(completion.decision).toBe('withdraw');
    expect(completion.reasons.join()).toContain('completion fell');
    expect(decideTest(arm(), arm({ ...winning, negative: 14 }), T).reasons.join()).toContain('negative sentiment rose');
    expect(decideTest(arm(), arm({ ...winning, defective: 3 }), T).reasons.join()).toContain('defect rate rose');
  });

  it('withdraws a challenger whose request rate has significantly fallen', () => {
    const d = decideTest(arm({ requests: 12 }), arm({ requests: 2 }), T);
    expect(d.decision).toBe('withdraw');
    expect(d.reasons.join()).toContain('meeting-request rate fell');
    // A fall that could be noise is not a regression yet.
    expect(compareArms(arm({ requests: 1 }), arm({ requests: 0 }), { ...T, minAbsoluteLift: 0.02 }).regressions).toEqual([]);
    // And a small fall is not one however significant.
    expect(compareArms(arm({ eligible: 400, completed: 400, requests: 60 }), arm({ eligible: 400, completed: 400, requests: 56 }), T).regressions).toEqual([]);
  });

  it('flags a guardrail by tolerance, or by a one-sided test when worse at all, and not otherwise', () => {
    const tolerant = { ...T, maxCompletionDrop: 0.1 };
    // 3/40 worse is within the 10% tolerance, but a one-sided test at 0.2 calls it.
    expect(compareArms(arm(), arm({ completed: 37 }), tolerant).regressions.join()).toContain('completion fell');
    // 1/40 worse is within tolerance and nowhere near significant.
    expect(compareArms(arm(), arm({ completed: 39 }), tolerant).regressions).toEqual([]);
    // Better is never a regression.
    expect(compareArms(arm({ completed: 35 }), arm(), T).regressions).toEqual([]);
  });

  it('holds promotion while sentiment is too patchy to show no degradation', () => {
    const base = arm({ requests: 2, sentimentKnown: 20, negative: 2 });
    const challenger = arm({ requests: 10 });
    const d = decideTest(base, challenger, T);
    expect(d.decision).toBe('continue');
    expect(d.reasons[0]).toContain('sentiment is known for only 50.0%');
    expect(decideTest(arm({ requests: 2 }), arm({ requests: 10, sentimentKnown: 20, negative: 2 }), T).decision).toBe('continue');
  });

  it('retires a test that has run to the ceiling without showing anything', () => {
    const big = (over: Partial<ArmEvidence>) => arm({ eligible: 150, completed: 150, sentimentKnown: 150, negative: 15, requests: 15, ...over });
    const flat = decideTest(big({}), big({ requests: 16 }), T);
    expect(flat.decision).toBe('retire');
    expect(flat.reasons[0]).toContain('inconclusive after 150');
    const patchy = decideTest(big({ sentimentKnown: 50 }), big({ requests: 40 }), T);
    expect(patchy.decision).toBe('retire');
    expect(armRates(big({})).requestRate).toBeCloseTo(0.1, 5);
  });
});

describe('watching a promoted champion', () => {
  const watch = 30;
  it('rolls back for a missing disclosure at once', () => {
    expect(monitorPromotion(arm(), arm({ completed: 3, hardFailures: 1 }), T, watch).status).toBe('rollback');
  });
  it('waits for enough conversations', () => {
    const w = monitorPromotion(arm(), arm({ completed: 12 }), T, watch);
    expect(w.status).toBe('watching');
    expect(w.reasons[0]).toContain('12 of 30');
  });
  it('rolls back on regression and clears a healthy one', () => {
    const bad = monitorPromotion(arm({ requests: 12 }), arm({ requests: 2 }), T, watch);
    expect(bad.status).toBe('rollback');
    expect(monitorPromotion(arm({ requests: 8 }), arm({ requests: 9 }), T, watch).status).toBe('ok');
  });
});
