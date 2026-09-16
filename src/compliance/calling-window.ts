/**
 * Calling-window evaluation.
 *
 * Two separate questions, deliberately not collapsed into one.
 *
 * The POLICY window is the operator's own working day. It is evaluated on one
 * clock per market - Sydney time for Australia, Auckland time for New Zealand -
 * because the calling plan is written, read and approved by one person in one
 * place, and a plan that means a different thing for every prospect is not a plan.
 *
 * The STATUTORY window is where the recipient actually is, and it is evaluated in
 * every locality they might be in. A dial is legal only if it is inside the
 * window in all of them.
 *
 * A dial needs both. Anchoring the plan to Sydney time therefore cannot make an
 * illegal call legal: 09:30 in Sydney is 06:30 in Perth, and the statutory check
 * refuses it. What it does is let one plan cover the whole country, with each
 * prospect reached during the part of the operator's day that is lawful where
 * they are.
 */

import { DateTime, Interval } from 'luxon';
import type { CompliancePolicy, DayWindow, WeekdayKey, WeekWindow } from './policy.js';
import { STATUTORY_WINDOWS, WEEKDAYS } from './policy.js';
import type { HolidayCalendar, HolidayStatus } from './holidays.js';
import type { Jurisdiction, Locality, Market } from './types.js';

export interface WindowEvaluation {
  jurisdiction: Jurisdiction;
  timezone: string;
  /** Local wall-clock time on the clock this window is measured against. */
  localTime: string;
  localDate: string;
  weekday: WeekdayKey;
  holiday: HolidayStatus;
  /** True when a holiday is what closed this window, rather than the clock. */
  holidayBlocks: boolean;
  holidayNames: string[];
  open: boolean;
}

function weekdayKey(dt: DateTime): WeekdayKey {
  return WEEKDAYS[dt.weekday - 1] as WeekdayKey;
}

function withinWindow(hhmm: string, window: DayWindow | null): boolean {
  if (window === null) return false;
  return hhmm >= window.start && hhmm < window.end;
}

/** Clip a day window so it ends when a part-day holiday begins. */
function clipForHoliday(window: DayWindow | null, holiday: HolidayStatus): DayWindow | null {
  if (window === null) return null;
  if (holiday.kind === 'working-day') return window;
  if (holiday.kind === 'part-day-holiday') {
    const end = holiday.from < window.end ? holiday.from : window.end;
    return end > window.start ? { start: window.start, end } : null;
  }
  return null;
}

function evaluateWindow(
  at: Date,
  jurisdiction: Jurisdiction,
  timezone: string,
  week: WeekWindow,
  calendar: HolidayCalendar,
  requireVerified: boolean
): WindowEvaluation {
  const dt = DateTime.fromJSDate(at, { zone: timezone });
  const day = weekdayKey(dt);
  const hhmm = dt.toFormat('HH:mm');
  const localDate = dt.toFormat('yyyy-MM-dd');
  const holiday = calendar.status(jurisdiction, localDate, requireVerified);
  const named = holiday.kind === 'holiday' || holiday.kind === 'part-day-holiday' ? holiday.names : [];

  return {
    jurisdiction,
    timezone,
    localTime: dt.toFormat("yyyy-MM-dd'T'HH:mm:ssZZ"),
    localDate,
    weekday: day,
    holiday,
    holidayBlocks:
      holiday.kind === 'holiday' || (holiday.kind === 'part-day-holiday' && hhmm >= holiday.from),
    holidayNames: named,
    open: withinWindow(hhmm, clipForHoliday(week[day], holiday))
  };
}

/** Is the recipient inside the legal window where they actually are? */
export function evaluateStatutory(
  at: Date,
  locality: Locality,
  market: Market,
  policy: CompliancePolicy,
  calendar: HolidayCalendar
): WindowEvaluation {
  return evaluateWindow(
    at,
    locality.jurisdiction,
    locality.timezone,
    STATUTORY_WINDOWS[market],
    calendar,
    policy.holidays.require_verified_calendar
  );
}

/** Is the operator inside their own working day? One clock per market. */
export function evaluatePolicy(
  at: Date,
  market: Market,
  policy: CompliancePolicy,
  calendar: HolidayCalendar
): WindowEvaluation {
  const anchor = policy.anchors[market];
  return evaluateWindow(
    at,
    anchor.jurisdiction,
    anchor.timezone,
    policy.policyWindows[market],
    calendar,
    policy.holidays.require_verified_calendar
  );
}

/** Absolute open intervals for one window across the next `days` local days. */
function openIntervals(
  from: DateTime,
  jurisdiction: Jurisdiction,
  timezone: string,
  week: WeekWindow,
  calendar: HolidayCalendar,
  requireVerified: boolean,
  days: number
): Interval[] {
  const out: Interval[] = [];
  let cursor = from.setZone(timezone).startOf('day');
  for (let i = 0; i < days; i++) {
    const localDate = cursor.toFormat('yyyy-MM-dd');
    const holiday = calendar.status(jurisdiction, localDate, requireVerified);
    const window = clipForHoliday(week[weekdayKey(cursor)], holiday);
    if (window !== null) {
      const start = cursor.set({
        hour: Number(window.start.slice(0, 2)),
        minute: Number(window.start.slice(3, 5))
      });
      const end = cursor.set({
        hour: Number(window.end.slice(0, 2)),
        minute: Number(window.end.slice(3, 5))
      });
      const interval = Interval.fromDateTimes(start, end);
      if (interval.isValid) out.push(interval);
    }
    cursor = cursor.plus({ days: 1 }).startOf('day');
  }
  return out;
}

function intersectAll(lists: Interval[][]): Interval[] {
  return lists.reduce((acc, list) => {
    const merged: Interval[] = [];
    for (const a of acc) {
      for (const b of list) {
        const i = a.intersection(b);
        if (i !== null && i.isValid && i.length('minutes') > 0) merged.push(i);
      }
    }
    return merged;
  });
}

/**
 * The next instant at which the operator's working day and every candidate
 * locality's legal window are open at once. Drives the retry timestamp on a
 * window denial and the console's "next dial" countdown.
 */
export function nextOpenAt(
  from: Date,
  localities: Locality[],
  market: Market,
  policy: CompliancePolicy,
  calendar: HolidayCalendar,
  horizonDays = 30
): Date | null {
  const start = DateTime.fromJSDate(from);
  const anchor = policy.anchors[market];
  const requireVerified = policy.holidays.require_verified_calendar;

  // Most denials clear within a day or two, and a mobile can carry twelve
  // candidate localities, so widen the search in steps rather than always
  // projecting a month of windows for every locality.
  for (const horizon of [3, 10, horizonDays].filter((h, i, all) => h <= horizonDays && all.indexOf(h) === i)) {
    const lists = [
      openIntervals(
        start,
        anchor.jurisdiction,
        anchor.timezone,
        policy.policyWindows[market],
        calendar,
        requireVerified,
        horizon + 1
      ),
      ...localities.map((l) =>
        openIntervals(
          start,
          l.jurisdiction,
          l.timezone,
          STATUTORY_WINDOWS[market],
          calendar,
          requireVerified,
          horizon + 1
        )
      )
    ];
    const common = intersectAll(lists)
      .filter((i) => i.end !== null && i.end > start)
      .sort((a, b) => (a.start as DateTime).toMillis() - (b.start as DateTime).toMillis());

    const first = common[0];
    if (first !== undefined) {
      const at = (first.start as DateTime) > start ? (first.start as DateTime) : start;
      return at.toJSDate();
    }
  }
  return null;
}
