/**
 * When the demo queue's verdicts are evaluated.
 *
 * The real console asks the gate about the real moment. Run the demo at ten at
 * night, or on a Sunday, and every person in the queue would be held for the same
 * reason (it is outside calling hours), which shows nothing of what the gate can
 * say. So the demo evaluates its queue at the next moment calling is lawful,
 * mid-morning, and says so in the standing-by note.
 *
 * Only the gate's question is moved. Every timestamp in the demo (calls, the
 * clock on a live call, spend) stays on the real clock, so a browser's own sense
 * of "now" agrees with what it is shown. The gate is the real gate, called with
 * an `at` it is perfectly able to accept; nothing about its rules is relaxed.
 */

import { nextOpenAt } from '../../compliance/calling-window.js';
import type { HolidayCalendar } from '../../compliance/holidays.js';
import type { CompliancePolicy } from '../../compliance/policy.js';

const MID_MORNING_MS = 75 * 60_000;

export function illustrativeGateInstant(now: Date, policy: CompliancePolicy, calendar: HolidayCalendar): Date {
  const sydney = [{ jurisdiction: 'au-nsw' as const, timezone: 'Australia/Sydney' }];
  const open = nextOpenAt(now, sydney, 'AU', policy, calendar, 14);
  if (open === null) return now;
  // Already open: use the real moment. Otherwise the opening of the next window,
  // a little after, so the verdicts are not decided on a boundary.
  return open.getTime() <= now.getTime() ? now : new Date(open.getTime() + MID_MORNING_MS);
}
