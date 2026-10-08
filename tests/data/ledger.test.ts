/**
 * The enrichment ledger is what makes "never re-buy" true, so the in-memory and
 * the blackboard implementations are held to one suite. If they could disagree,
 * the tests that pass on one would mean nothing on the other.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createTestBlackboard } from '../../src/blackboard/client.js';
import { InMemoryEnrichmentLedger, PrismaEnrichmentLedger, type EmailPurchase, type EnrichmentLedger } from '../../src/data/enrichment-ledger.js';

const dbs: Array<Awaited<ReturnType<typeof createTestBlackboard>>> = [];
afterAll(async () => {
  for (const db of dbs) await db.$disconnect();
});

const purchase = (over: Partial<EmailPurchase> = {}): EmailPurchase => ({
  apolloId: 'a1',
  boughtAt: '2026-10-01T00:00:00.000Z',
  matched: true,
  person: {
    apolloId: 'a1',
    firstName: 'Priya',
    lastName: 'Raman',
    lastNameObfuscated: false,
    title: 'Chief Data Officer',
    email: 'priya@bank.example',
    emailStatus: 'verified',
    personalEmails: [],
    phones: []
  },
  credits: 1,
  estimated: false,
  ...over
});

const implementations: Array<[string, () => Promise<EnrichmentLedger>]> = [
  ['in memory', async () => new InMemoryEnrichmentLedger()],
  [
    'on the blackboard',
    async () => {
      const db = await createTestBlackboard();
      dbs.push(db);
      return new PrismaEnrichmentLedger(db);
    }
  ]
];

describe.each(implementations)('enrichment ledger, %s', (_name, make) => {
  it('remembers an email purchase, whole', async () => {
    const ledger = await make();
    expect(await ledger.getEmail('a1')).toBeNull();
    expect(await ledger.recordEmail(purchase())).toBe(true);
    expect(await ledger.getEmail('a1')).toEqual(purchase());
  });

  it('keeps the first write and refuses the second, so a purchase is never overwritten', async () => {
    const ledger = await make();
    await ledger.recordEmail(purchase());
    expect(await ledger.recordEmail(purchase({ credits: 99 }))).toBe(false);
    expect((await ledger.getEmail('a1'))?.credits).toBe(1);
  });

  it('records a miss', async () => {
    const ledger = await make();
    await ledger.recordEmail({ apolloId: 'ghost', boughtAt: '2026-10-01T00:00:00.000Z', matched: false, credits: 0, estimated: true });
    expect(await ledger.getEmail('ghost')).toMatchObject({ matched: false });
  });

  it('attaches the Apollo contact id to an existing purchase', async () => {
    const ledger = await make();
    await ledger.recordEmail(purchase());
    await ledger.setApolloContact('a1', 'ac-9');
    expect((await ledger.getEmail('a1'))?.apolloContactId).toBe('ac-9');
    await ledger.setApolloContact('nobody', 'ac-1'); // no purchase, no effect, no error
    expect(await ledger.getEmail('nobody')).toBeNull();
  });

  const phoneRequest = {
    apolloId: 'a1',
    requestedAt: '2026-10-01T00:00:00.000Z',
    estimatedCredits: 8,
    status: 'requested' as const,
    deliveries: [],
    numbers: []
  };

  it('applies a phone delivery once, and recognises Apollo\'s retry of it', async () => {
    const ledger = await make();
    expect(await ledger.recordPhoneRequest(phoneRequest)).toBe(true);
    expect(await ledger.recordPhoneRequest(phoneRequest)).toBe(false);

    const numbers = [{ number: '+61290001234', kind: 'work_direct' as const }];
    const at = new Date('2026-10-01T00:05:00.000Z');
    const first = await ledger.recordPhoneDelivery('a1', 'key-1', numbers, at);
    expect(first).toMatchObject({ applied: true, request: { status: 'delivered' } });

    expect(await ledger.recordPhoneDelivery('a1', 'key-1', numbers, at)).toEqual({ applied: false, reason: 'duplicate' });
    const stored = await ledger.getPhone('a1');
    expect(stored?.deliveries).toHaveLength(1);
    expect(stored?.numbers).toHaveLength(1);
  });

  it('merges a different delivery for the same person without duplicating a number', async () => {
    const ledger = await make();
    await ledger.recordPhoneRequest(phoneRequest);
    const direct = { number: '+61290001234', kind: 'work_direct' as const };
    const mobile = { number: '+61412345678', kind: 'mobile' as const };
    await ledger.recordPhoneDelivery('a1', 'k1', [direct], new Date());
    await ledger.recordPhoneDelivery('a1', 'k2', [direct, mobile], new Date());
    const stored = await ledger.getPhone('a1');
    expect(stored?.numbers.map((n) => n.number)).toEqual(['+61290001234', '+61412345678']);
    expect(stored?.deliveries).toHaveLength(2);
  });

  it('records an empty delivery as "none"', async () => {
    const ledger = await make();
    await ledger.recordPhoneRequest(phoneRequest);
    expect(await ledger.recordPhoneDelivery('a1', 'k', [], new Date())).toMatchObject({ applied: true, request: { status: 'none' } });
  });

  it('refuses a delivery for someone we never asked about', async () => {
    const ledger = await make();
    expect(await ledger.recordPhoneDelivery('stranger', 'k', [{ number: '+61290001234', kind: 'unknown' }], new Date())).toEqual({
      applied: false,
      reason: 'unrequested'
    });
    expect(await ledger.getPhone('stranger')).toBeNull();
  });

  it('keeps an organisation purchase keyed on its domain, case-insensitively', async () => {
    const ledger = await make();
    const org = {
      domain: 'Bank.Example',
      boughtAt: '2026-10-01T00:00:00.000Z',
      credits: 1,
      organization: { apolloId: 'org1', name: 'Bank', domain: 'bank.example' }
    };
    expect(await ledger.recordOrganization(org)).toBe(true);
    expect(await ledger.recordOrganization(org)).toBe(false);
    expect((await ledger.getOrganization('bank.example'))?.organization?.apolloId).toBe('org1');
  });
});

describe('the blackboard ledger', () => {
  it('stops at a corrupt record rather than handing an agent a plausible value', async () => {
    const db = await createTestBlackboard();
    dbs.push(db);
    await db.memory.create({
      data: { id: 'apollo:email:bad', scope: 'contact', key: 'apollo:bad', kind: 'apollo-email', summary: 'x', content: '{"apolloId": 5}' }
    });
    await expect(new PrismaEnrichmentLedger(db).getEmail('bad')).rejects.toThrow(/does not match its schema/);
  });

  it('does not depend on a Contact row existing', async () => {
    const db = await createTestBlackboard();
    dbs.push(db);
    const ledger = new PrismaEnrichmentLedger(db);
    await ledger.recordEmail(purchase());
    expect(await db.contact.count()).toBe(0);
    expect(await ledger.getEmail('a1')).not.toBeNull();
  });
});
