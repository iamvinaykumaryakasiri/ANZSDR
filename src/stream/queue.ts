/**
 * Up next: the queue, with what the compliance gate says about each person.
 *
 * Two things matter about this module.
 *
 * The verdicts are the gate's own. `evaluateDialRequest` is called with the same
 * policy, calendar and state snapshot a real dial request would get, so a line
 * that reads "held: DAY_PLAN_NOT_APPROVED" is the gate speaking, not the console's
 * idea of what the gate would say. It never calls `gate.request`, which would
 * write a dial-decision audit record for a call nobody asked to make.
 *
 * And it can only read. There is no path from here to a dial, a suppression or a
 * plan approval.
 */

import { evaluateDialRequest, operationalDate } from '../compliance/gate.js';
import { nextOpenAt } from '../compliance/calling-window.js';
import { marketForDial, parsePhoneNumber, resolveLocality } from '../compliance/phone.js';
import type { DialDecision, DialRequest, Jurisdiction, Market, PlanStatus } from '../compliance/types.js';
import type { QueueItemView } from './contract.js';
import type { ConsoleDeps } from './deps.js';

/** More than this is not a "next" list; the rest are counted, not drawn. */
export const MAX_QUEUE_ITEMS = 15;
const MAX_EVALUATED = 40;

interface Entry {
  contactId: string;
  accountId: string;
  campaignId: string;
  e164: string;
  displayName: string;
  title: string;
  accountName: string;
  hypothesis: string;
}

export interface PlanSummary {
  campaign: string;
  planDate: string;
  status: PlanStatus | 'none';
  entries: number;
}

export interface QueueResult {
  /** The list as the console draws it, capped at MAX_QUEUE_ITEMS. */
  items: QueueItemView[];
  /** How many people are waiting in total, drawn or not. */
  waiting: number;
  /** Of those, how many the gate would let through at the evaluation instant. */
  allowed: number;
  /**
   * Who the dialler would take next: the first person the gate lets through, or,
   * when nobody clears it, the first in line, so the reason it is held can be shown.
   */
  head: { item: QueueItemView; allowed: boolean; retryAt: Date | null } | null;
  plans: PlanSummary[];
  /** The instant the verdicts were evaluated at. */
  evaluatedAt: Date;
}

function marketOf(country: string): Market {
  return country === 'NZ' ? 'NZ' : 'AU';
}

export interface VerdictSubject {
  id: string;
  accountId: string;
  campaignId: string;
  jurisdiction: string | null;
  timezone: string | null;
  account: { country: string };
}

/**
 * What the gate says about one person at one instant. Shared by the queue and by
 * Jarvis ("why did we stop calling..."), so both quote the same ruling.
 */
export async function dialVerdict(
  deps: ConsoleDeps,
  subject: VerdictSubject,
  phone: string,
  at: Date
): Promise<{ decision: DialDecision; market: Market; request: DialRequest }> {
  const market = marketForDial(phone, marketOf(subject.account.country));
  const request: DialRequest = {
    requestId: `console-${subject.id}`,
    contactId: subject.id,
    accountId: subject.accountId,
    campaignId: subject.campaignId,
    phone,
    market,
    source: 'orchestrator',
    at,
    ...(subject.jurisdiction !== null
      ? {
          localityHint: {
            jurisdiction: subject.jurisdiction as Jurisdiction,
            ...(subject.timezone !== null ? { timezone: subject.timezone } : {})
          }
        }
      : {})
  };
  const snapshot = await deps.gate.snapshot(request);
  return { decision: evaluateDialRequest(request, snapshot, deps.policy, deps.calendar), market, request };
}

export async function loadQueue(deps: ConsoleDeps, now: Date, alreadyCalledToday: ReadonlySet<string>): Promise<QueueResult> {
  const at = deps.gateAt(now);
  const planDate = operationalDate(at, deps.policy);
  const campaigns = await deps.db.campaign.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });

  const entries: Entry[] = [];
  const plans: PlanSummary[] = [];

  for (const campaign of campaigns) {
    const plan = await deps.plans.live(campaign.id, planDate);
    if (plan !== null) {
      plans.push({ campaign: campaign.name, planDate, status: plan.status, entries: plan.entries.length });
      for (const e of plan.entries) {
        entries.push({
          contactId: e.contactId,
          accountId: e.accountId,
          campaignId: campaign.id,
          e164: e.e164,
          displayName: e.displayName,
          title: e.title,
          accountName: e.accountName,
          hypothesis: e.hypothesis
        });
      }
      continue;
    }

    // No plan for the day. Show who would be planned, so the gate's answer
    // ("no call plan has been drawn up") is attached to real people.
    plans.push({ campaign: campaign.name, planDate, status: 'none', entries: 0 });
    const candidates = await deps.db.contact.findMany({
      where: { campaignId: campaign.id, status: { in: ['researched', 'queued'] }, phoneE164: { not: null } },
      orderBy: [{ icpScore: 'desc' }, { createdAt: 'asc' }],
      take: MAX_EVALUATED,
      include: { account: true, dossiers: { orderBy: { createdAt: 'desc' }, take: 1 } }
    });
    for (const c of candidates) {
      entries.push({
        contactId: c.id,
        accountId: c.accountId,
        campaignId: campaign.id,
        e164: c.phoneE164 as string,
        displayName: `${c.firstName} ${c.lastName}`.trim(),
        title: c.title,
        accountName: c.account.name,
        hypothesis: c.dossiers[0]?.hypothesis ?? ''
      });
    }
  }

  // Someone already rung today is not "up next", whatever the plan still says.
  const waiting = entries.filter((e) => !alreadyCalledToday.has(e.contactId)).slice(0, MAX_EVALUATED);
  const contacts = await deps.db.contact.findMany({
    where: { id: { in: waiting.map((e) => e.contactId) } },
    include: { account: true, dossiers: { orderBy: { createdAt: 'desc' }, take: 1 } }
  });
  const byId = new Map(contacts.map((c) => [c.id, c]));

  const decisions: Array<{ item: QueueItemView; decision: DialDecision }> = [];
  for (const entry of waiting) {
    const contact = byId.get(entry.contactId);
    const subject: VerdictSubject = contact ?? {
      id: entry.contactId,
      accountId: entry.accountId,
      campaignId: entry.campaignId,
      jurisdiction: null,
      timezone: null,
      account: { country: 'AU' }
    };
    const { decision, market, request } = await dialVerdict(deps, subject, entry.e164, at);

    const parsed = parsePhoneNumber(entry.e164, market);
    const earliest = parsed.valid
      ? nextOpenAt(at, resolveLocality(parsed, request.localityHint).candidates, market, deps.policy, deps.calendar, 14)
      : null;

    decisions.push({
      decision,
      item: {
        contactId: entry.contactId,
        name: entry.displayName,
        title: entry.title,
        company: entry.accountName,
        market,
        hypothesis: entry.hypothesis !== '' ? entry.hypothesis : (contact?.dossiers[0]?.hypothesis ?? ''),
        earliestLawfulAt: earliest === null ? null : earliest.toISOString(),
        gate: { allowed: decision.allowed, reasons: decision.reasons.map((r) => r.code) }
      }
    });
  }

  const headEntry = decisions.find((d) => d.decision.allowed) ?? decisions[0];
  return {
    items: decisions.slice(0, MAX_QUEUE_ITEMS).map((d) => d.item),
    waiting: decisions.length,
    allowed: decisions.filter((d) => d.decision.allowed).length,
    head:
      headEntry === undefined
        ? null
        : { item: headEntry.item, allowed: headEntry.decision.allowed, retryAt: headEntry.decision.retryableAt ?? null },
    plans,
    evaluatedAt: at
  };
}
