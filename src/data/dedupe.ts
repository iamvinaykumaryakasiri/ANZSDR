/**
 * "Deduplicates against everything we already hold. Never re-buys data."
 *
 * Two questions are asked before a credit is spent, and both are answered from
 * the blackboard rather than from Apollo:
 *
 *   - Do we already hold this person? By Apollo id first; failing that, by name
 *     at the same account, because people entered by hand (config/contacts.csv)
 *     have no Apollo id and are exactly the ones a search will find again.
 *   - Is this account one we have been told to leave alone?
 *
 * The suppression read here is advisory and exists only to avoid spending money
 * on someone we will never be allowed to call. The compliance gate still makes
 * the actual decision on every dial; nothing in this file replaces it.
 */

import type { Blackboard } from '../blackboard/client.js';

export interface DedupeCandidate {
  apolloId: string;
  firstName: string;
  lastName: string;
  /** True when `lastName` is Apollo's masked form ("Ra***n"), not a real surname. */
  lastNameObfuscated: boolean;
}

export interface HeldContact {
  contactId: string;
  how: 'apollo-id' | 'name';
  status: string;
  hasEmail: boolean;
}

/** A masked surname matches any held surname that fits its visible letters. */
export function lastNameMatches(held: string, candidate: string, obfuscated: boolean): boolean {
  const a = held.trim().toLowerCase();
  const b = candidate.trim().toLowerCase();
  if (a === '' || b === '') return false;
  if (!obfuscated) return a === b;
  const pattern = new RegExp(
    `^${b
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  );
  return pattern.test(a);
}

/**
 * Someone held, but only as far as `scored`, with no address, has not been
 * enriched yet: they are still worth buying. Everyone else is already ours.
 */
export function isFullyHeld(held: HeldContact): boolean {
  return held.hasEmail || !['discovered', 'scored'].includes(held.status);
}

export async function findHeldContacts(
  db: Blackboard,
  accountId: string,
  candidates: DedupeCandidate[]
): Promise<Map<string, HeldContact>> {
  const held = new Map<string, HeldContact>();
  if (candidates.length === 0) return held;

  const rows = await db.contact.findMany({
    where: { OR: [{ accountId }, { apolloId: { in: candidates.map((c) => c.apolloId) } }] },
    include: { emails: { select: { id: true } } }
  });

  for (const c of candidates) {
    const byId = rows.find((r) => r.apolloId === c.apolloId);
    const match =
      byId ??
      rows.find(
        (r) =>
          r.accountId === accountId &&
          r.firstName.trim().toLowerCase() === c.firstName.trim().toLowerCase() &&
          lastNameMatches(r.lastName, c.lastName, c.lastNameObfuscated)
      );
    if (match === undefined) continue;
    held.set(c.apolloId, {
      contactId: match.id,
      how: byId !== undefined ? 'apollo-id' : 'name',
      status: match.status,
      hasEmail: match.emails.length > 0
    });
  }
  return held;
}

export interface AccountHold {
  scope: 'account' | 'domain';
  reason: string;
}

export async function accountSuppression(
  db: Blackboard,
  account: { accountId: string; domain: string }
): Promise<AccountHold | null> {
  const rows = await db.suppression.findMany({
    where: {
      OR: [
        { scope: 'account', key: account.accountId },
        { scope: 'domain', key: account.domain.toLowerCase() }
      ]
    }
  });
  const row = rows[0];
  if (row === undefined) return null;
  return { scope: row.scope === 'account' ? 'account' : 'domain', reason: row.reason };
}
