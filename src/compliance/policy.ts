/**
 * Compliance policy: the statutory floor, which is frozen in code, and the
 * operator policy, which is configurable.
 *
 * The statutory windows are NOT configurable and are not read from YAML. A dial
 * has to pass both the statutory check and the policy check, so a misconfigured
 * or malicious policy file can only ever make calling more restrictive. There is
 * no code path by which a config change widens the legal window.
 */

import { readFileSync } from 'node:fs';
import { IANAZone } from 'luxon';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { AU_JURISDICTIONS, NZ_JURISDICTIONS, NZ_NATIONAL, type Jurisdiction, type Market } from './types.js';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WeekdayKey = (typeof WEEKDAYS)[number];

export interface DayWindow {
  /** Inclusive local start, `HH:mm`. */
  start: string;
  /** Exclusive local end, `HH:mm`. A call must both start and be legal at its start. */
  end: string;
}

export type WeekWindow = Record<WeekdayKey, DayWindow | null>;

/**
 * Australia: Telecommunications (Telemarketing and Research Calls) Industry
 * Standard 2017 - weekdays 09:00-20:00, no Sundays, no public holidays.
 *
 * The Standard also permits Saturday 09:00-17:00. The operator has ruled Saturday
 * out entirely, so it is closed here in code rather than in config: no edit to
 * `config/policy.yaml` can re-open it. Being stricter than the Standard is always
 * allowed; being looser never is.
 */
const AU_STATUTORY: WeekWindow = Object.freeze({
  mon: { start: '09:00', end: '20:00' },
  tue: { start: '09:00', end: '20:00' },
  wed: { start: '09:00', end: '20:00' },
  thu: { start: '09:00', end: '20:00' },
  fri: { start: '09:00', end: '20:00' },
  sat: null,
  sun: null
});

/**
 * New Zealand has no statutory telemarketing window. This is the NZ Marketing
 * Association convention applied conservatively, and it is treated as if it were
 * statutory: weekdays 09:00-17:00, no weekends, no public holidays.
 */
const NZ_STATUTORY: WeekWindow = Object.freeze({
  mon: { start: '09:00', end: '17:00' },
  tue: { start: '09:00', end: '17:00' },
  wed: { start: '09:00', end: '17:00' },
  thu: { start: '09:00', end: '17:00' },
  fri: { start: '09:00', end: '17:00' },
  sat: null,
  sun: null
});

export const STATUTORY_WINDOWS: Readonly<Record<Market, WeekWindow>> = Object.freeze({
  AU: AU_STATUTORY,
  NZ: NZ_STATUTORY
});

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

const jurisdictionSchema = z.enum([...AU_JURISDICTIONS, ...NZ_JURISDICTIONS, NZ_NATIONAL]);

const windowSchema = z
  .object({
    /**
     * The clock the calling plan is written in - the operator's own, not the
     * recipient's. Australia/Sydney means every plan is read in Sydney time
     * whoever is being called. It does NOT relax the statutory check, which is
     * always evaluated where the recipient actually is.
     */
    timezone: z.string().min(1),
    /** Whose public holidays close the operator's own working day. */
    holiday_jurisdiction: jurisdictionSchema,
    days: z.array(z.enum(WEEKDAYS)).min(0),
    start: timeSchema,
    end: timeSchema
  })
  .refine((w) => w.start < w.end, { message: 'window start must be before end' })
  .refine((w) => IANAZone.isValidZone(w.timezone), { message: 'unknown IANA timezone' });

export const policySchema = z.object({
  policy_version: z.string().min(1),
  operational_timezone: z.string().min(1),
  calling_windows: z.object({ AU: windowSchema, NZ: windowSchema }),
  caller_id: z.object({
    /** Real, contactable numbers. Never withheld, never spoofed (section 7.3). */
    au_number: z.string(),
    nz_number: z.string(),
    withheld: z.literal(false),
    answerable_for_days: z.number().int().min(30)
  }),
  dnc: z.object({
    /**
     * Apollo returns personal mobiles and a personal mobile can be on the DNCR.
     * Until washing is arranged this stays false and only office direct dials
     * are placed.
     */
    allow_mobile_dialling: z.boolean(),
    wash_required_for: z.array(z.enum(['mobile', 'fixed', 'non-geographic'])),
    wash_validity_days: z.number().int().positive(),
    register: z.string().min(1)
  }),
  volume: z.object({
    max_attempts_per_contact: z.number().int().positive(),
    attempt_window_days: z.number().int().positive(),
    min_days_between_attempts: z.number().int().positive(),
    max_contacts_per_account_per_week: z.number().int().positive(),
    global_daily_dial_cap: z.number().int().positive(),
    max_concurrent_calls: z.number().int().positive(),
    max_dials_per_number_per_day: z.number().int().positive()
  }),
  holidays: z.object({ require_verified_calendar: z.boolean() }),
  dialling: z.object({
    /**
     * While true, only contacts marked `test` may be dialled - numbers the
     * operator controls. A real prospect is refused outright. This is how the
     * system ships, and it is what makes "calls only to numbers I control" a
     * property of the compliance gate rather than a matter of care.
     */
    test_contacts_only: z.boolean()
  }),
  approval: z.object({
    /**
     * No call goes out until the operator has approved that day's plan. Approval
     * covers one named list on one named day; it never carries over.
     */
    require_daily_plan: z.boolean()
  }),
  recording: z.object({ retention_days: z.number().int().positive() }),
  kill_switch: z.object({
    auto_trip: z.object({
      escalations_per_day: z.number().int().positive(),
      error_rate: z.number().min(0).max(1),
      claim_defects_per_day: z.number().int().positive(),
      negative_sentiment_rate: z.number().min(0).max(1),
      min_calls_before_rate_trips: z.number().int().positive()
    })
  })
});

export type PolicyFile = z.infer<typeof policySchema>;

/** Where the operator sits: the clock and calendar the plan is written against. */
export interface MarketAnchor {
  timezone: string;
  jurisdiction: Jurisdiction;
}

export interface CompliancePolicy extends PolicyFile {
  /** Policy windows expressed per weekday, for direct comparison with statutory. */
  policyWindows: Record<Market, WeekWindow>;
  /** The operator's clock and calendar per market. */
  anchors: Record<Market, MarketAnchor>;
  /** Anything in the config that tried to be more permissive than the law allows. */
  warnings: string[];
}

function toWeekWindow(spec: z.infer<typeof windowSchema>): WeekWindow {
  const out = {} as WeekWindow;
  for (const day of WEEKDAYS) {
    out[day] = spec.days.includes(day) ? { start: spec.start, end: spec.end } : null;
  }
  return out;
}

/**
 * Report where policy is looser than statute. Nothing is silently clamped: both
 * windows are enforced at dial time, so a warning here is informational, not a fix.
 */
function widerThanStatute(market: Market, policy: WeekWindow): string[] {
  const warnings: string[] = [];
  const statutory = STATUTORY_WINDOWS[market];
  for (const day of WEEKDAYS) {
    const p = policy[day];
    if (p === null) continue;
    const s = statutory[day];
    if (s === null) {
      warnings.push(`${market} policy allows ${day} but the statutory window does not; ${day} stays blocked`);
      continue;
    }
    if (p.start < s.start || p.end > s.end) {
      warnings.push(
        `${market} policy window ${day} ${p.start}-${p.end} exceeds the statutory ${s.start}-${s.end}; the statutory bound applies`
      );
    }
  }
  return warnings;
}

export function loadPolicyFromObject(raw: unknown): CompliancePolicy {
  const file = policySchema.parse(raw);
  const policyWindows: Record<Market, WeekWindow> = {
    AU: toWeekWindow(file.calling_windows.AU),
    NZ: toWeekWindow(file.calling_windows.NZ)
  };
  const anchors: Record<Market, MarketAnchor> = {
    AU: {
      timezone: file.calling_windows.AU.timezone,
      jurisdiction: file.calling_windows.AU.holiday_jurisdiction
    },
    NZ: {
      timezone: file.calling_windows.NZ.timezone,
      jurisdiction: file.calling_windows.NZ.holiday_jurisdiction
    }
  };
  return {
    ...file,
    policyWindows,
    anchors,
    warnings: [...widerThanStatute('AU', policyWindows.AU), ...widerThanStatute('NZ', policyWindows.NZ)]
  };
}

export function loadPolicy(path: string): CompliancePolicy {
  return loadPolicyFromObject(parseYaml(readFileSync(path, 'utf8')) as unknown);
}
