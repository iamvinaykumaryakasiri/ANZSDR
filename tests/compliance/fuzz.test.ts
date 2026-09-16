/**
 * Phase 1 acceptance: a fuzz test over 10,000 synthetic dial requests yields zero
 * out-of-window or suppressed dials.
 *
 * Every decision is checked against an oracle written independently of the gate:
 * its own area-code table, its own window arithmetic, its own read of the raw
 * holiday JSON. Agreement between two implementations that were written
 * separately is worth far more than a test that walks the same code twice.
 *
 * The run also asserts the converse - that the gate ALLOWS everything the oracle
 * says it should. A gate that denied everything would trivially satisfy "zero
 * out-of-window dials" while being useless, so both directions are checked.
 */

import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { evaluateDialRequest } from '../../src/compliance/gate.js';
import { suppress } from '../../src/compliance/suppression.js';
import type { CompliancePolicy } from '../../src/compliance/policy.js';
import type {
  AttemptRecord,
  ComplianceSnapshot,
  ContactKind,
  DayPlanState,
  DialRequest,
  DncWashRecord,
  PlanStatus,
  SuppressionEntry
} from '../../src/compliance/types.js';
import {
  AU_CALENDAR_PATH,
  calendar,
  mulberry32,
  NZ_CALENDAR_PATH,
  policy
} from '../support/fixtures.js';

const DAY = 86_400_000;

/* ---------------------------------------------------------------- */
/* The oracle: written from the brief, not from the implementation.  */
/* ---------------------------------------------------------------- */

interface RawCalendar {
  coverage: { fromYear: number; toYear: number };
  jurisdictions: Record<
    string,
    {
      inherits: string[];
      years: Record<string, { verified: boolean }>;
      holidays: Record<string, Array<{ name: string; partDayFrom?: string }>>;
    }
  >;
}

const RAW: RawCalendar[] = [
  JSON.parse(readFileSync(AU_CALENDAR_PATH, 'utf8')) as RawCalendar,
  JSON.parse(readFileSync(NZ_CALENDAR_PATH, 'utf8')) as RawCalendar
];

function rawJurisdiction(id: string) {
  for (const file of RAW) {
    const j = file.jurisdictions[id];
    if (j !== undefined) return { file, j };
  }
  return null;
}

const ZONES: Record<string, string> = {
  'au-act': 'Australia/Sydney',
  'au-nsw': 'Australia/Sydney',
  'au-nt': 'Australia/Darwin',
  'au-qld': 'Australia/Brisbane',
  'au-sa': 'Australia/Adelaide',
  'au-tas': 'Australia/Hobart',
  'au-vic': 'Australia/Melbourne',
  'au-wa': 'Australia/Perth',
  'nz-auckland': 'Pacific/Auckland',
  'nz-canterbury': 'Pacific/Auckland',
  'nz-chatham': 'Pacific/Chatham',
  'nz-hawkes-bay': 'Pacific/Auckland',
  'nz-marlborough': 'Pacific/Auckland',
  'nz-nelson': 'Pacific/Auckland',
  'nz-otago': 'Pacific/Auckland',
  'nz-south-canterbury': 'Pacific/Auckland',
  'nz-southland': 'Pacific/Auckland',
  'nz-taranaki': 'Pacific/Auckland',
  'nz-wellington': 'Pacific/Auckland',
  'nz-westland': 'Pacific/Auckland'
};

// Saturday is closed: stricter than the Industry Standard, by the operator's
// instruction, and closed in code rather than config.
const AU_STATUTORY: Record<number, [string, string] | null> = {
  1: ['09:00', '20:00'],
  2: ['09:00', '20:00'],
  3: ['09:00', '20:00'],
  4: ['09:00', '20:00'],
  5: ['09:00', '20:00'],
  6: null,
  7: null
};
const NZ_STATUTORY: Record<number, [string, string] | null> = {
  1: ['09:00', '17:00'],
  2: ['09:00', '17:00'],
  3: ['09:00', '17:00'],
  4: ['09:00', '17:00'],
  5: ['09:00', '17:00'],
  6: null,
  7: null
};

/**
 * Is a window open in one jurisdiction at one instant?
 *
 * `bounds` is the window being tested - the statutory one where the recipient
 * is, or the operator's own. The holiday calendar is read raw, from the JSON.
 */
function oracleWindowOpen(
  at: Date,
  jurisdiction: string,
  timezone: string,
  bounds: (weekday: number) => [string, string] | null,
  p: CompliancePolicy
): boolean {
  const entry = rawJurisdiction(jurisdiction);
  if (entry === null) return false;

  const dt = DateTime.fromJSDate(at, { zone: timezone });
  const date = dt.toFormat('yyyy-MM-dd');
  const hhmm = dt.toFormat('HH:mm');

  const provenance = entry.j.years[date.slice(0, 4)];
  if (provenance === undefined) return false;
  if (p.holidays.require_verified_calendar && !provenance.verified) return false;

  const window = bounds(dt.weekday);
  if (window === null) return false;
  const [start, rawEnd] = window;
  let end = rawEnd;

  const entries = [
    ...(entry.j.holidays[date] ?? []),
    ...entry.j.inherits.flatMap((parent) => rawJurisdiction(parent)?.j.holidays[date] ?? [])
  ];
  if (entries.length > 0) {
    if (entries.some((e) => e.partDayFrom === undefined)) return false;
    const earliest = entries.map((e) => e.partDayFrom as string).sort()[0] as string;
    if (earliest < end) end = earliest;
  }

  if (start >= end) return false;
  return hhmm >= start && hhmm < end;
}

/** The legal window, where the recipient actually is. */
function oracleStatutoryOpen(at: Date, jurisdiction: string, market: 'AU' | 'NZ', p: CompliancePolicy): boolean {
  const table = market === 'AU' ? AU_STATUTORY : NZ_STATUTORY;
  return oracleWindowOpen(at, jurisdiction, ZONES[jurisdiction] as string, (w) => table[w] ?? null, p);
}

/** The operator's working day, on one clock per market. */
function oraclePolicyOpen(at: Date, market: 'AU' | 'NZ', p: CompliancePolicy): boolean {
  const spec = p.calling_windows[market];
  const days = spec.days as string[];
  return oracleWindowOpen(
    at,
    spec.holiday_jurisdiction,
    spec.timezone,
    (w) => {
      const key = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][w - 1] as string;
      return days.includes(key) ? [spec.start, spec.end] : null;
    },
    p
  );
}

/** Both windows, which is what the gate requires. */
function oracleOpen(at: Date, jurisdiction: string, market: 'AU' | 'NZ', p: CompliancePolicy): boolean {
  return oraclePolicyOpen(at, market, p) && oracleStatutoryOpen(at, jurisdiction, market, p);
}

/* ---------------------------------------------------------------- */
/* The generator                                                     */
/* ---------------------------------------------------------------- */

const AU_AREA: Record<string, string[]> = {
  '2': ['au-nsw', 'au-act'],
  '3': ['au-vic', 'au-tas'],
  '7': ['au-qld'],
  '8': ['au-sa', 'au-wa', 'au-nt']
};
const AU_ALL = ['au-act', 'au-nsw', 'au-nt', 'au-qld', 'au-sa', 'au-tas', 'au-vic', 'au-wa'];
const NZ_AREA: Record<string, string[]> = {
  '3': ['nz-nelson', 'nz-marlborough', 'nz-westland', 'nz-canterbury', 'nz-south-canterbury', 'nz-otago', 'nz-southland'],
  '4': ['nz-wellington'],
  '6': ['nz-taranaki', 'nz-hawkes-bay', 'nz-wellington'],
  '7': ['nz-auckland'],
  '9': ['nz-auckland']
};
const NZ_ALL = [
  'nz-auckland', 'nz-canterbury', 'nz-chatham', 'nz-hawkes-bay', 'nz-marlborough', 'nz-nelson',
  'nz-otago', 'nz-south-canterbury', 'nz-southland', 'nz-taranaki', 'nz-wellington', 'nz-westland'
];

const BAD_NUMBERS = ['', 'call me', '+1 415 555 0100', '+61 2 8000', '+64 9 456', '0412 34'];

interface Generated {
  request: DialRequest;
  snapshot: ComplianceSnapshot;
  candidates: string[];
  valid: boolean;
  marketMismatch: boolean;
  lineType: 'fixed' | 'mobile' | 'non-geographic';
  suppressed: boolean;
  planDate: string;
  contactKind: ContactKind | null;
}

function digits(rand: () => number, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += Math.floor(rand() * 10);
  return out;
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

function generate(rand: () => number, index: number): Generated {
  const market = rand() < 0.65 ? 'AU' : 'NZ';
  const roll = rand();

  let phone: string;
  let candidates: string[];
  let lineType: 'fixed' | 'mobile' | 'non-geographic';
  let valid = true;
  let numberMarket = market;

  if (roll < 0.05) {
    phone = pick(rand, BAD_NUMBERS);
    candidates = [];
    lineType = 'fixed';
    valid = false;
  } else if (roll < 0.1) {
    // A number from the other market, recorded against this one.
    numberMarket = market === 'AU' ? 'NZ' : 'AU';
    phone = numberMarket === 'AU' ? `+612${digits(rand, 8)}` : `+649${digits(rand, 7)}`;
    candidates = [];
    lineType = 'fixed';
  } else if (roll < 0.55) {
    const area = market === 'AU' ? pick(rand, Object.keys(AU_AREA)) : pick(rand, Object.keys(NZ_AREA));
    phone = market === 'AU' ? `+61${area}${digits(rand, 8)}` : `+64${area}${digits(rand, 7)}`;
    candidates = (market === 'AU' ? AU_AREA : NZ_AREA)[area] as string[];
    lineType = 'fixed';
  } else if (roll < 0.9) {
    phone = market === 'AU' ? `+614${digits(rand, 8)}` : `+6421${digits(rand, 7)}`;
    candidates = market === 'AU' ? AU_ALL : NZ_ALL;
    lineType = 'mobile';
  } else {
    phone = market === 'AU' ? `+611300${digits(rand, 6)}` : `+64800${digits(rand, 6)}`;
    candidates = market === 'AU' ? AU_ALL : NZ_ALL;
    lineType = 'non-geographic';
  }

  // Instants spread across four years, which straddles the boundary between the
  // signed-off official dataset, the derived years, and the end of coverage.
  // Two thirds are drawn from business hours on a weekday so the run concentrates
  // on the boundary cases rather than on nights and Sundays, where every
  // implementation trivially agrees.
  let at: Date;
  if (rand() < 0.67) {
    const day = DateTime.fromMillis(Date.UTC(2024, 0, 1) + Math.floor(rand() * 1400 * DAY), {
      zone: 'Australia/Sydney'
    }).startOf('day');
    // Land on Tuesday, Wednesday or Thursday, around the edges of the policy window.
    const target = 2 + Math.floor(rand() * 3);
    const weekday = day.plus({ days: (target - day.weekday + 7) % 7 });
    at = weekday.set({ hour: 9 + Math.floor(rand() * 8), minute: Math.floor(rand() * 60) }).toJSDate();
  } else {
    at = new Date(Date.UTC(2024, 0, 1) + Math.floor(rand() * 1600 * DAY) + Math.floor(rand() * DAY));
  }

  const contactId = `contact-${Math.floor(rand() * 500)}`;
  const accountId = `account-${Math.floor(rand() * 120)}`;

  const suppressions: SuppressionEntry[] = [];
  const suppressed = rand() < 0.12;
  if (suppressed) {
    suppressions.push(
      pick(rand, [
        suppress('contact', contactId, 'not-interested', 'declined on a previous call', at),
        suppress('account', accountId, 'existing-relationship', 'already a Hexaware client', at)
      ])
    );
  }
  // Entries that look similar but belong to someone else must not block anything.
  if (rand() < 0.15) {
    suppressions.push(suppress('contact', `contact-other-${index}`, 'complaint', 'unrelated', at));
  }

  const attemptCount = Math.floor(rand() * 4);
  const contactAttempts: AttemptRecord[] = [];
  for (let i = 0; i < attemptCount; i++) {
    contactAttempts.push({
      contactId,
      accountId,
      e164: phone,
      at: new Date(at.getTime() - Math.floor(rand() * 40 * DAY)),
      hadConversation: rand() < 0.2
    });
  }

  const accountAttemptsThisWeek: AttemptRecord[] = [];
  if (rand() < 0.3) {
    accountAttemptsThisWeek.push({
      contactId: rand() < 0.4 ? contactId : `contact-${Math.floor(rand() * 500)}`,
      accountId,
      e164: `+612${digits(rand, 8)}`,
      at: new Date(at.getTime() - Math.floor(rand() * 6 * DAY)),
      hadConversation: false
    });
  }

  let dncWash: DncWashRecord | null = null;
  if (rand() < 0.7) {
    dncWash = {
      e164: phone,
      result: rand() < 0.15 ? 'registered' : 'clear',
      washedAt: new Date(at.getTime() - Math.floor(rand() * 60 * DAY)),
      register: 'ACMA Do Not Call Register'
    };
  }

  // The day's plan, in every state an operator could leave it in.
  const planDate = DateTime.fromJSDate(at, { zone: 'Australia/Sydney' }).toFormat('yyyy-MM-dd');
  const planRoll = rand();
  let dayPlan: DayPlanState | null;
  if (planRoll < 0.08) {
    dayPlan = null;
  } else {
    const status: PlanStatus =
      planRoll < 0.16 ? 'pending_approval' : planRoll < 0.2 ? 'rejected' : planRoll < 0.24 ? 'draft' : 'approved';
    const staleDate = planRoll >= 0.24 && planRoll < 0.3;
    dayPlan = {
      planId: `plan-${index}`,
      planDate: staleDate
        ? DateTime.fromJSDate(at, { zone: 'Australia/Sydney' }).minus({ days: 1 }).toFormat('yyyy-MM-dd')
        : planDate,
      status,
      includesContact: planRoll >= 0.38,
      entryCount: 12
    };
  }

  // Who the number belongs to. A small share are not on the blackboard at all,
  // which the gate has to refuse rather than assume anything about.
  const kindRoll = rand();
  const contactKind: ContactKind | null = kindRoll < 0.04 ? null : kindRoll < 0.28 ? 'prospect' : 'test';

  const request: DialRequest = {
    requestId: `fuzz-${index}`,
    contactId,
    accountId,
    campaignId: 'anz-bfsi',
    phone,
    market,
    source: 'orchestrator',
    at
  };

  const snapshot: ComplianceSnapshot = {
    killSwitch: rand() < 0.03 ? { active: true, reason: 'fuzz' } : { active: false },
    dayPlan,
    contactKind,
    suppressions,
    dncWash,
    contactAttempts,
    accountAttemptsThisWeek,
    accountHasConversed: rand() < 0.2,
    dialsToday: Math.floor(rand() * 70),
    numberDialsToday: rand() < 0.15 ? 1 : 0,
    liveCalls: rand() < 0.1 ? 1 : 0
  };

  return {
    request,
    snapshot,
    candidates,
    valid,
    marketMismatch: numberMarket !== market,
    lineType,
    suppressed,
    planDate,
    contactKind
  };
}

/** Everything the oracle thinks is wrong with a request, from the brief's rules. */
function oracleReasons(g: Generated, p: CompliancePolicy): string[] {
  const reasons: string[] = [];
  const { request: r, snapshot: s } = g;

  if (s.killSwitch.active) reasons.push('kill-switch');
  if (!g.valid) return [...reasons, 'invalid-number'];
  if (g.marketMismatch) return [...reasons, 'market-mismatch'];

  if (s.suppressions.some((e) => (e.scope === 'contact' && e.key === r.contactId) || (e.scope === 'account' && e.key === r.accountId))) {
    reasons.push('suppressed');
  }

  // A wash that says the number is on the register settles it, whoever owns the
  // number and whatever line type it is. Below that: a number the operator owns
  // is not what the register protects, so the rest of the rules drop away for it.
  const operatorTestNumber =
    s.contactKind === 'test' && p.dnc.exempt_test_contacts && p.dialling.test_contacts_only;
  if (s.dncWash !== null && s.dncWash.result === 'registered') {
    reasons.push('dnc-registered');
  } else if (!operatorTestNumber) {
    if (g.lineType === 'mobile' && !p.dnc.allow_mobile_dialling) {
      reasons.push('mobile-disabled');
    } else if (p.dnc.wash_required_for.includes(g.lineType)) {
      if (s.dncWash === null) reasons.push('wash-missing');
      else if (r.at.getTime() - s.dncWash.washedAt.getTime() >= p.dnc.wash_validity_days * DAY) {
        reasons.push('wash-stale');
      }
    }
  }

  const sorted = [...s.contactAttempts].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (sorted.length >= p.volume.max_attempts_per_contact) reasons.push('attempt-cap');
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first !== undefined && last !== undefined) {
    if (r.at.getTime() >= first.at.getTime() + p.volume.attempt_window_days * DAY) reasons.push('window-closed');
    if (r.at.getTime() < last.at.getTime() + p.volume.min_days_between_attempts * DAY) reasons.push('min-interval');
  }
  const distinct = new Set(s.accountAttemptsThisWeek.map((a) => a.contactId));
  if (!s.accountHasConversed && !distinct.has(r.contactId) && distinct.size >= p.volume.max_contacts_per_account_per_week) {
    reasons.push('account-weekly');
  }

  if (s.dialsToday >= p.volume.global_daily_dial_cap) reasons.push('daily-cap');
  if (s.numberDialsToday >= p.volume.max_dials_per_number_per_day) reasons.push('number-today');
  if (s.liveCalls >= p.volume.max_concurrent_calls) reasons.push('concurrency');

  if (g.candidates.some((j) => !oracleOpen(r.at, j, r.market, p))) reasons.push('window');

  if (s.contactKind === null) {
    reasons.push('no-contact-record');
  } else if (p.dialling.test_contacts_only && s.contactKind !== 'test') {
    reasons.push('not-a-test-contact');
  }

  if (p.approval.require_daily_plan) {
    const plan = s.dayPlan;
    if (
      plan === null ||
      plan.planDate !== g.planDate ||
      plan.status !== 'approved' ||
      !plan.includesContact
    ) {
      reasons.push('day-plan');
    }
  }

  return reasons;
}

describe('compliance gate fuzz', () => {
  const cal = calendar();

  /**
   * Three runs. The calendar requirement is the original pair; the third turns
   * on the test-number exemption from section 7.2, because a rule that lets a
   * dial through is exactly the rule that has to be fuzzed hardest.
   */
  const RUNS = [
    { label: 'unverified calendar allowed', requireVerified: false, exempt: false, seed: 0xbadc0de, minAllowed: 80 },
    { label: 'verified calendar required', requireVerified: true, exempt: false, seed: 0xc0ffee, minAllowed: 25 },
    { label: 'operator test numbers exempt from DNC', requireVerified: false, exempt: true, seed: 0x5eed17, minAllowed: 80 }
  ] as const;

  for (const run of RUNS) {
    it(`agrees with an independent oracle across 5,000 requests (${run.label})`, () => {
      // The approval gate and test mode are on in every run. A dial that slipped
      // past either would be as serious as one that slipped past calling hours.
      const p = policy({
        requireVerifiedCalendar: run.requireVerified,
        requireDailyPlan: true,
        testContactsOnly: true,
        exemptTestContacts: run.exempt
      });
      const rand = mulberry32(run.seed);

      let allowed = 0;
      const disagreements: string[] = [];
      const outOfWindow: string[] = [];
      const suppressedDials: string[] = [];
      const unapprovedDials: string[] = [];
      const saturdayDials: string[] = [];
      const prospectDials: string[] = [];
      const registeredDials: string[] = [];

      for (let i = 0; i < 5000; i++) {
        const g = generate(rand, i);
        const decision = evaluateDialRequest(g.request, g.snapshot, p, cal);
        const expected = oracleReasons(g, p);

        if (decision.allowed !== (expected.length === 0)) {
          disagreements.push(
            `#${i} ${g.request.phone} at ${g.request.at.toISOString()}: gate=${decision.allowed ? 'allow' : decision.reasons.map((x) => x.code).join('|')} oracle=${expected.join('|') || 'allow'}`
          );
        }

        if (decision.allowed) {
          allowed += 1;
          for (const j of [...g.candidates, 'operator']) {
            const zone = j === 'operator' ? 'Australia/Sydney' : (ZONES[j] as string);
            if (DateTime.fromJSDate(g.request.at, { zone }).weekday === 6) {
              saturdayDials.push(`#${i} allowed on a Saturday in ${j}`);
            }
          }
          // The two invariants Phase 1 is accepted on, asserted directly rather
          // than inferred from the oracle agreeing.
          for (const j of g.candidates) {
            if (!oracleOpen(g.request.at, j, g.request.market, p)) {
              outOfWindow.push(`#${i} ${g.request.phone} allowed while ${j} was closed`);
            }
          }
          if (g.suppressed) suppressedDials.push(`#${i} ${g.request.contactId} allowed while suppressed`);
          if (g.contactKind !== 'test') {
            prospectDials.push(`#${i} allowed a ${g.contactKind ?? 'unknown'} contact while in test mode`);
          }
          // The exemption must never reach a number we know is on the register,
          // and a mobile must never get through on a contact that is not a test
          // number - the two things the exemption could plausibly break.
          if (g.snapshot.dncWash?.result === 'registered') {
            registeredDials.push(`#${i} ${g.request.phone} allowed while on the register`);
          }
          if (g.lineType === 'mobile' && !p.dnc.allow_mobile_dialling && g.contactKind !== 'test') {
            registeredDials.push(`#${i} ${g.request.phone} allowed a mobile that is not a test number`);
          }
          if (
            g.snapshot.dayPlan === null ||
            g.snapshot.dayPlan.status !== 'approved' ||
            g.snapshot.dayPlan.planDate !== g.planDate ||
            !g.snapshot.dayPlan.includesContact
          ) {
            unapprovedDials.push(`#${i} ${g.request.contactId} allowed without an approved plan for the day`);
          }
        }
      }

      expect(outOfWindow).toEqual([]);
      expect(suppressedDials).toEqual([]);
      expect(unapprovedDials).toEqual([]);
      expect(saturdayDials).toEqual([]);
      expect(prospectDials).toEqual([]);
      expect(registeredDials).toEqual([]);
      expect(disagreements.slice(0, 10)).toEqual([]);
      // Proof the gate is not simply refusing everything.
      expect(allowed).toBeGreaterThan(run.minAllowed);
    });
  }
});
