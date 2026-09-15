import { describe, expect, it } from 'vitest';
import { HolidayCalendar } from '../../src/compliance/holidays.js';
import { calendar } from '../support/fixtures.js';

describe('HolidayCalendar', () => {
  const cal = calendar();

  it('knows every AU and NZ jurisdiction plus the NZ national list', () => {
    expect(cal.jurisdictions()).toHaveLength(21);
    expect(cal.jurisdictions()).toContain('nz-national');
  });

  it('reports a gazetted holiday', () => {
    const s = cal.status('au-nsw', '2025-04-25', false);
    expect(s.kind).toBe('holiday');
    if (s.kind === 'holiday') expect(s.names.join()).toContain('Anzac');
  });

  it('reports a normal working day', () => {
    expect(cal.status('au-nsw', '2025-04-23', false).kind).toBe('working-day');
  });

  it('gives NZ regions the national holidays they inherit', () => {
    expect(cal.status('nz-otago', '2026-02-06', false).kind).toBe('holiday');
    const anniversary = cal.status('nz-otago', '2026-03-23', false);
    expect(anniversary.kind).toBe('holiday');
    if (anniversary.kind === 'holiday') expect(anniversary.names.join()).toContain('Otago');
  });

  it('does not leak one NZ region anniversary into another', () => {
    expect(cal.status('nz-auckland', '2026-03-23', false).kind).toBe('working-day');
  });

  it('keeps part-day evening holidays separate from whole-day ones', () => {
    const s = cal.status('au-sa', '2025-12-24', false);
    expect(s.kind).toBe('part-day-holiday');
    if (s.kind === 'part-day-holiday') expect(s.from).toBe('19:00');
  });

  it('takes the earliest start when a date carries more than one part-day holiday', () => {
    const cal2 = HolidayCalendar.fromData([
      {
        schemaVersion: 1,
        market: 'AU',
        generatedAt: 'now',
        coverage: { fromYear: 2026, toYear: 2026 },
        jurisdictions: {
          'au-nsw': {
            inherits: [],
            years: { '2026': { verified: true, provenance: 'official-dataset', source: 's', gaps: [] } },
            holidays: {
              '2026-12-24': [
                { name: 'late', partDayFrom: '19:00' },
                { name: 'early', partDayFrom: '18:00' }
              ]
            }
          }
        }
      }
    ]);
    const s = cal2.status('au-nsw', '2026-12-24', false);
    expect(s.kind).toBe('part-day-holiday');
    if (s.kind === 'part-day-holiday') expect(s.from).toBe('18:00');
  });

  it('takes the earliest start whichever order the entries arrive in', () => {
    const build = (names: Array<{ name: string; partDayFrom: string }>) =>
      HolidayCalendar.fromData([
        {
          schemaVersion: 1,
          market: 'AU',
          generatedAt: 'now',
          coverage: { fromYear: 2026, toYear: 2026 },
          jurisdictions: {
            'au-nsw': {
              inherits: [],
              years: { '2026': { verified: true, provenance: 'official-dataset', source: 's', gaps: [] } },
              holidays: { '2026-12-24': names }
            }
          }
        }
      ]);
    const ascending = build([
      { name: 'early', partDayFrom: '18:00' },
      { name: 'late', partDayFrom: '19:00' }
    ]).status('au-nsw', '2026-12-24', false);
    expect(ascending.kind === 'part-day-holiday' && ascending.from).toBe('18:00');
  });

  it('treats a whole-day holiday as whole-day even alongside a part-day one', () => {
    const s = cal.status('au-nt', '2025-12-25', false);
    expect(s.kind).toBe('holiday');
  });

  it('says so when it has never heard of the jurisdiction', () => {
    const s = cal.status('au-nsw' as never, '2026-01-01', false);
    expect(s.kind).not.toBe('out-of-coverage');
    const missing = cal.status('nz-narnia' as never, '2026-01-01', false);
    expect(missing).toEqual({ kind: 'out-of-coverage', coverage: null });
  });

  it('says so when the date falls outside its coverage', () => {
    const s = cal.status('au-nsw', '2031-01-01', false);
    expect(s.kind).toBe('out-of-coverage');
    if (s.kind === 'out-of-coverage') expect(s.coverage).toEqual({ fromYear: 2021, toYear: 2027 });
  });

  it('reports NZ coverage for an out-of-range NZ date', () => {
    const s = cal.status('nz-otago', '2031-01-01', false);
    if (s.kind === 'out-of-coverage') expect(s.coverage?.toYear).toBe(2027);
  });

  it('refuses a year nobody has signed off when verification is required', () => {
    const s = cal.status('au-nsw', '2026-03-11', true);
    expect(s.kind).toBe('unverified');
    if (s.kind === 'unverified') expect(s.provenance.provenance).toBe('derived-rule');
  });

  it('accepts a year taken straight from the official dataset', () => {
    expect(cal.status('au-nsw', '2025-04-23', true).kind).toBe('working-day');
  });

  it('lists what still needs signing off', () => {
    const unverified = cal.unverifiedYears();
    expect(unverified.length).toBeGreaterThan(0);
    expect(unverified.every((u) => !u.provenance.verified)).toBe(true);
    // Every NZ year is derived; AU is only derived past the published dataset.
    expect(unverified.some((u) => u.jurisdiction === 'au-nsw' && u.year === '2026')).toBe(true);
    expect(unverified.some((u) => u.jurisdiction === 'au-nsw' && u.year === '2025')).toBe(false);
  });

  it('rejects a calendar file that does not match the schema', () => {
    expect(() => HolidayCalendar.fromData([{ schemaVersion: 2 }])).toThrow();
  });
});
