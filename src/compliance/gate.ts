/**
 * The Compliance Gate.
 *
 * This is the only thing in the system allowed to say yes to a dial. It is a
 * pure function of the request, a state snapshot, the policy and the holiday
 * calendar: same inputs, same answer, every time, with no model involved.
 *
 * It fails closed. Anything it cannot establish - an unparseable number, a
 * calendar that does not cover the date, a wash result it has never seen - is a
 * denial, not a shrug.
 *
 * The Campaign Director can request a dial. It cannot grant one.
 */

import { DateTime } from 'luxon';
import { evaluatePolicy, evaluateStatutory, nextOpenAt, type WindowEvaluation } from './calling-window.js';
import { evaluateDnc } from './dnc.js';
import { evaluateAttempts } from './attempts.js';
import type { HolidayCalendar } from './holidays.js';
import { parsePhoneNumber, resolveLocality } from './phone.js';
import type { CompliancePolicy } from './policy.js';
import { applicableSuppressions } from './suppression.js';
import type {
  ComplianceSnapshot,
  DecisionEvidence,
  DenyCode,
  DenyReason,
  DialDecision,
  DialRequest,
  ParsedNumber,
  ResolvedLocality
} from './types.js';

function deny(
  code: DenyCode,
  detail: string,
  opts: { permanent?: boolean; retryableAt?: Date } = {}
): DenyReason {
  const reason: DenyReason = { code, detail, permanent: opts.permanent ?? false };
  if (opts.retryableAt !== undefined) reason.retryableAt = opts.retryableAt;
  return reason;
}

/**
 * When could the whole request clear?
 *
 * Every reason has to clear, so the answer is the latest of them. A permanent
 * reason means never; a reason with no known clearing time means unknown, and
 * unknown is reported as unknown rather than guessed.
 */
function combinedRetry(reasons: DenyReason[]): Date | undefined {
  if (reasons.some((r) => r.permanent)) return undefined;
  if (reasons.some((r) => r.retryableAt === undefined)) return undefined;
  return reasons
    .map((r) => r.retryableAt as Date)
    .reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

function emptyEvidence(policy: CompliancePolicy): DecisionEvidence {
  return {
    policyVersion: policy.policy_version,
    localTimes: [],
    attemptsUsed: 0,
    attemptsRemaining: policy.volume.max_attempts_per_contact,
    dialsToday: 0,
    liveCalls: 0
  };
}

function decision(
  request: DialRequest,
  reasons: DenyReason[],
  evidence: DecisionEvidence
): DialDecision {
  const result: DialDecision = {
    requestId: request.requestId,
    allowed: reasons.length === 0,
    evaluatedAt: request.at,
    reasons,
    evidence
  };
  const retry = reasons.length === 0 ? undefined : combinedRetry(reasons);
  if (retry !== undefined) result.retryableAt = retry;
  return result;
}

function callerIdFor(policy: CompliancePolicy, market: DialRequest['market']): string {
  return market === 'AU' ? policy.caller_id.au_number : policy.caller_id.nz_number;
}

/** Start of the current operational day, used for the global dial cap. */
function operationalDayStart(at: Date, policy: CompliancePolicy): DateTime {
  return DateTime.fromJSDate(at, { zone: policy.operational_timezone }).startOf('day');
}

/** The operational calendar date, which is what a day's call plan is keyed on. */
export function operationalDate(at: Date, policy: CompliancePolicy): string {
  return DateTime.fromJSDate(at, { zone: policy.operational_timezone }).toFormat('yyyy-MM-dd');
}

/**
 * Has the operator approved today's calling, and is this person on the list?
 *
 * Approval is of a named list on a named day. Nothing here can be satisfied by a
 * plan for another day, a plan still being drafted, or a plan that covers
 * somebody else.
 */
function dayPlanReason(
  plan: ComplianceSnapshot['dayPlan'],
  today: string,
  contactId: string
): DenyReason | null {
  if (plan === null) {
    return deny('DAY_PLAN_NOT_APPROVED', `no call plan has been drawn up for ${today}`);
  }
  if (plan.planDate !== today) {
    return deny(
      'DAY_PLAN_NOT_APPROVED',
      `the most recent call plan is for ${plan.planDate}; approval does not carry over to ${today}`
    );
  }
  if (plan.status !== 'approved') {
    return deny(
      'DAY_PLAN_NOT_APPROVED',
      `the call plan for ${today} is ${plan.status.replace('_', ' ')} and has not been approved`
    );
  }
  if (!plan.includesContact) {
    return deny(
      'DAY_PLAN_NOT_APPROVED',
      `the approved plan for ${today} covers ${plan.entryCount} contact(s) and ${contactId} is not one of them`
    );
  }
  return null;
}

/** A window that was checked, and which denial code applies when the clock closed it. */
interface CheckedWindow {
  evaluation: WindowEvaluation;
  closedCode: DenyCode;
  /** How to describe this window to someone reading the console. */
  label: string;
}

function windowReasons(checked: CheckedWindow[], retryableAt: Date | undefined): DenyReason[] {
  const grouped = new Map<DenyCode, string[]>();
  const add = (code: DenyCode, detail: string): void => {
    grouped.set(code, [...(grouped.get(code) ?? []), detail]);
  };

  for (const { evaluation: e, closedCode, label } of checked) {
    if (e.open) continue;
    const where = `${label} (${e.localTime})`;
    if (e.holiday.kind === 'out-of-coverage') {
      add('HOLIDAY_CALENDAR_COVERAGE_GAP', `${where}: the holiday calendar does not cover ${e.localDate}`);
    } else if (e.holiday.kind === 'unverified') {
      add(
        'HOLIDAY_CALENDAR_UNVERIFIED',
        `${where}: the ${e.localDate.slice(0, 4)} calendar is ${e.holiday.provenance.provenance} and has not been signed off`
      );
    } else if (e.holidayBlocks) {
      add('PUBLIC_HOLIDAY', `${where}: ${e.holidayNames.join(', ')}`);
    } else {
      add(
        closedCode,
        closedCode === 'OUTSIDE_STATUTORY_WINDOW'
          ? `${where}: ${e.weekday} is outside the legal calling window where the recipient is`
          : `${where}: ${e.weekday} is outside the operator's calling window`
      );
    }
  }

  return [...grouped].map(([code, details]) => {
    const opts: { retryableAt?: Date } = {};
    // A coverage gap or an unsigned-off calendar is a data problem, not a timing
    // one; suggesting a retry time for it would be a fiction.
    if (retryableAt !== undefined && code !== 'HOLIDAY_CALENDAR_COVERAGE_GAP' && code !== 'HOLIDAY_CALENDAR_UNVERIFIED') {
      opts.retryableAt = retryableAt;
    }
    return deny(code, details.join('; '), opts);
  });
}

export function evaluateDialRequest(
  request: DialRequest,
  snapshot: ComplianceSnapshot,
  policy: CompliancePolicy,
  calendar: HolidayCalendar
): DialDecision {
  const reasons: DenyReason[] = [];
  const at = request.at;

  if (snapshot.killSwitch.active) {
    reasons.push(
      deny('KILL_SWITCH_ACTIVE', `dialling is halted: ${snapshot.killSwitch.reason ?? 'no reason recorded'}`)
    );
  }

  const parsed = parsePhoneNumber(request.phone, request.market);
  if (!parsed.valid) {
    reasons.push(deny('INVALID_NUMBER', `${request.phone}: ${parsed.reason}`, { permanent: true }));
    return decision(request, reasons, emptyEvidence(policy));
  }

  const number: ParsedNumber = {
    e164: parsed.e164,
    market: parsed.market,
    lineType: parsed.lineType,
    nsn: parsed.nsn,
    areaCode: parsed.areaCode
  };

  if (number.market !== request.market) {
    reasons.push(
      deny(
        'MARKET_MISMATCH',
        `${number.e164} is a ${number.market} number but the contact is recorded in ${request.market}`,
        { permanent: true }
      )
    );
    return decision(request, reasons, { ...emptyEvidence(policy), number });
  }

  const locality: ResolvedLocality = resolveLocality(number, request.localityHint);

  if (callerIdFor(policy, request.market).trim() === '') {
    reasons.push(
      deny(
        'CALLER_ID_NOT_CONFIGURED',
        `no ${request.market} caller line identification number is configured; the Industry Standard requires a real, contactable number that stays answerable for ${policy.caller_id.answerable_for_days} days`
      )
    );
  }

  const suppressionSubject = {
    contactId: request.contactId,
    e164: number.e164,
    accountId: request.accountId,
    ...(request.emailDomain !== undefined ? { emailDomain: request.emailDomain } : {})
  };
  const suppressions = applicableSuppressions(snapshot.suppressions, suppressionSubject);
  if (suppressions.length > 0) {
    reasons.push(
      deny(
        'SUPPRESSED',
        suppressions.map((s) => `${s.scope} ${s.key} suppressed (${s.source}): ${s.reason}`).join('; '),
        { permanent: true }
      )
    );
  }

  const dnc = evaluateDnc(number, snapshot.dncWash, policy, at);
  switch (dnc.kind) {
    case 'mobile-dialling-disabled':
      reasons.push(
        deny(
          'MOBILE_DIALLING_DISABLED',
          `${number.e164} is a mobile and mobile dialling is off until Do Not Call washing is in place; office direct dials only`
        )
      );
      break;
    case 'missing':
      reasons.push(deny('DNC_WASH_MISSING', `${number.e164} has never been washed against the ${policy.dnc.register}`));
      break;
    case 'stale':
      reasons.push(
        deny(
          'DNC_WASH_STALE',
          `${number.e164} was last washed ${dnc.washedAt.toISOString().slice(0, 10)}; the result expired ${dnc.expiresAt.toISOString().slice(0, 10)}`
        )
      );
      break;
    case 'registered':
      reasons.push(
        deny('DNC_REGISTERED', `${number.e164} is on the ${policy.dnc.register}`, { permanent: true })
      );
      break;
    case 'not-required':
    case 'ok':
      break;
  }

  const attempts = evaluateAttempts(
    request.contactId,
    snapshot.contactAttempts,
    snapshot.accountAttemptsThisWeek,
    snapshot.accountHasConversed,
    policy,
    at
  );
  if (attempts.capReached) {
    reasons.push(
      deny(
        'ATTEMPT_CAP_REACHED',
        `${attempts.used} of ${policy.volume.max_attempts_per_contact} attempts already made against this contact`,
        { permanent: true }
      )
    );
  }
  if (attempts.windowClosed) {
    reasons.push(
      deny(
        'ATTEMPT_WINDOW_CLOSED',
        `the ${policy.volume.attempt_window_days}-day attempt window for this contact closed on ${(attempts.windowClosesAt as Date).toISOString().slice(0, 10)}`,
        { permanent: true }
      )
    );
  }
  if (!attempts.minIntervalMet) {
    reasons.push(
      deny(
        'MIN_INTERVAL_NOT_ELAPSED',
        `attempts must be at least ${policy.volume.min_days_between_attempts} days apart`,
        { retryableAt: attempts.nextAttemptAllowedAt as Date }
      )
    );
  }
  if (!attempts.accountWeeklyCapMet) {
    reasons.push(
      deny(
        'ACCOUNT_WEEKLY_CAP',
        `this account has already been approached this week and nobody there has spoken to us yet`,
        { retryableAt: attempts.accountNextAllowedAt as Date }
      )
    );
  }

  // Who this number belongs to. A prospect is a real person; a test contact is a
  // number the operator controls. The distinction is read from the blackboard,
  // never taken from the request, so nothing upstream can assert its way past it.
  if (snapshot.contactKind === null) {
    reasons.push(
      deny(
        'CONTACT_NOT_ON_BLACKBOARD',
        `${request.contactId} is not on the blackboard, so there is no record of who this number belongs to`,
        { permanent: true }
      )
    );
  } else if (policy.dialling.test_contacts_only && snapshot.contactKind !== 'test') {
    reasons.push(
      deny(
        'NOT_A_TEST_CONTACT',
        `${request.contactId} is a real prospect and the system is in test mode; only numbers the operator controls may be dialled`
      )
    );
  }

  if (policy.approval.require_daily_plan) {
    const reason = dayPlanReason(snapshot.dayPlan, operationalDate(at, policy), request.contactId);
    // No retry time: a plan is approved when a person decides to approve it,
    // and inventing a timestamp for that would be a fiction.
    if (reason !== null) reasons.push(reason);
  }

  const nextOperationalDay = operationalDayStart(at, policy).plus({ days: 1 }).toJSDate();
  if (snapshot.dialsToday >= policy.volume.global_daily_dial_cap) {
    reasons.push(
      deny(
        'DAILY_DIAL_CAP',
        `${snapshot.dialsToday} dials already placed today (cap ${policy.volume.global_daily_dial_cap})`,
        { retryableAt: nextOperationalDay }
      )
    );
  }
  if (snapshot.numberDialsToday >= policy.volume.max_dials_per_number_per_day) {
    reasons.push(
      deny(
        'NUMBER_ALREADY_DIALLED_TODAY',
        `${number.e164} has already been dialled today`,
        { retryableAt: nextOperationalDay }
      )
    );
  }
  if (snapshot.liveCalls >= policy.volume.max_concurrent_calls) {
    reasons.push(
      deny('CONCURRENCY_LIMIT', `${snapshot.liveCalls} call(s) already in progress (limit ${policy.volume.max_concurrent_calls})`)
    );
  }

  // The operator's working day, on one clock, plus the legal window in every
  // place the recipient might be. Both have to be open.
  const operatorDay = evaluatePolicy(at, request.market, policy, calendar);
  const checked: CheckedWindow[] = [
    {
      evaluation: operatorDay,
      closedCode: 'OUTSIDE_POLICY_WINDOW',
      label: `the operator's day in ${operatorDay.timezone}`
    },
    ...locality.candidates.map((c) => ({
      evaluation: evaluateStatutory(at, c, request.market, policy, calendar),
      closedCode: 'OUTSIDE_STATUTORY_WINDOW' as DenyCode,
      label: c.jurisdiction
    }))
  ];

  if (checked.some((c) => !c.evaluation.open)) {
    // A calendar gap is a data problem with no retry time, so when that is the
    // only thing wrong there is nothing to project forward to.
    const timingProblem = checked.some(
      (c) =>
        !c.evaluation.open &&
        c.evaluation.holiday.kind !== 'out-of-coverage' &&
        c.evaluation.holiday.kind !== 'unverified'
    );
    const nextOpen = timingProblem
      ? nextOpenAt(at, locality.candidates, request.market, policy, calendar)
      : null;
    reasons.push(...windowReasons(checked, nextOpen ?? undefined));
  }

  const evidence: DecisionEvidence = {
    policyVersion: policy.policy_version,
    number,
    locality,
    localTimes: checked
      .slice(1)
      .map((c) => ({
        jurisdiction: c.evaluation.jurisdiction,
        timezone: c.evaluation.timezone,
        local: c.evaluation.localTime
      })),
    operatorTime: {
      timezone: operatorDay.timezone,
      local: operatorDay.localTime,
      weekday: operatorDay.weekday
    },
    attemptsUsed: attempts.used,
    attemptsRemaining: attempts.remaining,
    dialsToday: snapshot.dialsToday,
    liveCalls: snapshot.liveCalls
  };

  return decision(request, reasons, evidence);
}
