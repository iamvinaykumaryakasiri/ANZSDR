/**
 * The compliance gate's reason codes, in words a person can read aloud.
 *
 * The gate returns codes; the wire contract carries codes. This is the one place
 * the backend turns them into sentences (for the standing-by note, the briefing
 * and Jarvis). Typed over every code the gate can return, so adding a deny code
 * without adding its sentence is a compile error rather than a blank in the room.
 */

import type { DenyCode } from '../compliance/types.js';

export const HOLD_TEXT: Record<DenyCode, string> = {
  KILL_SWITCH_ACTIVE: 'dialling is halted',
  INVALID_NUMBER: 'the number is not valid',
  MARKET_MISMATCH: 'the number belongs to a different market from the one the contact is recorded in',
  CALLER_ID_NOT_CONFIGURED: 'no caller ID number is configured',
  MOBILE_DIALLING_DISABLED: 'it is a mobile, and mobiles are not dialled until Do Not Call washing is in place',
  DNC_WASH_MISSING: 'the number has never been washed against the Do Not Call register',
  DNC_WASH_STALE: 'the Do Not Call wash has expired',
  DNC_REGISTERED: 'the number is on the Do Not Call register',
  SUPPRESSED: 'they are on the suppression list',
  OUTSIDE_STATUTORY_WINDOW: 'it is outside the legal calling hours where they are',
  OUTSIDE_POLICY_WINDOW: "it is outside Vinay's calling hours",
  PUBLIC_HOLIDAY: 'it is a public holiday',
  HOLIDAY_CALENDAR_COVERAGE_GAP: 'the holiday calendar does not cover this date',
  HOLIDAY_CALENDAR_UNVERIFIED: 'the holiday calendar for this date has not been signed off',
  ATTEMPT_CAP_REACHED: 'the maximum number of attempts has been made',
  ATTEMPT_WINDOW_CLOSED: 'the attempt window for this person has closed',
  MIN_INTERVAL_NOT_ELAPSED: 'it is too soon after the last attempt',
  ACCOUNT_WEEKLY_CAP: 'someone at the same organisation has already been approached this week',
  DAILY_DIAL_CAP: "today's dial cap has been reached",
  CONCURRENCY_LIMIT: 'a call is already in progress',
  NUMBER_ALREADY_DIALLED_TODAY: 'the number has already been dialled today',
  DAY_PLAN_NOT_APPROVED: "today's plan has not been approved",
  NOT_A_TEST_CONTACT: 'the system is in test mode and this is a real prospect',
  CONTACT_NOT_ON_BLACKBOARD: 'there is no record of who the number belongs to'
};

/** "dialling is halted", or "X, and 2 other reasons". Unknown codes are named rather than hidden. */
export function describeReasons(codes: string[]): string {
  if (codes.length === 0) return '';
  const first = codes[0] as string;
  const text = HOLD_TEXT[first as DenyCode] ?? first;
  const rest = codes.length - 1;
  return rest === 0 ? text : `${text}, and ${rest} other ${rest === 1 ? 'reason' : 'reasons'}`;
}
