/**
 * Generate `config/holidays/{au,nz}.json` from the vendored official dataset plus
 * the rule engine, and report exactly where the calendar is not authoritative.
 *
 *   npm run holidays:build
 *
 * The generated files are committed. The runtime gate reads them and nothing else,
 * so a calendar change is always a reviewable diff.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AU_RULES, NZ_RULES, NZ_REGIONS, type HolidayRule } from './rules.js';
import { observe, type CivilDate } from './evaluate.js';

const ROOT = resolve(import.meta.dirname, '../..');
const OFFICIAL_AU = resolve(ROOT, 'data/sources/australian-public-holidays-combined-2021-2025.csv');

/** Years the official AU dataset covers, and therefore the years we can call verified. */
const OFFICIAL_YEARS = { from: 2021, to: 2025 };
/** How far ahead the generated calendar runs. Dials past this date are denied. */
const HORIZON_YEAR = 2027;

export interface HolidayEntry {
  name: string;
  partDayFrom?: string;
}

export interface YearProvenance {
  verified: boolean;
  provenance: 'official-dataset' | 'derived-rule';
  source: string;
  /** Holidays known to exist in this year whose date could not be determined. */
  gaps: string[];
  verifiedBy?: string;
  verifiedAt?: string;
}

export interface JurisdictionCalendar {
  inherits: string[];
  years: Record<string, YearProvenance>;
  holidays: Record<CivilDate, HolidayEntry[]>;
}

export interface HolidayCalendarFile {
  schemaVersion: 1;
  market: 'AU' | 'NZ';
  generatedAt: string;
  coverage: { fromYear: number; toYear: number };
  jurisdictions: Record<string, JurisdictionCalendar>;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export interface OfficialRow { date: CivilDate; name: string; jurisdiction: string }

export function readOfficialAu(path = OFFICIAL_AU): OfficialRow[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(1)
    .map(parseCsvLine)
    .filter((r) => r.length >= 6)
    .map((r) => {
      const raw = (r[1] as string).trim();
      return {
        date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
        name: (r[2] as string).trim(),
        jurisdiction: `au-${(r[5] as string).trim()}`
      };
    });
}

/** All dates the rules produce for a jurisdiction in a year. */
export function derive(rules: HolidayRule[], jurisdiction: string, year: number): Map<CivilDate, HolidayEntry[]> {
  const out = new Map<CivilDate, HolidayEntry[]>();
  for (const rule of rules) {
    if (!rule.jurisdictions.includes(jurisdiction)) continue;
    for (const o of observe(rule, year)) {
      const entry: HolidayEntry = { name: o.name };
      if (o.partDayFrom !== undefined) entry.partDayFrom = o.partDayFrom;
      const list = out.get(o.date) ?? [];
      list.push(entry);
      out.set(o.date, list);
    }
  }
  return out;
}

/** Proclaimed holidays with no published date for a given year. */
export function gapsFor(rules: HolidayRule[], jurisdiction: string, year: number): string[] {
  const gaps: string[] = [];
  for (const rule of rules) {
    if (!rule.jurisdictions.includes(jurisdiction)) continue;
    if (rule.proclaimed !== true) continue;
    if (rule.effectiveFrom !== undefined && year < rule.effectiveFrom) continue;
    if (observe(rule, year).length === 0) gaps.push(`${rule.name} (${rule.source})`);
  }
  return gaps;
}

function sortRecord<T>(rec: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b)));
}

function buildAu(): { file: HolidayCalendarFile; misses: string[] } {
  const official = readOfficialAu();
  const jurisdictions = [...new Set(official.map((r) => r.jurisdiction))].sort();
  const misses: string[] = [];
  const out: Record<string, JurisdictionCalendar> = {};

  for (const j of jurisdictions) {
    const holidays: Record<CivilDate, HolidayEntry[]> = {};
    const years: Record<string, YearProvenance> = {};

    for (let year = OFFICIAL_YEARS.from; year <= OFFICIAL_YEARS.to; year++) {
      const rows = official.filter((r) => r.jurisdiction === j && r.date.startsWith(String(year)));
      const derived = derive(AU_RULES, j, year);
      for (const row of rows) {
        // The generated calendar must be a superset of the gazetted one.
        const match = derived.get(row.date);
        if (match === undefined) misses.push(`${j} ${row.date} ${row.name}`);
        // The gazette records "Christmas Eve: 7pm to midnight" as an ordinary row.
        // Carry the part-day start across so an evening holiday does not block the
        // whole working day.
        const partDay =
          match !== undefined && match.every((e) => e.partDayFrom !== undefined)
            ? match.map((e) => e.partDayFrom as string).sort()[0]
            : undefined;
        (holidays[row.date] ??= []).push(partDay === undefined ? { name: row.name } : { name: row.name, partDayFrom: partDay });
      }
      // Conservative extras the rules produce but the gazette does not list stay in:
      // over-blocking one slot is cheaper than a breach.
      for (const [date, entries] of derived) {
        if (holidays[date] === undefined) holidays[date] = entries;
      }
      years[String(year)] = {
        verified: true,
        provenance: 'official-dataset',
        source: 'data.gov.au australian-holidays-machine-readable-dataset (2021-2025), retrieved 2026-09-15',
        gaps: []
      };
    }

    for (let year = OFFICIAL_YEARS.to + 1; year <= HORIZON_YEAR; year++) {
      for (const [date, entries] of derive(AU_RULES, j, year)) holidays[date] = entries;
      years[String(year)] = {
        verified: false,
        provenance: 'derived-rule',
        source: 'scripts/holidays/rules.ts - no official dataset published for this year yet',
        gaps: gapsFor(AU_RULES, j, year)
      };
    }

    out[j] = { inherits: [], years: sortRecord(years), holidays: sortRecord(holidays) };
  }

  return {
    file: {
      schemaVersion: 1,
      market: 'AU',
      generatedAt: new Date().toISOString(),
      coverage: { fromYear: OFFICIAL_YEARS.from, toYear: HORIZON_YEAR },
      jurisdictions: sortRecord(out)
    },
    misses
  };
}

function buildNz(): HolidayCalendarFile {
  const out: Record<string, JurisdictionCalendar> = {};
  const all = ['nz-national', ...NZ_REGIONS];

  for (const j of all) {
    const holidays: Record<CivilDate, HolidayEntry[]> = {};
    const years: Record<string, YearProvenance> = {};
    for (let year = OFFICIAL_YEARS.from; year <= HORIZON_YEAR; year++) {
      for (const [date, entries] of derive(NZ_RULES, j, year)) holidays[date] = entries;
      years[String(year)] = {
        verified: false,
        provenance: 'derived-rule',
        source: 'Holidays Act 2003 (NZ) rules in scripts/holidays/rules.ts - New Zealand publishes no machine-readable holiday dataset',
        gaps: gapsFor(NZ_RULES, j, year)
      };
    }
    out[j] = {
      inherits: j === 'nz-national' ? [] : ['nz-national'],
      years: sortRecord(years),
      holidays: sortRecord(holidays)
    };
  }

  return {
    schemaVersion: 1,
    market: 'NZ',
    generatedAt: new Date().toISOString(),
    coverage: { fromYear: OFFICIAL_YEARS.from, toYear: HORIZON_YEAR },
    jurisdictions: sortRecord(out)
  };
}

function main(): void {
  if (!existsSync(OFFICIAL_AU)) {
    console.error(`missing vendored source: ${OFFICIAL_AU}`);
    process.exit(1);
  }

  const { file: au, misses } = buildAu();
  const nz = buildNz();

  writeFileSync(resolve(ROOT, 'config/holidays/au.json'), `${JSON.stringify(au, null, 2)}\n`);
  writeFileSync(resolve(ROOT, 'config/holidays/nz.json'), `${JSON.stringify(nz, null, 2)}\n`);

  const count = (f: HolidayCalendarFile): number =>
    Object.values(f.jurisdictions).reduce((n, j) => n + Object.keys(j.holidays).length, 0);

  console.log(`AU: ${Object.keys(au.jurisdictions).length} jurisdictions, ${count(au)} dated entries`);
  console.log(`NZ: ${Object.keys(nz.jurisdictions).length} jurisdictions, ${count(nz)} dated entries`);

  const gaps: string[] = [];
  for (const [market, f] of [['AU', au], ['NZ', nz]] as const) {
    for (const [j, cal] of Object.entries(f.jurisdictions)) {
      for (const [year, prov] of Object.entries(cal.years)) {
        for (const g of prov.gaps) gaps.push(`${market} ${j} ${year}: ${g}`);
      }
    }
  }
  if (gaps.length > 0) {
    console.log(`\n${gaps.length} proclaimed holidays with no published date (jurisdiction-year stays unverified):`);
    for (const g of gaps) console.log(`  - ${g}`);
  }

  if (misses.length > 0) {
    console.error(`\nFAIL: ${misses.length} gazetted holidays the rules do not cover:`);
    for (const m of misses.slice(0, 40)) console.error(`  - ${m}`);
    process.exit(1);
  }
  console.log('\nrules reproduce every gazetted AU holiday 2021-2025');
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main();
}
