import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnalyst, deliverDigest } from '../../src/agents/analyst/agent.js';
import { digestSchema, type DailyDigest } from '../../src/agents/analyst/contract.js';
import { OPENING_AUDIT_CALLOUT } from '../../src/agents/analyst/digest.js';
import { analystTools } from '../../src/agents/analyst/tools.js';
import { loadIdentityFromObject } from '../../src/agents/caller/identity.js';
import { buildOpening } from '../../src/agents/caller/opening.js';
import { MemoryMailer, ProspectMailBlockedError } from '../../src/agents/concierge/ports.js';
import { InMemoryJournal } from '../../src/agents/journal.js';
import { runAgent } from '../../src/agents/runner.js';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { InMemoryKillSwitchStore } from '../../src/compliance/kill-switch.js';
import { PlaybookStore } from '../../src/playbook/store.js';
import { briefingSchema } from '../../src/stream/contract.js';
import { addArm, addCall, coachConfig, passed, world, type World } from '../playbook/support.js';

const identity = loadIdentityFromObject({
  agent: { name: 'Lexi', gender: 'female', accent: 'au-neutral' },
  operator: { name: 'Vinay Kumar', title: 'Sales Director', company: 'Hexaware Technologies', team: 'the ANZ sales team', email: 'vinay@example.com' },
  callback: { number: '+61280000000' }
});

/** Tuesday 6 October 2026 in Sydney is 05 Oct 13:00Z to 06 Oct 13:00Z. */
const DAY = '2026-10-06';
const at = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 9, 6, hour, minute));
const GENERATED = '2026-10-06T20:00:00.000Z'; // 07:00 on the 7th in Sydney

const REASON = 'I wanted to ask you one question about how your data platform is set up.';
const OPENING_LINE = buildOpening({ identity, reason: REASON }).find((s) => s.id === 'affiliation')?.text ?? '';
const flag = (quote: string) => ({ kind: 'unsupported-claim', detail: `"${quote}" — not on the approved list (a model's reading, not certain)` });

let db: Blackboard;
let w: World;
let store: PlaybookStore;
const killSwitch = new InMemoryKillSwitchStore();

beforeEach(async () => {
  db = await createTestBlackboard();
  w = await world(db);
  store = new PlaybookStore(db, () => new Date('2026-10-01T00:00:00Z'));
  await store.ensureBaseline();
  await db.dossier.create({
    data: { id: 'd1', contactId: w.contactId, hypothesis: REASON, confidence: 'high', person: '{}', account: '{}', hooks: '[]', landmines: '[]', unverified: '[]', sources: '[]' }
  });
});
afterEach(async () => {
  await db.$disconnect();
});

const marks = [
  { section: 'disclosure', atSecond: 0 },
  { section: 'reason', atSecond: 8 },
  { section: 'hook', atSecond: 18 },
  { section: 'value-statement', atSecond: 38 },
  { section: 'ask', atSecond: 58 }
];

async function seedDay(): Promise<void> {
  // Yesterday: ten dials. Two meeting requests, one of which waits on Vinay.
  const openingFlags = [flag(OPENING_LINE), flag("I'm calling because we do a lot of data and engineering work with banks in New Zealand.")];
  await addCall(db, w, { at: at(0, 5), durationSec: 0, outcome: 'no_answer' });
  await addCall(db, w, { at: at(0, 15), durationSec: 20, outcome: 'voicemail' });
  await addCall(db, w, { at: at(0, 25), durationSec: 12, outcome: 'not_interested', marks, defects: openingFlags });
  await addCall(db, w, { at: at(0, 35), durationSec: 27, outcome: 'not_interested', marks, defects: openingFlags, objections: [{ saidAs: 'we already have a partner', handledAs: 'acknowledged' }] });
  await addCall(db, w, { at: at(0, 45), durationSec: 25, outcome: 'not_interested', marks, defects: [...openingFlags, flag('We have helped twelve banks move to the cloud')] });
  await addCall(db, w, { at: at(1, 5), durationSec: 90, outcome: 'meeting_requested', marks, hook: 'the core rebuild', defects: openingFlags });
  const second = await addCall(db, w, { at: at(1, 15), durationSec: 100, outcome: 'meeting_requested', marks, defects: openingFlags });
  await addCall(db, w, { at: at(1, 25), durationSec: 5, outcome: 'gatekeeper_blocked' });
  await addCall(db, w, { at: at(1, 35), durationSec: 8, outcome: 'wrong_person' });
  await addCall(db, w, { at: at(1, 45), durationSec: 70, outcome: null, marks });

  await db.meetingRequest.create({ data: { id: '3f2a9c10-0000-4000-8000-000000000000', callId: second, contactId: w.contactId, status: 'requested', createdAt: at(2) } });
  const first = await db.call.findFirstOrThrow({ where: { outcome: 'meeting_requested', NOT: { id: second } } });
  await db.meetingRequest.create({ data: { id: '9a000000-0000-4000-8000-000000000000', callId: first.id, contactId: w.contactId, status: 'confirmed', createdAt: at(2), decidedAt: at(3) } });

  // The week before: a steady 20 dials a day.
  await addArm(db, w, store, { assignment: { arm: 'champion', slot: 'hook', versions: { hook: 1 }, variant: 'hook v1' }, n: 20, requests: 2, at: new Date('2026-10-02T00:00:00Z') });

  await db.spendRecord.createMany({
    data: [
      { id: 'sp1', at: at(1), category: 'llm', usd: 1.5 },
      { id: 'sp2', at: at(2), category: 'voice', usd: 2.5 },
      { id: 'sp3', at: new Date('2026-10-03T00:00:00Z'), category: 'apollo', usd: 4 }
    ]
  });
  await db.escalation.create({ data: { id: 'esc-1', level: 'human', reason: 'a legal threat from a prospect', status: 'open', createdAt: at(3) } });
  const plan = await db.callPlan.create({ data: { id: 'plan-today', campaignId: w.campaignId, planDate: '2026-10-07', status: 'pending_approval' } });
  await db.callPlanEntry.create({
    data: { id: 'pe1', planId: plan.id, contactId: w.contactId, accountId: w.accountId, position: 0, e164: '+6444960000', displayName: 'Priya Raman', title: 'Head of Data', accountName: 'Kiwibank', gateAllowed: true }
  });
}

async function digest(): Promise<DailyDigest> {
  const analyst = createAnalyst({
    tools: analystTools({ db, store, config: coachConfig(), identity, killSwitch })
  });
  const outcome = await runAgent(analyst, { day: DAY, generatedAt: GENERATED }, { taskId: 'digest', journal: new InMemoryJournal() });
  expect(outcome.status).toBe('succeeded');
  if (outcome.status !== 'succeeded') throw new Error('digest failed');
  expect(outcome.spend.usd).toBe(0);
  return outcome.output;
}

describe('the daily digest', () => {
  it('says what happened, where people dropped, what it cost, and what needs Vinay', async () => {
    await seedDay();
    const d = await digest();

    expect(d.subject).toBe('[DAILY DIGEST] Tue 6 Oct — 2 meeting requests, US$4.00');
    expect(d.headline).toContain('10 dials, 2 meeting requests, US$4.00 spent');
    expect(d.headline).toContain('2 things need you');
    expect(d.sections.map((s) => s.title)).toEqual(['Tuesday 6 October', 'Where people dropped', 'Money', 'Defects', 'The script', 'Needs you', "Today's queue"]);

    const f = d.figures;
    expect(f.today).toMatchObject({ dialled: 10, requests: 2, spendUsd: 4, costPerMeetingUsd: 2 });
    expect(f.funnel).toHaveLength(9);
    expect(f.sectionHangups.attributed).toBeGreaterThan(0);
    expect(f.objections[0]).toEqual({ label: 'Already has a partner', count: 1 });
    expect(f.gatekeepers).toEqual([{ company: 'Kiwibank', blocks: 1, calls: 10 }]);
    expect(f.wrongNumberRate).toBe(0.1);

    const day = d.sections[0]?.body ?? '';
    expect(day).toContain('dialled 10 numbers');
    expect(day).toContain('1 of those has been confirmed');
    const money = d.sections[2]?.body ?? '';
    expect(money).toContain('US$4.00 was spent on the day');
    expect(money).toContain('llm US$1.50');
    expect(money).toContain('US$8.00 in the last seven days against a ceiling of US$25.00');
    expect(money).toContain('Cost per meeting request is US$2.00 over the last seven days');
    expect(f.spend.costPerMeetingSevenDaysUsd).toBe(2); // four requests in the seven days, two of them yesterday

    const needs = d.sections[5]?.body ?? '';
    expect(needs).toContain('Priya Raman at Kiwibank (MR-3F2A9C10)');
    expect(needs).toContain('a legal threat from a prospect');
    expect(d.sections[3]?.body).toContain(OPENING_AUDIT_CALLOUT);

    const queue = d.sections[6]?.body ?? '';
    expect(queue).toContain('waiting for your approval');
    expect(queue).toContain('Nothing will be dialled until you approve it');
    expect(d.sections[4]?.body).toContain('Current champions: hook v1');
    expect(d.sections[4]?.body).toContain('No test is running');
  });

  it('shows the audit\'s unsupported-claim count both ways, and calls out why they differ', async () => {
    await seedDay();
    const d = await digest();
    const u = d.figures.defects.unsupportedClaims;
    // Five calls, each flagged on both of the frozen opening's mandated lines, and one genuine unsupported claim.
    expect(u.openingLineFlags).toBe(10);
    expect(u.other).toBe(1);
    expect(u.total).toBe(11);
    const defects = d.sections[3]?.body ?? '';
    expect(defects).toContain('Unsupported claims as the audit reports them: 11.');
    expect(defects).toContain("frozen opening's own lines taken out: 1.");
    expect(defects).toContain('To read: "We have helped twelve banks move to the cloud" (Kiwibank).');
    expect(defects).toContain('the decision was to leave the audit as it is');
    expect(d.figures.safety).toMatchObject({ claimDefectsRaw: 11, claimDefectsToday: 1, escalationsToday: 1 });
  });

  it('is shaped as the console\'s briefing, validates against its own contract, and reads in whole sentences', async () => {
    await seedDay();
    const d = await digest();
    expect(digestSchema.safeParse(d).success).toBe(true);
    expect(briefingSchema.safeParse({ generatedAt: d.generatedAt, headline: d.headline, sections: d.sections }).success).toBe(true);
    expect(d.text.startsWith(d.headline)).toBe(true);
    expect(d.text).toContain("Today's queue\n-------------");
  });

  it('says so plainly when nothing happened, instead of padding', async () => {
    const d = await digest();
    expect(d.headline).toContain('No calls on Tue 6 Oct');
    expect(d.headline).toContain('Nothing needs you');
    expect(d.sections[0]?.body).toBe('No calls were placed on Tuesday 6 October.');
    expect(d.sections[1]?.body).toContain('nothing to compare');
    expect(d.sections[2]?.body).toContain('no meeting requests to divide by');
    expect(d.sections[3]?.body).toContain('No calls, so no defects to report');
    expect(d.sections[6]?.body).toContain('No plan has been drawn up for today');
  });

  it('reports a halted system, a test in progress and what changed in the script', async () => {
    await seedDay();
    await killSwitch.write({ active: true, reason: 'three escalations in a day' });
    const now = new Date('2026-10-06T10:00:00Z');
    const s = new PlaybookStore(db, () => now);
    await s.startChallenger(await passed({ slot: 'hook', template: 'I was looking at {{company}} and noticed this: {{hook}}.' }), { rationale: 'Trying a plainer hook.' });
    await addArm(db, w, s, { assignment: { arm: 'challenger', slot: 'hook', versions: { hook: 2 }, variant: 'hook v2' }, n: 4, requests: 2, at: new Date('2026-10-06T11:00:00Z') });

    const analyst = createAnalyst({ tools: analystTools({ db, store: s, config: coachConfig(), identity, killSwitch }) });
    const outcome = await runAgent(analyst, { day: DAY, generatedAt: GENERATED }, { taskId: 'digest', journal: new InMemoryJournal() });
    if (outcome.status !== 'succeeded') throw new Error('digest failed');
    const d = outcome.output;
    expect(d.headline).toContain('Dialling is halted');
    expect(d.sections[6]?.body).toContain('Dialling is halted: three escalations in a day');
    expect(d.sections[4]?.body).toContain('Trying a plainer hook.');
    expect(d.sections[4]?.body).toContain('A test is running on the hook: version 2');
    expect(d.figures.playbook.test).toMatchObject({ slot: 'hook', version: 2, challengerCompleted: 4, minimum: 30 });
    await killSwitch.write({ active: false });
  });
});

describe('delivering the digest', () => {
  it('goes to the operator and to no one else', async () => {
    await seedDay();
    const d = await digest();
    const mailer = new MemoryMailer();
    await deliverDigest(mailer, 'vinay@example.com', d);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: 'vinay@example.com', subject: d.subject, body: d.text, attachments: [] });
  });

  it('sends nothing when there is no operator address, rather than something to someone', async () => {
    const d = await digest();
    const mailer = new MemoryMailer();
    await expect(deliverDigest(mailer, '', d)).rejects.toThrow(ProspectMailBlockedError);
    expect(mailer.sent).toEqual([]);
  });

  it('fails closed on a tool that returns something off-contract', async () => {
    const tools = analystTools({ db, store, config: coachConfig(), identity });
    const broken = tools.map((t) => (t.name === 'read-needs-you' ? { ...t, handler: async () => ({ openMeetingRequests: 'none' }) } : t));
    // The agent builds a digest from whatever the tool returned; the contract is what stops a bad one.
    const outcome = await runAgent(createAnalyst({ tools: broken }), { day: DAY, generatedAt: GENERATED }, { taskId: 'digest', journal: new InMemoryJournal() });
    expect(outcome.status).toBe('escalated');
  });

  it('cannot reach a tool it was not given, or be given a bad day', async () => {
    const outcome = await runAgent(createAnalyst({ tools: [] }), { day: DAY, generatedAt: GENERATED }, { taskId: 'digest', journal: new InMemoryJournal() });
    expect(outcome.status === 'escalated' && outcome.failure.kind).toBe('tool-contract');
    const badInput = await runAgent(createAnalyst({ tools: [] }), { day: 'yesterday', generatedAt: GENERATED }, { taskId: 'digest', journal: new InMemoryJournal() });
    expect(badInput.status === 'escalated' && badInput.failure.kind).toBe('input-contract');
  });
});
