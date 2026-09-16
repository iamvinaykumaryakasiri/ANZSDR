/**
 * The daily call plan.
 *
 * Every day's calling is written down before it happens: who would be called, in
 * what order, why, and what the compliance gate already says about each of them.
 * The operator approves that list, and only that list, for that day.
 *
 * The approval is enforced in `src/compliance`, not here. This module is the
 * record; the gate is the gate.
 */

import { randomUUID } from 'node:crypto';
import type { DayPlanStore } from '../compliance/ports.js';
import type { DayPlanState, DenyReason, PlanStatus } from '../compliance/types.js';
import type { Blackboard } from './client.js';

export interface PlanEntryInput {
  contactId: string;
  accountId: string;
  e164: string;
  displayName: string;
  title: string;
  accountName: string;
  hypothesis: string;
  gateAllowed: boolean;
  gateReasons: DenyReason[];
  earliestAt: Date | null;
}

export interface PlanEntry extends PlanEntryInput {
  id: string;
  position: number;
}

export interface CallPlanRecord {
  id: string;
  campaignId: string;
  planDate: string;
  status: PlanStatus;
  createdAt: Date;
  submittedAt: Date | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  note: string;
  entries: PlanEntry[];
}

const LIVE_STATUSES: PlanStatus[] = ['draft', 'pending_approval', 'approved', 'rejected'];

export class CallPlanRepository implements DayPlanStore {
  constructor(private readonly db: Blackboard) {}

  /**
   * Replace whatever plan exists for this campaign-day with a fresh draft.
   *
   * The previous plan is superseded rather than deleted, so a rejected plan and
   * the reason it was rejected stay on the record.
   */
  async draft(
    campaignId: string,
    planDate: string,
    entries: PlanEntryInput[],
    at: Date
  ): Promise<CallPlanRecord> {
    await this.db.callPlan.updateMany({
      where: { campaignId, planDate, status: { in: LIVE_STATUSES } },
      data: { status: 'superseded' }
    });

    const id = randomUUID();
    await this.db.callPlan.create({
      data: { id, campaignId, planDate, status: 'draft', createdAt: at }
    });
    for (const [index, entry] of entries.entries()) {
      await this.db.callPlanEntry.create({
        data: {
          id: randomUUID(),
          planId: id,
          contactId: entry.contactId,
          accountId: entry.accountId,
          position: index + 1,
          e164: entry.e164,
          displayName: entry.displayName,
          title: entry.title,
          accountName: entry.accountName,
          hypothesis: entry.hypothesis,
          gateAllowed: entry.gateAllowed,
          gateReasons: JSON.stringify(entry.gateReasons),
          earliestAt: entry.earliestAt
        }
      });
    }
    return (await this.get(id)) as CallPlanRecord;
  }

  async get(id: string): Promise<CallPlanRecord | null> {
    const row = await this.db.callPlan.findUnique({
      where: { id },
      include: { entries: { orderBy: { position: 'asc' } } }
    });
    if (row === null) return null;
    return {
      id: row.id,
      campaignId: row.campaignId,
      planDate: row.planDate,
      status: row.status as PlanStatus,
      createdAt: row.createdAt,
      submittedAt: row.submittedAt,
      decidedAt: row.decidedAt,
      decidedBy: row.decidedBy,
      note: row.note,
      entries: row.entries.map((e) => ({
        id: e.id,
        position: e.position,
        contactId: e.contactId,
        accountId: e.accountId,
        e164: e.e164,
        displayName: e.displayName,
        title: e.title,
        accountName: e.accountName,
        hypothesis: e.hypothesis,
        gateAllowed: e.gateAllowed,
        gateReasons: JSON.parse(e.gateReasons) as DenyReason[],
        earliestAt: e.earliestAt
      }))
    };
  }

  /** The plan that is currently in play for a campaign-day, if any. */
  async live(campaignId: string, planDate: string): Promise<CallPlanRecord | null> {
    const row = await this.db.callPlan.findFirst({
      where: { campaignId, planDate, status: { in: LIVE_STATUSES } },
      orderBy: { createdAt: 'desc' }
    });
    return row === null ? null : this.get(row.id);
  }

  /** The newest live plan for a campaign, whatever day it is for. */
  async latest(campaignId: string): Promise<CallPlanRecord | null> {
    const row = await this.db.callPlan.findFirst({
      where: { campaignId, status: { in: LIVE_STATUSES } },
      orderBy: [{ planDate: 'desc' }, { createdAt: 'desc' }]
    });
    return row === null ? null : this.get(row.id);
  }

  async submit(id: string, at: Date): Promise<void> {
    await this.db.callPlan.update({
      where: { id },
      data: { status: 'pending_approval', submittedAt: at }
    });
  }

  async approve(id: string, by: string, at: Date, note = ''): Promise<void> {
    await this.db.callPlan.update({
      where: { id },
      data: { status: 'approved', decidedBy: by, decidedAt: at, note }
    });
  }

  async reject(id: string, by: string, at: Date, note: string): Promise<void> {
    await this.db.callPlan.update({
      where: { id },
      data: { status: 'rejected', decidedBy: by, decidedAt: at, note }
    });
  }

  /**
   * What the compliance gate needs to know: is there a plan for this day, what
   * state is it in, and is this contact on it.
   *
   * Deliberately reports the newest live plan for the campaign whatever day it
   * is for, so the gate can say "the only plan is for yesterday" rather than the
   * less useful "there is no plan".
   */
  async current(campaignId: string, planDate: string, contactId: string): Promise<DayPlanState | null> {
    const plan = (await this.live(campaignId, planDate)) ?? (await this.latest(campaignId));
    if (plan === null) return null;
    const state: DayPlanState = {
      planId: plan.id,
      planDate: plan.planDate,
      status: plan.status,
      includesContact: plan.entries.some((e) => e.contactId === contactId),
      entryCount: plan.entries.length
    };
    if (plan.decidedBy !== null) state.approvedBy = plan.decidedBy;
    if (plan.decidedAt !== null) state.approvedAt = plan.decidedAt;
    return state;
  }
}
