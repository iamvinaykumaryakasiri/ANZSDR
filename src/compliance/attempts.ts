/**
 * Volume limits (section 7.5).
 *
 * Three attempts per contact ever, inside a 21-day window from the first attempt,
 * at least five days apart, and one contact per account per week until someone at
 * that account has actually had a conversation with us.
 */

import type { CompliancePolicy } from './policy.js';
import type { AttemptRecord } from './types.js';

const DAY_MS = 86_400_000;

export interface AttemptEvaluation {
  used: number;
  remaining: number;
  /** All three attempts spent. Permanent. */
  capReached: boolean;
  /** The 21 days from the first attempt have elapsed. Permanent. */
  windowClosed: boolean;
  windowClosesAt?: Date;
  /** Five clear days since the last attempt. */
  minIntervalMet: boolean;
  nextAttemptAllowedAt?: Date;
  /** One contact per account per week, lifted once a conversation has happened. */
  accountWeeklyCapMet: boolean;
  accountNextAllowedAt?: Date;
}

export function evaluateAttempts(
  contactId: string,
  contactAttempts: AttemptRecord[],
  accountAttemptsThisWeek: AttemptRecord[],
  accountHasConversed: boolean,
  policy: CompliancePolicy,
  at: Date
): AttemptEvaluation {
  const sorted = [...contactAttempts].sort((a, b) => a.at.getTime() - b.at.getTime());
  const used = sorted.length;
  const remaining = Math.max(0, policy.volume.max_attempts_per_contact - used);

  const result: AttemptEvaluation = {
    used,
    remaining,
    capReached: used >= policy.volume.max_attempts_per_contact,
    windowClosed: false,
    minIntervalMet: true,
    accountWeeklyCapMet: true
  };

  const first = sorted[0];
  if (first !== undefined) {
    const closesAt = new Date(first.at.getTime() + policy.volume.attempt_window_days * DAY_MS);
    result.windowClosesAt = closesAt;
    result.windowClosed = at.getTime() >= closesAt.getTime();

    const last = sorted[sorted.length - 1] as AttemptRecord;
    const nextAllowed = new Date(last.at.getTime() + policy.volume.min_days_between_attempts * DAY_MS);
    result.nextAttemptAllowedAt = nextAllowed;
    result.minIntervalMet = at.getTime() >= nextAllowed.getTime();
  }

  // The weekly cap limits how many DIFFERENT people we approach at one account.
  // Calling the same person back is governed by the per-contact interval above,
  // so a contact already inside this week's set does not consume a second slot.
  const distinctContacts = new Set(accountAttemptsThisWeek.map((a) => a.contactId));
  if (
    !accountHasConversed &&
    !distinctContacts.has(contactId) &&
    distinctContacts.size >= policy.volume.max_contacts_per_account_per_week
  ) {
    result.accountWeeklyCapMet = false;
    const earliest = accountAttemptsThisWeek.reduce((a, b) => (a.at <= b.at ? a : b));
    result.accountNextAllowedAt = new Date(earliest.at.getTime() + 7 * DAY_MS);
  }

  return result;
}
