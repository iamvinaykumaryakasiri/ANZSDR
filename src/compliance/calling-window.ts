/**
 * Calling-window evaluation, in the recipient's local time.
 *
 * A dial is only inside the window if it is inside the window in EVERY locality
 * the recipient might be in. For an office direct dial that is usually one place;
 * for a mobile it is the whole market, which makes the effective window the
 * intersection of every state's window - exactly the conservative behaviour
 * section 7.1 asks for when the location is unknown.
 */

import { DateTime, Interval } from 'luxon';
import type { CompliancePolicy, DayWindow, WeekdayKey, WeekWindow } from './policy.js';
import { STATUTORY_WINDOWS, WEEKDAYS } from './policy.js';
import type { HolidayCalendar, HolidayStatus } from './holidays.js';
import type { Locality, Market } from './types.js';

export interface LocalityEvaluation {
  locality: Locality;
  /** Local wall-clock time, for the audit record. */
  localTime: string;
  localDate: string;
  weekday: WeekdayKey;
  statutoryOpen: boolean;
  policyOpen: boolean;
  holiday: HolidayStatus;
  /** True when a holiday is what closed this locality, rather than the clock. */
  holidayBlocks: boolean;
  /** The holidays in force on this local date, ready to name in a denial. */
  holidayNames: string[];
  /** True only if every check above passes. */
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

function holidayStatusFor(
  calendar: HolidayCalendar,
  locality: Locality,
  localDate: string,
  requireVerified: boolean
): HolidayStatus {
  return calendar.status(locality.jurisdiction, localDate, requireVerified);
}

export function evaluateLocality(
  at: Date,
  locality: Locality,
  market: Market,
  policy: CompliancePolicy,
  calendar: HolidayCalendar
): LocalityEvaluation {
  const dt = DateTime.fromJSDate(at, { zone: locality.timezone });
  const day = weekdayKey(dt);
  const hhmm = dt.toFormat('HH:mm');
  const localDate = dt.toFormat('yyyy-MM-dd');
  const holiday = holidayStatusFor(calendar, locality, localDate, policy.holidays.require_verified_calendar);

  const statutoryOpen = withinWindow(hhmm, clipForHoliday(STATUTORY_WINDOWS[market][day], holiday));
  const policyOpen = withinWindow(hhmm, clipForHoliday(policy.policyWindows[market][day], holiday));
  const named = holiday.kind === 'holiday' || holiday.kind === 'part-day-holiday' ? holiday.names : [];
  const holidayBlocks =
    holiday.kind === 'holiday' || (holiday.kind === 'part-day-holiday' && hhmm >= holiday.from);

  return {
    locality,
    localTime: dt.toFormat("yyyy-MM-dd'T'HH:mm:ssZZ"),
    localDate,
    weekday: day,
    statutoryOpen,
    policyOpen,
    holiday,
    holidayBlocks,
    holidayNames: named,
    open: statutoryOpen && policyOpen
  };
}

/** Intersect statutory and policy for one weekday, before holidays are applied. */
function effectiveDayWindow(market: Market, policy: CompliancePolicy, day: WeekdayKey): DayWindow | null {
  const statutory: WeekWindow = STATUTORY_WINDOWS[market];
  const s = statutory[day];
  const p = policy.policyWindows[market][day];
  if (s === null || p === null) return null;
  const start = s.start > p.start ? s.start : p.start;
  const end = s.end < p.end ? s.end : p.end;
  return start < end ? { start, end } : null;
}

/** Absolute open intervals for one locality across the next `days` local days. */
function openIntervals(
  from: DateTime,
  locality: Locality,
  market: Market,
  policy: CompliancePolicy,
  calendar: HolidayCalendar,
  days: number
): Interval[] {
  const out: Interval[] = [];
  let cursor = from.setZone(locality.timezone).startOf('day');
  for (let i = 0; i < days; i++) {
    const localDate = cursor.toFormat('yyyy-MM-dd');
    const holiday = holidayStatusFor(calendar, locality, localDate, policy.holidays.require_verified_calendar);
    const window = clipForHoliday(effectiveDayWindow(market, policy, weekdayKey(cursor)), holiday);
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
 * The next instant at which every candidate locality is simultaneously inside its
 * window. Drives the retry timestamp on a window denial and the console's
 * "next dial" countdown. Returns null if nothing opens inside the horizon, which
 * is what happens when a mobile's candidate set has no common window at all.
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
  // Most denials clear within a day or two, and a mobile can carry twelve
  // candidate localities, so widen the search in steps rather than always
  // projecting a month of windows for every locality.
  for (const horizon of [3, 10, horizonDays].filter((h, i, all) => h <= horizonDays && all.indexOf(h) === i)) {
    const perLocality = localities.map((l) => openIntervals(start, l, market, policy, calendar, horizon + 1));
    const common = intersectAll(perLocality)
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
