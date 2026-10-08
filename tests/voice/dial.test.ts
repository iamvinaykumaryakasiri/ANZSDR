/**
 * Placing a test call: the contact must be a test contact, the gate must say
 * yes, and a failure must not leave the single live-call slot held.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { loadIdentityFromObject } from '../../src/agents/caller/identity.js';
import { operationalDate } from '../../src/compliance/gate.js';
import { CallStore } from '../../src/voice/call-store.js';
import { placeTestCall, type DialDeps } from '../../src/voice/dial.js';
import { ProviderRejectedError, ProviderUncertainError } from '../../src/voice/provider.js';
import { CALLER_ID, EMPTY_PACK, FakeAdapter, IDENTITY, TEST_PHONE, TUESDAY, claimIndex, seedContact, world, type World } from './support.js';

let worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds) await w.close();
  worlds = [];
});

async function setup(overrides = {}, identity = IDENTITY) {
  const w = await world(overrides);
  worlds.push(w);
  const adapter = new FakeAdapter();
  const deps: DialDeps = {
    db: w.db,
    gate: w.gate,
    policy: w.policy,
    adapter,
    briefing: { db: w.db, identity, claims: () => claimIndex(), pack: () => EMPTY_PACK },
    now: () => TUESDAY
  };
  return { w, adapter, deps };
}

describe('only a test contact can be rung', () => {
  it('refuses a real prospect before the gate is even asked', async () => {
    const { w, adapter, deps } = await setup();
    const { contactId } = await seedContact(w.db, { kind: 'prospect' });

    const result = await placeTestCall(deps, contactId);
    expect(result).toMatchObject({ ok: false, refused: 'NOT_A_TEST_CONTACT' });
    expect(adapter.placed).toEqual([]);
    expect(await w.auditCount()).toBe(0);
    expect(await w.db.call.count()).toBe(0);
  });

  it('refuses a real prospect even with the gate\'s own test-mode fence taken down', async () => {
    // The two fences are independent. Turning test_contacts_only off (which is
    // what the phase 9 pilot will do) does not make this command ring strangers.
    const { w, adapter, deps } = await setup({ testContactsOnly: false });
    const { contactId } = await seedContact(w.db, { kind: 'prospect' });

    const result = await placeTestCall(deps, contactId);
    expect(result).toMatchObject({ ok: false, refused: 'NOT_A_TEST_CONTACT' });
    expect(adapter.placed).toEqual([]);
  });

  it('reads the kind from the blackboard at the moment of dialling', async () => {
    const { w, adapter, deps } = await setup();
    const { contactId } = await seedContact(w.db, { kind: 'test' });
    await w.db.contact.update({ where: { id: contactId }, data: { kind: 'prospect' } });

    expect(await placeTestCall(deps, contactId)).toMatchObject({ ok: false, refused: 'NOT_A_TEST_CONTACT' });
    expect(adapter.placed).toEqual([]);
  });

  it('refuses a contact that does not exist, or has no number', async () => {
    const { w, deps } = await setup();
    expect(await placeTestCall(deps, 'nobody')).toMatchObject({ ok: false, refused: 'CONTACT_NOT_FOUND' });
    const { contactId } = await seedContact(w.db, { phone: null });
    expect(await placeTestCall(deps, contactId)).toMatchObject({ ok: false, refused: 'NO_PHONE_NUMBER' });
  });
});

describe('a test call that the gate allows', () => {
  it('goes to the provider on a permit for exactly that number, and is recorded', async () => {
    const { w, adapter, deps } = await setup();
    const { contactId } = await seedContact(w.db);

    const result = await placeTestCall(deps, contactId);
    expect(result).toMatchObject({ ok: true, providerCallId: 'prov-1', e164: TEST_PHONE, callerId: CALLER_ID });
    if (!result.ok) throw new Error('unreachable');

    expect(adapter.placed).toHaveLength(1);
    expect(adapter.placed[0]?.permit.e164).toBe(TEST_PHONE);
    expect(adapter.placed[0]?.request.callId).toBe(result.callId);

    const calls = new CallStore(w.db);
    const call = await calls.get(result.callId);
    expect(call).toMatchObject({ providerCallId: 'prov-1', endedAt: null, contactId });
    expect((await calls.metrics(result.callId)).controlUrl).toContain('vapi.ai');
    expect(await w.db.dialAttempt.findMany({ where: { callId: result.callId } })).toHaveLength(1);
    expect(await w.auditCount()).toBe(1);
  });

  it('a second dial to the same number the same day is refused', async () => {
    const { w, deps } = await setup();
    const { contactId } = await seedContact(w.db);
    expect((await placeTestCall(deps, contactId)).ok).toBe(true);

    const second = await placeTestCall(deps, contactId);
    expect(second.ok).toBe(false);
    if (second.ok || second.refused !== 'GATE_DENIED') throw new Error('expected the gate to refuse');
    expect(second.reasons?.map((r) => r.code)).toContain('NUMBER_ALREADY_DIALLED_TODAY');
  });
});

describe('a test call that the gate refuses', () => {
  it('never reaches the provider, and says every reason', async () => {
    const { w, adapter, deps } = await setup();
    const { contactId } = await seedContact(w.db);
    await w.killSwitch.trip('operator', 'testing', TUESDAY);

    const result = await placeTestCall(deps, contactId);
    expect(result).toMatchObject({ ok: false, refused: 'GATE_DENIED' });
    expect(result.ok ? [] : result.reasons?.map((r) => r.code)).toContain('KILL_SWITCH_ACTIVE');
    expect(adapter.placed).toEqual([]);
    // No call record is created for a call that was never going to happen.
    expect(await w.db.call.count()).toBe(0);
    expect(await w.db.dialAttempt.count()).toBe(0);
  });

  it('with no caller ID configured, says CALLER_ID_NOT_CONFIGURED and places nothing', async () => {
    const { w, adapter, deps } = await setup({ callerIdAu: '' });
    const { contactId } = await seedContact(w.db);
    const result = await placeTestCall(deps, contactId);
    expect(result.ok ? [] : result.reasons?.map((r) => r.code)).toContain('CALLER_ID_NOT_CONFIGURED');
    expect(adapter.placed).toEqual([]);
  });

  it('without an approved plan for today, says DAY_PLAN_NOT_APPROVED; with one, goes ahead', async () => {
    const { w, adapter, deps } = await setup({ requireDailyPlan: true });
    const seeded = await seedContact(w.db);

    const before = await placeTestCall(deps, seeded.contactId);
    expect(before.ok ? [] : before.reasons?.map((r) => r.code)).toContain('DAY_PLAN_NOT_APPROVED');
    expect(adapter.placed).toEqual([]);

    const plan = await w.plans.draft(
      seeded.campaignId,
      operationalDate(TUESDAY, w.policy),
      [
        {
          contactId: seeded.contactId,
          accountId: seeded.accountId,
          e164: TEST_PHONE,
          displayName: 'Vinay Test',
          title: 'Head of Data',
          accountName: 'Kiwibank',
          hypothesis: '',
          gateAllowed: true,
          gateReasons: [],
          earliestAt: TUESDAY
        }
      ],
      TUESDAY
    );
    await w.plans.submit(plan.id, TUESDAY);
    await w.plans.approve(plan.id, 'vinay', TUESDAY, '');

    const after = await placeTestCall(deps, seeded.contactId);
    expect(after.ok).toBe(true);
    expect(adapter.placed).toHaveLength(1);
  });
});

describe('a call that cannot be briefed', () => {
  it('is not placed: a phone that rings into silence wastes the day\'s one dial', async () => {
    const nameless = loadIdentityFromObject({
      agent: { name: '', gender: 'female', accent: 'au-neutral' },
      operator: IDENTITY.operator,
      callback: IDENTITY.callback
    });
    const { w, adapter, deps } = await setup({}, nameless);
    const { contactId } = await seedContact(w.db);

    const result = await placeTestCall(deps, contactId);
    expect(result).toMatchObject({ ok: false, refused: 'BRIEFING_UNAVAILABLE' });
    expect(result.ok ? '' : result.detail).toContain('agent.name');
    expect(adapter.placed).toEqual([]);
    expect(await w.auditCount()).toBe(0);
  });
});

describe('when the provider fails', () => {
  it('a definite refusal costs no attempt and does not hold the live-call slot', async () => {
    const { w, adapter, deps } = await setup();
    const { contactId } = await seedContact(w.db);
    adapter.placeResult = new ProviderRejectedError('401 bad key', 401);

    const result = await placeTestCall(deps, contactId);
    expect(result).toMatchObject({ ok: false, refused: 'PROVIDER_REJECTED' });
    expect(await w.db.dialAttempt.count()).toBe(0);
    const row = await w.db.call.findFirst();
    expect(row?.endedAt).not.toBeNull();

    // Fixing the key and trying again works: the number was not used up.
    adapter.placeResult = { providerCallId: 'prov-2', controlUrl: null, providerStatus: 'queued' };
    expect(await placeTestCall(deps, contactId)).toMatchObject({ ok: true, providerCallId: 'prov-2' });
  });

  it('an unknown outcome is counted, because the phone may have rung', async () => {
    const { w, adapter, deps } = await setup();
    const { contactId } = await seedContact(w.db);
    adapter.placeResult = new ProviderUncertainError('timed out');

    const result = await placeTestCall(deps, contactId);
    expect(result).toMatchObject({ ok: false, refused: 'PROVIDER_UNCERTAIN' });
    expect(await w.db.dialAttempt.count()).toBe(1);
    expect((await w.db.call.findFirst())?.endedAt).not.toBeNull();

    // And the number cannot be rung again today.
    adapter.placeResult = { providerCallId: 'p', controlUrl: null, providerStatus: 'queued' };
    const again = await placeTestCall(deps, contactId);
    expect(again.ok ? [] : again.reasons?.map((r) => r.code)).toContain('NUMBER_ALREADY_DIALLED_TODAY');
  });
});
