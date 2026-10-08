import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ApolloStatusVerifier,
  deliverabilityFromApollo,
  emailInUse,
  selectEmail,
  storeApolloEmail,
  type EmailRow,
  type EmailVerifier
} from '../../src/data/email.js';
import { addContact, world } from '../support/phase3.js';

const row = (kind: EmailRow['kind'], verified: boolean, address = `${kind}@x.example`): EmailRow => ({ kind, verified, address });

describe('which email is used', () => {
  it('lets an address confirmed on the call win over anything Apollo says, verified or not', () => {
    const chosen = selectEmail([row('apollo_work', true), row('apollo_personal', true), row('confirmed_on_call', false)]);
    expect(chosen?.kind).toBe('confirmed_on_call');
  });

  it('prefers the work address to the personal one', () => {
    expect(selectEmail([row('apollo_personal', true), row('apollo_work', true)])?.kind).toBe('apollo_work');
  });

  it('passes over an Apollo address that has not been verified, and falls through to one that has', () => {
    expect(selectEmail([row('apollo_work', false), row('apollo_personal', true)])?.kind).toBe('apollo_personal');
    expect(selectEmail([row('apollo_work', false)])).toBeNull();
  });

  it('can be asked to ignore verification, for a view that only wants to show what is held', () => {
    expect(selectEmail([row('apollo_work', false)], { requireVerified: false })?.kind).toBe('apollo_work');
  });

  it('returns nothing when there is nothing', () => {
    expect(selectEmail([])).toBeNull();
  });
});

describe('verification through Apollo\'s own status', () => {
  it.each([
    ['verified', 'valid'],
    ['Verified', 'valid'],
    ['unverified', 'risky'],
    ['likely to engage', 'risky'],
    ['extrapolated', 'risky'],
    ['catch-all', 'risky'],
    ['unavailable', 'invalid'],
    ['bounced', 'invalid'],
    ['something new', 'unknown'],
    [undefined, 'unknown']
  ])('%s is %s', (status, expected) => {
    expect(deliverabilityFromApollo(status)).toBe(expected);
  });

  it('reports its provider and when it checked', async () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const result = await new ApolloStatusVerifier(() => at).verify('a@b.example', { apolloStatus: 'verified' });
    expect(result).toEqual({ status: 'valid', provider: 'apollo-email-status', checkedAt: at });
  });
});

const dbs: Array<{ $disconnect(): Promise<void> }> = [];
afterAll(async () => {
  for (const d of dbs) await d.$disconnect();
});

describe('storing an Apollo address on a contact', () => {
  it('stores a verified work email as verified, with the time', async () => {
    const w = await world();
    dbs.push(w.db);
    const contactId = await addContact(w, 'bank.example');
    const result = await storeApolloEmail(w.db, contactId, { address: 'Priya@Bank.Example', kind: 'apollo_work', apolloStatus: 'verified' }, new ApolloStatusVerifier());
    expect(result).toEqual({ stored: true, kind: 'apollo_work', verified: true });
    const stored = await w.db.contactEmail.findFirstOrThrow({ where: { contactId } });
    expect(stored).toMatchObject({ address: 'priya@bank.example', kind: 'apollo_work', verified: true });
    expect(stored.verifiedAt).not.toBeNull();
  });

  it('stores a risky address, unverified, so it is held but not used', async () => {
    const w = await world();
    dbs.push(w.db);
    const contactId = await addContact(w, 'bank.example');
    await storeApolloEmail(w.db, contactId, { address: 'p@bank.example', kind: 'apollo_work', apolloStatus: 'likely to engage' }, new ApolloStatusVerifier());
    expect(await emailInUse(w.db, contactId)).toBeNull();
    expect((await emailInUse(w.db, contactId, { requireVerified: false }))?.address).toBe('p@bank.example');
  });

  it('does not hold an address the verifier calls undeliverable', async () => {
    const w = await world();
    dbs.push(w.db);
    const contactId = await addContact(w, 'bank.example');
    const result = await storeApolloEmail(w.db, contactId, { address: 'dead@bank.example', kind: 'apollo_work', apolloStatus: 'unavailable' }, new ApolloStatusVerifier());
    expect(result.stored).toBe(false);
    expect(await w.db.contactEmail.count()).toBe(0);
  });

  it('never touches an address confirmed on the call', async () => {
    const w = await world();
    dbs.push(w.db);
    const contactId = await addContact(w, 'bank.example');
    await w.db.contactEmail.create({
      data: { id: randomUUID(), contactId, address: 'heard-on-call@bank.example', kind: 'confirmed_on_call', verified: false }
    });
    await storeApolloEmail(w.db, contactId, { address: 'apollo@bank.example', kind: 'apollo_work', apolloStatus: 'verified' }, new ApolloStatusVerifier());
    const rows = await w.db.contactEmail.findMany({ where: { contactId }, orderBy: { kind: 'asc' } });
    expect(rows.map((r) => [r.kind, r.address])).toEqual([
      ['apollo_work', 'apollo@bank.example'],
      ['confirmed_on_call', 'heard-on-call@bank.example']
    ]);
    expect((await emailInUse(w.db, contactId))?.address).toBe('heard-on-call@bank.example');
  });

  it('replaces the previous Apollo address for the same kind rather than adding a second', async () => {
    const w = await world();
    dbs.push(w.db);
    const contactId = await addContact(w, 'bank.example');
    const verifier = new ApolloStatusVerifier();
    await storeApolloEmail(w.db, contactId, { address: 'old@bank.example', kind: 'apollo_work', apolloStatus: 'verified' }, verifier);
    await storeApolloEmail(w.db, contactId, { address: 'new@bank.example', kind: 'apollo_work', apolloStatus: 'verified' }, verifier);
    expect((await w.db.contactEmail.findMany({ where: { contactId } })).map((r) => r.address)).toEqual(['new@bank.example']);
  });

  it('accepts any verifier behind the interface', async () => {
    const w = await world();
    dbs.push(w.db);
    const contactId = await addContact(w, 'bank.example');
    const strict: EmailVerifier = {
      name: 'always-risky',
      verify: async () => ({ status: 'risky', provider: 'always-risky', checkedAt: new Date() })
    };
    const result = await storeApolloEmail(w.db, contactId, { address: 'a@bank.example', kind: 'apollo_work', apolloStatus: 'verified' }, strict);
    expect(result).toEqual({ stored: true, kind: 'apollo_work', verified: false });
  });
});
