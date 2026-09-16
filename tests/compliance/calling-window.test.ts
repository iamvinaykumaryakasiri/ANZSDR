import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { evaluatePolicy, evaluateStatutory, nextOpenAt } from '../../src/compliance/calling-window.js';
import { HolidayCalendar } from '../../src/compliance/holidays.js';
import { calendar, policy } from '../support/fixtures.js';
import type { Locality } from '../../src/compliance/types.js';

const cal = calendar();
const NSW: Locality = { jurisdiction: 'au-nsw', timezone: 'Australia/Sydney' };
const WA: Locality = { jurisdiction: 'au-wa', timezone: 'Australia/Perth' };
const SA: Locality = { jurisdiction: 'au-sa', timezone: 'Australia/Adelaide' };
const AKL: Locality = { jurisdiction: 'nz-auckland', timezone: 'Pacific/Auckland' };

/** Build an instant from a local wall-clock time in a given zone. */
function localInstant(iso: string, zone: string): Date {
  return DateTime.fromISO(iso, { zone }).toJSDate();
}

describe('the operator\'s working day', () => {
  const p = policy();

  it('is measured in Sydney time whoever is being called', () => {
    const at = localInstant('2025-03-12T11:00', 'Australia/Sydney');
    const day = evaluatePolicy(at, 'AU', p, cal);
    expect(day.timezone).toBe('Australia/Sydney');
    expect(day.localTime.slice(11, 16)).toBe('11:00');
    expect(day.open).toBe(true);
  });

  it('is measured in Auckland time for New Zealand', () => {
    const at = localInstant('2025-03-12T11:00', 'Pacific/Auckland');
    expect(evaluatePolicy(at, 'NZ', p, cal).timezone).toBe('Pacific/Auckland');
    expect(evaluatePolicy(at, 'NZ', p, cal).open).toBe(true);
  });

  it('closes on a New South Wales public holiday', () => {
    const anzac = localInstant('2025-04-25T11:00', 'Australia/Sydney');
    const weekdays = policy({ days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
    const day = evaluatePolicy(anzac, 'AU', weekdays, cal);
    expect(day.open).toBe(false);
    expect(day.holidayBlocks).toBe(true);
  });

  it('ignores a holiday that is not the operator\'s', () => {
    // Canberra Day is an ACT holiday; Sydney works.
    const canberraDay = localInstant('2025-03-10T11:00', 'Australia/Sydney');
    const weekdays = policy({ days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
    expect(evaluatePolicy(canberraDay, 'AU', weekdays, cal).open).toBe(true);
  });

  it('closes on a day outside the configured days', () => {
    const monday = localInstant('2025-03-10T11:00', 'Australia/Sydney');
    expect(evaluatePolicy(monday, 'AU', p, cal).open).toBe(false);
  });

  it('treats the window end as exclusive and the start as inclusive', () => {
    const at = (hhmm: string) => evaluatePolicy(localInstant(`2025-03-12T${hhmm}`, 'Australia/Sydney'), 'AU', p, cal).open;
    expect([at('09:29'), at('09:30'), at('16:29'), at('16:30')]).toEqual([false, true, true, false]);
  });
});

describe('the statutory window, where the recipient actually is', () => {
  const p = policy();

  it('opens on a weekday inside legal hours', () => {
    const e = evaluateStatutory(localInstant('2025-03-12T11:00', 'Australia/Sydney'), NSW, 'AU', p, cal);
    expect(e.open).toBe(true);
    expect(e.weekday).toBe('wed');
  });

  it('is closed on a Sunday', () => {
    const e = evaluateStatutory(localInstant('2025-03-09T11:00', 'Australia/Sydney'), NSW, 'AU', p, cal);
    expect(e.open).toBe(false);
  });

  it('is closed on a Saturday, though the Industry Standard permits it', () => {
    const saturday = localInstant('2025-03-08T11:00', 'Australia/Sydney');
    expect(evaluateStatutory(saturday, NSW, 'AU', p, cal).open).toBe(false);
    // And no policy configuration can re-open it.
    const everyDay = policy({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '09:00', end: '17:00' });
    expect(evaluateStatutory(saturday, NSW, 'AU', everyDay, cal).open).toBe(false);
    expect(evaluateStatutory(saturday, AKL, 'NZ', everyDay, cal).open).toBe(false);
  });

  it('blocks a public holiday outright and names it', () => {
    const e = evaluateStatutory(localInstant('2025-04-25T11:00', 'Australia/Sydney'), NSW, 'AU', p, cal);
    expect(e.holidayBlocks).toBe(true);
    expect(e.holidayNames.join()).toContain('Anzac');
  });

  it('blocks a holiday in one state but not its neighbour', () => {
    const cup = localInstant('2025-03-10T11:00', 'Australia/Adelaide');
    expect(evaluateStatutory(cup, SA, 'AU', p, cal).holidayBlocks).toBe(true);
    expect(evaluateStatutory(cup, NSW, 'AU', p, cal).holidayBlocks).toBe(false);
  });

  it('leaves the working part of a part-day holiday open', () => {
    // 24 December 2025 is a Wednesday; South Australia's holiday starts at 19:00.
    const afternoon = evaluateStatutory(localInstant('2025-12-24T15:00', 'Australia/Adelaide'), SA, 'AU', p, cal);
    const evening = evaluateStatutory(localInstant('2025-12-24T19:30', 'Australia/Adelaide'), SA, 'AU', p, cal);
    expect(afternoon.open).toBe(true);
    expect(evening.open).toBe(false);
    expect(evening.holidayBlocks).toBe(true);
  });

  it('closes the whole day when a part-day holiday starts before business hours', () => {
    // A part-day holiday running from 08:00 leaves nothing of the legal window,
    // so the day is closed rather than clipped to an empty span.
    const earlyHoliday = HolidayCalendar.fromData([
      {
        schemaVersion: 1,
        market: 'AU',
        generatedAt: 'now',
        coverage: { fromYear: 2025, toYear: 2025 },
        jurisdictions: {
          'au-nsw': {
            inherits: [],
            years: { '2025': { verified: true, provenance: 'official-dataset', source: 's', gaps: [] } },
            holidays: { '2025-03-12': [{ name: 'a morning-long observance', partDayFrom: '08:00' }] }
          }
        }
      }
    ]);
    const e = evaluateStatutory(
      localInstant('2025-03-12T11:00', 'Australia/Sydney'),
      NSW,
      'AU',
      p,
      earlyHoliday
    );
    expect(e.open).toBe(false);
    expect(e.holidayBlocks).toBe(true);
  });

  it('leaves the day alone when a part-day holiday starts after the window closes', () => {
    // A 22:00 observance is past the 20:00 legal cut-off, so it changes nothing.
    const lateHoliday = HolidayCalendar.fromData([
      {
        schemaVersion: 1,
        market: 'AU',
        generatedAt: 'now',
        coverage: { fromYear: 2025, toYear: 2025 },
        jurisdictions: {
          'au-nsw': {
            inherits: [],
            years: { '2025': { verified: true, provenance: 'official-dataset', source: 's', gaps: [] } },
            holidays: { '2025-03-12': [{ name: 'a late-evening observance', partDayFrom: '22:00' }] }
          }
        }
      }
    ]);
    const e = evaluateStatutory(localInstant('2025-03-12T11:00', 'Australia/Sydney'), NSW, 'AU', p, lateHoliday);
    expect(e.open).toBe(true);
    expect(e.holidayBlocks).toBe(false);
  });

  it('refuses a year nobody has signed off, and a date off the calendar entirely', () => {
    const strict = policy({ requireVerifiedCalendar: true });
    const unsigned = evaluateStatutory(localInstant('2026-03-11T11:00', 'Australia/Sydney'), NSW, 'AU', strict, cal);
    expect(unsigned.holiday.kind).toBe('unverified');
    expect(unsigned.open).toBe(false);

    const beyond = evaluateStatutory(localInstant('2031-03-12T11:00', 'Australia/Sydney'), NSW, 'AU', p, cal);
    expect(beyond.holiday.kind).toBe('out-of-coverage');
    expect(beyond.open).toBe(false);
  });

  it('follows the recipient across daylight saving rather than the server clock', () => {
    const summer = localInstant('2025-01-15T11:00', 'Australia/Sydney');
    const winter = localInstant('2025-07-16T11:00', 'Australia/Sydney');
    expect(evaluateStatutory(summer, WA, 'AU', p, cal).localTime.slice(11, 16)).toBe('08:00');
    expect(evaluateStatutory(winter, WA, 'AU', p, cal).localTime.slice(11, 16)).toBe('09:00');
  });
});

describe('nextOpenAt: both windows at once', () => {
  const p = policy();

  it('returns the current instant when everything is already open', () => {
    const now = localInstant('2025-03-12T11:00', 'Australia/Sydney');
    expect(nextOpenAt(now, [NSW], 'AU', p, cal)?.toISOString()).toBe(now.toISOString());
  });

  it('skips forward to the next permitted weekday', () => {
    const friday = localInstant('2025-03-14T11:00', 'Australia/Sydney');
    const next = nextOpenAt(friday, [NSW], 'AU', p, cal);
    expect(DateTime.fromJSDate(next as Date, { zone: 'Australia/Sydney' }).toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2025-03-18 09:30'
    );
  });

  it('never lands on a Saturday', () => {
    const everyDay = policy({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '09:00', end: '17:00' });
    const friday = localInstant('2025-03-14T18:00', 'Australia/Sydney');
    const next = nextOpenAt(friday, [NSW], 'AU', everyDay, cal);
    expect(DateTime.fromJSDate(next as Date, { zone: 'Australia/Sydney' }).toFormat('cccc yyyy-MM-dd')).toBe(
      'Monday 2025-03-17'
    );
  });

  it('waits for a Perth prospect until it is lawful in Perth, not when Sydney opens', () => {
    // The plan says 09:30 Sydney. That is 06:30 in Perth in March, so the first
    // lawful moment is 09:00 Perth - noon in Sydney.
    const early = localInstant('2025-03-12T06:00', 'Australia/Sydney');
    const next = nextOpenAt(early, [WA], 'AU', p, cal) as Date;
    expect(DateTime.fromJSDate(next, { zone: 'Australia/Perth' }).toFormat('HH:mm')).toBe('09:00');
    expect(DateTime.fromJSDate(next, { zone: 'Australia/Sydney' }).toFormat('HH:mm')).toBe('12:00');
  });

  it('closes a Perth prospect\'s day when the operator\'s day ends, not when Perth\'s does', () => {
    // 16:30 Sydney is 13:30 Perth: the operator has stopped, so the window shuts
    // even though Perth is still well inside legal hours.
    const at = localInstant('2025-03-12T13:45', 'Australia/Perth');
    const day = evaluatePolicy(at, 'AU', p, cal);
    expect(day.open).toBe(false);
    expect(evaluateStatutory(at, WA, 'AU', p, cal).open).toBe(true);
  });

  it('skips a public holiday that lands on a permitted weekday', () => {
    const monday = localInstant('2025-11-03T18:00', 'Australia/Melbourne');
    const next = nextOpenAt(monday, [{ jurisdiction: 'au-vic', timezone: 'Australia/Melbourne' }], 'AU', p, cal);
    // Melbourne Cup is Tuesday 4 November; Victoria is closed, so Wednesday.
    expect(DateTime.fromJSDate(next as Date, { zone: 'Australia/Melbourne' }).toFormat('yyyy-MM-dd')).toBe(
      '2025-11-05'
    );
  });

  it('clamps a too-early policy start to the statutory one', () => {
    const early = policy({ start: '08:00', end: '16:30' });
    const monday = localInstant('2025-03-10T18:00', 'Australia/Brisbane');
    const next = nextOpenAt(monday, [{ jurisdiction: 'au-qld', timezone: 'Australia/Brisbane' }], 'AU', early, cal);
    // Brisbane is an hour behind Sydney in March: 09:00 Brisbane is 10:00 Sydney,
    // which is the first moment both the law and the plan allow.
    expect(DateTime.fromJSDate(next as Date, { zone: 'Australia/Brisbane' }).toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2025-03-11 09:00'
    );
  });

  it('returns null when policy opens a day the statute closes outright', () => {
    const sundays = policy({ days: ['sun'] });
    expect(nextOpenAt(localInstant('2025-03-10T09:00', 'Australia/Sydney'), [NSW], 'AU', sundays, cal)).toBeNull();
  });

  it('returns null when the horizon runs past the calendar', () => {
    const at = localInstant('2027-12-20T09:00', 'Australia/Sydney');
    expect(nextOpenAt(at, [NSW], 'AU', policy({ requireVerifiedCalendar: true }), cal, 5)).toBeNull();
  });

  it('returns null when a mobile\'s candidate localities share no common window', () => {
    const narrow = policy({ start: '09:30', end: '10:00' });
    const at = localInstant('2025-03-10T18:00', 'Australia/Sydney');
    expect(nextOpenAt(at, [NSW, WA], 'AU', narrow, cal)).toBeNull();
  });
});
