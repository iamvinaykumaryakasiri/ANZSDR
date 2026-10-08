/**
 * "There must be NO code path from your adapter to a provider that bypasses the
 * gate."
 *
 * The adapter takes a permit and no number. These tests try to get a call out
 * without one, with a counterfeit, with a used one, with an out-of-date one, and
 * through a gate that is not the gate - and assert that the provider is never
 * so much as contacted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { DialRequest } from '../../src/compliance/types.js';
import { DialDenied, PermitRejected, redeemPermit, requestDialPermit, type DialPermit } from '../../src/voice/permit.js';
import { VapiAdapter } from '../../src/voice/vapi.js';
import { CALLER_ID, TEST_PHONE, TUESDAY, fakeFetch, seedContact, world, type World } from './support.js';

let worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds) await w.close();
  worlds = [];
});

async function ready(overrides = {}) {
  const w = await world(overrides);
  worlds.push(w);
  const seeded = await seedContact(w.db);
  const request: DialRequest = {
    requestId: 'req-1',
    contactId: seeded.contactId,
    accountId: seeded.accountId,
    campaignId: seeded.campaignId,
    phone: TEST_PHONE,
    market: 'AU',
    source: 'operator',
    at: TUESDAY
  };
  return { w, seeded, request };
}

function adapter(fetchImpl: ReturnType<typeof fakeFetch>, now = TUESDAY) {
  return new VapiAdapter({
    apiKey: 'api-key',
    webhookSecret: 'hook',
    assistantId: 'assistant-1',
    phoneNumberIds: { AU: 'pn-au', NZ: 'pn-nz' },
    fetch: fetchImpl,
    now: () => now
  });
}

const provider = () =>
  fakeFetch((call) => {
    if (call.method === 'GET' && call.url.endsWith('/phone-number/pn-au')) return { json: { id: 'pn-au', number: CALLER_ID } };
    if (call.method === 'POST' && call.url.endsWith('/call')) {
      return { json: { id: 'prov-9', status: 'queued', monitor: { controlUrl: 'https://phone-call-websocket.aws.vapi.ai/prov-9/control' } } };
    }
    return { status: 404, text: 'no such route' };
  });

describe('getting a permit', () => {
  it('is possible only when the gate allows the dial, and names the number the gate ruled on', async () => {
    const { w, request } = await ready();
    const permit = await requestDialPermit(w.gate, w.policy, request);

    expect(permit.e164).toBe(TEST_PHONE);
    expect(permit.callerId).toBe(CALLER_ID);
    expect(permit.market).toBe('AU');
    expect(permit.expiresAt.getTime()).toBeGreaterThan(permit.issuedAt.getTime());
    expect(Object.isFrozen(permit)).toBe(true);
    expect(() => {
      (permit as { e164: string }).e164 = '+61400000000';
    }).toThrow(TypeError);
  });

  it('is refused, with every reason, when the gate says no', async () => {
    const { w, request } = await ready();
    await w.killSwitch.trip('operator', 'testing', TUESDAY);

    const error = await requestDialPermit(w.gate, w.policy, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DialDenied);
    expect((error as DialDenied).decision.reasons.map((r) => r.code)).toContain('KILL_SWITCH_ACTIVE');
  });

  it('is refused when no caller ID is configured (the gate says CALLER_ID_NOT_CONFIGURED)', async () => {
    const { w, request } = await ready({ callerIdAu: '' });
    const error = await requestDialPermit(w.gate, w.policy, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DialDenied);
    expect((error as DialDenied).decision.reasons.map((r) => r.code)).toContain('CALLER_ID_NOT_CONFIGURED');
  });

  it('is refused for a real prospect while the system is in test mode', async () => {
    const w = await world();
    worlds.push(w);
    const seeded = await seedContact(w.db, { kind: 'prospect' });
    const error = await requestDialPermit(w.gate, w.policy, {
      requestId: 'r',
      contactId: seeded.contactId,
      accountId: seeded.accountId,
      campaignId: seeded.campaignId,
      phone: TEST_PHONE,
      market: 'AU',
      source: 'orchestrator',
      at: TUESDAY
    }).catch((e: unknown) => e);
    expect((error as DialDenied).decision.reasons.map((r) => r.code)).toContain('NOT_A_TEST_CONTACT');
  });

  it('cannot be had from a look-alike gate that says yes to everything', async () => {
    const { w, request } = await ready();
    const impostor = {
      request: async () => ({ allowed: true, reasons: [], evaluatedAt: TUESDAY, requestId: 'x', evidence: { number: { e164: '+61400000000' }, policyVersion: 'x' } })
    };
    await expect(requestDialPermit(impostor as never, w.policy, request)).rejects.toThrow(TypeError);
  });
});

describe('using a permit', () => {
  it('a counterfeit is not a permit, however well it is made', async () => {
    const { w, request } = await ready();
    const real = await requestDialPermit(w.gate, w.policy, request);

    for (const fake of [{ ...real }, Object.freeze({ ...real }), {}, null, undefined, 'permit', { e164: '+61400000000' }]) {
      expect(() => redeemPermit(fake as unknown as DialPermit, TUESDAY)).toThrow(PermitRejected);
    }
    // The real one is untouched by all that.
    expect(() => redeemPermit(real, TUESDAY)).not.toThrow();
  });

  it('is good once', async () => {
    const { w, request } = await ready();
    const permit = await requestDialPermit(w.gate, w.policy, request);
    redeemPermit(permit, TUESDAY);
    expect(() => redeemPermit(permit, TUESDAY)).toThrow(/already been used/);
  });

  it('goes out of date', async () => {
    const { w, request } = await ready();
    const permit = await requestDialPermit(w.gate, w.policy, request, { ttlMs: 1000 });
    expect(() => redeemPermit(permit, new Date(TUESDAY.getTime() + 5000))).toThrow(/expired/);
  });
});

describe('the adapter will not place a call without one', () => {
  it('contacts nobody when handed a counterfeit permit', async () => {
    const { w, request } = await ready();
    const real = await requestDialPermit(w.gate, w.policy, request);
    const fetchImpl = provider();

    await expect(adapter(fetchImpl).placeCall({ ...real } as DialPermit, { callId: 'c1' })).rejects.toThrow(PermitRejected);
    await expect(adapter(fetchImpl).placeCall(undefined as never, { callId: 'c1' })).rejects.toThrow(PermitRejected);
    await expect(adapter(fetchImpl).placeCall({ e164: '+61400000000', callerId: CALLER_ID, market: 'AU' } as never, { callId: 'c1' })).rejects.toThrow(PermitRejected);

    expect(fetchImpl.calls).toEqual([]);
  });

  it('with a real permit, dials the number the gate ruled on and nothing else', async () => {
    const { w, request } = await ready();
    const permit = await requestDialPermit(w.gate, w.policy, request);
    const fetchImpl = provider();

    const placed = await adapter(fetchImpl).placeCall(permit, { callId: 'our-call-id' });
    expect(placed.providerCallId).toBe('prov-9');
    expect(placed.controlUrl).toContain('vapi.ai');

    const post = fetchImpl.calls.find((c) => c.method === 'POST' && c.url.endsWith('/call'));
    expect(post?.body).toEqual({
      assistantId: 'assistant-1',
      // Our id and nothing about the person.
      assistantOverrides: { metadata: { callId: 'our-call-id' } },
      phoneNumberId: 'pn-au',
      customer: { number: TEST_PHONE, numberE164CheckEnabled: true },
      name: 'lexi-our-call'
    });
    expect(post?.headers.authorization).toBe('Bearer api-key');

    // And the same permit cannot ring a second time.
    await expect(adapter(fetchImpl).placeCall(permit, { callId: 'again' })).rejects.toThrow(/already been used/);
  });

  it('refuses to present a caller ID other than the one the gate approved', async () => {
    const { w, request } = await ready();
    const permit = await requestDialPermit(w.gate, w.policy, request);
    const fetchImpl = fakeFetch((call) =>
      call.url.endsWith('/phone-number/pn-au') ? { json: { id: 'pn-au', number: '+61299999999' } } : { json: { id: 'prov' } }
    );

    await expect(adapter(fetchImpl).placeCall(permit, { callId: 'c' })).rejects.toThrow(/different number/);
    expect(fetchImpl.calls.some((c) => c.method === 'POST' && c.url.endsWith('/call'))).toBe(false);
  });

  it('refuses when there is no provider number for the market', async () => {
    const { w, request } = await ready();
    const permit = await requestDialPermit(w.gate, w.policy, request);
    const noNumbers = new VapiAdapter({ apiKey: 'k', webhookSecret: 's', assistantId: 'a', phoneNumberIds: {}, fetch: provider(), now: () => TUESDAY });
    await expect(noNumbers.placeCall(permit, { callId: 'c' })).rejects.toThrow(/VAPI_PHONE_NUMBER_ID_AU/);
  });
});
