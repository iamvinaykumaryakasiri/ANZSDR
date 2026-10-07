/**
 * Carrying out a follow-up, end to end against a real database.
 *
 * Scribe feeds the executor in every test, so what is exercised is the real
 * handoff rather than a hand-built result. The mailer is wrapped in
 * `operatorOnly` throughout, which means every test is also a check that
 * nothing here can email a prospect.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { PrismaSuppressionStore } from '../../src/blackboard/compliance-stores.js';
import { MeetingRequestRepository } from '../../src/blackboard/meetings.js';
import { loadIdentityFromObject } from '../../src/agents/caller/identity.js';
import { callbackLabel, inExecutionOrder, runFollowUp, type RunDeps } from '../../src/agents/concierge/run.js';
import { MemoryMailer, MemorySmsSender, operatorOnly, type Mailer, type OutboundMail } from '../../src/agents/concierge/ports.js';
import { isGsm7 } from '../../src/agents/concierge/sms.js';
import { scribeCall, type ScribeInput, type ScribeModel, type ScribeResult } from '../../src/agents/scribe/scribe.js';
import type { TranscriptTurn } from '../../src/agents/guardian/audit.js';
import type { PlannedAction } from '../../src/agents/concierge/followup.js';
import { seedCall, type Seeded } from '../support/seed.js';

const STARTED = new Date('2026-10-07T02:00:00.000Z');
const ENDED = new Date('2026-10-07T02:01:30.000Z');
const NOW = new Date('2026-10-07T02:03:00.000Z');
const VINAY = 'vinay@example.com';

const goodSummary = {
  summary: ['Mid-way through a platform rebuild.', 'Offered Tuesday morning.'],
  hook: 'platform rebuild',
  sentiment: 'positive',
  sentimentTrace: [],
  attentionLostAtSec: null
};
const model: ScribeModel = { summarise: async () => goodSummary };

const talk: TranscriptTurn[] = [
  { speaker: 'lexi', text: "Hi, my name's Lexi. I'm an AI assistant, not a person.", atSecond: 0 },
  { speaker: 'prospect', text: "Okay. We're mid-way through a rebuild.", atSecond: 12 },
  { speaker: 'lexi', text: 'Would a couple of windows suit?', atSecond: 40 },
  { speaker: 'prospect', text: 'Tuesday morning. priya@kiwibank.co.nz', atSecond: 52 }
];

const mark = (outcome: string) => ({ name: 'mark_outcome', value: { outcome, note: '' } });
const email = { name: 'capture_email', value: { email: 'priya@kiwibank.co.nz', confidence: 'read-back-confirmed' } };
const times = {
  name: 'capture_preferred_times',
  value: {
    slots: [{ saidAs: 'Tuesday morning', startsAt: '2026-10-13T09:00:00+13:00', endsAt: '2026-10-13T12:00:00+13:00' }],
    timezone: 'Pacific/Auckland'
  }
};

function identity(operatorEmail = VINAY) {
  return loadIdentityFromObject({
    agent: { name: 'Lexi', gender: 'female', accent: 'au-neutral' },
    operator: {
      name: 'Vinay Kumar',
      title: 'Sales Director',
      company: 'Hexaware Technologies',
      team: 'the ANZ sales team',
      email: operatorEmail
    },
    callback: { number: '+61280001234' }
  });
}

let dbs: Blackboard[] = [];
afterEach(async () => {
  for (const db of dbs) await db.$disconnect();
  dbs = [];
});

interface World {
  db: Blackboard;
  deps: RunDeps;
  mail: MemoryMailer;
  sms: MemorySmsSender;
  suppressions: PrismaSuppressionStore;
  meetings: MeetingRequestRepository;
}

async function world(over: Partial<RunDeps> & { mailer?: Mailer } = {}): Promise<World> {
  const db = await createTestBlackboard();
  dbs.push(db);
  const meetings = new MeetingRequestRepository(db);
  const suppressions = new PrismaSuppressionStore(db);
  const mail = new MemoryMailer();
  const sms = new MemorySmsSender();
  const deps: RunDeps = {
    db,
    meetings,
    suppressions,
    mailer: operatorOnly(mail, [VINAY]),
    sms,
    smsFrom: '+61412000000',
    identity: identity(),
    killSwitch: { state: async () => ({ active: false }) },
    now: () => NOW,
    ...over
  };
  return { db, deps, mail, sms, suppressions, meetings };
}

async function finish(
  w: World,
  tools: Array<{ name: string; value: unknown }>,
  seed: Parameters<typeof seedCall>[1] = {},
  inputOver: Partial<ScribeInput> = {}
): Promise<{ scribe: ScribeResult; seeded: Seeded }> {
  const seeded = await seedCall(w.db, { outcome: null, line: 'mobile', phone: '+61448455510', startedAt: STARTED, endedAt: ENDED, ...seed });
  const scribe = await scribeCall(
    { db: w.db, model, now: () => NOW },
    {
      callId: seeded.callId,
      endedAt: ENDED,
      durationSec: 90,
      transcript: talk,
      toolCalls: tools,
      turnDefects: [],
      audit: [],
      ...inputOver
    }
  );
  return { scribe, seeded };
}

const kinds = (r: { results: Array<{ kind: string; status: string }> }, status?: string) =>
  r.results.filter((x) => status === undefined || x.status === status).map((x) => x.kind);

/* ------------------------------------------------------------------ */

describe('an interested call', () => {
  it('emails Vinay the request, texts the prospect, and queues LinkedIn', async () => {
    const w = await world();
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')]);
    const run = await runFollowUp(w.deps, scribe);

    expect(run.complete).toBe(true);
    expect(kinds(run, 'done')).toEqual(['meeting-request-email', 'draft-reply', 'sms-confirmation', 'linkedin-queue']);

    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]?.to).toBe(VINAY);
    expect(w.mail.sent[0]?.subject).toContain('[MEETING REQUEST] Priya Raman — Kiwibank');
    expect(w.mail.sent[0]?.attachments[0]?.filename).toMatch(/\.ics$/);
    expect(w.sms.sent).toHaveLength(1);
  });

  it('records the request as sent and waiting on Vinay', async () => {
    const w = await world();
    const { scribe, seeded } = await finish(w, [email, times, mark('meeting_requested')]);
    await runFollowUp(w.deps, scribe);
    const request = await w.meetings.findByCall(seeded.callId);
    expect(request?.status).toBe('requested');
    expect(request?.emailSentAt).toEqual(NOW);
  });

  it('sends a text that says who it is, that it is an AI, and how to stop', async () => {
    const w = await world();
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')]);
    await runFollowUp(w.deps, scribe);
    const text = w.sms.sent[0]?.body ?? '';
    expect(text).toContain('Lexi');
    expect(text).toMatch(/\bAI\b/);
    expect(text).toContain('Reply STOP');
    expect(text).toContain('will email you today');
    expect(isGsm7(text)).toBe(true);
    expect(w.sms.sent[0]?.to).toBe('+61448455510');
    expect(w.sms.sent[0]?.from).toBe('+61412000000');
  });

  it('does not text a landline', async () => {
    const w = await world();
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')], { line: 'fixed' });
    const run = await runFollowUp(w.deps, scribe);
    expect(w.sms.sent).toEqual([]);
    expect(run.plan.withheld.find((x) => x.kind === 'sms-confirmation')?.why).toContain('cannot receive SMS');
    expect(w.mail.sent).toHaveLength(1);
  });

  it('does not text when the prospect barely spoke, whatever Lexi marked', async () => {
    // A model can mark a meeting request on a call where nobody said anything.
    const w = await world();
    const silent = talk.filter((t) => t.speaker === 'lexi');
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')], {}, { transcript: silent });
    await runFollowUp(w.deps, scribe);
    expect(w.sms.sent).toEqual([]);
  });

  it('queues a LinkedIn connect for Vinay to send by hand and sends nothing itself', async () => {
    const w = await world();
    const { scribe, seeded } = await finish(w, [email, times, mark('meeting_requested')]);
    await runFollowUp(w.deps, scribe);
    const rows = await w.db.memory.findMany({ where: { scope: 'contact', key: seeded.contactId, kind: 'linkedin-queue' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toContain('Priya Raman');
  });
});

describe('when the request cannot reach Vinay', () => {
  it('records the request, sends nothing, and says why, when his address is not configured', async () => {
    const w = await world({ identity: identity('') });
    const { scribe, seeded } = await finish(w, [email, times, mark('meeting_requested')]);
    const run = await runFollowUp(w.deps, scribe);

    expect(run.complete).toBe(false);
    expect(w.mail.sent).toEqual([]);
    expect(run.results.find((r) => r.kind === 'meeting-request-email')?.detail).toContain('section 15 item 6');
    // It exists, so it will show as needing him once there is somewhere to send it.
    expect(await w.meetings.findByCall(seeded.callId)).not.toBeNull();
  });

  it('does not text the prospect to expect an email nobody knows to send', async () => {
    const w = await world({ identity: identity('') });
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')]);
    const run = await runFollowUp(w.deps, scribe);
    expect(w.sms.sent).toEqual([]);
    expect(run.results.find((r) => r.kind === 'sms-confirmation')?.detail).toContain('has not reached Vinay');
  });

  it('does not text when the mail to Vinay fails either', async () => {
    const failing: Mailer = {
      async send() {
        throw new Error('smtp unreachable');
      }
    };
    const w = await world({ mailer: operatorOnly(failing, [VINAY]) });
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')]);
    const run = await runFollowUp(w.deps, scribe);
    expect(run.results.find((r) => r.kind === 'meeting-request-email')?.detail).toContain('smtp unreachable');
    expect(w.sms.sent).toEqual([]);
  });

  it('fails the draft reply along with the email it lives inside', async () => {
    const w = await world({ identity: identity('') });
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')]);
    const run = await runFollowUp(w.deps, scribe);
    expect(run.results.find((r) => r.kind === 'draft-reply')?.status).toBe('failed');
  });
});

describe('running it again', () => {
  it('does nothing the second time: no second email, no second text', async () => {
    const w = await world();
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')]);
    await runFollowUp(w.deps, scribe);
    const again = await runFollowUp(w.deps, scribe);

    expect(again.alreadyRun).toBe(true);
    expect(w.mail.sent).toHaveLength(1);
    expect(w.sms.sent).toHaveLength(1);
  });

  it('finishes the job after a failure without repeating what already worked', async () => {
    let up = false;
    const delivered = new MemoryMailer();
    const flaky: Mailer = {
      async send(mail: OutboundMail) {
        if (!up) throw new Error('smtp unreachable');
        return delivered.send(mail);
      }
    };
    const w = await world({ mailer: operatorOnly(flaky, [VINAY]) });
    const legal = { name: 'escalate', value: { reason: 'legal-threat', saidAs: "I'll be calling our lawyers", closedPolitely: true } };
    const { scribe } = await finish(w, [legal, mark('escalated')], { kind: 'prospect' });

    const first = await runFollowUp(w.deps, scribe);
    expect(first.complete).toBe(false);
    expect(first.results.find((r) => r.kind === 'alert-operator')?.status).toBe('failed');
    const suppressedAfterFirst = (await w.suppressions.list()).length;
    expect(suppressedAfterFirst).toBeGreaterThan(0);

    up = true;
    const second = await runFollowUp(w.deps, scribe);
    expect(second.alreadyRun).toBe(false);
    expect(second.results.find((r) => r.kind === 'alert-operator')?.status).toBe('done');
    expect(delivered.sent).toHaveLength(1);
    // The suppression that worked the first time is not written a second time.
    expect((await w.suppressions.list()).length).toBe(suppressedAfterFirst);

    // And now that everything has worked, a third run is a no-op.
    const third = await runFollowUp(w.deps, scribe);
    expect(third.alreadyRun).toBe(true);
    expect(delivered.sent).toHaveLength(1);
  });

  it('retries a failed email once there is somewhere to send it, and texts only once', async () => {
    const w = await world();
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')]);

    // First pass with no operator address: nowhere to send the request, so no text promising one.
    const first = await runFollowUp({ ...w.deps, identity: identity('') }, scribe);
    expect(first.complete).toBe(false);
    expect(w.mail.sent).toEqual([]);
    expect(w.sms.sent).toEqual([]);

    // The address is configured, and the retry goes through.
    const second = await runFollowUp(w.deps, scribe);
    expect(second.alreadyRun).toBe(false);
    expect(second.results.find((r) => r.kind === 'meeting-request-email')?.status).toBe('done');
    expect(w.mail.sent).toHaveLength(1);
    expect(w.sms.sent).toHaveLength(1);

    const third = await runFollowUp(w.deps, scribe);
    expect(third.alreadyRun).toBe(true);
    expect(w.mail.sent).toHaveLength(1);
    expect(w.sms.sent).toHaveLength(1);
  });
});

describe('the kill switch', () => {
  it('stops every text while it is on', async () => {
    const w = await world({ killSwitch: { state: async () => ({ active: true }) } });
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')]);
    const run = await runFollowUp(w.deps, scribe);
    expect(w.sms.sent).toEqual([]);
    expect(run.plan.withheld.find((x) => x.kind === 'sms-confirmation')?.why).toContain('kill switch');
  });

  it('is checked again at the moment of sending, not trusted from planning', async () => {
    // Off when the plan was made, on by the time the text would go out.
    let calls = 0;
    const w = await world({ killSwitch: { state: async () => ({ active: ++calls > 1 }) } });
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')]);
    const run = await runFollowUp(w.deps, scribe);
    expect(w.sms.sent).toEqual([]);
    expect(run.results.find((r) => r.kind === 'sms-confirmation')?.detail).toContain('kill switch');
  });
});

describe('texting needs a sender a reply can reach', () => {
  it('sends nothing with no SMS sender at all', async () => {
    const w = await world({ sms: undefined });
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')]);
    const run = await runFollowUp(w.deps, scribe);
    expect(run.plan.withheld.find((x) => x.kind === 'sms-confirmation')?.why).toContain('opt-out reply');
  });

  it('treats an alphanumeric sender as not configured, since nobody can reply STOP to it', async () => {
    const w = await world({ smsFrom: 'HEXAWARE' });
    const { scribe } = await finish(w, [email, times, mark('meeting_requested')]);
    await runFollowUp(w.deps, scribe);
    expect(w.sms.sent).toEqual([]);
  });

  it('does not text someone who has already opted out', async () => {
    const w = await world();
    const { scribe, seeded } = await finish(w, [email, times, mark('meeting_requested')]);
    await w.db.memory.create({
      data: { id: 'opt1', scope: 'contact', key: seeded.contactId, kind: 'sms-opt-out', summary: 'replied STOP', content: '{}' }
    });
    await runFollowUp(w.deps, scribe);
    expect(w.sms.sent).toEqual([]);
  });
});

describe('a callback', () => {
  const callbackTimes = {
    name: 'capture_preferred_times',
    value: {
      slots: [{ saidAs: 'Thursday at 2', startsAt: '2026-10-15T14:00:00+13:00', endsAt: '2026-10-15T14:30:00+13:00' }],
      timezone: 'Pacific/Auckland'
    }
  };

  it('texts when they will be rung back, in their own clock, and requests the retry', async () => {
    const w = await world();
    const { scribe, seeded } = await finish(w, [callbackTimes, mark('callback_requested')]);
    const run = await runFollowUp(w.deps, scribe);

    expect(w.sms.sent[0]?.body).toContain("I'll try you again on Thursday at 2pm");
    const retry = await w.db.memory.findFirst({ where: { scope: 'contact', key: seeded.contactId, kind: 'retry-requested' } });
    expect(retry).not.toBeNull();
    expect(run.results.find((r) => r.kind === 'schedule-retry')?.detail).toContain('compliance gate decide');
  });

  it('with no time given, drafts the one-pager for Vinay and schedules nothing', async () => {
    const w = await world();
    const { scribe } = await finish(w, [email, mark('callback_requested')]);
    const run = await runFollowUp(w.deps, scribe);
    expect(kinds(run, 'done')).toEqual(['draft-one-pager-email']);
    expect(w.mail.sent[0]?.subject).toContain('[DRAFT] One-pager follow-up');
    expect(w.sms.sent).toEqual([]);
  });
});

describe('someone who said no', () => {
  it('is suppressed, drafted a thank-you for Vinay, and sent nothing', async () => {
    const w = await world();
    const { scribe, seeded } = await finish(w, [email, mark('not_interested')], { kind: 'prospect' });
    const run = await runFollowUp(w.deps, scribe);

    expect((await w.suppressions.list()).map((e) => e.scope).sort()).toEqual(['contact', 'number']);
    expect(w.sms.sent).toEqual([]);
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]?.to).toBe(VINAY);
    expect(w.mail.sent[0]?.subject).toContain('[DRAFT] Thank-you');
    expect((await w.db.contact.findUniqueOrThrow({ where: { id: seeded.contactId } })).status).toBe('done');
    expect(run.complete).toBe(true);
  });

  it('suppresses a test contact as a contact only, so rehearsing does not burn the phone', async () => {
    const w = await world();
    const { scribe } = await finish(w, [email, mark('not_interested')], { kind: 'test' });
    await runFollowUp(w.deps, scribe);
    expect((await w.suppressions.list()).map((e) => e.scope)).toEqual(['contact']);
  });
});

describe('someone who asked us to stop', () => {
  it('is suppressed and nothing at all is sent', async () => {
    const w = await world();
    const { scribe } = await finish(w, [
      email,
      mark('meeting_requested'),
      { name: 'suppress_contact', value: { reason: 'asked-not-to-be-called', saidAs: 'take me off your list' } }
    ], { kind: 'prospect' });
    const run = await runFollowUp(w.deps, scribe);

    expect(scribe.outcome).toBe('do_not_contact');
    expect(w.mail.sent).toEqual([]);
    expect(w.sms.sent).toEqual([]);
    expect((await w.suppressions.list()).map((e) => e.scope).sort()).toEqual(['contact', 'number']);
    expect(kinds(run, 'done')).toEqual(['suppress']);
  });
});

describe('an escalation', () => {
  const legal = { name: 'escalate', value: { reason: 'legal-threat', saidAs: "I'll be calling our lawyers", closedPolitely: true } };

  it('alerts Vinay with what was said, suppresses, and texts nobody', async () => {
    const w = await world();
    const { scribe } = await finish(w, [legal, mark('escalated')], { kind: 'prospect' });
    await runFollowUp(w.deps, scribe);

    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]?.subject).toContain('[ESCALATION]');
    expect(w.mail.sent[0]?.subject).toContain('a legal threat');
    expect(w.mail.sent[0]?.body).toContain("I'll be calling our lawyers");
    expect(w.sms.sent).toEqual([]);
    expect((await w.suppressions.list()).length).toBeGreaterThan(0);
  });

  it('suppresses the whole account for an existing client', async () => {
    const w = await world();
    const client = { name: 'escalate', value: { reason: 'existing-client-or-partner', saidAs: 'we are a client', closedPolitely: true } };
    const { scribe } = await finish(w, [client, mark('escalated')], { kind: 'prospect' });
    await runFollowUp(w.deps, scribe);
    expect((await w.suppressions.list()).map((e) => e.scope)).toContain('account');
  });

  it('still suppresses when the mail that would alert Vinay fails', async () => {
    // Safety before courtesy: a mail outage must not stop a suppression.
    const failing: Mailer = {
      async send() {
        throw new Error('smtp unreachable');
      }
    };
    const w = await world({ mailer: operatorOnly(failing, [VINAY]) });
    const { scribe } = await finish(w, [legal, mark('escalated')], { kind: 'prospect' });
    const run = await runFollowUp(w.deps, scribe);

    expect(run.complete).toBe(false);
    expect(run.results.find((r) => r.kind === 'alert-operator')?.status).toBe('failed');
    expect(run.results.find((r) => r.kind === 'suppress')?.status).toBe('done');
    expect((await w.suppressions.list()).length).toBeGreaterThan(0);
  });
});

describe('a voicemail', () => {
  it('drafts one email, once, however many times it is tried', async () => {
    const w = await world();
    const first = await finish(w, [email, mark('voicemail')], {}, { transcript: [talk[0] as TranscriptTurn] });
    await runFollowUp(w.deps, first.scribe);
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]?.subject).toContain('[DRAFT] Voicemail follow-up');

    // A second voicemail for the same person: a different call, the same contact.
    const call2 = await w.db.call.create({
      data: {
        id: 'call-2',
        contactId: first.seeded.contactId,
        accountId: first.seeded.accountId,
        campaignId: first.seeded.campaignId,
        startedAt: new Date(STARTED.getTime() + 7 * 86_400_000),
        endedAt: new Date(ENDED.getTime() + 7 * 86_400_000)
      }
    });
    const second = await scribeCall(
      { db: w.db, model, now: () => NOW },
      {
        callId: call2.id,
        endedAt: call2.endedAt as Date,
        durationSec: 20,
        transcript: [talk[0] as TranscriptTurn],
        toolCalls: [mark('voicemail')],
        turnDefects: [],
        audit: []
      }
    );
    await runFollowUp(w.deps, second);
    expect(w.mail.sent).toHaveLength(1);
  });
});

describe('a call with no outcome', () => {
  it('does nothing irreversible and says so', async () => {
    const w = await world();
    const { scribe } = await finish(w, []);
    const run = await runFollowUp(w.deps, scribe);
    expect(run.plan.actions).toEqual([]);
    expect(run.results[0]?.detail).toContain('needs a look');
    expect(w.mail.sent).toEqual([]);
    expect(w.sms.sent).toEqual([]);
    expect(await w.suppressions.list()).toEqual([]);
  });
});

describe('who can ever be emailed', () => {
  it('is the operator and nobody else, across every kind of call', async () => {
    const w = await world();
    const calls: Array<[Array<{ name: string; value: unknown }>, Parameters<typeof seedCall>[1]]> = [
      [[email, times, mark('meeting_requested')], {}],
      [[email, mark('not_interested')], { kind: 'prospect' }],
      [[email, mark('callback_requested')], {}],
      [[{ name: 'escalate', value: { reason: 'hostility', saidAs: 'x', closedPolitely: true } }, mark('escalated')], { kind: 'prospect' }]
    ];
    for (const [tools, seed] of calls) {
      const { scribe } = await finish(w, tools, seed);
      await runFollowUp(w.deps, scribe);
    }
    expect(w.mail.sent.length).toBeGreaterThan(0);
    for (const mail of w.mail.sent) expect(mail.to).toBe(VINAY);
  });
});

describe('ordering and labels', () => {
  it('puts suppression and retiring before any email or text', () => {
    const actions: PlannedAction[] = [
      { kind: 'sms-confirmation', detail: '' },
      { kind: 'meeting-request-email', detail: '' },
      { kind: 'suppress', detail: '', targets: ['contact'], source: 'operator' },
      { kind: 'retire-contact', detail: '' },
      { kind: 'alert-operator', detail: '' }
    ];
    expect(inExecutionOrder(actions).map((a) => a.kind)).toEqual([
      'suppress',
      'retire-contact',
      'alert-operator',
      'meeting-request-email',
      'sms-confirmation'
    ]);
  });

  it('labels a callback in the prospect’s own clock, without a spurious :00', () => {
    expect(callbackLabel('2026-10-15T14:00:00+13:00', 'Pacific/Auckland')).toBe('on Thursday at 2pm');
    expect(callbackLabel('2026-10-15T14:30:00+13:00', 'Pacific/Auckland')).toBe('on Thursday at 2:30pm');
    expect(callbackLabel('2026-10-15T09:00:00+13:00', 'Pacific/Auckland')).toBe('on Thursday at 9am');
  });

  it('keeps the label plain enough for an SMS', () => {
    expect(isGsm7(callbackLabel('2026-10-15T14:30:00+13:00', 'Pacific/Auckland'))).toBe(true);
  });
});
