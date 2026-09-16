/**
 * Drawing up the day's calling.
 *
 * The planner picks who would be called today, in what order, and asks the
 * compliance gate what it thinks of each of them - before anyone is asked to
 * approve anything. The operator therefore approves a list whose state they can
 * see, rather than a promise that the system will behave.
 *
 * The planner cannot approve. It drafts and submits; a person decides.
 */

import { DateTime } from 'luxon';
import { evaluateDialRequest } from '../compliance/gate.js';
import { nextOpenAt } from '../compliance/calling-window.js';
import { marketForDial, parsePhoneNumber, resolveLocality } from '../compliance/phone.js';
import type { CompliancePolicy } from '../compliance/policy.js';
import type { HolidayCalendar } from '../compliance/holidays.js';
import type { ComplianceGate } from '../compliance/service.js';
import type { DialRequest, Jurisdiction, Market } from '../compliance/types.js';
import type { Blackboard } from '../blackboard/client.js';
import type { CallPlanRecord, PlanEntryInput } from '../blackboard/call-plans.js';
import type { CallPlanRepository } from '../blackboard/call-plans.js';

export interface DailyPlannerDeps {
  db: Blackboard;
  plans: CallPlanRepository;
  gate: ComplianceGate;
  policy: CompliancePolicy;
  calendar: HolidayCalendar;
  now?: () => Date;
  /** How many people one day's plan may contain. */
  maxEntries?: number;
}

export interface DraftOptions {
  campaignId: string;
  /** Defaults to today in the operational timezone. */
  planDate?: string;
}

export class DailyCallPlanner {
  private readonly now: () => Date;
  private readonly maxEntries: number;

  constructor(private readonly deps: DailyPlannerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.maxEntries = deps.maxEntries ?? 60;
  }

  today(): string {
    return DateTime.fromJSDate(this.now(), { zone: this.deps.policy.operational_timezone }).toFormat(
      'yyyy-MM-dd'
    );
  }

  /**
   * Ask the gate what it would say about each candidate, with the approval check
   * itself switched off. Otherwise every entry would read "no approved plan" and
   * the plan could never say anything useful about itself.
   */
  private planningPolicy(): CompliancePolicy {
    return { ...this.deps.policy, approval: { require_daily_plan: false } };
  }

  async draft(options: DraftOptions): Promise<CallPlanRecord> {
    const planDate = options.planDate ?? this.today();
    const policy = this.planningPolicy();
    const at = this.now();

    const contacts = await this.deps.db.contact.findMany({
      where: {
        campaignId: options.campaignId,
        status: { in: ['researched', 'queued'] },
        phoneE164: { not: null }
      },
      orderBy: [{ icpScore: 'desc' }, { createdAt: 'asc' }],
      take: this.maxEntries,
      include: {
        account: true,
        dossiers: { orderBy: { createdAt: 'desc' }, take: 1 }
      }
    });

    const entries: PlanEntryInput[] = [];
    for (const contact of contacts) {
      const phone = contact.phoneE164 as string;
      // The number decides which market's rules apply, not the account's
      // headquarters: a New Zealand bank can employ someone on an Australian
      // mobile, and the gate is owed the clock the recipient is actually on.
      // The account's country is only the fallback for a number written in
      // national form, or one that will not parse.
      const accountMarket = (contact.account.country === 'NZ' ? 'NZ' : 'AU') as Market;
      const market = marketForDial(phone, accountMarket);

      const request: DialRequest = {
        requestId: `plan-${planDate}-${contact.id}`,
        contactId: contact.id,
        accountId: contact.accountId,
        campaignId: options.campaignId,
        phone,
        market,
        source: 'orchestrator',
        at,
        ...(contact.jurisdiction !== null
          ? {
              localityHint: {
                jurisdiction: contact.jurisdiction as Jurisdiction,
                ...(contact.timezone !== null ? { timezone: contact.timezone } : {})
              }
            }
          : {})
      };

      const snapshot = await this.deps.gate.snapshot(request);
      const decision = evaluateDialRequest(request, { ...snapshot, dayPlan: null }, policy, this.deps.calendar);

      entries.push({
        contactId: contact.id,
        accountId: contact.accountId,
        e164: phone,
        displayName: `${contact.firstName} ${contact.lastName}`,
        title: contact.title,
        accountName: contact.account.name,
        hypothesis: contact.dossiers[0]?.hypothesis ?? '',
        gateAllowed: decision.allowed,
        gateReasons: decision.reasons,
        earliestAt: this.earliestCallableAt(phone, market, request, planDate)
      });
    }

    return this.deps.plans.draft(options.campaignId, planDate, entries, at);
  }

  /**
   * The first moment today at which this person could lawfully be called, on the
   * operator's clock and theirs. Null when today offers no such moment.
   */
  private earliestCallableAt(
    phone: string,
    market: Market,
    request: DialRequest,
    planDate: string
  ): Date | null {
    const parsed = parsePhoneNumber(phone, market);
    if (!parsed.valid) return null;
    const locality = resolveLocality(parsed, request.localityHint);
    const dayStart = DateTime.fromISO(planDate, { zone: this.deps.policy.operational_timezone })
      .startOf('day')
      .toJSDate();
    const from = dayStart > request.at ? dayStart : request.at;
    const next = nextOpenAt(from, locality.candidates, market, this.planningPolicy(), this.deps.calendar, 2);
    if (next === null) return null;
    const sameDay =
      DateTime.fromJSDate(next, { zone: this.deps.policy.operational_timezone }).toFormat('yyyy-MM-dd') ===
      planDate;
    return sameDay ? next : null;
  }

  /** Hand the draft to the operator. Nothing dials until they say so. */
  async submit(planId: string): Promise<void> {
    await this.deps.plans.submit(planId, this.now());
  }
}

/** A plain-English rendering of a plan, for the terminal and for the digest email. */
export function renderPlan(plan: CallPlanRecord, timezone: string): string {
  const lines: string[] = [];
  const callable = plan.entries.filter((e) => e.gateAllowed);
  lines.push(`Call plan for ${plan.planDate} — ${plan.status.replace('_', ' ')}`);
  lines.push(
    `${plan.entries.length} contact(s) planned, ${callable.length} clear the compliance gate right now`
  );
  if (plan.decidedBy !== null) {
    lines.push(`decided by ${plan.decidedBy} at ${plan.decidedAt?.toISOString() ?? 'unknown'}`);
  }
  if (plan.note !== '') lines.push(`note: ${plan.note}`);
  lines.push('');

  for (const entry of plan.entries) {
    const when =
      entry.earliestAt === null
        ? 'no lawful window today'
        : `from ${DateTime.fromJSDate(entry.earliestAt, { zone: timezone }).toFormat('HH:mm')}`;
    lines.push(`${String(entry.position).padStart(2)}. ${entry.displayName} — ${entry.title}, ${entry.accountName}`);
    lines.push(`    ${entry.e164} · ${when}`);
    if (entry.hypothesis !== '') lines.push(`    why: ${entry.hypothesis}`);
    if (!entry.gateAllowed) {
      for (const reason of entry.gateReasons) lines.push(`    blocked: ${reason.code} — ${reason.detail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
