/**
 * A call, end to end, with nothing real in it.
 *
 * The provider is played by this file: it asks the voice server for what Lexi
 * says, then reports the call over, exactly as Vapi's requests and webhooks
 * arrive. Everything on our side is real - the endpoint, the journal, the
 * lifecycle, the webhook, Scribe, the follow-up, the mailer to Vinay - against a
 * real (temporary) database. The models are scripts.
 *
 * What it proves: a call's transcript, tool calls and timings end up on the
 * blackboard in the shape Scribe consumes, a redelivered report is processed
 * once, a forged one is not processed at all, and a recording the prospect
 * objected to is gone.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallerModel, ModelToolCall } from '../../src/agents/caller/brain.js';
import type { CheckModel } from '../../src/agents/guardian/check.js';
import { MemoryMailer, operatorOnly } from '../../src/agents/concierge/ports.js';
import { buildOpening, renderOpening } from '../../src/agents/caller/opening.js';
import { MeetingRequestRepository } from '../../src/blackboard/meetings.js';
import { PrismaSuppressionStore } from '../../src/blackboard/compliance-stores.js';
import { PrismaCallJournal } from '../../src/voice/call-journal.js';
import { CallStore } from '../../src/voice/call-store.js';
import { buildVoiceServer, wireVoice, type Wired } from '../../src/voice/server.js';
import { sweepCalls } from '../../src/voice/watchdog.js';
import {
  EMPTY_PACK,
  FakeAdapter,
  IDENTITY,
  OPERATOR_EMAIL,
  TUESDAY,
  claimIndex,
  seedContact,
  spoken,
  world,
  type World
} from './support.js';

const SECRET = 'llm-secret';
const HOOK = 'webhook-secret';
const NOW = new Date(TUESDAY.getTime() + 2 * 60_000);
const OPENING = renderOpening(buildOpening({ identity: IDENTITY, reason: 'I wanted to ask you one question about how your data platform is set up.' }));

interface Rig {
  w: World;
  app: FastifyInstance;
  adapter: FakeAdapter;
  wired: Wired;
  mail: MemoryMailer;
  calls: CallStore;
  jobs: Promise<unknown>[];
  say(callKey: Record<string, unknown>, messages: Array<{ role: string; content: string }>): Promise<string>;
  hook(body: unknown, secret?: string | null): Promise<{ status: number; json: Record<string, unknown> }>;
  newCall(options?: { providerCallId?: string; startedAt?: Date; kind?: 'test' | 'prospect' }): Promise<{ callId: string; contactId: string; providerCallId: string }>;
}

let rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs) {
    await r.app.close();
    await r.w.close();
  }
  rigs = [];
});

function sequence(turns: Array<{ say: string; tools?: ModelToolCall[] }>): CallerModel {
  let i = 0;
  let current: { say: string; tools?: ModelToolCall[] } | undefined;
  return {
    async *stream() {
      current = turns[Math.min(i++, turns.length - 1)];
      yield current?.say ?? '';
    },
    toolCalls: () => current?.tools ?? []
  };
}

const safe: CheckModel = { judge: async () => ({ verdict: 'safe' }) };

async function rig(caller: CallerModel = sequence([{ say: 'Okay.' }]), options: { closeGraceMs?: number } = {}): Promise<Rig> {
  const w = await world();
  const adapter = new FakeAdapter();
  const mail = new MemoryMailer();
  const jobs: Promise<unknown>[] = [];

  const wired = wireVoice({
    db: w.db,
    identity: IDENTITY,
    adapter,
    briefing: { db: w.db, identity: IDENTITY, claims: () => claimIndex('Hexaware has offices in Sydney.'), pack: () => EMPTY_PACK },
    killSwitch: w.killSwitch,
    caller,
    check: safe,
    sharedSecret: SECRET,
    closeGraceMs: options.closeGraceMs ?? 10,
    now: () => NOW,
    log: () => {},
    ended: {
      db: w.db,
      now: () => NOW,
      claims: () => claimIndex('Hexaware has offices in Sydney.'),
      adapter,
      retentionDays: 90,
      latencyTargetMs: 800,
      post: {
        scribe: {
          db: w.db,
          now: () => NOW,
          model: {
            summarise: async () => ({
              summary: ['She is partway through a platform rebuild.', 'She is free Tuesday morning, Auckland time.'],
              hook: 'the platform rebuild',
              sentiment: 'positive',
              sentimentTrace: [],
              attentionLostAtSec: null
            })
          }
        },
        followUp: {
          db: w.db,
          meetings: new MeetingRequestRepository(w.db),
          suppressions: new PrismaSuppressionStore(w.db),
          mailer: operatorOnly(mail, [OPERATOR_EMAIL]),
          sms: undefined,
          smsFrom: '+61280000000',
          identity: IDENTITY,
          killSwitch: { state: async () => ({ active: false }) },
          now: () => NOW
        }
      }
    }
  });

  const app = buildVoiceServer({
    endpoint: wired.endpoint,
    webhook: { adapter, ended: wired.ended, schedule: (job) => void jobs.push(job()) },
    health: async () => ({ ok: true })
  });

  const r: Rig = {
    w,
    app,
    adapter,
    wired,
    mail,
    calls: wired.calls,
    jobs,
    async say(callKey, messages) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${SECRET}` },
        payload: { stream: true, ...callKey, messages: [{ role: 'system', content: 'placeholder' }, ...messages] }
      });
      // The endpoint closes the stream first and writes its bookkeeping after,
      // on purpose. Wait for the writes to stop arriving.
      let last = -1;
      for (let i = 0; i < 100; i++) {
        const count = await w.db.callEvent.count();
        if (count === last) break;
        last = count;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return spoken(response.body);
    },
    async hook(body, secret = HOOK) {
      const response = await app.inject({
        method: 'POST',
        url: '/vapi/webhook',
        headers: secret === null ? {} : { 'x-vapi-secret': secret },
        payload: body as Record<string, unknown>
      });
      await Promise.all(jobs.splice(0));
      return { status: response.statusCode, json: response.json() as Record<string, unknown> };
    },
    async newCall(options = {}) {
      const seeded = await seedContact(w.db, { kind: options.kind ?? 'test' });
      const call = await r.calls.create(seeded);
      const providerCallId = options.providerCallId ?? `prov-${call.id.slice(0, 6)}`;
      await r.calls.setProvider(call.id, providerCallId, 'https://phone-call-websocket.aws.vapi.ai/x/control');
      if (options.startedAt !== undefined) await w.db.call.update({ where: { id: call.id }, data: { startedAt: options.startedAt } });
      await w.db.dialAttempt.create({
        data: { id: `att-${call.id}`, contactId: seeded.contactId, accountId: seeded.accountId, e164: '+61448455510', at: TUESDAY, hadConversation: false, callId: call.id }
      });
      return { callId: call.id, contactId: seeded.contactId, providerCallId };
    }
  };
  rigs.push(r);
  return r;
}

const report = (providerCallId: string, callId: string, extra: Record<string, unknown> = {}, messages: unknown[] = []) => ({
  message: {
    type: 'end-of-call-report',
    endedReason: 'customer-ended-call',
    startedAt: TUESDAY.toISOString(),
    endedAt: new Date(TUESDAY.getTime() + 75_000).toISOString(),
    cost: 0.31,
    call: { id: providerCallId, assistantOverrides: { metadata: { callId } } },
    artifact: { messages, performanceMetrics: { turnLatencies: [{ turnLatency: 690 }, { turnLatency: 760 }] } },
    ...extra
  }
});

const EMAIL_TURN = {
  say: 'Vinay will send you a confirmation and an invite today.',
  tools: [
    { name: 'capture_email', args: { email: 'priya@kiwibank.co.nz', confidence: 'read-back-confirmed' } },
    {
      name: 'capture_preferred_times',
      args: {
        slots: [{ saidAs: 'Wednesday morning', startsAt: '2026-10-14T09:00:00+13:00', endsAt: '2026-10-14T12:00:00+13:00' }],
        timezone: 'Pacific/Auckland',
        attendees: []
      }
    },
    { name: 'mark_outcome', args: { outcome: 'meeting_requested', note: '' } }
  ] as ModelToolCall[]
};

describe('an interested call', () => {
  it('goes from the provider\'s first request to a meeting request in Vinay\'s inbox', async () => {
    const r = await rig(sequence([{ say: "Thanks. What's the best email for you?" }, EMAIL_TURN]));
    const { callId, providerCallId } = await r.newCall();
    const key = { call: { id: providerCallId }, metadata: { callId } };

    // The provider asks for the first words; the opening comes back, frozen.
    const opening = (await r.wired.contexts.get(callId))?.openingText ?? '';
    expect(opening).toContain("I'm an AI assistant, not a person");
    expect(await r.say(key, [])).toBe(opening);
    let metrics = await r.calls.metrics(callId);
    expect(metrics.state).toBe('in-progress');
    expect(metrics.recording?.announcedAt).toBeDefined();

    const talk = [{ role: 'assistant', content: opening }, { role: 'user', content: 'Okay, go on.' }];
    expect(await r.say(key, talk)).toContain('best email');
    const talk2 = [...talk, { role: 'assistant', content: "Thanks. What's the best email for you?" }, { role: 'user', content: 'priya at kiwibank dot co dot nz, and Wednesday morning suits.' }];
    expect(await r.say(key, talk2)).toContain('Vinay will send you a confirmation');

    // Everything said and done is in the journal, in order.
    const turns = await r.calls.events(callId, 'turn');
    expect(turns.map((t) => `${t.speaker}: ${t.text}`)).toEqual([
      `lexi: ${opening}`,
      'prospect: Okay, go on.',
      "lexi: Thanks. What's the best email for you?",
      'prospect: priya at kiwibank dot co dot nz, and Wednesday morning suits.',
      'lexi: Vinay will send you a confirmation and an invite today.'
    ]);
    expect((await r.calls.events(callId, 'tool')).map((t) => t.data.name)).toEqual(['capture_email', 'capture_preferred_times', 'mark_outcome']);

    // The provider reports the call over: what was actually heard, with times.
    const heard = [
      { role: 'bot', message: opening, secondsFromStart: 0.5 },
      { role: 'user', message: 'Okay, go on.', secondsFromStart: 24 },
      { role: 'bot', message: "Thanks. What's the best email for you?", secondsFromStart: 26 },
      { role: 'user', message: 'priya at kiwibank dot co dot nz, and Wednesday morning suits.', secondsFromStart: 40 },
      { role: 'bot', message: 'Vinay will send you a confirmation and an invite today.', secondsFromStart: 48 }
    ];
    const result = await r.hook(report(providerCallId, callId, {}, heard));
    expect(result).toEqual({ status: 200, json: { accepted: true } });

    // Scribe consumed it.
    const call = await r.w.db.call.findUniqueOrThrow({ where: { id: callId } });
    expect(call.outcome).toBe('meeting_requested');
    expect(call.endedAt).not.toBeNull();
    expect(call.durationSec).toBe(75);
    expect(call.endedReason).toBe('customer-ended-call');
    const record = await r.w.db.callRecord.findUniqueOrThrow({ where: { callId } });
    expect(JSON.parse(record.windows)).toHaveLength(1);
    expect(record.timezone).toBe('Pacific/Auckland');
    expect((await r.w.db.contactEmail.findFirst({ where: { kind: 'confirmed_on_call' } }))?.address).toBe('priya@kiwibank.co.nz');

    // The disclosure was heard, so the audit found nothing wrong with it.
    expect(JSON.parse(call.defects).filter((d: { kind: string }) => d.kind === 'disclosure-missing')).toEqual([]);

    // Concierge followed up: one email, to Vinay only.
    expect(r.mail.sent).toHaveLength(1);
    expect(r.mail.sent[0]?.to).toBe(OPERATOR_EMAIL);
    expect(r.mail.sent[0]?.subject).toContain('[MEETING REQUEST]');
    expect(await r.w.db.meetingRequest.count()).toBe(1);

    // Timing is on the call record: ours, and the provider's.
    metrics = await r.calls.metrics(callId);
    expect(metrics.state).toBe('ended');
    expect(metrics.pipeline?.status).toBe('done');
    expect(metrics.latency?.turns).toHaveLength(2);
    expect(metrics.latency?.basis).toBe('perceived');
    expect(metrics.latency?.perceivedSamplesMs).toEqual([690, 760]);
    expect(metrics.latency?.withinTarget).toBe(true);
    expect(metrics.provider?.costUsd).toBe(0.31);
    expect((await r.w.db.spendRecord.findFirst({ where: { category: 'voice' } }))?.usd).toBe(0.31);

    // The attempt knows a conversation happened, which lifts the account's weekly cap.
    expect((await r.w.db.dialAttempt.findFirstOrThrow({ where: { callId } })).hadConversation).toBe(true);
  });

  it('is processed once however many times the provider tells us', async () => {
    const r = await rig();
    const { callId, providerCallId } = await r.newCall();
    const body = report(providerCallId, callId, {}, [{ role: 'user', message: 'Hello?', secondsFromStart: 2 }]);

    const first = await r.hook(body);
    const second = await r.hook(body);
    const third = await r.hook(body);
    expect(first.json).toEqual({ accepted: true });
    expect(second.json).toEqual({ duplicate: true });
    expect(third.json).toEqual({ duplicate: true });
    expect(await r.w.db.callRecord.count()).toBe(1);
    expect(await r.w.db.spendRecord.count({ where: { category: 'voice' } })).toBe(1);
  });

  it('is processed once even when the redeliveries arrive at the same moment', async () => {
    const r = await rig();
    const { callId, providerCallId } = await r.newCall();
    const body = report(providerCallId, callId, {}, [{ role: 'user', message: 'Hello?', secondsFromStart: 2 }]);

    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        r.app.inject({ method: 'POST', url: '/vapi/webhook', headers: { 'x-vapi-secret': HOOK }, payload: body })
      )
    );
    await Promise.all(r.jobs.splice(0));
    const kinds = results.map((x) => Object.keys(x.json() as object)[0]).sort();
    expect(kinds).toEqual(['accepted', 'duplicate', 'duplicate', 'duplicate']);
    expect(await r.w.db.spendRecord.count({ where: { category: 'voice' } })).toBe(1);
  });
});

describe('a webhook that is not the provider\'s', () => {
  it('is turned away before anything is read', async () => {
    const r = await rig();
    const { callId, providerCallId } = await r.newCall();
    const body = report(providerCallId, callId, {}, [{ role: 'user', message: 'Hello?', secondsFromStart: 2 }]);

    expect((await r.hook(body, null)).status).toBe(401);
    expect((await r.hook(body, 'wrong')).status).toBe(401);
    expect((await r.calls.get(callId)).endedAt).toBeNull();
    expect(await r.w.db.callRecord.count()).toBe(0);
  });

  it('cannot reach a call that belongs to a different provider call', async () => {
    const r = await rig();
    const { callId } = await r.newCall({ providerCallId: 'prov-real' });
    // Right secret, but the report names another provider call while pointing our id at this one.
    const result = await r.hook(report('prov-other', callId, {}, [{ role: 'user', message: 'x', secondsFromStart: 1 }]));
    expect(result.json).toEqual({ ignored: 'unknown-call' });
    expect((await r.calls.get(callId)).endedAt).toBeNull();
  });

  it('ignores a call it never placed, and message types it does not use', async () => {
    const r = await rig();
    expect((await r.hook(report('prov-stranger', 'nope'))).json).toEqual({ ignored: 'unknown-call' });
    expect((await r.hook({ message: { type: 'speech-update', call: { id: 'x' } } })).json).toEqual({ ignored: 'speech-update' });
    expect((await r.hook({ message: { type: 'status-update', status: 'ended', call: { id: 'prov-stranger' } } })).json).toEqual({ ignored: 'unknown-call' });
  });
});

describe('a call nobody answered', () => {
  it('is over as soon as the line drops, and recorded as no answer', async () => {
    const r = await rig();
    const { callId, providerCallId } = await r.newCall();

    await r.hook({ message: { type: 'status-update', status: 'ringing', call: { id: providerCallId } } });
    expect((await r.calls.metrics(callId)).state).toBe('ringing');
    // The late, repeated, or out-of-order update changes nothing.
    await r.hook({ message: { type: 'status-update', status: 'queued', call: { id: providerCallId } } });
    expect((await r.calls.metrics(callId)).state).toBe('ringing');

    await r.hook({ message: { type: 'status-update', status: 'ended', endedReason: 'customer-did-not-answer', call: { id: providerCallId } } });
    // The live-call slot is free before any processing has happened.
    expect((await r.calls.get(callId)).endedAt).not.toBeNull();
    expect(await r.calls.liveCalls()).toEqual([]);

    await r.hook(report(providerCallId, callId, { endedReason: 'customer-did-not-answer' }));
    const call = await r.w.db.call.findUniqueOrThrow({ where: { id: callId } });
    expect(call.outcome).toBe('no_answer');
    expect(call.durationSec).toBe(75);
    // Said to be the provider's finding, not Lexi's.
    const tool = (await r.calls.events(callId, 'tool')).find((e) => e.data.name === 'mark_outcome');
    expect(tool?.data.source).toBe('provider');
    // Nothing was said, so there is no opening to find missing.
    expect(JSON.parse(call.defects).map((d: { kind: string }) => d.kind)).not.toContain('disclosure-missing');
    expect(r.mail.sent).toEqual([]);
  });

  it('is not given an outcome by the provider if a person actually spoke', async () => {
    const r = await rig();
    const { callId, providerCallId } = await r.newCall();
    await r.hook(report(providerCallId, callId, { endedReason: 'voicemail' }, [{ role: 'user', message: 'Hello, who is this?', secondsFromStart: 3 }]));
    const call = await r.w.db.call.findUniqueOrThrow({ where: { id: callId } });
    expect(call.outcome).toBeNull();
  });
});

describe('defects reach the record in the shape the rest of the system reads', () => {
  it('keeps content defects, and leaves operational noise in the journal', async () => {
    const r = await rig();
    const { callId, providerCallId } = await r.newCall();
    const journal = new PrismaCallJournal(r.calls, () => NOW);
    await journal.defect(callId, 'banned-topic', 'a competitor was mentioned');
    await journal.defect(callId, 'guardian-override', 'guardian overrode the turn: implied a relationship');
    await journal.defect(callId, 'guardian-unavailable', 'guardian check did not return: timed out');
    await journal.defect(callId, 'no-briefing', 'a call arrived with no briefing pack');

    await r.hook(report(providerCallId, callId, {}, [{ role: 'user', message: 'Hello?', secondsFromStart: 2 }]));
    const kinds = JSON.parse((await r.w.db.call.findUniqueOrThrow({ where: { id: callId } })).defects).map((d: { kind: string }) => d.kind);
    expect(kinds).toContain('banned-topic');
    expect(kinds).toContain('unsupported-claim');
    expect(kinds).not.toContain('guardian-unavailable');
    expect(kinds).not.toContain('no-briefing');
    expect((await r.calls.events(callId, 'defect')).map((e) => e.data.kind)).toContain('guardian-unavailable');
  });
});

describe('a prospect who objects to being recorded', () => {
  it('ends the call, and the recording is deleted when the report arrives', async () => {
    const r = await rig(sequence([{ say: 'Should never be said.' }]), { closeGraceMs: 10 });
    const { callId, providerCallId } = await r.newCall();
    const key = { call: { id: providerCallId }, metadata: { callId } };

    const line = await r.say(key, [{ role: 'assistant', content: OPENING }, { role: 'user', content: "Actually I don't want to be recorded." }]);
    expect(line).toMatch(/can't switch the recording off/);
    expect(line).not.toContain('Should never be said');
    expect((await r.calls.metrics(callId)).recording).toMatchObject({ deleteNow: true, objectionHandling: 'call-ended' });

    // The provider is asked to hang up if the call is still there after the goodbye.
    for (let i = 0; i < 50 && r.adapter.hungUp.length === 0; i++) await new Promise((res) => setTimeout(res, 20));
    expect(r.adapter.hungUp).toEqual([providerCallId]);

    await r.hook(
      report(providerCallId, callId, { artifact: { recordingUrl: 'https://storage.vapi.ai/r.mp3', messages: [{ role: 'user', message: "I don't want to be recorded.", secondsFromStart: 20 }] } })
    );
    expect(r.adapter.deleted).toEqual([providerCallId]);
    const row = await r.w.db.call.findUniqueOrThrow({ where: { id: callId } });
    expect(row.recordingUrl).toBeNull();
    expect((await r.calls.metrics(callId)).recording?.deletedAt).toBeDefined();
  });

  it('carries on without recording only if the provider can really stop it', async () => {
    const r = await rig();
    r.adapter.capabilities = { stopRecordingMidCall: true, deleteArtifacts: true, hangUp: true };
    const { callId, providerCallId } = await r.newCall();
    const key = { call: { id: providerCallId }, metadata: { callId } };

    // It says it can but cannot: Lexi must not claim to have stopped it.
    const line = await r.say(key, [{ role: 'assistant', content: OPENING }, { role: 'user', content: 'Please stop recording.' }]);
    expect(line).not.toMatch(/stopped the recording/i);
    expect(line).toMatch(/can't switch the recording off/);
    expect((await r.calls.metrics(callId)).recording?.objectionHandling).toBe('call-ended');
  });
});

describe('the watchdog', () => {
  const limits = { maxCallSeconds: 240, ringTimeoutSeconds: 90, reportGraceSeconds: 180 };

  it('closes a call that never connected, so it cannot hold the one live-call slot', async () => {
    const r = await rig();
    const { callId } = await r.newCall({ startedAt: new Date(NOW.getTime() - 5 * 60_000) });

    const swept = await sweepCalls(r.wired.ended, limits);
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ callId, reason: 'never-connected', hungUp: true });
    expect(r.adapter.hungUp).toHaveLength(1);
    expect(await r.calls.liveCalls()).toEqual([]);
    expect((await r.w.db.call.findUniqueOrThrow({ where: { id: callId } })).outcome).toBe('no_answer');

    // And nothing is left to do the next time.
    expect(await sweepCalls(r.wired.ended, limits)).toEqual([]);
  });

  it('leaves a call alone that is just ringing', async () => {
    const r = await rig();
    await r.newCall({ startedAt: new Date(NOW.getTime() - 20_000) });
    expect(await sweepCalls(r.wired.ended, limits)).toEqual([]);
  });

  it('processes a call that ended but was never reported', async () => {
    const r = await rig();
    const { callId } = await r.newCall({ startedAt: new Date(NOW.getTime() - 20 * 60_000) });
    await r.calls.markEnded(callId, { at: new Date(NOW.getTime() - 10 * 60_000), endedReason: 'customer-ended-call' });

    const swept = await sweepCalls(r.wired.ended, limits);
    expect(swept[0]).toMatchObject({ callId, reason: 'report-missing', hungUp: false });
    expect((await r.calls.metrics(callId)).pipeline?.status).toBe('done');
  });
});

describe('the journal', () => {
  it('records the same prospect words once, however often the provider repeats them', async () => {
    const r = await rig();
    const { callId } = await r.newCall();
    const journal = new PrismaCallJournal(r.calls, () => NOW);

    await journal.prospectTurn(callId, 'Hello?');
    await journal.prospectTurn(callId, 'Hello?');
    await journal.lexiTurn(callId, 'Hi.', {});
    await journal.prospectTurn(callId, 'Hello?');
    expect((await r.calls.events(callId, 'turn')).map((e) => e.speaker)).toEqual(['prospect', 'lexi', 'prospect']);
  });

  it('reports a write that still fails after retries, and does not break the call', async () => {
    const r = await rig();
    const failing = new CallStore(r.w.db);
    failing.append = async () => {
      throw new Error('database is locked');
    };
    const errors: string[] = [];
    const journal = new PrismaCallJournal(failing, () => NOW, (_id, what, error) => errors.push(`${what}: ${(error as Error).message}`));

    await expect(journal.tool('some-call', 'suppress_contact', {})).resolves.toBeUndefined();
    expect(errors).toEqual(['tool suppress_contact: database is locked']);
  });
});
