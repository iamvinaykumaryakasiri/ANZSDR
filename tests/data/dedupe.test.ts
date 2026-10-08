import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { accountSuppression, findHeldContacts, isFullyHeld, lastNameMatches } from '../../src/data/dedupe.js';
import { addContact, world } from '../support/phase3.js';

describe('matching a masked surname', () => {
  it('matches the visible letters and treats the stars as anything', () => {
    expect(lastNameMatches('Raman', 'Ra***n', true)).toBe(true);
    expect(lastNameMatches('Whitcombe', 'Wh***be', true)).toBe(true);
    expect(lastNameMatches('Ramsay', 'Ra***n', true)).toBe(false);
    expect(lastNameMatches('Smith', 'Ra***n', true)).toBe(false);
  });

  it('is exact for an unmasked surname, and ignores case', () => {
    expect(lastNameMatches('raman', 'RAMAN', false)).toBe(true);
    expect(lastNameMatches('Raman', 'Ramanathan', false)).toBe(false);
  });

  it('matches nothing against nothing', () => {
    expect(lastNameMatches('', 'Raman', false)).toBe(false);
    expect(lastNameMatches('Raman', '', false)).toBe(false);
  });

  it('does not let a regex character in a surname change the pattern', () => {
    expect(lastNameMatches("O'Br.an", "O'Br.***", true)).toBe(true);
    expect(lastNameMatches("O'Brian", "O'Br.***", true)).toBe(false);
  });
});

const dbs: Array<{ $disconnect(): Promise<void> }> = [];
afterAll(async () => {
  for (const d of dbs) await d.$disconnect();
});

describe('finding people we already hold', () => {
  it('finds them by Apollo id, by exact name, and by a masked surname at the same account', async () => {
    const w = await world([
      { domain: 'bank.example', name: 'Bank' },
      { domain: 'other.example', name: 'Other' }
    ]);
    dbs.push(w.db);
    const byId = await addContact(w, 'bank.example', { firstName: 'Ann', lastName: 'Lee', apolloId: 'A1', status: 'researched' });
    const byName = await addContact(w, 'bank.example', { firstName: 'Tom', lastName: 'Whitcombe', apolloId: null });
    await addContact(w, 'other.example', { firstName: 'Sam', lastName: 'Keller', apolloId: null });

    const held = await findHeldContacts(w.db, w.accountIds.get('bank.example') as string, [
      { apolloId: 'A1', firstName: 'Ann', lastName: 'Le***e', lastNameObfuscated: true },
      { apolloId: 'B2', firstName: 'Tom', lastName: 'Wh***be', lastNameObfuscated: true },
      // Same name, different account: a different person.
      { apolloId: 'C3', firstName: 'Sam', lastName: 'Keller', lastNameObfuscated: false },
      { apolloId: 'D4', firstName: 'Nobody', lastName: 'Here', lastNameObfuscated: false }
    ]);

    expect(held.get('A1')).toMatchObject({ contactId: byId, how: 'apollo-id' });
    expect(held.get('B2')).toMatchObject({ contactId: byName, how: 'name' });
    expect(held.has('C3')).toBe(false);
    expect(held.has('D4')).toBe(false);
  });

  it('answers quickly and correctly for an empty list', async () => {
    const w = await world();
    dbs.push(w.db);
    expect((await findHeldContacts(w.db, 'x', [])).size).toBe(0);
  });

  it('counts someone as fully held only once they have an address or have moved on', async () => {
    const w = await world();
    dbs.push(w.db);
    const scored = await addContact(w, 'bank.example', { apolloId: 'S', status: 'scored' });
    const enriched = await addContact(w, 'bank.example', { firstName: 'E', apolloId: 'E', status: 'enriched' });
    const withEmail = await addContact(w, 'bank.example', { firstName: 'W', apolloId: 'W', status: 'scored' });
    await w.db.contactEmail.create({ data: { id: randomUUID(), contactId: withEmail, address: 'w@bank.example', kind: 'apollo_work', verified: true } });

    const held = await findHeldContacts(
      w.db,
      w.accountIds.get('bank.example') as string,
      ['S', 'E', 'W'].map((id) => ({ apolloId: id, firstName: id, lastName: 'Raman', lastNameObfuscated: false }))
    );
    expect(held.get('S')?.contactId).toBe(scored);
    expect(isFullyHeld(held.get('S')!)).toBe(false);
    expect(isFullyHeld(held.get('E')!)).toBe(true);
    expect(enriched).toBeTruthy();
    expect(isFullyHeld(held.get('W')!)).toBe(true);
  });
});

describe('accounts we have been told to leave alone', () => {
  it('sees an account-scope or domain-scope suppression', async () => {
    const w = await world([
      { domain: 'a.example', name: 'A' },
      { domain: 'b.example', name: 'B' },
      { domain: 'c.example', name: 'C' }
    ]);
    dbs.push(w.db);
    const a = w.accountIds.get('a.example') as string;
    await w.db.suppression.create({ data: { id: randomUUID(), scope: 'account', key: a, source: 'operator', reason: 'existing client' } });
    await w.db.suppression.create({ data: { id: randomUUID(), scope: 'domain', key: 'b.example', source: 'operator', reason: 'asked us to stop' } });

    expect(await accountSuppression(w.db, { accountId: a, domain: 'a.example' })).toEqual({ scope: 'account', reason: 'existing client' });
    expect(await accountSuppression(w.db, { accountId: 'x', domain: 'B.example' })).toEqual({ scope: 'domain', reason: 'asked us to stop' });
    expect(await accountSuppression(w.db, { accountId: 'y', domain: 'c.example' })).toBeNull();
  });
});
