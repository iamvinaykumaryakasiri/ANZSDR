/** Civil-date arithmetic for the holiday rule engine. No timezones here: a public
 *  holiday is a calendar date in a jurisdiction, and the timezone is applied later
 *  when that date is compared against a real instant. */

import type { DateRule, HolidayRule, Substitution, Weekday } from './rules.js';

export type CivilDate = string; // YYYY-MM-DD

export function toCivil(d: Date): CivilDate {
  return d.toISOString().slice(0, 10);
}

export function fromCivil(s: CivilDate): Date {
  return new Date(`${s}T00:00:00Z`);
}

export function addDays(s: CivilDate, days: number): CivilDate {
  const d = fromCivil(s);
  d.setUTCDate(d.getUTCDate() + days);
  return toCivil(d);
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(s: CivilDate): Weekday {
  const day = fromCivil(s).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

export function isWeekend(s: CivilDate): boolean {
  const w = isoWeekday(s);
  return w === 6 || w === 7;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function civil(year: number, month: number, day: number): CivilDate {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Meeus/Jones/Butcher Gregorian computus. */
export function easterSunday(year: number): CivilDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return civil(year, month, day);
}

function nthWeekdayOfMonth(year: number, month: number, weekday: Weekday, n: number): CivilDate {
  if (n < 0) {
    // Walk back from the last day of the month.
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let date = civil(year, month, lastDay);
    while (isoWeekday(date) !== weekday) date = addDays(date, -1);
    return addDays(date, (n + 1) * 7);
  }
  let date = civil(year, month, 1);
  while (isoWeekday(date) !== weekday) date = addDays(date, 1);
  return addDays(date, (n - 1) * 7);
}

function weekdayOnOrAfter(start: CivilDate, weekday: Weekday): CivilDate {
  let date = start;
  while (isoWeekday(date) !== weekday) date = addDays(date, 1);
  return date;
}

/** The Monday closest to a date: the same week's Monday for Mon-Thu, the next one otherwise. */
function mondayNearest(target: CivilDate): CivilDate {
  const w = isoWeekday(target);
  return w <= 4 ? addDays(target, -(w - 1)) : addDays(target, 8 - w);
}

export function resolveDateRule(rule: DateRule, year: number): CivilDate[] {
  switch (rule.kind) {
    case 'fixed':
      return [civil(year, rule.month, rule.day)];
    case 'nth-weekday':
      return [nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.n)];
    case 'easter-offset':
      return [addDays(easterSunday(year), rule.offset)];
    case 'weekday-on-or-after':
      return [weekdayOnOrAfter(civil(year, rule.month, rule.day), rule.weekday)];
    case 'monday-nearest':
      return [mondayNearest(civil(year, rule.month, rule.day))];
    case 'weekday-before': {
      const anchors = resolveDateRule(rule.before, year);
      return anchors.map((a) => {
        let date = addDays(a, -1);
        while (isoWeekday(date) !== rule.weekday) date = addDays(date, -1);
        return date;
      });
    }
    case 'weekday-after': {
      const anchors = resolveDateRule(rule.after, year);
      return anchors.map((a) => {
        let date = addDays(a, 1);
        while (isoWeekday(date) !== rule.weekday) date = addDays(date, 1);
        return date;
      });
    }
    case 'listed': {
      const entry = rule.dates[year];
      return entry === null || entry === undefined ? [] : [entry];
    }
  }
}

export interface ObservedHoliday {
  date: CivilDate;
  name: string;
  partDayFrom?: string;
  proclaimed: boolean;
  substituted: boolean;
}

function substitutes(base: CivilDate, substitution: Substitution): CivilDate[] {
  switch (substitution) {
    case 'none':
      return [];
    case 'add-monday-if-weekend':
      return isWeekend(base) ? [weekdayOnOrAfter(base, 1)] : [];
    case 'weekend-plus-two':
      return isWeekend(base) ? [addDays(base, 2)] : [];
    case 'mondayise':
      return isWeekend(base) ? [weekdayOnOrAfter(base, 1)] : [];
  }
}

/** Every date this rule causes to be observed in `jurisdiction` during `year`. */
export function observe(rule: HolidayRule, year: number): ObservedHoliday[] {
  const out: ObservedHoliday[] = [];
  for (const base of resolveDateRule(rule.date, year)) {
    const entry: ObservedHoliday = {
      date: base,
      name: rule.name,
      proclaimed: rule.proclaimed === true,
      substituted: false
    };
    if (rule.partDayFrom !== undefined) entry.partDayFrom = rule.partDayFrom;
    out.push(entry);
    for (const sub of substitutes(base, rule.substitution)) {
      out.push({
        date: sub,
        name: `${rule.name} (additional day)`,
        proclaimed: rule.proclaimed === true,
        substituted: true
      });
    }
  }
  return out;
}
