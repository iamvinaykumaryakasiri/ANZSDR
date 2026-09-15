import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { evaluateLocality, nextOpenAt } from '../../src/compliance/calling-window.js';
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

describe('evaluateLocality', () => {
  const p = policy();

  it('opens on a Wednesday late morning', () => {
    const e = evaluateLocality(localInstant('2025-03-12T11:00', 'Australia/Sydney'), NSW, 'AU', p, cal);
    expect(e.open).toBe(true);
    expect(e.weekday).toBe('wed');
    expect(e.localDate).toBe('2025-03-12');
  });

  it('closes on a Monday by policy while the statute would allow it', () => {
    const e = evaluateLocality(localInstant('2025-03-10T11:00', 'Australia/Sydney'), NSW, 'AU', p, cal);
    expect(e.statutoryOpen).toBe(true);
    expect(e.policyOpen).toBe(false);
    expect(e.open).toBe(false);
  });

  it('closes on a Sunday by statute', () => {
    const e = evaluateLocality(localInstant('2025-03-09T11:00', 'Australia/Sydney'), NSW, 'AU', p, cal);
    expect(e.statutoryOpen).toBe(false);
  });

  it('closes a Saturday to policy but not to the AU statute', () => {
    const e = evaluateLocality(localInstant('2025-03-08T11:00', 'Australia/Sydney'), NSW, 'AU', p, cal);
    expect(e.statutoryOpen).toBe(true);
    expect(e.policyOpen).toBe(false);
  });

  it('closes a Saturday to the NZ convention as well', () => {
    const e = evaluateLocality(localInstant('2025-03-08T11:00', 'Pacific/Auckland'), AKL, 'NZ', p, cal);
    expect(e.statutoryOpen).toBe(false);
  });

  it('treats the window end as exclusive and the start as inclusive', () => {
    const at930 = evaluateLocality(localInstant('2025-03-12T09:30', 'Australia/Sydney'), NSW, 'AU', p, cal);
    const at1629 = evaluateLocality(localInstant('2025-03-12T16:29', 'Australia/Sydney'), NSW, 'AU', p, cal);
    const at1630 = evaluateLocality(localInstant('2025-03-12T16:30', 'Australia/Sydney'), NSW, 'AU', p, cal);
    expect([at930.open, at1629.open, at1630.open]).toEqual([true, true, false]);
  });

  it('blocks a public holiday outright', () => {
    const e = evaluateLocality(localInstant('2025-04-25T11:00', 'Australia/Sydney'), NSW, 'AU', p, cal);
    expect(e.holiday.kind).toBe('holiday');
    expect(e.holidayBlocks).toBe(true);
    expect(e.open).toBe(false);
  });

  it('blocks a holiday in one candidate state but not its neighbour', () => {
    // Adelaide Cup Day is South Australian only; NSW works that Monday.
    const cup = localInstant('2025-03-10T11:00', 'Australia/Adelaide');
    expect(evaluateLocality(cup, SA, 'AU', p, cal).holiday.kind).toBe('holiday');
    expect(evaluateLocality(cup, NSW, 'AU', p, cal).holiday.kind).toBe('working-day');
  });

  it('leaves the working part of a part-day holiday open', () => {
    const wide = policy({ days: ['tue', 'wed', 'thu'], start: '09:00', end: '20:00' });
    // 24 December 2025 is a Wednesday; SA's holiday starts at 19:00.
    const afternoon = evaluateLocality(localInstant('2025-12-24T15:00', 'Australia/Adelaide'), SA, 'AU', wide, cal);
    const evening = evaluateLocality(localInstant('2025-12-24T19:30', 'Australia/Adelaide'), SA, 'AU', wide, cal);
    expect(afternoon.open).toBe(true);
    expect(afternoon.holidayBlocks).toBe(false);
    expect(evening.open).toBe(false);
    expect(evening.holidayBlocks).toBe(true);
  });

  it('closes the day entirely when a part-day holiday starts before the window opens', () => {
    const late = policy({ days: ['tue', 'wed', 'thu'], start: '19:00', end: '20:00' });
    const e = evaluateLocality(localInstant('2025-12-24T19:30', 'Australia/Adelaide'), SA, 'AU', late, cal);
    expect(e.policyOpen).toBe(false);
  });

  it('refuses a date in a year nobody has signed off', () => {
    const strict = policy({ requireVerifiedCalendar: true });
    const e = evaluateLocality(localInstant('2026-03-11T11:00', 'Australia/Sydney'), NSW, 'AU', strict, cal);
    expect(e.holiday.kind).toBe('unverified');
    expect(e.open).toBe(false);
  });

  it('refuses a date outside the calendar entirely', () => {
    const e = evaluateLocality(localInstant('2031-03-12T11:00', 'Australia/Sydney'), NSW, 'AU', p, cal);
    expect(e.holiday.kind).toBe('out-of-coverage');
    expect(e.open).toBe(false);
  });

  it('follows the recipient across daylight saving rather than the server clock', () => {
    // 11:00 Sydney is a different UTC instant in January (AEDT) and July (AEST).
    const summer = localInstant('2025-01-15T11:00', 'Australia/Sydney');
    const winter = localInstant('2025-07-16T11:00', 'Australia/Sydney');
    expect(evaluateLocality(summer, NSW, 'AU', p, cal).open).toBe(true);
    expect(evaluateLocality(winter, NSW, 'AU', p, cal).open).toBe(true);
    // The same instants in Perth, which does not observe daylight saving.
    expect(evaluateLocality(summer, WA, 'AU', p, cal).localTime.slice(11, 16)).toBe('08:00');
    expect(evaluateLocality(winter, WA, 'AU', p, cal).localTime.slice(11, 16)).toBe('09:00');
  });
});

describe('nextOpenAt', () => {
  const p = policy();

  it('returns the current instant when the window is already open', () => {
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

  it('skips a public holiday that lands on a permitted weekday', () => {
    // Melbourne Cup, Tuesday 4 November 2025, is a Victorian public holiday.
    const monday = localInstant('2025-11-03T18:00', 'Australia/Melbourne');
    const next = nextOpenAt(monday, [{ jurisdiction: 'au-vic', timezone: 'Australia/Melbourne' }], 'AU', p, cal);
    expect(DateTime.fromJSDate(next as Date, { zone: 'Australia/Melbourne' }).toFormat('yyyy-MM-dd')).toBe(
      '2025-11-05'
    );
  });

  it('intersects every candidate locality for a mobile', () => {
    const monday = localInstant('2025-03-10T18:00', 'Australia/Sydney');
    const next = nextOpenAt(monday, [NSW, WA], 'AU', p, cal);
    // Perth is three hours behind Sydney in March, so the common window opens when
    // Perth reaches 09:30, not when Sydney does.
    expect(DateTime.fromJSDate(next as Date, { zone: 'Australia/Perth' }).toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2025-03-11 09:30'
    );
  });

  it('returns null when the candidate localities share no window at all', () => {
    const narrow = policy({ start: '09:30', end: '10:00' });
    const at = localInstant('2025-03-10T18:00', 'Australia/Sydney');
    expect(nextOpenAt(at, [NSW, WA], 'AU', narrow, cal)).toBeNull();
  });

  it('clamps a too-early policy start to the statutory one', () => {
    // Policy asks for 08:00; the Industry Standard does not open until 09:00.
    const early = policy({ start: '08:00', end: '16:30' });
    const monday = localInstant('2025-03-10T18:00', 'Australia/Brisbane');
    const next = nextOpenAt(monday, [{ jurisdiction: 'au-qld', timezone: 'Australia/Brisbane' }], 'AU', early, cal);
    expect(DateTime.fromJSDate(next as Date, { zone: 'Australia/Brisbane' }).toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2025-03-11 09:00'
    );
  });

  it('returns null when policy opens a day the statute closes outright', () => {
    const sundays = policy({ days: ['sun'] });
    const at = localInstant('2025-03-10T09:00', 'Australia/Sydney');
    expect(nextOpenAt(at, [NSW], 'AU', sundays, cal)).toBeNull();
  });

  it('returns null when the policy window sits entirely outside the statutory one', () => {
    // Saturday trading closes at 17:00 under the Industry Standard.
    const evenings = policy({ days: ['sat'], start: '18:00', end: '19:30' });
    const at = localInstant('2025-03-10T09:00', 'Australia/Sydney');
    expect(nextOpenAt(at, [NSW], 'AU', evenings, cal)).toBeNull();
  });

  it('returns null when the horizon runs past the calendar', () => {
    const at = localInstant('2027-12-20T09:00', 'Australia/Sydney');
    expect(nextOpenAt(at, [NSW], 'AU', policy({ requireVerifiedCalendar: true }), cal, 5)).toBeNull();
  });
});
