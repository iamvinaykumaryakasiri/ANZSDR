/**
 * Runtime holiday calendar.
 *
 * Reads the generated files in `config/holidays/` and answers one question:
 * is this calendar date a public holiday in this jurisdiction, and do we actually
 * know? "We do not know" is a distinct answer from "no", and the gate treats it
 * as a denial - a dial on an unknown date is a dial we cannot defend.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Jurisdiction } from './types.js';

const holidayEntrySchema = z.object({
  name: z.string(),
  partDayFrom: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'partDayFrom must be HH:mm')
    .optional()
});

const yearProvenanceSchema = z.object({
  verified: z.boolean(),
  provenance: z.enum(['official-dataset', 'derived-rule']),
  source: z.string(),
  gaps: z.array(z.string()),
  /** Who signed this jurisdiction-year off, and when. Set by `npm run holidays:verify`. */
  verifiedBy: z.string().optional(),
  verifiedAt: z.string().optional()
});

const jurisdictionCalendarSchema = z.object({
  inherits: z.array(z.string()),
  years: z.record(z.string(), yearProvenanceSchema),
  holidays: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.array(holidayEntrySchema))
});

export const holidayCalendarFileSchema = z.object({
  schemaVersion: z.literal(1),
  market: z.enum(['AU', 'NZ']),
  generatedAt: z.string(),
  coverage: z.object({ fromYear: z.number().int(), toYear: z.number().int() }),
  jurisdictions: z.record(z.string(), jurisdictionCalendarSchema)
});

export type HolidayCalendarFile = z.infer<typeof holidayCalendarFileSchema>;
export type HolidayEntry = z.infer<typeof holidayEntrySchema>;
export type YearProvenance = z.infer<typeof yearProvenanceSchema>;

export type HolidayStatus =
  /** The date is covered by the calendar and is a normal working day. */
  | { kind: 'working-day' }
  /** The whole date is blocked. */
  | { kind: 'holiday'; names: string[] }
  /** Only the evening is a holiday (Christmas Eve, New Year's Eve in some states). */
  | { kind: 'part-day-holiday'; names: string[]; from: string }
  /** The calendar does not cover this date at all. */
  | { kind: 'out-of-coverage'; coverage: { fromYear: number; toYear: number } | null }
  /** The calendar covers the date but no human has signed the year off. */
  | { kind: 'unverified'; provenance: YearProvenance };

export class HolidayCalendar {
  private readonly byJurisdiction = new Map<
    string,
    { cal: z.infer<typeof jurisdictionCalendarSchema>; coverage: { fromYear: number; toYear: number } }
  >();

  private constructor(files: HolidayCalendarFile[]) {
    for (const file of files) {
      for (const [jurisdiction, cal] of Object.entries(file.jurisdictions)) {
        this.byJurisdiction.set(jurisdiction, { cal, coverage: file.coverage });
      }
    }
  }

  static fromData(files: unknown[]): HolidayCalendar {
    return new HolidayCalendar(files.map((f) => holidayCalendarFileSchema.parse(f)));
  }

  static fromFiles(paths: string[]): HolidayCalendar {
    return HolidayCalendar.fromData(paths.map((p) => JSON.parse(readFileSync(p, 'utf8')) as unknown));
  }

  /** Jurisdictions the calendar knows about, for health reporting. */
  jurisdictions(): string[] {
    return [...this.byJurisdiction.keys()].sort();
  }

  /** Every jurisdiction-year a human has not yet signed off, with the reason. */
  unverifiedYears(): Array<{ jurisdiction: string; year: string; provenance: YearProvenance }> {
    const out: Array<{ jurisdiction: string; year: string; provenance: YearProvenance }> = [];
    for (const [jurisdiction, { cal }] of this.byJurisdiction) {
      for (const [year, provenance] of Object.entries(cal.years)) {
        if (!provenance.verified) out.push({ jurisdiction, year, provenance });
      }
    }
    return out;
  }

  /**
   * Status of one calendar date in one jurisdiction.
   *
   * `requireVerified` makes an unsigned-off jurisdiction-year a hard stop rather
   * than a warning. It defaults on, so a freshly generated future year cannot be
   * dialled against until someone has checked it.
   */
  status(jurisdiction: Jurisdiction, date: string, requireVerified: boolean): HolidayStatus {
    const entry = this.byJurisdiction.get(jurisdiction);
    if (entry === undefined) {
      return { kind: 'out-of-coverage', coverage: null };
    }
    const { cal, coverage } = entry;

    const year = date.slice(0, 4);
    const provenance = cal.years[year];
    if (provenance === undefined) {
      return { kind: 'out-of-coverage', coverage };
    }
    if (requireVerified && !provenance.verified) {
      return { kind: 'unverified', provenance };
    }

    const entries: HolidayEntry[] = [
      ...(cal.holidays[date] ?? []),
      ...cal.inherits.flatMap((parent) => this.byJurisdiction.get(parent)?.cal.holidays[date] ?? [])
    ];
    if (entries.length === 0) {
      return { kind: 'working-day' };
    }

    const fullDay = entries.filter((e) => e.partDayFrom === undefined);
    if (fullDay.length > 0) {
      return { kind: 'holiday', names: fullDay.map((e) => e.name) };
    }
    const earliest = entries.reduce((a, b) => ((a.partDayFrom as string) <= (b.partDayFrom as string) ? a : b));
    return {
      kind: 'part-day-holiday',
      names: entries.map((e) => e.name),
      from: earliest.partDayFrom as string
    };
  }
}
