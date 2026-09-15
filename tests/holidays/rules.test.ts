/**
 * The holiday rules are validated differentially against five years of official
 * `data.gov.au` data. If the rules can reproduce every gazetted holiday for every
 * Australian jurisdiction from 2021 to 2025, the 2026-2027 dates they derive are
 * credible; if they cannot, no future year should be trusted either.
 */

import { describe, expect, it } from 'vitest';
import { derive, gapsFor, readOfficialAu } from '../../scripts/holidays/build.js';
import { AU_RULES, NZ_RULES } from '../../scripts/holidays/rules.js';
import { easterSunday, isoWeekday, observe } from '../../scripts/holidays/evaluate.js';

describe('easter', () => {
  it('matches known Gregorian Easter Sundays', () => {
    expect(easterSunday(2021)).toBe('2021-04-04');
    expect(easterSunday(2024)).toBe('2024-03-31');
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    expect(easterSunday(2038)).toBe('2038-04-25');
  });
});

describe('AU rules against the official dataset', () => {
  const official = readOfficialAu();
  const jurisdictions = [...new Set(official.map((r) => r.jurisdiction))].sort();

  it('covers all eight states and territories', () => {
    expect(jurisdictions).toEqual(['au-act', 'au-nsw', 'au-nt', 'au-qld', 'au-sa', 'au-tas', 'au-vic', 'au-wa']);
  });

  for (let year = 2021; year <= 2025; year++) {
    it(`reproduces every gazetted holiday in ${year}`, () => {
      const misses: string[] = [];
      for (const j of jurisdictions) {
        const derived = derive(AU_RULES, j, year);
        for (const row of official.filter((r) => r.jurisdiction === j && r.date.startsWith(String(year)))) {
          if (!derived.has(row.date)) misses.push(`${j} ${row.date} ${row.name}`);
        }
      }
      expect(misses).toEqual([]);
    });
  }
});

describe('NZ rules', () => {
  it('Mondayises Anzac Day onto the following Monday', () => {
    const anzac = NZ_RULES.find((r) => r.name === 'Anzac Day');
    // 25 April 2026 is a Saturday.
    expect(observe(anzac!, 2026).map((o) => o.date)).toEqual(['2026-04-25', '2026-04-27']);
  });

  it('pushes a weekend Boxing Day two days on, clearing the Christmas substitute', () => {
    const boxing = NZ_RULES.find((r) => r.name === 'Boxing Day' && r.jurisdictions[0] === 'nz-national');
    // 2027: Christmas falls Saturday, Boxing Day Sunday.
    expect(observe(boxing!, 2027).map((o) => o.date)).toEqual(['2027-12-26', '2027-12-28']);
  });

  it('puts every anniversary day on the weekday its province observes', () => {
    const on = (name: string, year: number): string[] =>
      observe(NZ_RULES.find((r) => r.name === name)!, year).map((o) => o.date);
    expect(on('Auckland Anniversary Day', 2026)).toEqual(['2026-01-26']);
    expect(on('Wellington Anniversary Day', 2026)).toEqual(['2026-01-19']);
    expect(on('Nelson Anniversary Day', 2026)).toEqual(['2026-02-02']);
    expect(on('Otago Anniversary Day', 2026)).toEqual(['2026-03-23']);
    // Southland observes Easter Tuesday.
    expect(on('Southland Anniversary Day', 2026)).toEqual(['2026-04-07']);
    // Hawke's Bay is the Friday before Labour Day; Marlborough the Monday after.
    expect(on("Hawke's Bay Anniversary Day", 2026)).toEqual(['2026-10-23']);
    expect(on('Marlborough Anniversary Day', 2026)).toEqual(['2026-11-02']);
    // Canterbury Show Day: the second Friday after the first Tuesday in November.
    expect(on('Canterbury Anniversary Day', 2026)).toEqual(['2026-11-13']);
  });

  it('places every derived anniversary day on the weekday it is defined for', () => {
    for (const rule of NZ_RULES) {
      if (!rule.name.includes('Anniversary')) continue;
      if (rule.name.startsWith('Canterbury') || rule.name.startsWith("Hawke's")) {
        expect(observe(rule, 2026).map((o) => isoWeekday(o.date))).toEqual([5]);
      } else if (rule.name.startsWith('Southland')) {
        expect(observe(rule, 2026).map((o) => isoWeekday(o.date))).toEqual([2]);
      } else {
        expect(observe(rule, 2026).map((o) => isoWeekday(o.date))).toEqual([1]);
      }
    }
  });
});

describe('gaps', () => {
  it('reports proclaimed holidays with no published date rather than pretending they do not exist', () => {
    expect(gapsFor(AU_RULES, 'au-wa', 2027).join()).toContain("King's Birthday");
    expect(gapsFor(AU_RULES, 'au-wa', 2026)).toEqual([]);
  });

  it('does not report a holiday as missing before it existed', () => {
    expect(gapsFor(NZ_RULES, 'nz-national', 2021)).toEqual([]);
    expect(gapsFor(NZ_RULES, 'nz-national', 2026)).toEqual([]);
  });
});
