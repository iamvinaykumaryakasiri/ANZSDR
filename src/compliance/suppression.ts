/**
 * The suppression list.
 *
 * Suppression is permanent and cross-campaign. There is no expiry, no "cooling
 * off", and no campaign scope: once a person, a number, an account or a domain
 * lands here, the system will not dial it again. Any refusal, complaint or
 * "don't call again" lands here forever (section 7.2).
 */

import type { SuppressionEntry, SuppressionScope } from './types.js';

export interface SuppressionSubject {
  contactId: string;
  e164: string;
  accountId: string;
  emailDomain?: string;
}

function keyFor(scope: SuppressionScope, subject: SuppressionSubject): string | undefined {
  switch (scope) {
    case 'contact':
      return subject.contactId;
    case 'number':
      return subject.e164;
    case 'account':
      return subject.accountId;
    case 'domain':
      return subject.emailDomain;
  }
}

/**
 * Filter a set of candidate entries down to the ones that genuinely apply.
 *
 * The gate re-checks the match rather than trusting whatever the store returned,
 * so a loader bug can neither smuggle a dial past a real suppression nor block a
 * contact on someone else's entry.
 */
export function applicableSuppressions(
  entries: SuppressionEntry[],
  subject: SuppressionSubject
): SuppressionEntry[] {
  return entries.filter((entry) => {
    const key = keyFor(entry.scope, subject);
    if (key === undefined) return false;
    return key.toLowerCase() === entry.key.toLowerCase();
  });
}

/** Build a suppression entry. The `permanent` flag exists to be asserted, not chosen. */
export function suppress(
  scope: SuppressionScope,
  key: string,
  source: SuppressionEntry['source'],
  reason: string,
  at: Date
): SuppressionEntry {
  return { scope, key, source, reason, createdAt: at, permanent: true };
}
