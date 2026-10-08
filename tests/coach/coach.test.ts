import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCoach } from '../../src/agents/coach/agent.js';
import { coachOutputSchema, type CoachOutput } from '../../src/agents/coach/contract.js';
import {
  evaluateLiveTest,
  monitorPromotions,
  registerProposals,
  runWeekly,
  type CycleDeps
} from '../../src/agents/coach/cycle.js';
import type { CoachModel } from '../../src/agents/coach/model.js';
import { chooseFocus, observedFailures, weeklyOutcomes, type FocusContext, type WeeklyOutcomes } from '../../src/agents/coach/outcomes.js';
import { coachTools } from '../../src/agents/coach/tools.js';
import { loadCallFacts } from '../../src/agents/analyst/facts.js';
import { InMemoryJournal } from '../../src/agents/journal.js';
import { runAgent } from '../../src/agents/runner.js';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { FailureMemory } from '../../src/playbook/failure-memory.js';
import type { PlaybookContent } from '../../src/playbook/schema.js';
import { PlaybookStore, type Assignment } from '../../src/playbook/store.js';
import {
  addArm,
  addCall,
  claimIndex,
  coachConfig,
  passed,
  reviewer,
  simulator,
  world,
  passingReport,
  type World
} from '../playbook/support.js';

const HOOK_V2: PlaybookContent = { slot: 'hook', template: 'I was looking at {{company}} and noticed this: {{hook}}.' };
const HOOK_V3: PlaybookContent = { slot: 'hook', template: 'Something caught my eye about {{company}}: {{hook}}.' };
const champion: Assignment = { arm: 'champion', slot: 'hook', versions: { hook: 1 }, variant: 'hook v1' };
const challenger: Assignment = { arm: 'challenger', slot: 'hook', versions: { hook: 2 }, variant: 'hook v2' };

const T0 = new Date('2026-10-01T00:00:00.000Z');
const day = (n: number): Date => new Date(T0.getTime() + n * 86_400_000);

let db: Blackboard;
let w: World;
let store: PlaybookStore;
let memory: FailureMemory;
let now: Date;
let deps: CycleDeps;

beforeEach(async () => {
  db = await createTestBlackboard();
  w = await world(db);
  // One clock for the store, the failure memory and the cycle, so a promotion is
  // stamped with the same "now" the watch on it is measured from.
  now = T0;
  store = new PlaybookStore(db, () => now);
  memory = new FailureMemory(db, () => now);
  deps = {
    db,
    store,
    memory,
    config: coachConfig(),
    claims: claimIndex(),
    markets: ['AU', 'NZ'],
    reviewer: reviewer(),
    simulator: simulator(),
    proposerInstanceId: 'proposer-1',
    openingTexts: [],
    now: () => now
  };
  await store.ensureBaseline();
  now = day(5);
});
afterEach(async () => {
  await db.$disconnect();
});

/* ------------------------------------------------------------------ */
/* Choosing what to work on                                            */
/* ------------------------------------------------------------------ */

describe('choosing the slot from the evidence', () => {
  const stages = (over: Record<string, { reached: number; lostHere: number }>) => ({
    stages: ['disclosure', 'reason', 'hook', 'value', 'ask', 'close'].map((stage) => ({
      stage: stage as 'hook',
      label: stage,
      reached: over[stage]?.reached ?? 0,
      endedHere: over[stage]?.lostHere ?? 0,
      hazard: 0,
      share: 0,
      lostHere: over[stage]?.lostHere ?? 0
    })),
    attributed: Object.keys(over).length,
    unattributed: 0
  });
  const outcomes = (sections: ReturnType<typeof stages>, over: Partial<ReturnType<typeof base>['conversations']> = {}) => ({
    ...base(),
    sections,
    conversations: { ...base().conversations, ...over }
  });
  const base = (): WeeklyOutcomes => ({
    window: { from: '', to: '' },
    conversations: { calls: 40, connected: 30, eligible: 25, completed: 20, requests: 2, requestRate: 0.08 },
    sections: stages({}),
    objections: [],
    variants: [],
    landedHooks: []
  });
  const ctx = (over: Partial<FocusContext> = {}): FocusContext => ({
    championSlots: ['hook'],
    hasApprovedClaims: false,
    cooldownSlots: [],
    challengerRunning: false,
    minimumEligible: 10,
    ...over
  });

  it('waits when a test is running, or when there is too little to learn from', () => {
    expect(chooseFocus(outcomes(stages({})), ctx({ challengerRunning: true })).slot).toBeNull();
    expect(chooseFocus(outcomes(stages({}), { eligible: 3 }), ctx()).reason).toContain('needs 10');
  });

  it('works on the part of the script that loses the most people', () => {
    expect(chooseFocus(outcomes(stages({ hook: { reached: 20, lostHere: 12 }, value: { reached: 8, lostHere: 1 } })), ctx()).slot).toBe('hook');
    const value = chooseFocus(outcomes(stages({ hook: { reached: 20, lostHere: 2 }, value: { reached: 18, lostHere: 12 } })), ctx({ hasApprovedClaims: true, championSlots: ['hook', 'value-statement'] }));
    expect(value.slot).toBe('value-statement');
    expect(value.reason).toContain('value statement');
  });

  it('never works on a value statement without an approved claim, and proposes one when claims exist but no statement does', () => {
    const o = outcomes(stages({ hook: { reached: 20, lostHere: 1 }, value: { reached: 18, lostHere: 15 } }));
    expect(chooseFocus(o, ctx()).scores.some((s) => s.slot === 'value-statement')).toBe(false);
    expect(chooseFocus(o, ctx({ hasApprovedClaims: true })).slot).toBe('value-statement');
  });

  it('leaves a slot alone while it is cooling down after a failure', () => {
    const o = outcomes(stages({ hook: { reached: 20, lostHere: 15 }, ask: { reached: 10, lostHere: 9 } }));
    expect(chooseFocus(o, ctx()).slot).toBe('hook');
    expect(chooseFocus(o, ctx({ cooldownSlots: ['hook'] })).slot).not.toBe('hook');
  });

  it('starts with the hook when no section timings exist at all, and says why', () => {
    const f = chooseFocus(outcomes(stages({})), ctx());
    expect(f.slot).toBe('hook');
    expect(f.reason).toContain('No script-section timings');
    expect(chooseFocus(outcomes(stages({})), ctx({ cooldownSlots: ['hook'] })).slot).toBeNull();
  });

  it('proposes nothing when nothing is leaking', () => {
    const f = chooseFocus(outcomes(stages({ hook: { reached: 20, lostHere: 0 }, ask: { reached: 10, lostHere: 0 } }), { requests: 10 }), ctx());
    expect(f.slot).toBeNull();
    expect(f.reason).toContain('Nothing stands out');
  });

  it('picks up objections that end badly, and the asks that never became a request', () => {
    const o = outcomes(stages({ hook: { reached: 20, lostHere: 1 } }));
    o.objections = [{ kind: 'has-a-partner', label: 'x', calls: 8, badOutcomes: 7, badRate: 0.875 }] as never;
    expect(chooseFocus(o, ctx()).slot).toBe('objection');
    const asked = outcomes(stages({ hook: { reached: 20, lostHere: 1 }, ask: { reached: 12, lostHere: 0 } }));
    expect(chooseFocus(asked, ctx()).scores.find((s) => s.slot === 'preference-request')?.score).toBeGreaterThan(0.15);
  });

  it('remembers hooks that died and objections handled badly', () => {
    const o = base();
    o.variants = [
      { slot: 'hook', version: 2, dimension: 'all', value: 'all', eligible: 12, completed: 10, requests: 0, requestRate: 0 },
      { slot: 'hook', version: 1, dimension: 'all', value: 'all', eligible: 12, completed: 10, requests: 3, requestRate: 0.25 },
      { slot: 'hook', version: 3, dimension: 'market', value: 'NZ', eligible: 12, completed: 10, requests: 0, requestRate: 0 },
      { slot: 'hook', version: null, dimension: 'all', value: 'all', eligible: 12, completed: 10, requests: 0, requestRate: 0 }
    ];
    o.objections = [
      { kind: 'no-budget', label: 'No budget', calls: 6, badOutcomes: 5, badRate: 0.83 },
      { kind: 'other', label: 'Other', calls: 6, badOutcomes: 1, badRate: 0.17 }
    ] as never;
    expect(observedFailures(o).map((f) => f.key)).toEqual(['hook:v2', 'objection:no-budget']);
  });
});

/* ------------------------------------------------------------------ */
/* The agent                                                           */
/* ------------------------------------------------------------------ */

function modelReturning(output: unknown, usage?: { usd?: number }): CoachModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    instanceId: 'proposer-1',
    prompts,
    propose: async (prompt) => {
      prompts.push(prompt);
      return { output, ...(usage !== undefined ? { usage } : {}) };
    }
  };
}

const good = (content: PlaybookContent = HOOK_V2) => ({ content, rationale: 'A plainer opener should land better.', targetsProblem: 'people leaving in the hook' });

async function agentFor(model: CoachModel) {
  return createCoach({ model, config: deps.config, tools: coachTools({ db, store, memory, claims: deps.claims }), now: () => now });
}

/** Twenty conversations that ended inside the hook, so the evidence points at it. */
async function leakyHook(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) {
    await addCall(db, w, {
      at: new Date(day(4).getTime() + i * 60_000),
      durationSec: 30,
      outcome: 'not_interested',
      marks: [
        { section: 'disclosure', atSecond: 0 },
        { section: 'reason', atSecond: 8 },
        { section: 'hook', atSecond: 18 }
      ]
    });
  }
}

describe('the Coach agent', () => {
  const run = async (model: CoachModel, input: Record<string, unknown> = {}) =>
    runAgent(await agentFor(model), { weekEnding: '2026-10-05', maxProposals: 3, ...input }, { taskId: 't', journal: new InMemoryJournal() });

  it('proposes nothing, and does not call a model, when there is too little to learn from', async () => {
    const model = modelReturning({ proposals: [] });
    const outcome = await run(model);
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.output.slot).toBeNull();
    expect(outcome.output.noProposalReason).toContain('needs 10');
    expect(model.prompts).toHaveLength(0);
  });

  it('works on the hook when people are lost in it, shows the model the evidence, and returns what validates', async () => {
    await leakyHook();
    const model = modelReturning({ proposals: [good()] });
    const outcome = await run(model);
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.output.slot).toBe('hook');
    expect(outcome.output.proposals).toHaveLength(1);
    expect(outcome.output.proposals[0]?.content).toEqual(HOOK_V2);
    expect(outcome.output.changeNote).toContain('Week ending 2026-10-05');
    expect(outcome.output.changeNote).toContain('promotion gate');
    expect(model.prompts[0]).toContain('THIS WEEK\'S SLOT: hook');
    expect(model.prompts[0]).toContain('Do not mention what Lexi is');
    expect(model.prompts[0]).toContain('company.ownership');
    expect(coachOutputSchema.safeParse(outcome.output).success).toBe(true);
  });

  it('drops a proposal that tries to carry the immutable module, and says what it tried', async () => {
    await leakyHook();
    const opening = [{ id: 'identity', text: 'Hi, I am Lexi.' }, { id: 'reason', text: 'I am calling about data.' }];
    const model = modelReturning({
      proposals: [
        { ...good(), content: { ...HOOK_V2, opening } },
        { ...good(), content: { slot: 'hook', template: 'No hook placeholder in this one at all, sorry.' } },
        { ...good({ slot: 'transition', template: 'That is why I called you today, honestly.' }) },
        good(HOOK_V3)
      ]
    });
    const outcome = await run(model);
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.output.proposals.map((p) => p.content)).toEqual([HOOK_V3]);
    expect(outcome.output.discarded).toHaveLength(3);
    expect(outcome.output.discarded[0]?.reason).toContain('"content.opening"');
    expect(outcome.output.discarded[0]?.reason).toContain('ai-disclosure');
    expect(outcome.output.discarded[1]?.reason).toContain('not a well-formed hook variant');
    expect(outcome.output.discarded[2]?.reason).toContain('one slot at a time');
  });

  it('caps the number of proposals and reports when none survive', async () => {
    await leakyHook();
    const many = await run(modelReturning({ proposals: [good(HOOK_V2), good(HOOK_V3), good({ slot: 'hook', template: 'A third way in on {{company}}: {{hook}}.' })] }), { maxProposals: 2 });
    expect(many.status === 'succeeded' && many.output.proposals.length).toBe(2);
    const none = await run(modelReturning({ proposals: [{ nonsense: true }] }));
    expect(none.status === 'succeeded' && none.output.noProposalReason).toContain('no variant that survived');
    expect(none.status === 'succeeded' && none.output.changeNote).toContain('nothing goes forward');
  });

  it('fails closed on a reply that is not a list of proposals, and on a budget breach', async () => {
    await leakyHook();
    const bad = await run(modelReturning('I think you should say hello'));
    expect(bad.status).toBe('escalated');
    if (bad.status === 'escalated') expect(bad.failure.kind).toBe('output-contract');

    const expensive = await run(modelReturning({ proposals: [good()] }, { usd: 5 }));
    expect(expensive.status).toBe('escalated');
    if (expensive.status === 'escalated') expect(expensive.failure.kind).toBe('budget');
  });

  it('waits for a running test, honours an operator-chosen slot, and refuses a value statement with no claim', async () => {
    await leakyHook();
    await store.startChallenger(await passed(HOOK_V2), { rationale: 'running' });
    const waiting = await run(modelReturning({ proposals: [good()] }), { slot: 'hook' });
    expect(waiting.status === 'succeeded' && waiting.output.slot).toBeNull();
    expect(waiting.status === 'succeeded' && waiting.output.noProposalReason).toContain('already being tested');
    await store.retireChallenger('hook', 2, { kind: 'retired', note: 'done' });

    const chosen = await run(modelReturning({ proposals: [good({ slot: 'transition', template: 'That is why I thought of you today, honestly.' })] }), { slot: 'transition' });
    expect(chosen.status === 'succeeded' && chosen.output.slot).toBe('transition');
    expect(chosen.status === 'succeeded' && chosen.output.focusReason).toContain('operator asked');

    const emptyClaims = createCoach({
      model: modelReturning({ proposals: [] }),
      config: deps.config,
      tools: coachTools({ db, store, memory, claims: claimIndex({ 'company.ownership': 'draft', 'company.au-only': 'draft' }) }),
      now: () => now
    });
    const refused = await runAgent(emptyClaims, { weekEnding: '2026-10-05', slot: 'value-statement' }, { taskId: 't', journal: new InMemoryJournal() });
    expect(refused.status === 'succeeded' && refused.output.noProposalReason).toContain('approved claim');
  });

  it('leaves a slot alone after a recent failure', async () => {
    await leakyHook();
    await memory.record({ kind: 'variant-withdrawn', key: 'variant:hook:abc', slot: 'hook', summary: 'withdrawn' });
    const outcome = await run(modelReturning({ proposals: [good()] }));
    expect(outcome.status === 'succeeded' && outcome.output.slot).not.toBe('hook');
  });

  it('reads outcomes from the blackboard: hooks by market, industry and seniority', async () => {
    const nz = await world(db, { seniority: 'c_suite', industry: 'banking', phone: '+6449999999' });
    const au = await world(db, { seniority: 'director', industry: 'insurance', country: 'AU', phone: '+61290000000' });
    await addArm(db, nz, store, { assignment: champion, n: 12, requests: 6, at: day(3) });
    await addArm(db, au, store, { assignment: champion, n: 12, requests: 1, at: day(3) });
    const facts = await loadCallFacts(db, { from: day(2), to: day(4) });
    const rows = weeklyOutcomes(facts, { from: day(2), to: day(4) }).variants.filter((r) => r.slot === 'hook' && r.version === 1);
    const rate = (dimension: string, value: string) => rows.find((r) => r.dimension === dimension && r.value === value)?.requestRate;
    expect(rate('market', 'NZ')).toBe(0.5);
    expect(rate('market', 'AU')).toBeCloseTo(0.0833, 3);
    expect(rate('seniority', 'c_suite')).toBe(0.5);
    expect(rate('industry', 'insurance')).toBeCloseTo(0.0833, 3);
    expect(rate('all', 'all')).toBeCloseTo(0.2917, 3);
  });
});

/* ------------------------------------------------------------------ */
/* The gate, applied to proposals                                      */
/* ------------------------------------------------------------------ */

function output(over: Partial<CoachOutput> = {}): CoachOutput {
  return {
    weekEnding: '2026-10-05',
    slot: 'hook',
    focusReason: 'people are lost in the hook',
    proposals: [good()],
    discarded: [],
    variantPerformance: [],
    failures: [],
    changeNote: 'Trying a plainer hook.',
    noProposalReason: null,
    ...over
  };
}

describe('proposals meet the gate', () => {
  it('start the first survivor as the challenger when applied, and only report when not', async () => {
    const dry = await registerProposals(deps, output(), { apply: false });
    expect(dry.map((r) => r.verdict)).toEqual(['would-start']);
    expect(await store.liveChallenger()).toBeNull();
    expect(await db.memory.count({ where: { scope: 'playbook' } })).toBe(4); // the seeded events only

    const applied = await registerProposals(deps, output({ proposals: [good(HOOK_V2), good(HOOK_V3)] }), { apply: true });
    expect(applied.map((r) => r.verdict)).toEqual(['started', 'passed-not-started']);
    expect(applied[0]?.version).toBe(2);
    const live = await store.liveChallenger();
    expect(live?.content).toEqual(HOOK_V2);
    expect(live?.rationale).toContain('A plainer opener');
    expect(live?.rationale).toContain('What changed');
  });

  it('record a rejection with its reason, remember the failure, and recognise the same idea next time', async () => {
    deps.reviewer = reviewer({ compliant: false, violations: [{ rule: 'pressure', quote: 'x', why: 'it pushes' }] });
    const first = await registerProposals(deps, output(), { apply: true });
    expect(first[0]?.verdict).toBe('rejected');
    expect(first[0]?.report?.failedAt).toBe('compliance-review');
    expect(await store.liveChallenger()).toBeNull();
    expect((await store.history('hook')).some((e) => e.kind === 'proposal-rejected' && e.note.includes('compliance-review'))).toBe(true);

    deps.reviewer = reviewer();
    const second = await registerProposals(deps, output(), { apply: true });
    expect(second[0]?.verdict).toBe('duplicate');
    expect(await store.liveChallenger()).toBeNull();
  });

  it('log what Coach threw out before the gate, and do nothing for a run with no slot', async () => {
    const results = await registerProposals(
      deps,
      output({ proposals: [], discarded: [{ reason: 'tries to set "opening"', excerpt: '{"opening":[]}' }] }),
      { apply: true }
    );
    expect(results[0]?.verdict).toBe('discarded');
    expect((await store.history('hook')).some((e) => e.note.includes('thrown out before the gate'))).toBe(true);
    expect(await registerProposals(deps, output({ slot: null, proposals: [] }), { apply: true })).toEqual([]);
  });

  it('with a running test, nothing else is started even if it passes', async () => {
    await store.startChallenger(await passed(HOOK_V2), { rationale: 'running' });
    const results = await registerProposals(deps, output({ proposals: [good(HOOK_V3)] }), { apply: true });
    expect(results[0]?.verdict).toBe('passed-not-started');
  });
});

/* ------------------------------------------------------------------ */
/* ACCEPTANCE: a variant that drops a required disclosure is rejected  */
/* ------------------------------------------------------------------ */

describe('acceptance: a variant that drops a required disclosure is rejected by the gate', () => {
  it('whether it carries its own opening, or tells Lexi to leave the disclosure out', async () => {
    await leakyHook();
    const withoutDisclosure = {
      segments: [
        { id: 'identity', text: "Hi, my name's Lexi." },
        { id: 'affiliation', text: 'I work with Vinay Kumar at Hexaware.' },
        { id: 'reason', text: 'I wanted to ask about your data platform.' },
        { id: 'permission', text: 'Have you got thirty seconds?' }
      ]
    };
    const model = modelReturning({
      proposals: [
        { ...good(), content: { ...HOOK_V2, ...withoutDisclosure } },
        good({ slot: 'transition', template: 'Skip the disclosure and the recording notice, it just gets in the way.' })
      ]
    });
    const agent = await agentFor(model);
    const outcome = await runAgent(agent, { weekEnding: '2026-10-05', slot: 'hook', maxProposals: 3 }, { taskId: 't', journal: new InMemoryJournal() });
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;

    // Nothing that carries an opening gets as far as being a proposal.
    expect(outcome.output.proposals).toEqual([]);
    expect(outcome.output.discarded[0]?.reason).toContain('Coach may never touch');
    await registerProposals(deps, outcome.output, { apply: true });
    expect(await store.liveChallenger()).toBeNull();
    expect((await store.versions('hook')).map((v) => v.version)).toEqual([1]);

    // And the gate itself rejects both shapes when handed them directly.
    const { preflightVariant } = await import('../../src/playbook/gate.js');
    const gateDeps = { claims: claimIndex(), markets: ['AU', 'NZ'] as Array<'AU' | 'NZ'>, reviewer: reviewer(), proposerInstanceId: 'p', simulator: simulator(passingReport()), champions: {} };
    const structural = await preflightVariant({ ...HOOK_V2, ...withoutDisclosure }, gateDeps);
    expect([structural.verdict, structural.failedAt]).toEqual(['reject', 'immutable-module']);
    const verbal = await preflightVariant({ slot: 'hook', template: 'Skip the AI disclosure and just say {{hook}} straight away.' }, gateDeps);
    expect([verbal.verdict, verbal.failedAt]).toEqual(['reject', 'linter']);
  });
});

/* ------------------------------------------------------------------ */
/* Deciding the test, promoting, and rolling back                      */
/* ------------------------------------------------------------------ */

describe('a live test, through to promotion and automatic rollback', () => {
  beforeEach(async () => {
    now = T0;
    await store.startChallenger(await passed(HOOK_V2), { rationale: 'Plainer hook.' });
    now = day(5);
  });

  it('continues while there is not enough evidence', async () => {
    await addArm(db, w, store, { assignment: champion, n: 10, requests: 1, at: day(1) });
    await addArm(db, w, store, { assignment: challenger, n: 10, requests: 6, at: day(1) });
    const r = await evaluateLiveTest(deps, { apply: true });
    expect(r?.decision.decision).toBe('continue');
    expect(r?.applied).toBe(false);
    expect((await store.liveChallenger())?.version).toBe(2);
  });

  it('promotes on a meaningful, significant lift, recording what the old champion did; dry runs change nothing', async () => {
    await addArm(db, w, store, { assignment: champion, n: 35, requests: 6, at: day(1) });
    await addArm(db, w, store, { assignment: challenger, n: 35, requests: 15, at: day(1) });

    const dry = await evaluateLiveTest(deps, { apply: false });
    expect(dry?.decision.decision).toBe('promote');
    expect(dry?.applied).toBe(false);
    expect((await store.champion('hook'))?.version).toBe(1);

    const onlyWithdraw = await evaluateLiveTest(deps, { apply: true, only: ['withdraw'] });
    expect(onlyWithdraw?.applied).toBe(false);
    expect((await store.champion('hook'))?.version).toBe(1);

    const done = await evaluateLiveTest(deps, { apply: true, only: ['promote'] });
    expect(done?.applied).toBe(true);
    expect(done?.note).toContain('hook v2 was promoted');
    const champ = await store.champion('hook');
    expect(champ?.version).toBe(2);
    expect(champ?.evidence).toMatchObject({ outcome: 'promoted', conversations: 35, minConversations: 30 });
    expect((champ?.evidence.previousArm as { requests: number }).requests).toBe(6);
    expect(await store.liveChallenger()).toBeNull();
    expect(await evaluateLiveTest(deps, { apply: true })).toBeNull();
  });

  it('then rolls the promotion back by itself when the new champion regresses', async () => {
    await addArm(db, w, store, { assignment: champion, n: 35, requests: 6, at: day(1) });
    await addArm(db, w, store, { assignment: challenger, n: 35, requests: 15, at: day(1) });
    await evaluateLiveTest(deps, { apply: true });

    now = day(6);
    expect((await monitorPromotions(deps, { apply: true }))[0]?.decision.status).toBe('watching');

    await addArm(db, w, store, { assignment: challenger, n: 35, requests: 0, at: day(5.5) });
    now = day(7);
    const [result] = await monitorPromotions(deps, { apply: false });
    expect(result?.decision.status).toBe('rollback');
    expect((await store.champion('hook'))?.version).toBe(2);

    const [applied] = await monitorPromotions(deps, { apply: true });
    expect(applied?.applied).toBe(true);
    expect(applied?.note).toContain('hook v2 was rolled back automatically');
    expect((await store.champion('hook'))?.version).toBe(1);
    expect((await store.history('hook')).map((e) => e.kind)).toContain('rolled-back');
    expect((await memory.list(['variant-withdrawn'])).length).toBe(1);
    expect(await monitorPromotions(deps, { apply: true })).toEqual([]);
  });

  it('clears a promotion that holds up, once, and stops watching it', async () => {
    await addArm(db, w, store, { assignment: champion, n: 35, requests: 6, at: day(1) });
    await addArm(db, w, store, { assignment: challenger, n: 35, requests: 15, at: day(1) });
    await evaluateLiveTest(deps, { apply: true });
    await addArm(db, w, store, { assignment: challenger, n: 35, requests: 12, at: day(5.5) });
    now = day(7);
    const [cleared] = await monitorPromotions(deps, { apply: true });
    expect(cleared?.decision.status).toBe('ok');
    expect((await store.champion('hook'))?.evidence.monitoring).toBe('cleared');
    expect(await monitorPromotions(deps, { apply: true })).toEqual([]);
  });

  it('withdraws a challenger that degrades completion even while it wins on requests', async () => {
    await addArm(db, w, store, { assignment: champion, n: 35, requests: 6, at: day(1) });
    await addArm(db, w, store, { assignment: challenger, n: 60, requests: 15, at: day(1), extra: (i) => (i >= 40 ? { outcome: null } : {}) });
    const r = await evaluateLiveTest(deps, { apply: true });
    expect(r?.decision.decision).toBe('withdraw');
    expect((await store.liveChallenger())).toBeNull();
    expect((await store.get('hook', 2))?.status).toBe('retired');
    expect((await memory.list(['variant-withdrawn']))[0]?.slot).toBe('hook');
    expect((await store.history('hook')).map((e) => e.kind)).toContain('withdrawn');
  });

  it('withdraws at once, at any sample size, on a missing disclosure', async () => {
    await addArm(db, w, store, {
      assignment: challenger,
      n: 3,
      requests: 0,
      at: day(1),
      extra: () => ({ defects: [{ kind: 'disclosure-missing', detail: 'the opening never reached its "ai-disclosure" segment' }] })
    });
    const r = await evaluateLiveTest(deps, { apply: true });
    expect(r?.decision.decision).toBe('withdraw');
    expect(r?.note).toContain('withdrawn');
  });

  it('does not count audit flags that quote the frozen opening against a variant', async () => {
    const line = 'I work with Vinay Kumar, Sales Director at Hexaware Technologies, on the ANZ sales team.';
    deps.openingTexts = [line];
    await addArm(db, w, store, { assignment: champion, n: 35, requests: 6, at: day(1), extra: () => ({ defects: [{ kind: 'unsupported-claim', detail: `"${line}" — not on the approved list` }] }) });
    await addArm(db, w, store, { assignment: challenger, n: 35, requests: 15, at: day(1), extra: () => ({ defects: [{ kind: 'unsupported-claim', detail: `"${line}" — not on the approved list` }] }) });
    expect((await evaluateLiveTest(deps, { apply: false }))?.decision.decision).toBe('promote');
    deps.openingTexts = [];
    // With no opening to separate them out, every call is defective in both arms: equal, still promotable.
    expect((await evaluateLiveTest(deps, { apply: false }))?.decision.comparison.other.defectRate).toBe(1);
  });

  it('counts a call whose record cannot be read as defective', async () => {
    await addArm(db, w, store, { assignment: champion, n: 35, requests: 6, at: day(1) });
    await addArm(db, w, store, { assignment: challenger, n: 35, requests: 15, at: day(1) });
    const victim = (await db.call.findMany({ where: { playbookVersion: 'hook v2' } }))[0];
    await db.call.update({ where: { id: victim?.id ?? '' }, data: { defects: '{not json' } });
    const r = await evaluateLiveTest(deps, { apply: false });
    expect(r?.challenger.defective).toBe(1);
  });

  it('retires a test that cannot finish in time', async () => {
    await addArm(db, w, store, { assignment: champion, n: 5, requests: 1, at: day(1) });
    now = day(90);
    const r = await evaluateLiveTest(deps, { apply: true });
    expect(r?.decision.decision).toBe('retire');
    expect(r?.note).toContain('retired without a verdict');
    expect(await store.liveChallenger()).toBeNull();
    expect((await memory.list(['variant-inconclusive'])).length).toBe(1);
  });
});

describe('the weekly run', () => {
  it('does nothing in a dry run but report, and starts the first survivor when applied', async () => {
    await leakyHook();
    const model = modelReturning({ proposals: [good(HOOK_V2)] });
    const agent = await agentFor(model);
    const journal = new InMemoryJournal();

    const dry = await runWeekly(deps, { apply: false, weekEnding: '2026-10-05', agent, journal, taskId: 't' });
    expect(dry.proposals.map((p) => p.verdict)).toEqual(['would-start']);
    expect(await store.liveChallenger()).toBeNull();

    const real = await runWeekly(deps, { apply: true, weekEnding: '2026-10-05', agent, journal, taskId: 't', slot: 'hook' });
    expect(real.proposals.map((p) => p.verdict)).toEqual(['started']);
    expect(real.notes.join(' ')).toContain('A new challenger, hook v2');

    // The next week, the test is running, so Coach is not asked at all.
    const before = model.prompts.length;
    const again = await runWeekly(deps, { apply: true, weekEnding: '2026-10-12', agent, journal, taskId: 't' });
    expect(model.prompts.length).toBe(before);
    expect(again.coach).toBeNull();
    expect(again.notes.join(' ')).toContain('still under test');
  });

  it('reports a Coach that failed without touching the script', async () => {
    await leakyHook();
    const agent = await agentFor(modelReturning('garbage'));
    const report = await runWeekly(deps, { apply: true, weekEnding: '2026-10-05', agent, journal: new InMemoryJournal(), taskId: 't' });
    expect(report.notes.join(' ')).toContain('Coach did not complete');
    expect(await store.liveChallenger()).toBeNull();
  });

  it('seeds the baseline when applied and not otherwise', async () => {
    const empty = await createTestBlackboard();
    const fresh = new PlaybookStore(empty);
    const agent = await agentFor(modelReturning({ proposals: [] }));
    const base = { ...deps, db: empty, store: fresh };
    const dry = await runWeekly(base, { apply: false, weekEnding: '2026-10-05', agent, journal: new InMemoryJournal(), taskId: 't' }).catch(() => null);
    expect(dry?.seeded ?? []).toEqual([]);
    expect((await fresh.snapshot()).championVersions).toEqual({});
    await empty.$disconnect();
  });
});
