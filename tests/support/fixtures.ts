import { resolve } from 'node:path';
import { HolidayCalendar } from '../../src/compliance/holidays.js';
import { loadPolicyFromObject, type CompliancePolicy } from '../../src/compliance/policy.js';
import type { DialRequest } from '../../src/compliance/types.js';

export const ROOT = resolve(import.meta.dirname, '../..');

export const AU_CALENDAR_PATH = resolve(ROOT, 'config/holidays/au.json');
export const NZ_CALENDAR_PATH = resolve(ROOT, 'config/holidays/nz.json');

export function calendar(): HolidayCalendar {
  return HolidayCalendar.fromFiles([AU_CALENDAR_PATH, NZ_CALENDAR_PATH]);
}

export interface PolicyOverrides {
  requireVerifiedCalendar?: boolean;
  allowMobileDialling?: boolean;
  callerIdAu?: string;
  callerIdNz?: string;
  days?: string[];
  start?: string;
  end?: string;
  /** The operator's clock. Defaults to Sydney for AU and Auckland for NZ. */
  auTimezone?: string;
  auHolidayJurisdiction?: string;
  requireDailyPlan?: boolean;
  testContactsOnly?: boolean;
}

export function policy(overrides: PolicyOverrides = {}): CompliancePolicy {
  const days = overrides.days ?? ['tue', 'wed', 'thu'];
  const start = overrides.start ?? '09:30';
  const end = overrides.end ?? '16:30';
  return loadPolicyFromObject({
    policy_version: 'test-1.0.0',
    operational_timezone: 'Australia/Sydney',
    calling_windows: {
      AU: {
        timezone: overrides.auTimezone ?? 'Australia/Sydney',
        holiday_jurisdiction: overrides.auHolidayJurisdiction ?? 'au-nsw',
        days,
        start,
        end
      },
      NZ: { timezone: 'Pacific/Auckland', holiday_jurisdiction: 'nz-national', days, start, end }
    },
    caller_id: {
      au_number: overrides.callerIdAu ?? '+61280000000',
      nz_number: overrides.callerIdNz ?? '+6498000000',
      withheld: false,
      answerable_for_days: 30
    },
    dnc: {
      allow_mobile_dialling: overrides.allowMobileDialling ?? false,
      wash_required_for: ['mobile'],
      wash_validity_days: 30,
      register: 'ACMA Do Not Call Register'
    },
    volume: {
      max_attempts_per_contact: 3,
      attempt_window_days: 21,
      min_days_between_attempts: 5,
      max_contacts_per_account_per_week: 1,
      global_daily_dial_cap: 60,
      max_concurrent_calls: 1,
      max_dials_per_number_per_day: 1
    },
    holidays: { require_verified_calendar: overrides.requireVerifiedCalendar ?? false },
    dialling: { test_contacts_only: overrides.testContactsOnly ?? false },
    approval: { require_daily_plan: overrides.requireDailyPlan ?? false },
    recording: { retention_days: 90 },
    kill_switch: {
      auto_trip: {
        escalations_per_day: 3,
        error_rate: 0.1,
        claim_defects_per_day: 5,
        negative_sentiment_rate: 0.4,
        min_calls_before_rate_trips: 10
      }
    }
  });
}

/** An empty snapshot: nothing suppressed, nothing attempted, nothing running. */
export function cleanSnapshot(overrides: Partial<import('../../src/compliance/types.js').ComplianceSnapshot> = {}) {
  return {
    killSwitch: { active: false },
    dayPlan: null,
    contactKind: 'test' as const,
    suppressions: [],
    dncWash: null,
    contactAttempts: [],
    accountAttemptsThisWeek: [],
    accountHasConversed: false,
    dialsToday: 0,
    numberDialsToday: 0,
    liveCalls: 0,
    ...overrides
  };
}

export function request(overrides: Partial<DialRequest> = {}): DialRequest {
  return {
    requestId: 'req-1',
    contactId: 'contact-1',
    accountId: 'account-1',
    campaignId: 'anz-bfsi',
    phone: '+61280001234',
    market: 'AU',
    source: 'orchestrator',
    // Wednesday 11 March 2026, 11:00 Sydney - inside every window.
    at: new Date('2026-03-11T00:00:00.000Z'),
    ...overrides
  };
}

/** Deterministic PRNG so a fuzz failure is reproducible from its seed alone. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
