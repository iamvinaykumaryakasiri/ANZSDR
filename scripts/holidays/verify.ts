/**
 * Holiday calendar sign-off.
 *
 *   npm run holidays:verify                        report what is not signed off
 *   npm run holidays:verify -- --sign-off au-nsw:2026 --by "Vinay Kumar"
 *   npm run holidays:verify -- --sign-off all:2026 --by "Vinay Kumar"
 *
 * The gate refuses to dial on a date whose jurisdiction-year has not been signed
 * off (`holidays.require_verified_calendar`). That is deliberate: the official
 * Australian dataset stops at 2025, so every later year is derived from rules and
 * needs a human to check it against the gazette before a real prospect is called.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const FILES = ['config/holidays/au.json', 'config/holidays/nz.json'].map((p) => resolve(ROOT, p));

interface Provenance {
  verified: boolean;
  provenance: string;
  source: string;
  gaps: string[];
  verifiedBy?: string;
  verifiedAt?: string;
}
interface CalendarFile {
  market: string;
  jurisdictions: Record<string, { years: Record<string, Provenance>; holidays: Record<string, unknown> }>;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function report(files: CalendarFile[]): number {
  let unverified = 0;
  let gaps = 0;
  for (const file of files) {
    for (const [jurisdiction, cal] of Object.entries(file.jurisdictions)) {
      for (const [year, p] of Object.entries(cal.years)) {
        if (!p.verified) {
          unverified += 1;
          console.log(`  unsigned  ${jurisdiction} ${year}  (${p.provenance})`);
        }
        for (const gap of p.gaps) {
          gaps += 1;
          console.log(`  GAP       ${jurisdiction} ${year}  ${gap}`);
        }
      }
    }
  }
  console.log(`\n${unverified} jurisdiction-years not signed off, ${gaps} holidays with no published date.`);
  if (unverified > 0) {
    console.log('Dials on those dates are DENIED while holidays.require_verified_calendar is true.');
  }
  return unverified;
}

function signOff(files: CalendarFile[], target: string, by: string): void {
  const [jurisdiction, year] = target.split(':');
  if (jurisdiction === undefined || year === undefined) {
    console.error('--sign-off expects <jurisdiction>:<year>, for example au-nsw:2026 or all:2026');
    process.exit(2);
  }
  const at = new Date().toISOString();
  let changed = 0;
  for (const [index, file] of files.entries()) {
    for (const [id, cal] of Object.entries(file.jurisdictions)) {
      if (jurisdiction !== 'all' && id !== jurisdiction) continue;
      const p = cal.years[year];
      if (p === undefined) continue;
      p.verified = true;
      p.verifiedBy = by;
      p.verifiedAt = at;
      changed += 1;
    }
    writeFileSync(FILES[index] as string, `${JSON.stringify(file, null, 2)}\n`);
  }
  console.log(`signed off ${changed} jurisdiction-year(s) for ${year} as ${by}`);
  console.log('Commit the change so the sign-off is on the record.');
}

const files = FILES.map((p) => JSON.parse(readFileSync(p, 'utf8')) as CalendarFile);
const target = arg('sign-off');

if (target !== undefined) {
  const by = arg('by');
  if (by === undefined) {
    console.error('--sign-off requires --by "Your Name": an unattributed sign-off is not a sign-off');
    process.exit(2);
  }
  signOff(files, target, by);
} else {
  process.exit(report(files) > 0 ? 1 : 0);
}
