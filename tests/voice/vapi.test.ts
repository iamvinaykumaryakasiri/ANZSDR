/**
 * The Vapi adapter, against a provider that is a table of canned answers.
 *
 * What is under test is our side of the contract: the assistant we would send,
 * how we tell the provider's webhooks from forgeries, how we read what it tells
 * us, and what we do when it fails. Whether Vapi accepts the assistant is
 * checked by the first `npm run voice:assistant`, not here.
 */

import { describe, expect, it } from 'vitest';
import { loadVoiceConfigFromObject } from '../../src/voice/voice-config.js';
import { ProviderRejectedError, ProviderUncertainError } from '../../src/voice/provider.js';
import {
  AssistantInvariantError,
  OPENING_MODE,
  VapiAdapter,
  assertAssistantInvariants,
  buildVapiAssistant,
  isVapiHost,
  parseVapiWebhook
} from '../../src/voice/vapi.js';
import { fakeFetch } from './support.js';

const BASE = 'https://lexi.example.ngrok.app';
const config = (extra: Record<string, unknown> = {}) => loadVoiceConfigFromObject({ assistant_extra: extra });
const build = (extra: Record<string, unknown> = {}) =>
  buildVapiAssistant({ config: config(extra), publicBaseUrl: BASE, webhookSecret: 'hook-secret', llmSecret: 'llm-secret' });

describe('the assistant we send', () => {
  it('points the provider at our endpoint and has no first message of its own', () => {
    const a = build();
    expect(a.firstMessage).toBeUndefined();
    expect(a.firstMessageMode).toBe(OPENING_MODE);
    expect(a.model).toMatchObject({ provider: 'custom-llm', url: `${BASE}/v1`, metadataSendMode: 'variable' });
    expect(a.server).toMatchObject({ url: `${BASE}/vapi/webhook`, headers: { 'x-vapi-secret': 'hook-secret' } });
    expect(a.credentials).toEqual([{ provider: 'custom-llm', apiKey: 'llm-secret', name: 'anz-voice-sdr' }]);
  });

  it('records the call, because the opening says so', () => {
    expect(build().artifactPlan).toMatchObject({ recordingEnabled: true });
  });

  it('declares only the hang-up tool: Lexi\'s own tools never reach the provider', () => {
    const tools = (build().model as { tools: Array<{ type: string }> }).tools;
    expect(tools).toEqual([{ type: 'endCall' }]);
  });

  it('yields to the prospect at once and has a ceiling on how long a call can run', () => {
    const a = build();
    expect(a.stopSpeakingPlan).toMatchObject({ numWords: 0, voiceSeconds: 0.2 });
    expect(a.maxDurationSeconds).toBe(240);
  });

  it('does not leave voicemail messages: detection hangs up', () => {
    const a = build();
    expect(a.voicemailDetection).toEqual({ provider: 'vapi' });
    expect(a.voicemailMessage).toBeUndefined();
  });

  it('accepts harmless extras, merged in', () => {
    const a = build({ backgroundDenoisingEnabled: true, voice: { speed: 1.05 } });
    expect(a.backgroundDenoisingEnabled).toBe(true);
    expect(a.voice).toMatchObject({ provider: 'azure', voiceId: 'en-AU-NatashaNeural', speed: 1.05 });
  });

  it.each([
    ['a first message', { firstMessage: 'Hi, it\'s Lexi.' }, /firstMessage/],
    ['a different first-message mode', { firstMessageMode: 'assistant-speaks-first' }, /firstMessageMode/],
    ['a different model', { model: { provider: 'openai' } }, /custom LLM/],
    ['a different model url', { model: { url: 'https://elsewhere.example/v1' } }, /custom LLM/],
    ['recording switched off', { artifactPlan: { recordingEnabled: false } }, /recording must be enabled/],
    ['a different webhook', { server: { url: 'https://elsewhere.example/hook' } }, /webhook/]
  ])('refuses to send an assistant with %s, whatever assistant_extra says', (_name, extra, message) => {
    expect(() => build(extra as Record<string, unknown>)).toThrow(AssistantInvariantError);
    expect(() => build(extra as Record<string, unknown>)).toThrow(message);
  });

  it('can check an assistant it did not build (the one deployed at the provider)', () => {
    const live = JSON.parse(JSON.stringify(build())) as Record<string, unknown>;
    expect(() => assertAssistantInvariants(live, { publicBaseUrl: BASE })).not.toThrow();
    live.firstMessage = 'Hello! Someone edited me in the dashboard.';
    expect(() => assertAssistantInvariants(live, { publicBaseUrl: BASE })).toThrow(/firstMessage/);
  });
});

describe('who may talk to the webhook', () => {
  const adapter = new VapiAdapter({ apiKey: 'k', webhookSecret: 'hook-secret', assistantId: 'a', phoneNumberIds: {} });

  it('accepts the shared secret, as the provider sends it', () => {
    expect(adapter.verifyWebhook({ 'x-vapi-secret': 'hook-secret' })).toBe(true);
    expect(adapter.verifyWebhook({ authorization: 'Bearer hook-secret' })).toBe(true);
  });

  it('refuses everything else', () => {
    expect(adapter.verifyWebhook({})).toBe(false);
    expect(adapter.verifyWebhook({ 'x-vapi-secret': 'nope' })).toBe(false);
    expect(adapter.verifyWebhook({ 'x-vapi-secret': 'hook-secre' })).toBe(false);
    expect(adapter.verifyWebhook({ 'x-vapi-secret': '' })).toBe(false);
    expect(adapter.verifyWebhook({ authorization: 'Bearer ' })).toBe(false);
    expect(adapter.verifyWebhook({ authorization: 'hook-secret-but-not-bearer-form-xx' })).toBe(false);
  });

  it('refuses everything when no secret is configured, even an empty one', () => {
    const open = new VapiAdapter({ apiKey: 'k', webhookSecret: '', assistantId: 'a', phoneNumberIds: {} });
    expect(open.verifyWebhook({ 'x-vapi-secret': '' })).toBe(false);
    expect(open.verifyWebhook({})).toBe(false);
  });
});

describe('reading what the provider tells us', () => {
  it('reads a status update', () => {
    const event = parseVapiWebhook({
      message: {
        type: 'status-update',
        status: 'ended',
        endedReason: 'customer-did-not-answer',
        call: { id: 'prov-1', assistantOverrides: { metadata: { callId: 'ours-1' } }, monitor: { controlUrl: 'https://x.vapi.ai/c' } }
      }
    });
    expect(event).toMatchObject({
      kind: 'status',
      providerCallId: 'prov-1',
      ourCallId: 'ours-1',
      status: 'ended',
      endedReason: 'customer-did-not-answer',
      controlUrl: 'https://x.vapi.ai/c'
    });
  });

  it('reads an end-of-call report into a transcript, a recording and metrics', () => {
    const event = parseVapiWebhook({
      message: {
        type: 'end-of-call-report',
        endedReason: 'customer-ended-call',
        startedAt: '2026-10-13T02:00:00.000Z',
        endedAt: '2026-10-13T02:01:10.000Z',
        cost: 0.42,
        call: { id: 'prov-1', metadata: { callId: 'ours-1' } },
        artifact: {
          recordingUrl: 'https://storage.vapi.ai/rec.mp3',
          stereoRecordingUrl: 'https://storage.vapi.ai/rec-stereo.mp3',
          messages: [
            { role: 'system', message: 'You are...', secondsFromStart: 0 },
            { role: 'bot', message: "Hi, my name's Lexi. I should say up front, I'm an AI assistant.", secondsFromStart: 0.4 },
            { role: 'user', message: 'Okay, go on.', secondsFromStart: 11.6 },
            { role: 'tool_calls', message: 'ignored', secondsFromStart: 12 },
            { role: 'assistant', message: '  Thanks.  ', secondsFromStart: 13 }
          ],
          performanceMetrics: { turnLatencyAverage: 910, modelLatencyAverage: 420, turnLatencies: [{ turnLatency: 880 }, { turnLatency: 940 }, {}] }
        }
      }
    });
    if (event.kind !== 'report') throw new Error('expected a report');
    expect(event.ourCallId).toBe('ours-1');
    expect(event.durationSec).toBe(70);
    expect(event.recordingUrl).toBe('https://storage.vapi.ai/rec.mp3');
    expect(event.costUsd).toBe(0.42);
    expect(event.messages).toEqual([
      { speaker: 'lexi', text: "Hi, my name's Lexi. I should say up front, I'm an AI assistant.", atSecond: 0 },
      { speaker: 'prospect', text: 'Okay, go on.', atSecond: 12 },
      { speaker: 'lexi', text: 'Thanks.', atSecond: 13 }
    ]);
    expect(event.metrics.turnLatenciesMs).toEqual([880, 940, null]);
    expect(event.metrics.averagesMs).toEqual({ turnLatencyAverage: 910, modelLatencyAverage: 420 });
  });

  it('takes message times from epoch stamps when seconds are not given', () => {
    const event = parseVapiWebhook({
      message: {
        type: 'end-of-call-report',
        startedAt: '2026-10-13T02:00:00.000Z',
        call: { id: 'p' },
        artifact: { messages: [{ role: 'user', message: 'Hello', time: Date.parse('2026-10-13T02:00:07.400Z') }] }
      }
    });
    if (event.kind !== 'report') throw new Error('expected a report');
    expect(event.messages[0]?.atSecond).toBe(7);
  });

  it('ignores what it does not understand rather than failing on it', () => {
    expect(parseVapiWebhook({ message: { type: 'speech-update', call: { id: 'p' } } })).toEqual({ kind: 'ignored', type: 'speech-update' });
    expect(parseVapiWebhook({ message: { type: 'status-update' } })).toEqual({ kind: 'ignored', type: 'status-update' });
    expect(parseVapiWebhook({})).toEqual({ kind: 'ignored', type: 'unknown' });
    expect(parseVapiWebhook('nonsense')).toEqual({ kind: 'ignored', type: 'unknown' });
  });
});

describe('talking to the provider', () => {
  const make = (route: Parameters<typeof fakeFetch>[0]) => {
    const fetchImpl = fakeFetch(route);
    return { fetchImpl, adapter: new VapiAdapter({ apiKey: 'api-key', webhookSecret: 's', assistantId: 'a', phoneNumberIds: {}, fetch: fetchImpl }) };
  };

  it('hangs a call up through its control URL, and only if that is a Vapi address', async () => {
    const { fetchImpl, adapter } = make(() => ({ json: {} }));
    await adapter.hangUp({ providerCallId: 'p', controlUrl: 'https://phone-call-websocket.aws.vapi.ai/p/control' });
    expect(fetchImpl.calls[0]).toMatchObject({ url: 'https://phone-call-websocket.aws.vapi.ai/p/control', body: { type: 'end-call' } });

    await expect(adapter.hangUp({ providerCallId: 'p', controlUrl: 'https://evil.example.com/control' })).rejects.toThrow(/not a Vapi host/);
    await expect(adapter.hangUp({ providerCallId: 'p', controlUrl: null })).rejects.toThrow(/no control URL/);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('knows what is a Vapi host', () => {
    expect(isVapiHost(new URL('https://storage.vapi.ai/x'))).toBe(true);
    expect(isVapiHost(new URL('https://vapi.ai/x'))).toBe(true);
    expect(isVapiHost(new URL('https://notvapi.ai/x'))).toBe(false);
    expect(isVapiHost(new URL('https://vapi.ai.evil.com/x'))).toBe(false);
    expect(isVapiHost(new URL('http://storage.vapi.ai/x'))).toBe(false);
  });

  it('sends the API key to Vapi\'s own hosts only', () => {
    const { adapter } = make(() => ({ json: {} }));
    expect(adapter.artifactHeaders(new URL('https://storage.vapi.ai/rec.mp3'))).toEqual({ authorization: 'Bearer api-key' });
    expect(adapter.artifactHeaders(new URL('https://attacker.example.com/rec.mp3'))).toEqual({});
  });

  it('deletes a call\'s artifacts', async () => {
    const { fetchImpl, adapter } = make(() => ({ json: {} }));
    await adapter.deleteArtifacts('prov-1');
    expect(fetchImpl.calls[0]).toMatchObject({ method: 'DELETE', url: 'https://api.vapi.ai/call/prov-1' });
  });

  it('updates the assistant it already has instead of creating a second', async () => {
    const { fetchImpl, adapter } = make((call) =>
      call.method === 'GET' ? { json: [{ id: 'other', name: 'Someone else' }, { id: 'ours', name: 'Lexi (ANZ Voice SDR)' }] } : { json: { id: 'ours' } }
    );
    const result = await adapter.upsertAssistant(build());
    expect(result).toEqual({ id: 'ours', created: false });
    expect(fetchImpl.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);

    const fresh = make((call) => (call.method === 'GET' ? { json: [] } : { json: { id: 'new-id' } }));
    expect(await fresh.adapter.upsertAssistant(build())).toEqual({ id: 'new-id', created: true });
  });

  describe('when creating a call goes wrong', () => {
    // These go through the real permit path in permit.test.ts; here a transport
    // failure is simulated at the seam that matters: is the call "maybe placed"?
    const permitted = async () => {
      const { world: makeWorld, seedContact, TUESDAY, TEST_PHONE } = await import('./support.js');
      const { requestDialPermit } = await import('../../src/voice/permit.js');
      const w = await makeWorld();
      const seeded = await seedContact(w.db);
      const permit = await requestDialPermit(w.gate, w.policy, {
        requestId: 'r',
        contactId: seeded.contactId,
        accountId: seeded.accountId,
        campaignId: seeded.campaignId,
        phone: TEST_PHONE,
        market: 'AU',
        source: 'operator',
        at: TUESDAY
      });
      return { permit, close: () => w.close(), TUESDAY };
    };
    const adapterFor = (route: Parameters<typeof fakeFetch>[0], now: Date) =>
      new VapiAdapter({ apiKey: 'k', webhookSecret: 's', assistantId: 'a', phoneNumberIds: { AU: 'pn-au' }, fetch: fakeFetch(route), now: () => now });
    const phoneOk = (call: { url: string; method: string }) =>
      call.method === 'GET' ? { json: { number: '+61280000000' } } : undefined;

    it('a 4xx means nothing was placed', async () => {
      const { permit, close, TUESDAY } = await permitted();
      const adapter = adapterFor((call) => phoneOk(call) ?? { status: 401, text: 'bad key' }, TUESDAY);
      await expect(adapter.placeCall(permit, { callId: 'c' })).rejects.toBeInstanceOf(ProviderRejectedError);
      await close();
    });

    it('a 5xx, a dropped connection, or a reply that is not a call all mean "maybe placed"', async () => {
      for (const reply of [{ status: 502, text: 'bad gateway' }, new Error('socket hang up'), { json: { unexpected: true } }, { text: 'not json at all' }]) {
        const { permit, close, TUESDAY } = await permitted();
        const adapter = adapterFor((call) => phoneOk(call) ?? reply, TUESDAY);
        await expect(adapter.placeCall(permit, { callId: 'c' })).rejects.toBeInstanceOf(ProviderUncertainError);
        await close();
      }
    });
  });
});
