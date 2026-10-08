/**
 * The console backend end to end: the snapshot built from a real blackboard, and
 * the routes that serve and change it.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { applyOperatorReply } from '../../src/agents/concierge/apply-reply.js';
import { refFor } from '../../src/agents/concierge/ref.js';
import { CallPlanRepository } from '../../src/blackboard/call-plans.js';
import { consoleSnapshotSchema, meetingRequestSchema, callDetailSchema, callLogEntrySchema, traceEntrySchema } from '../../src/stream/contract.js';
import type { ConsoleEvent } from '../../src/stream/contract.js';
import { DbLiveCallSource } from '../../src/stream/live-source.js';
import { buildSnapshot } from '../../src/stream/snapshot.js';
import { buildServer } from '../../src/web/server.js';
import { addCall, addContact, addMeetingRequest, at, bearer, closeWorlds, NOW, world, type World } from './helpers.js';

const TOKEN = 'console-test-token-0123456789';
const servers: FastifyInstance[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  await closeWorlds();
});

function serve(w: World): FastifyInstance {
  const app = buildServer({ db: w.db, adminToken: TOKEN, console: { deps: w.deps, webDir: false, refreshMs: 50 } });
  servers.push(app);
  return app;
}

const json = { 'content-type': 'application/json' };
const post = (app: FastifyInstance, url: string, body: unknown, token = TOKEN) =>
  app.inject({ method: 'POST', url, headers: { ...bearer(token), ...json }, payload: body as object });
const get = (app: FastifyInstance, url: string, token = TOKEN) => app.inject({ method: 'GET', url, headers: bearer(token) });

const WINDOWS = [
  { saidAs: 'Tuesday morning', startsAt: '2026-10-13T09:00:00+13:00', endsAt: '2026-10-13T12:00:00+13:00' },
  { saidAs: 'after 3pm Thursday', startsAt: '2026-10-15T15:00:00+13:00', endsAt: '2026-10-15T17:00:00+13:00' }
];

async function requestFor(w: World, id: string, first = 'Priya', status: 'requested' | 'confirmed' = 'requested') {
  const contactId = await addContact(w, { first, last: 'Raman' });
  await w.db.contactEmail.create({ data: { id: randomUUID(), contactId, address: `${first.toLowerCase()}@kiwibank.example`, kind: 'confirmed_on_call', verified: true } });
  const { callId } = await addCall(w, {
    contactId, startedAt: at(0, 10), duration: 90, outcome: 'meeting_requested', hook: 'the platform rebuild',
    summary: ['She is mid-way through a rebuild.', 'She was open to twenty minutes.'], windows: WINDOWS, timezone: 'Pacific/Auckland', attendees: ['her head of architecture'],
    objections: [{ kind: 'no-time-now', saidAs: 'We are mid-way through it, honestly.', handledAs: 'Offered twenty minutes later.' }]
  });
  await addMeetingRequest(w, callId, contactId, status, id);
  return { contactId, callId, ref: refFor(id) };
}

describe('the snapshot', () => {
  it('is valid, says it is live, and is honest when the room is empty', async () => {
    const w = await world();
    const s = await buildSnapshot(w.deps);
    expect(consoleSnapshotSchema.safeParse(s).success).toBe(true);
    expect(s.mode).toBe('live');
    expect(s.live).toBeNull();
    expect(s.standingBy.next).toBeNull();
    expect(s.standingBy.note).toMatch(/nobody is queued/i);
    expect(s.playbook.champion.version).toBe('built-in script');
    expect(s.playbook.challenger).toBeNull();
    expect(s.funnel).toHaveLength(9);
    expect(s.hangupCurve.sections.map((x) => x.id)).toEqual(['disclosure', 'reason', 'hook', 'value', 'ask', 'close']);
  });

  it('builds the funnel from calls, with absolute loss and the seven-day baseline', async () => {
    const w = await world();
    // Today (Sydney): eight dials.
    const today: Array<[number, string | null, Array<[string, number]>?]> = [
      [25, 'no_answer'], [30, 'voicemail'], [8, 'not_interested'], [20, 'not_interested'],
      [55, 'not_interested', [['ask', 48]]], [70, 'callback_requested'], [90, 'meeting_requested', [['ask', 60]]], [100, 'meeting_requested', [['ask', 62]]]
    ];
    const made: string[] = [];
    for (const [i, [duration, outcome, marks]] of today.entries()) {
      const { callId, contactId } = await addCall(w, { startedAt: at(0, 9, 30 + i * 5), duration, outcome, ...(marks ? { marks } : {}) });
      made.push(callId);
      if (i === 7) await addMeetingRequest(w, callId, contactId, 'confirmed');
      if (i === 6) await addMeetingRequest(w, callId, contactId, 'requested');
    }
    // Yesterday: the baseline.
    for (const [i, [duration, outcome, marks]] of ([[25, 'no_answer'], [10, 'not_interested'], [60, 'not_interested', [['ask', 50]]], [95, 'meeting_requested', [['ask', 60]]]] as const).entries()) {
      const { callId, contactId } = await addCall(w, { startedAt: at(1, 11, i * 5), duration, outcome, ...(marks ? { marks: marks as unknown as Array<[string, number]> } : {}) });
      if (i === 3) await addMeetingRequest(w, callId, contactId, 'confirmed');
    }

    const s = await buildSnapshot(w.deps);
    const counts = Object.fromEntries(s.funnel.map((f) => [f.id, f.count]));
    expect(counts).toEqual({ queued: 8, gate_passed: 8, dialled: 8, answered: 6, survived_opener: 5, real_conversation: 4, ask_made: 4, meeting_requested: 2, confirmed: 1 });
    const stage = Object.fromEntries(s.funnel.map((f) => [f.id, f]));
    expect(stage.answered).toMatchObject({ rate: 0.75, loss: 2, baselineRate: 0.75 });
    expect(stage.survived_opener).toMatchObject({ rate: 0.8333, loss: 1, baselineRate: 0.6667 });
    expect(stage.meeting_requested).toMatchObject({ rate: 0.5, loss: 2, baselineRate: 0.5 });
    expect(stage.confirmed).toMatchObject({ rate: 0.5, loss: 1, baselineRate: 1 });

    expect(s.today).toMatchObject({ dialled: 8, connected: 6, conversations: 4, requests: 2 });
    // The curve covers every answered, finished call across the window, and each bin names its calls.
    const inCurve = s.hangupCurve.bins.flatMap((b) => b.callIds);
    expect(inCurve).toContain(made[2]);
    expect(inCurve).not.toContain(made[0]);
    expect(s.hangupCurve.bins.reduce((n, b) => n + b.count, 0)).toBe(inCurve.length);
  });

  it('counts objections, gatekeeper blocks and wrong numbers from what Scribe recorded', async () => {
    const w = await world();
    await addCall(w, { startedAt: at(0, 9, 40), duration: 60, outcome: 'not_interested', hook: '', objections: [{ saidAs: 'We already have a partner.' }, { kind: 'no-budget', saidAs: 'No money.' }] });
    await addCall(w, { startedAt: at(0, 9, 50), duration: 60, outcome: 'not_interested', hook: '', objections: [{ saidAs: 'We already use a panel of vendors.' }] });
    await addCall(w, { startedAt: at(0, 10), duration: 20, outcome: 'gatekeeper_blocked' });
    await addCall(w, { startedAt: at(0, 10, 10), duration: 12, outcome: 'wrong_person' });
    await addCall(w, { startedAt: at(0, 10, 20), duration: 4, outcome: 'invalid_number' });

    const s = await buildSnapshot(w.deps);
    expect(s.objections).toEqual([{ label: 'Already has a partner', count: 2 }, { label: 'No budget', count: 1 }]);
    expect(s.gatekeeperByAccount).toEqual([{ company: 'Kiwibank', blocks: 1, calls: 5 }]);
    expect(s.wrongNumberRate).toBe(0.4);
  });

  it('puts the real compliance gate behind every line of the queue', async () => {
    const w = await world({ policy: { requireDailyPlan: true } });
    const contactId = await addContact(w, { status: 'researched' });
    await w.db.dossier.create({ data: { id: 'd1', contactId, hypothesis: 'Mid-way through a rebuild.', confidence: 'high', person: '{}', account: '{}', hooks: '[]', landmines: '[]', unverified: '[]', sources: '[]' } });

    // No plan: the gate says so, and there is no time to count down to.
    let s = await buildSnapshot(w.deps);
    expect(s.upNext).toHaveLength(1);
    expect(s.upNext[0]?.gate).toEqual({ allowed: false, reasons: ['DAY_PLAN_NOT_APPROVED'] });
    expect(s.upNext[0]?.hypothesis).toBe('Mid-way through a rebuild.');
    expect(s.standingBy.next?.contactId).toBe(contactId);
    expect(s.standingBy.nextDialAt).toBeNull();
    expect(s.standingBy.note).toMatch(/today's plan has not been approved/);
    expect(s.health.queueDepth).toBe(1);

    // A plan the operator has approved, with this person on it: the gate lets them through.
    const plan = await w.plans.draft(w.campaignId, '2026-10-07', [{ contactId, accountId: w.accountId, e164: '+6494960000', displayName: 'Priya Raman', title: 'Head of Data', accountName: 'Kiwibank', hypothesis: '', gateAllowed: true, gateReasons: [], earliestAt: null }], NOW);
    await w.plans.submit(plan.id, NOW);
    await w.plans.approve(plan.id, 'vinay', NOW);
    s = await buildSnapshot(w.deps);
    expect(s.upNext[0]?.gate).toEqual({ allowed: true, reasons: [] });
    expect(s.standingBy.nextDialAt).toBe(NOW.toISOString());

    // The kill switch is read from the same place the gate reads it.
    await w.killSwitch.trip('operator', 'testing', NOW);
    s = await buildSnapshot(w.deps);
    expect(s.killSwitch).toMatchObject({ engaged: true, reason: 'testing' });
    expect(s.upNext[0]?.gate.reasons).toContain('KILL_SWITCH_ACTIVE');
    expect(s.standingBy.nextDialAt).toBeNull();
    expect(s.standingBy.note).toMatch(/halted: testing/);
  });

  it('shows a request with both clocks, a draft reply, and the escalations beside it', async () => {
    const w = await world();
    const { callId } = await requestFor(w, 'de00c0d1-0000-4000-8000-000000000001');
    await w.db.escalation.create({ data: { id: 'e1', level: 'human', reason: 'no agent is registered for task kind "x"', status: 'open', detail: '{}', createdAt: NOW } });

    const s = await buildSnapshot(w.deps);
    const request = s.needsYou.meetingRequests[0];
    expect(meetingRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({ ref: 'MR-DE00C0D1', status: 'pending', name: 'Priya Raman', company: 'Kiwibank', email: 'priya@kiwibank.example', callId, hookThatWorked: 'the platform rebuild' });
    expect(request?.windows[0]).toMatchObject({
      said: 'Tuesday morning',
      localLabel: 'Tuesday 13 October, 09:00-12:00 NZDT',
      sydneyLabel: 'Tuesday 13 October, 07:00-10:00 Sydney'
    });
    expect(request?.attendees).toEqual(['her head of architecture']);
    expect(request?.draftReply).toContain('Hi Priya,');
    expect(request?.draftReply).not.toMatch(/\b(is booked|has been booked)\b/);
    expect(request?.objections[0]).toContain('mid-way through it');
    expect(s.needsYou.escalations[0]).toMatchObject({ id: 'e1', contact: 'The system' });
    expect(s.briefing.sections.map((x) => x.title)).toEqual(['Yesterday', 'What changed', 'Needs you', "Today's queue"]);
  });

  it('reads a call on air from the blackboard: stage from its marks, speech from its events', async () => {
    const w = await world({ live: undefined });
    const dossierContact = await addContact(w);
    await w.db.dossier.create({ data: { id: 'd2', contactId: dossierContact, hypothesis: 'A hypothesis.', confidence: 'medium', person: '{}', account: '{}', hooks: '[]', landmines: '[]', unverified: '[]', sources: '[]' } });
    await addCall(w, {
      contactId: dossierContact, startedAt: new Date(NOW.getTime() - 41_000), duration: 0, outcome: null, open: true, variant: 'hook v4',
      marks: [['disclosure', 0], ['reason', 10], ['hook', 22], ['value-statement', 38]],
      transcript: [{ speaker: 'lexi', text: 'Hi, my name is Lexi.', atSecond: 1 }, { speaker: 'prospect', text: 'Go on.', atSecond: 14 }]
    });
    w.deps.live = new DbLiveCallSource(w.db);
    const s = await buildSnapshot(w.deps);
    expect(s.live).toMatchObject({ stage: 'value', elapsedSeconds: 41, confidence: 'medium', variant: 'hook v4', hypothesis: 'A hypothesis.' });
    expect(s.live?.transcript.map((t) => t.speaker)).toEqual(['lexi', 'prospect']);
    // A call row that was never closed an hour ago is a crash, not a call on air.
    await w.db.call.updateMany({ data: { startedAt: new Date(NOW.getTime() - 3_600_000) } });
    expect((await buildSnapshot(w.deps)).live).toBeNull();
  });

  it('counts what the gate has refused, by reason', async () => {
    const w = await world({ policy: { requireDailyPlan: true } });
    const contactId = await addContact(w, { status: 'researched' });
    await w.deps.gate.request({ requestId: 'r1', contactId, accountId: w.accountId, campaignId: w.campaignId, phone: '+6494960000', market: 'NZ', source: 'orchestrator', at: NOW });
    const s = await buildSnapshot(w.deps);
    expect(s.health.gateRejections).toEqual([{ reason: 'DAY_PLAN_NOT_APPROVED', count: 1 }]);
  });
});

describe('the routes', () => {
  const routes: Array<['GET' | 'POST', string, object?]> = [
    ['GET', '/api/console/snapshot'],
    ['GET', '/api/console/stream'],
    ['POST', '/api/console/kill', { engage: true }],
    ['POST', '/api/console/meetings/MR-DE00C0D1', { decision: 'CONFIRMED' }],
    ['GET', '/api/console/calls'],
    ['GET', '/api/console/calls/nope'],
    ['GET', '/api/console/trace'],
    ['POST', '/api/console/jarvis', { query: 'what needs me' }],
    ['POST', '/api/console/jarvis/confirm', { actionId: 'x' }]
  ];

  it('refuses every route without the token, with a wrong one, and with a prefix of the right one', async () => {
    const w = await world();
    const app = serve(w);
    for (const [method, url, payload] of routes) {
      for (const headers of [{}, bearer('wrong'), bearer(TOKEN.slice(0, -1)), bearer(`${TOKEN}x`)]) {
        const res = await app.inject({ method, url, headers: { ...headers, ...json }, ...(payload ? { payload } : {}) });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    }
    // And nothing happened behind the refusals.
    expect((await w.killStore.read()).active).toBe(false);
  });

  it('also accepts the x-admin-token header the account desk accepts', async () => {
    const w = await world();
    const res = await serve(w).inject({ method: 'GET', url: '/api/console/snapshot', headers: { 'x-admin-token': TOKEN } });
    expect(res.statusCode).toBe(200);
  });

  it('serves a snapshot that matches the contract', async () => {
    const w = await world();
    const res = await get(serve(w), '/api/console/snapshot');
    expect(res.statusCode).toBe(200);
    expect(consoleSnapshotSchema.safeParse(res.json()).success).toBe(true);
  });

  it('Stop all trips the real kill switch, the gate sees it, and lifting it is a separate call', async () => {
    const w = await world();
    const app = serve(w);
    const events: ConsoleEvent[] = [];
    w.bus.subscribe((e) => events.push(e));

    const res = await post(app, '/api/console/kill', { engage: true, reason: 'testing the button' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ engaged: true, reason: 'testing the button' });
    expect(await w.killStore.read()).toMatchObject({ active: true, reason: 'testing the button', trippedBy: 'operator' });
    expect(events.some((e) => e.type === 'kill_switch' && e.killSwitch.engaged)).toBe(true);

    const contactId = await addContact(w, { status: 'researched' });
    const decision = await w.deps.gate.request({ requestId: 'k', contactId, accountId: w.accountId, campaignId: w.campaignId, phone: '+6494960000', market: 'NZ', source: 'orchestrator', at: NOW });
    expect(decision.reasons.map((r) => r.code)).toContain('KILL_SWITCH_ACTIVE');

    expect((await get(app, '/api/console/snapshot')).json().killSwitch.engaged).toBe(true);

    const lifted = await post(app, '/api/console/kill', { engage: false });
    expect(lifted.json()).toEqual({ engaged: false });
    expect((await w.killStore.read()).active).toBe(false);
  });

  it('rejects a malformed kill request without touching the switch', async () => {
    const w = await world();
    const res = await post(serve(w), '/api/console/kill', { engage: 'yes' });
    expect(res.statusCode).toBe(400);
    expect((await w.killStore.read()).active).toBe(false);
  });

  describe('answering a meeting request', () => {
    it('confirms through the Concierge state machine, once, and a repeat changes nothing', async () => {
      const w = await world();
      const app = serve(w);
      const { ref, contactId } = await requestFor(w, 'de00c0d1-0000-4000-8000-000000000001');

      const first = await post(app, `/api/console/meetings/${ref}`, { decision: 'CONFIRMED' });
      expect(first.statusCode).toBe(200);
      expect(meetingRequestSchema.parse(first.json()).status).toBe('confirmed');
      const row = await w.db.meetingRequest.findFirstOrThrow();
      expect(row).toMatchObject({ status: 'confirmed', decidedVia: 'console' });
      expect((await w.db.contact.findUniqueOrThrow({ where: { id: contactId } })).status).toBe('done');

      const decidedAt = row.decidedAt;
      const again = await post(app, `/api/console/meetings/${ref}`, { decision: 'CONFIRMED' });
      expect(again.statusCode).toBe(200);
      expect((await w.db.meetingRequest.findFirstOrThrow()).decidedAt).toEqual(decidedAt);
    });

    it('keeps confirmed and rejected terminal: a later tap cannot flip them or suppress anyone', async () => {
      const w = await world();
      const app = serve(w);
      const a = await requestFor(w, 'de00c0d1-0000-4000-8000-000000000001', 'Priya');
      const reject = await post(app, `/api/console/meetings/${a.ref}`, { decision: 'CONFIRMED' });
      expect(reject.statusCode).toBe(200);

      const flip = await post(app, `/api/console/meetings/${a.ref}`, { decision: 'REJECT' });
      expect(flip.statusCode).toBe(409);
      expect(flip.json().error).toMatch(/already confirmed/);
      expect(flip.json().request.status).toBe('confirmed');
      expect(await w.db.suppression.count()).toBe(0);

      const b = await requestFor(w, 'de00c0d2-0000-4000-8000-000000000002', 'Tom');
      expect((await post(app, `/api/console/meetings/${b.ref}`, { decision: 'REJECT' })).statusCode).toBe(200);
      const back = await post(app, `/api/console/meetings/${b.ref}`, { decision: 'CONFIRMED' });
      expect(back.statusCode).toBe(409);
      expect((await w.db.meetingRequest.findUniqueOrThrow({ where: { id: 'de00c0d2-0000-4000-8000-000000000002' } })).status).toBe('rejected');
    });

    it('REJECT from the console suppresses exactly as the emailed reply does, and RESCHEDULE keeps it open', async () => {
      const w = await world();
      const app = serve(w);
      const viaConsole = await requestFor(w, 'de00c0d1-0000-4000-8000-000000000001', 'Priya');
      const viaEmail = await requestFor(w, 'de00c0d2-0000-4000-8000-000000000002', 'Tom');
      const viaReschedule = await requestFor(w, 'de00c0d3-0000-4000-8000-000000000003', 'Sam');

      await post(app, `/api/console/meetings/${viaConsole.ref}`, { decision: 'REJECT' });
      const consoleScopes = (await w.db.suppression.findMany({ where: { key: { in: [viaConsole.contactId, '+6494960000'] } } })).map((s) => s.scope).sort();

      const email = await applyOperatorReply(
        { db: w.db, meetings: w.deps.meetings, suppressions: w.deps.suppressions, now: () => NOW },
        `REJECT\n\nSent from my iPhone\n\n> Leave this line in your reply so I know which request it is:  ${viaEmail.ref}`
      );
      expect(email.kind).toBe('applied');
      expect(await w.db.suppression.count({ where: { key: viaEmail.contactId } })).toBe(1);
      expect(consoleScopes).toContain('contact');
      expect(await w.db.suppression.count({ where: { key: viaConsole.contactId } })).toBe(1);
      expect(await w.db.meetingRequest.findUniqueOrThrow({ where: { id: 'de00c0d2-0000-4000-8000-000000000002' } })).toMatchObject({ status: 'rejected', decidedVia: 'email-reply' });
      expect(await w.db.meetingRequest.findUniqueOrThrow({ where: { id: 'de00c0d1-0000-4000-8000-000000000001' } })).toMatchObject({ status: 'rejected', decidedVia: 'console' });

      const res = await post(app, `/api/console/meetings/${viaReschedule.ref}`, { decision: 'RESCHEDULE' });
      expect(res.json().status).toBe('rescheduled');
      expect((await get(app, '/api/console/snapshot')).json().needsYou.meetingRequests.map((m: { status: string }) => m.status)).toEqual(['rescheduled']);
    });

    it('says what is wrong with a reference or a body, and changes nothing', async () => {
      const w = await world();
      const app = serve(w);
      const a = await requestFor(w, 'de00c0d1-0000-4000-8000-000000000001');
      expect((await post(app, '/api/console/meetings/MR-FFFFFFFF', { decision: 'CONFIRMED' })).statusCode).toBe(404);
      expect((await post(app, '/api/console/meetings/not-a-ref', { decision: 'CONFIRMED' })).statusCode).toBe(400);
      expect((await post(app, `/api/console/meetings/${a.ref}`, { decision: 'MAYBE' })).statusCode).toBe(400);
      expect((await w.db.meetingRequest.findFirstOrThrow()).status).toBe('requested');
    });
  });

  it('lists calls and shows one in full', async () => {
    const w = await world();
    const app = serve(w);
    const { callId } = await addCall(w, {
      startedAt: at(0, 10), duration: 90, outcome: 'meeting_requested', variant: 'hook v4', hook: 'x', summary: ['s'],
      defects: [{ kind: 'unsupported-claim', detail: 'said a thing', atSecond: 30 }],
      transcript: [{ speaker: 'lexi', text: 'Hi, my name is Lexi.', atSecond: 0 }, { speaker: 'prospect', text: 'Hello.', atSecond: 4 }]
    });
    await addCall(w, { startedAt: at(2, 10), duration: 20, outcome: 'no_answer' });

    const list = (await get(app, '/api/console/calls')).json();
    expect(list.map((c: { id: string }) => c.id)[0]).toBe(callId);
    for (const entry of list) expect(callLogEntrySchema.safeParse(entry).success).toBe(true);
    expect(list[0]).toMatchObject({ durationSeconds: 90, outcome: 'meeting_requested', variant: 'hook v4', market: 'NZ', defects: 1 });

    expect((await get(app, '/api/console/calls?outcome=no_answer')).json()).toHaveLength(1);
    expect((await get(app, '/api/console/calls?stage=meeting_requested')).json()).toHaveLength(1);
    expect((await get(app, '/api/console/calls?stage=nonsense')).statusCode).toBe(400);

    const detail = (await get(app, `/api/console/calls/${callId}`)).json();
    expect(callDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.transcript).toHaveLength(2);
    expect(detail.defectDetails).toEqual([{ kind: 'unsupported-claim', detail: 'said a thing', atSecond: 30 }]);
    expect((await get(app, '/api/console/calls/nope')).statusCode).toBe(404);
  });

  it('shows the agent trace in plain English, newest first', async () => {
    const w = await world();
    await w.db.traceEvent.create({ data: { id: 't1', at: new Date(NOW.getTime() - 60_000), actor: 'campaign-director', kind: 'decided', summary: 'Held a task: it could cost more than remains.', detail: '{}', usd: 0 } });
    await w.db.traceEvent.create({ data: { id: 't2', at: NOW, actor: 'scout', kind: 'validated', summary: 'Researched 3 contacts.', detail: '{}', usd: 0.31 } });
    const trace = (await get(serve(w), '/api/console/trace')).json();
    expect(trace.map((t: { id: string }) => t.id)).toEqual(['t2', 't1']);
    expect(traceEntrySchema.safeParse(trace[0]).success).toBe(true);
    expect(trace[0]).toMatchObject({ agent: 'scout', costUsd: 0.31 });
    expect(trace[0].result).toMatch(/accepted.*Cost \$0\.31/);
  });

  it('streams a snapshot first and then the events that follow, and drops the viewer cleanly', async () => {
    const w = await world();
    const app = serve(w);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const unauthorised = await fetch(`http://127.0.0.1:${port}/api/console/stream`);
    expect(unauthorised.status).toBe(401);

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/console/stream`, { headers: bearer(TOKEN), signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string): Promise<void> => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before "${needle}"`);
        text += decoder.decode(value);
      }
    };

    await readUntil('\n\n');
    expect(text.startsWith('data: {"type":"snapshot"')).toBe(true);
    expect(w.bus.subscriberCount).toBe(1);

    w.bus.publish({ type: 'transcript', callId: 'c1', turn: { speaker: 'lexi', text: 'Hello there.', atSecond: 3 } });
    await readUntil('Hello there.');
    expect(text).toContain('"type":"transcript"');

    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(w.bus.subscriberCount).toBe(0);
  });
});

describe('the plan repository is untouched by reading', () => {
  it('a snapshot writes nothing: no audit, no attempts, no calls', async () => {
    const w = await world({ policy: { requireDailyPlan: true } });
    await addContact(w, { status: 'researched' });
    const before = await Promise.all([w.db.auditRecord.count(), w.db.dialAttempt.count(), w.db.call.count(), w.db.suppression.count(), w.db.callPlan.count()]);
    await buildSnapshot(w.deps);
    await buildSnapshot(w.deps);
    const after = await Promise.all([w.db.auditRecord.count(), w.db.dialAttempt.count(), w.db.call.count(), w.db.suppression.count(), w.db.callPlan.count()]);
    expect(after).toEqual(before);
    expect(new CallPlanRepository(w.db)).toBeDefined();
  });
});
