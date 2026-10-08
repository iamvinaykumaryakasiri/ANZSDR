import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyObjection, loadCallFacts, type CallFact } from '../../src/agents/analyst/facts.js';
import {
  buildFunnel,
  buildHangupCurve,
  CONVERSATION_SECONDS,
  costPerMeeting,
  dayContaining,
  dayWindow,
  defectRateMetric,
  funnelCounts,
  gatekeeperByAccount,
  isOpeningLine,
  leakiestSection,
  loadGateRejections,
  loadQueueCounts,
  loadSafetySignals,
  loadSpend,
  median,
  objectionStats,
  OPENER_SECONDS,
  outcomeCounts,
  quoteOf,
  rankObjections,
  safetySignalsFromFacts,
  sectionHangups,
  shiftDays,
  stageOfSection,
  summariseDefects,
  todayNumbers,
  variantPerformance,
  worstStageAgainstBaseline,
  wrongNumberRate
} from '../../src/agents/analyst/metrics.js';
import { evaluateAutoTrip } from '../../src/compliance/kill-switch.js';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import type { FunnelStageView, HangupCurveView } from '../../src/stream/contract.js';
import { OPENER_SECONDS as CONSOLE_OPENER, CONVERSATION_SECONDS as CONSOLE_CONVERSATION } from '../../src/stream/facts.js';
import { policy } from '../support/fixtures.js';
import { addCall, world } from '../playbook/support.js';

let seq = 0;
/** A fact with every flag consistent with its length and outcome, as `toFact` would make it. */
function fact(over: Partial<CallFact> = {}): CallFact {
  seq += 1;
  const outcome = over.outcome === undefined ? 'not_interested' : over.outcome;
  const durationSec = over.durationSec ?? 60;
  const answered = outcome !== null ? !['no_answer', 'voicemail', 'invalid_number'].includes(outcome) : durationSec >= 10;
  const survivedOpener = answered && durationSec >= OPENER_SECONDS;
  const realConversation = survivedOpener && durationSec >= CONVERSATION_SECONDS;
  const marks = over.marks ?? [];
  const askMade = realConversation && (marks.some((m) => m.section === 'ask') || outcome === 'meeting_requested' || outcome === 'callback_requested');
  const requested = askMade && outcome === 'meeting_requested';
  return {
    id: `call-${seq}`,
    contactId: 'contact-1',
    accountId: 'account-1',
    campaignId: 'campaign-1',
    startedAt: new Date('2026-10-06T00:00:00Z'),
    endedAt: new Date('2026-10-06T00:01:00Z'),
    finished: true,
    durationSec,
    outcome,
    variant: 'hook v1',
    assignment: null,
    market: 'NZ',
    industry: 'banking',
    seniority: 'director',
    company: 'Kiwibank',
    name: 'Priya Raman',
    marks,
    defects: [],
    sentiment: 'neutral',
    objections: [],
    hook: '',
    attentionLostAtSec: null,
    endedReason: null,
    meetingStatus: null,
    unreadable: [],
    answered,
    survivedOpener,
    realConversation,
    askMade,
    requested,
    confirmed: requested && over.meetingStatus === 'confirmed',
    ...over
  };
}

const marks = (hook: number, value: number, ask: number) => [
  { section: 'disclosure', atSecond: 0 },
  { section: 'reason', atSecond: 8 },
  { section: 'hook', atSecond: hook },
  { section: 'value-statement', atSecond: value },
  { section: 'ask', atSecond: ask }
];

describe('days on the operator\'s clock', () => {
  it('knows that the day daylight saving starts is 23 hours long in Sydney', () => {
    const d = dayWindow('2026-10-04');
    expect((d.to.getTime() - d.from.getTime()) / 3_600_000).toBe(23);
    expect(dayWindow('2026-10-06').from.toISOString()).toBe('2026-10-05T13:00:00.000Z');
    expect(dayContaining(new Date('2026-10-06T20:00:00Z')).date).toBe('2026-10-07');
    expect(shiftDays(dayWindow('2026-10-06'), -7).date).toBe('2026-09-29');
    expect(() => dayWindow('nonsense')).toThrow(/not a date/);
  });
});

describe('the funnel', () => {
  it('uses the same thresholds as the console', () => {
    expect([OPENER_SECONDS, CONVERSATION_SECONDS]).toEqual([CONSOLE_OPENER, CONSOLE_CONVERSATION]);
  });

  const day = [
    fact({ outcome: 'no_answer', durationSec: 0 }),
    fact({ outcome: 'voicemail', durationSec: 20 }),
    fact({ outcome: 'not_interested', durationSec: 12 }),
    fact({ outcome: 'not_interested', durationSec: 30 }),
    fact({ outcome: 'meeting_requested', durationSec: 90, meetingStatus: 'confirmed' }),
    fact({ outcome: null, durationSec: 5 }),
    fact({ outcome: null, durationSec: 50 })
  ];

  it('nests each stage in the one before, forcing the queue side to agree with the call side', () => {
    const [q, g, dialled, answered, opener, real, ask, requested, confirmed] = funnelCounts(day, 4, 3) as number[];
    expect([q, g, dialled]).toEqual([7, 7, 7]);
    expect(answered).toBe(4);
    expect(opener).toBe(3);
    expect(real).toBe(2);
    expect([ask, requested, confirmed]).toEqual([1, 1, 1]);
    expect(funnelCounts(day, 20, 12).slice(0, 3)).toEqual([20, 12, 7]);
  });

  it('shows rate, loss and the same rate over the baseline, level with itself when the baseline has nothing', () => {
    const funnel = buildFunnel({ today: day, baseline: [], queued: 7, gatePassed: 7, baselineQueued: 0, baselineGatePassed: 0 });
    expect(funnel.map((s) => s.id)).toEqual(['queued', 'gate_passed', 'dialled', 'answered', 'survived_opener', 'real_conversation', 'ask_made', 'meeting_requested', 'confirmed']);
    expect(funnel[0]).toMatchObject({ count: 7, rate: 1, loss: 0, baselineRate: 1 });
    expect(funnel[3]).toMatchObject({ count: 4, loss: 3 });
    expect(funnel[3]?.baselineRate).toBe(funnel[3]?.rate);

    const good = Array.from({ length: 10 }, () => fact({ outcome: 'not_interested', durationSec: 60 }));
    const withBaseline = buildFunnel({ today: day, baseline: good, queued: 7, gatePassed: 7, baselineQueued: 10, baselineGatePassed: 10 });
    expect(withBaseline[4]?.baselineRate).toBe(1);
    const worst = worstStageAgainstBaseline(withBaseline, 3);
    expect(worst?.stage.id).toBe('answered');
    expect(worstStageAgainstBaseline(withBaseline, 100)).toBeNull();
    expect(worstStageAgainstBaseline(buildFunnel({ today: good, baseline: good, queued: 10, gatePassed: 10, baselineQueued: 10, baselineGatePassed: 10 }))).toBeNull();
  });

  it('has the console contract\'s shape', () => {
    const stages: FunnelStageView[] = buildFunnel({ today: day, baseline: [], queued: 7, gatePassed: 7, baselineQueued: 0, baselineGatePassed: 0 });
    const curve: HangupCurveView = buildHangupCurve(day);
    expect(stages).toHaveLength(9);
    expect(curve.sections).toHaveLength(6);
  });

  it('summarises the day', () => {
    expect(todayNumbers(day, 4.5)).toEqual({ dialled: 7, connected: 4, conversations: 2, requests: 1, spendUsd: 4.5, costPerMeetingUsd: 4.5 });
    expect(todayNumbers([], 0).costPerMeetingUsd).toBeNull();
    expect(costPerMeeting(10, 0)).toBeNull();
    expect(outcomeCounts(day)).toMatchObject({ no_answer: 1, no_outcome_marked: 2, not_interested: 2 });
  });
});

describe('seconds to hang-up, by script section', () => {
  const calls = [
    fact({ durationSec: 12, marks: marks(18, 38, 58) }), // ends in reason
    fact({ durationSec: 25, marks: marks(18, 38, 58) }), // ends in hook
    fact({ durationSec: 27, marks: marks(18, 38, 58) }), // ends in hook
    fact({ durationSec: 45, marks: marks(18, 38, 58) }), // ends in value
    fact({ durationSec: 90, marks: marks(18, 38, 58), outcome: 'meeting_requested' }), // ends in ask, a win
    fact({ durationSec: 70, marks: marks(18, 38, 58) }), // ends in ask, lost
    fact({ durationSec: 40 }), // no timings
    fact({ outcome: 'voicemail', durationSec: 30 }) // not answered: not counted
  ];

  it('counts where each call ended, how many reached each section, and the chance of ending there', () => {
    const report = sectionHangups(calls);
    const by = Object.fromEntries(report.stages.map((s) => [s.stage, s]));
    expect(report.attributed).toBe(6);
    expect(report.unattributed).toBe(1);
    expect(by.reason).toMatchObject({ reached: 6, endedHere: 1 });
    expect(by.hook).toMatchObject({ reached: 5, endedHere: 2, lostHere: 2 });
    expect(by.hook?.hazard).toBeCloseTo(0.4, 5);
    expect(by.ask).toMatchObject({ reached: 2, endedHere: 2, lostHere: 1 });
    expect(by.close).toMatchObject({ reached: 0, endedHere: 0, hazard: 0 });
    expect(leakiestSection(report, 3)?.stage).toBe('hook');
    expect(leakiestSection(report, 50)).toBeNull();
  });

  it('draws the curve over answered, finished calls, with sections placed where they were measured', () => {
    const curve = buildHangupCurve([...calls, fact({ finished: false, durationSec: 5 })]);
    expect(curve.binSeconds).toBe(5);
    expect(curve.bins.reduce((n, b) => n + b.count, 0)).toBe(7);
    expect(curve.bins.find((b) => b.fromSecond === 25)?.callIds).toHaveLength(2);
    const hook = curve.sections.find((s) => s.id === 'hook');
    expect(hook).toMatchObject({ fromSecond: 18, toSecond: 38 });
    // Past the end of the chart goes in the last bin.
    expect(buildHangupCurve([fact({ durationSec: 5000 })]).bins.at(-1)?.count).toBe(1);
    // With nothing measured, typical timings are used and stay in order.
    const defaults = buildHangupCurve([]).sections.map((s) => s.fromSecond);
    expect(defaults).toEqual([...defaults].sort((a, b) => a - b));
  });

  it('speaks the console\'s vocabulary', () => {
    expect(stageOfSection('value-statement')).toBe('value');
    expect(stageOfSection('value')).toBe('value');
    expect(stageOfSection('nonsense')).toBeNull();
    expect(median([])).toBeNull();
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('objections, gatekeepers, wrong numbers, variants', () => {
  const o = (saidAs: string) => ({ kind: classifyObjection(saidAs), saidAs, handledAs: 'listened' });

  it('classifies what was said the way the console does', () => {
    expect(classifyObjection('We already have a partner for this')).toBe('has-a-partner');
    expect(classifyObjection('just send me an email')).toBe('send-email');
    expect(classifyObjection('how much does it cost, what are your rates')).toBe('wants-pricing');
    expect(classifyObjection('are you a real person?')).toBe('asked-if-human');
    expect(classifyObjection('where did you get my number')).toBe('asked-where-number-came-from');
    expect(classifyObjection("I'm in a meeting")).toBe('no-time-now');
    expect(classifyObjection('hmm')).toBe('other');
  });

  it('ranks objections and says how often they ended badly', () => {
    const facts = [
      fact({ objections: [o('we have a partner')], outcome: 'not_interested' }),
      fact({ objections: [o('we have a partner'), o('no budget')], outcome: 'meeting_requested' }),
      fact({ objections: [o('already got a partner')], outcome: null }),
      fact({ objections: [o('no time, busy')], outcome: 'voicemail', durationSec: 0 })
    ];
    expect(rankObjections(facts)[0]).toEqual({ label: 'Already has a partner', count: 3 });
    const stats = objectionStats(facts);
    expect(stats[0]).toMatchObject({ kind: 'has-a-partner', calls: 3, badOutcomes: 2 });
    expect(stats[0]?.badRate).toBeCloseTo(0.6667, 3);
    expect(stats.find((s) => s.kind === 'no-time-now')).toBeUndefined();
  });

  it('finds gatekeepers by account and the wrong-number rate', () => {
    const facts = [
      fact({ company: 'Kiwibank', outcome: 'gatekeeper_blocked' }),
      fact({ company: 'Kiwibank', outcome: 'gatekeeper_blocked' }),
      fact({ company: 'Kiwibank' }),
      fact({ company: 'TSB', outcome: 'gatekeeper_blocked' }),
      fact({ company: 'ASB', outcome: 'wrong_person' }),
      fact({ company: 'ASB', outcome: 'invalid_number', durationSec: 0 }),
      fact({ company: 'BNZ', finished: false })
    ];
    expect(gatekeeperByAccount(facts)).toEqual([
      { company: 'Kiwibank', blocks: 2, calls: 3 },
      { company: 'TSB', blocks: 1, calls: 1 }
    ]);
    expect(gatekeeperByAccount(facts, 1)).toHaveLength(1);
    expect(wrongNumberRate(facts)).toBeCloseTo(0.3333, 3);
    expect(wrongNumberRate([])).toBe(0);
  });

  it('tracks each version of a slot separately by market, industry and seniority', () => {
    const run = (version: number, over: Partial<CallFact>) =>
      fact({ assignment: { arm: 'champion', slot: 'hook', versions: { hook: version }, variant: `hook v${version}` }, ...over });
    const facts = [
      run(1, { market: 'NZ', outcome: 'meeting_requested' }),
      run(1, { market: 'NZ' }),
      run(1, { market: 'AU', industry: 'insurance', seniority: 'c_suite' }),
      run(2, { market: 'AU', outcome: 'meeting_requested' }),
      fact({ assignment: { arm: 'champion', slot: 'hook', versions: {}, variant: null } }),
      fact({ assignment: null, variant: 'hook v2' }),
      fact({ assignment: null, variant: 'unversioned' }),
      fact({ outcome: 'no_answer', durationSec: 0 })
    ];
    const rows = variantPerformance(facts, 'hook');
    const row = (version: number | null, dimension: string, value: string) => rows.find((r) => r.version === version && r.dimension === dimension && r.value === value);
    expect(row(1, 'all', 'all')).toMatchObject({ eligible: 3, requests: 1 });
    expect(row(1, 'market', 'NZ')).toMatchObject({ eligible: 2, requests: 1, requestRate: 0.5 });
    expect(row(1, 'market', 'AU')).toMatchObject({ eligible: 1, requests: 0 });
    expect(row(1, 'seniority', 'c_suite')?.eligible).toBe(1);
    expect(row(2, 'all', 'all')?.eligible).toBe(2); // one by assignment, one by the console's variant name
    expect(row(null, 'all', 'all')?.eligible).toBe(1);
    expect(variantPerformance(facts, 'transition').find((r) => r.version === 2)).toBeUndefined();
  });
});

describe('defects, and the audit\'s known behaviour on the frozen opening', () => {
  const OPENING = ['I work with Vinay Kumar, Sales Director at Hexaware Technologies, on the ANZ sales team.', "I'm calling because we do a lot of data and engineering work with banks in New Zealand."];
  const flag = (quote: string, why = 'not on the approved list') => ({ kind: 'unsupported-claim', detail: `"${quote}" — ${why} (a model's reading, not certain)` });

  it('recognises a quote of an opening line, whole, partial or inside a longer quote', () => {
    expect(quoteOf('"I work with Vinay" — not on the list')).toBe('I work with Vinay');
    expect(quoteOf('no quotes here')).toBe('no quotes here');
    expect(isOpeningLine(OPENING[0] as string, OPENING)).toBe(true);
    expect(isOpeningLine('I work with Vinay Kumar, Sales Director at Hexaware Technologies', OPENING)).toBe(true);
    expect(isOpeningLine(`Hi, my name's Lexi. ${OPENING[0]} ${OPENING[1]}`, OPENING)).toBe(true);
    expect(isOpeningLine('We have helped twelve banks move to the cloud', OPENING)).toBe(false);
    expect(isOpeningLine('Hi', OPENING)).toBe(false);
  });

  it('shows the audit\'s count as reported and the count without the opening\'s own lines', () => {
    const facts = [
      fact({ defects: [flag(OPENING[0] as string), flag(OPENING[1] as string), flag('We have helped twelve banks move to the cloud')] }),
      fact({ defects: [flag(OPENING[0] as string), { kind: 'summary-unavailable', detail: 'no summariser' }] }),
      fact()
    ];
    const s = summariseDefects(facts, OPENING);
    expect(s).toMatchObject({ calls: 3, callsWithDefects: 2, total: 5 });
    expect(s.byKind).toEqual({ 'unsupported-claim': 4, 'summary-unavailable': 1 });
    expect(s.unsupportedClaims).toMatchObject({ total: 4, openingLineFlags: 3, other: 1 });
    expect(s.unsupportedClaims.examples[0]).toMatchObject({ quote: 'We have helped twelve banks move to the cloud', openingLine: false });
    // With no opening text to compare against, everything is counted.
    expect(summariseDefects(facts, []).unsupportedClaims.other).toBe(4);
  });

  it('feeds the kill switch the net figure, which does not trip on the opening\'s lines', () => {
    const facts = Array.from({ length: 4 }, () => fact({ defects: [flag(OPENING[0] as string), flag(OPENING[1] as string)] }));
    const metric = defectRateMetric(facts, OPENING);
    expect(metric).toMatchObject({ calls: 4, callsWithDefects: 4, defectRate: 1, claimDefectsRaw: 8, claimDefectsNet: 0 });

    const window = { from: new Date('2026-10-05T13:00:00Z'), to: new Date('2026-10-06T13:00:00Z') };
    const signals = safetySignalsFromFacts(facts, 0, window, OPENING);
    expect(signals).toMatchObject({ callsToday: 4, claimDefectsToday: 0, claimDefectsRaw: 8, defectRate: 1 });
    // It is a SafetySignals as far as the kill switch is concerned.
    expect(evaluateAutoTrip(signals, policy()).trip).toBe(false);
    // The raw figure would have tripped the five-a-day threshold on the second call.
    expect(evaluateAutoTrip({ ...signals, claimDefectsToday: signals.claimDefectsRaw }, policy()).source).toBe('claim-defect-threshold');
  });

  it('reads errors and sentiment into the signals', () => {
    const facts = [
      fact({ endedReason: 'assistant-error', sentiment: 'negative' }),
      fact({ endedReason: 'customer-ended-call', sentiment: 'positive' }),
      fact({ sentiment: 'unknown' }),
      fact({ endedReason: 'pipeline-error-timeout', sentiment: 'negative' })
    ];
    const s = safetySignalsFromFacts(facts, 2, { from: new Date(0), to: new Date(1) });
    expect(s.errorRate).toBe(0.5);
    expect(s.negativeSentimentRate).toBeCloseTo(0.6667, 3);
    expect(s.escalationsToday).toBe(2);
  });
});

describe('reading the blackboard', () => {
  let db: Blackboard;
  beforeEach(async () => {
    db = await createTestBlackboard();
  });
  afterEach(async () => {
    await db.$disconnect();
  });

  it('loads calls as facts with their sections, defects, objections, market and flags', async () => {
    const nz = await world(db, { phone: '+6449999999' });
    const au = await world(db, { country: 'NZ', phone: '+61290000000' });
    const at = new Date('2026-10-06T01:00:00Z');
    await addCall(db, nz, {
      at,
      durationSec: 80,
      outcome: 'meeting_requested',
      marks: [{ section: 'hook', atSecond: 15 }, { section: 'ask', atSecond: 60 }],
      defects: [{ kind: 'banned-topic', detail: 'x', atSecond: 40 }],
      sentiment: 'positive',
      hook: 'the core rebuild',
      objections: [{ saidAs: 'we have a partner', handledAs: 'acknowledged' }],
      attentionLostAtSec: 50,
      endedReason: 'customer-ended-call'
    });
    await addCall(db, au, { at: new Date(at.getTime() + 1000), durationSec: 5, outcome: null });
    await db.call.update({ where: { id: (await db.call.findFirstOrThrow({ where: { contactId: nz.contactId } })).id }, data: { playbookVersion: 'hook v2' } });

    const facts = await loadCallFacts(db, { from: new Date('2026-10-06T00:00:00Z'), to: new Date('2026-10-07T00:00:00Z') });
    expect(facts).toHaveLength(2);
    const [first, second] = facts as [CallFact, CallFact];
    expect(first).toMatchObject({ market: 'NZ', variant: 'hook v2', sentiment: 'positive', hook: 'the core rebuild', requested: true, askMade: true, attentionLostAtSec: 50 });
    expect(first.marks).toEqual([{ section: 'hook', atSecond: 15 }, { section: 'ask', atSecond: 60 }]);
    expect(first.defects).toEqual([{ kind: 'banned-topic', detail: 'x', atSecond: 40 }]);
    expect(first.objections[0]?.kind).toBe('has-a-partner');
    // The market follows the number, not the employer.
    expect(second).toMatchObject({ market: 'AU', answered: false, variant: 'unversioned' });
    expect(await loadCallFacts(db, { from: new Date('2027-01-01'), to: new Date('2027-01-02') })).toEqual([]);
  });

  it('flags a column it cannot read instead of reading it as clean', async () => {
    const w = await world(db);
    const id = await addCall(db, w, { at: new Date('2026-10-06T01:00:00Z') });
    await db.call.update({ where: { id }, data: { defects: '{broken', sectionMarks: '[{"section":"nope"}]', outcome: 'mystery' } });
    const [fact1] = await loadCallFacts(db, { from: new Date('2026-10-06T00:00:00Z'), to: new Date('2026-10-07T00:00:00Z') });
    expect(fact1?.unreadable.sort()).toEqual(['Call.defects', 'Call.outcome', 'Call.sectionMarks']);
    expect(fact1?.outcome).toBeNull();
  });

  it('sums spend by category over a window', async () => {
    const at = new Date('2026-10-06T01:00:00Z');
    await db.spendRecord.createMany({
      data: [
        { id: 's1', at, category: 'llm', usd: 1.25 },
        { id: 's2', at, category: 'llm', usd: 0.5 },
        { id: 's3', at, category: 'voice', usd: 2 },
        { id: 's4', at: new Date('2026-09-01T00:00:00Z'), category: 'apollo', usd: 9 }
      ]
    });
    const spend = await loadSpend(db, { from: new Date('2026-10-06T00:00:00Z'), to: new Date('2026-10-07T00:00:00Z') });
    expect(spend).toEqual({ totalUsd: 3.75, byCategory: { llm: 1.75, voice: 2 } });
    expect((await loadSpend(db, { from: new Date('2027-01-01'), to: new Date('2027-01-02') })).totalUsd).toBe(0);
  });

  it('counts who was queued and who passed the gate, and why the gate refused', async () => {
    const w = await world(db);
    const at = new Date('2026-10-06T01:00:00Z');
    const plan = await db.callPlan.create({ data: { id: 'plan-1', campaignId: w.campaignId, planDate: '2026-10-06', status: 'approved' } });
    await db.callPlanEntry.create({ data: { id: 'e1', planId: plan.id, contactId: w.contactId, accountId: w.accountId, position: 0, e164: '+6444960000', displayName: 'P', title: 'T', accountName: 'A', gateAllowed: true } });
    const decision = (id: string, subject: string, allowed: boolean, codes: string[]) => ({
      id,
      at,
      kind: 'dial-decision',
      actor: 'orchestrator',
      subject,
      summary: 's',
      data: JSON.stringify({ decision: { allowed, reasons: codes.map((code) => ({ code })) } })
    });
    await db.auditRecord.createMany({
      data: [
        decision('a1', w.contactId, true, []),
        decision('a2', 'other-1', false, ['DAY_PLAN_NOT_APPROVED', 'OUTSIDE_POLICY_WINDOW']),
        decision('a3', 'other-2', false, ['DAY_PLAN_NOT_APPROVED']),
        { ...decision('a4', 'other-3', true, []), data: 'not json' }
      ]
    });
    const range = { from: new Date('2026-10-06T00:00:00Z'), to: new Date('2026-10-07T00:00:00Z') };
    expect(await loadQueueCounts(db, range)).toEqual({ queued: 4, gatePassed: 1 });
    expect(await loadGateRejections(db, range)).toEqual([
      { reason: 'DAY_PLAN_NOT_APPROVED', count: 2 },
      { reason: 'OUTSIDE_POLICY_WINDOW', count: 1 }
    ]);
  });

  it('reads today\'s kill-switch inputs, and says so when it cannot reach the blackboard', async () => {
    const w = await world(db);
    await addCall(db, w, { at: new Date('2026-10-06T01:00:00Z'), sentiment: 'negative', endedReason: 'error' });
    await db.escalation.create({ data: { id: 'esc', level: 'human', reason: 'hostility', status: 'open', createdAt: new Date('2026-10-06T02:00:00Z') } });
    const signals = await loadSafetySignals(db, new Date('2026-10-06T05:00:00Z'), []);
    expect(signals).toMatchObject({ callsToday: 1, escalationsToday: 1, errorRate: 1, negativeSentimentRate: 1, blackboardReachable: true });

    const broken = { call: { findMany: async () => Promise.reject(new Error('gone')) } } as unknown as Blackboard;
    expect(await loadSafetySignals(broken, new Date())).toMatchObject({ blackboardReachable: false, callsToday: 0 });
  });
});
