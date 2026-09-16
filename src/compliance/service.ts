/**
 * The gate as a service: load the state snapshot, evaluate, write the audit
 * record, return the answer. The decision itself stays in the pure function in
 * `gate.ts` so it can be fuzzed without a database.
 */

import { DateTime } from 'luxon';
import type { AuditLog } from './audit.js';
import { dialDecisionRecord } from './audit.js';
import { evaluateDialRequest, operationalDate } from './gate.js';
import type { HolidayCalendar } from './holidays.js';
import type { KillSwitch } from './kill-switch.js';
import { parsePhoneNumber, resolveLocality } from './phone.js';
import type { CompliancePolicy } from './policy.js';
import type { AttemptStore, CallStateStore, ContactStore, DayPlanStore, DncStore, SuppressionStore } from './ports.js';
import type { ComplianceSnapshot, DialDecision, DialRequest } from './types.js';

export interface ComplianceGateDeps {
  policy: CompliancePolicy;
  calendar: HolidayCalendar;
  killSwitch: KillSwitch;
  suppression: SuppressionStore;
  dnc: DncStore;
  attempts: AttemptStore;
  calls: CallStateStore;
  dayPlans: DayPlanStore;
  contacts: ContactStore;
  audit: AuditLog;
}

const DAY_MS = 86_400_000;

export class ComplianceGate {
  constructor(private readonly deps: ComplianceGateDeps) {}

  /**
   * The start of the recipient's current local day. Where the recipient could be
   * in several places, the earliest of those day boundaries wins, so "once per
   * day per number" is measured over the longest plausible day.
   */
  private numberDayStart(request: DialRequest): Date {
    const parsed = parsePhoneNumber(request.phone, request.market);
    if (!parsed.valid) {
      return DateTime.fromJSDate(request.at, { zone: this.deps.policy.operational_timezone })
        .startOf('day')
        .toJSDate();
    }
    const locality = resolveLocality(parsed, request.localityHint);
    const starts = locality.candidates.map((c) =>
      DateTime.fromJSDate(request.at, { zone: c.timezone }).startOf('day').toMillis()
    );
    return new Date(Math.min(...starts));
  }

  async snapshot(request: DialRequest): Promise<ComplianceSnapshot> {
    const { policy } = this.deps;
    const parsed = parsePhoneNumber(request.phone, request.market);
    const e164 = parsed.valid ? parsed.e164 : request.phone;
    const operationalDayStart = DateTime.fromJSDate(request.at, { zone: policy.operational_timezone })
      .startOf('day')
      .toJSDate();
    const weekAgo = new Date(request.at.getTime() - 7 * DAY_MS);

    const [killSwitch, dayPlan, contactKind, suppressions, dncWash, contactAttempts, accountAttemptsThisWeek, accountHasConversed, dialsToday, numberDialsToday, liveCalls] =
      await Promise.all([
        this.deps.killSwitch.state(),
        this.deps.dayPlans.current(request.campaignId, operationalDate(request.at, policy), request.contactId),
        this.deps.contacts.kind(request.contactId),
        this.deps.suppression.find({
          contactId: request.contactId,
          e164,
          accountId: request.accountId,
          ...(request.emailDomain !== undefined ? { emailDomain: request.emailDomain } : {})
        }),
        this.deps.dnc.latestWash(e164),
        this.deps.attempts.forContact(request.contactId),
        this.deps.attempts.forAccountSince(request.accountId, weekAgo),
        this.deps.attempts.accountHasConversed(request.accountId),
        this.deps.attempts.countSince(operationalDayStart),
        this.deps.attempts.countForNumberSince(e164, this.numberDayStart(request)),
        this.deps.calls.liveCalls()
      ]);

    return {
      killSwitch,
      dayPlan,
      contactKind,
      suppressions,
      dncWash,
      contactAttempts,
      accountAttemptsThisWeek,
      accountHasConversed,
      dialsToday,
      numberDialsToday,
      liveCalls
    };
  }

  /** Ask for permission to dial. Every call, allowed or denied, is audited. */
  async request(request: DialRequest): Promise<DialDecision> {
    const snapshot = await this.snapshot(request);
    const decision = evaluateDialRequest(request, snapshot, this.deps.policy, this.deps.calendar);
    await this.deps.audit.append(dialDecisionRecord(request, decision));
    return decision;
  }
}
