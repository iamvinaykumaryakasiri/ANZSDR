/**
 * Storage ports for the compliance engine.
 *
 * The engine owns the decisions; it does not own the database. Phase 2 swaps
 * these in-memory implementations for the Prisma-backed blackboard without the
 * decision logic changing a line.
 */

import type { AttemptRecord, ContactKind, DayPlanState, DncWashRecord, SuppressionEntry } from './types.js';
import type { SuppressionSubject } from './suppression.js';
import { applicableSuppressions } from './suppression.js';

export interface SuppressionStore {
  find(subject: SuppressionSubject): Promise<SuppressionEntry[]>;
  add(entry: SuppressionEntry): Promise<void>;
  list(): Promise<SuppressionEntry[]>;
}

export interface DncStore {
  latestWash(e164: string): Promise<DncWashRecord | null>;
  record(wash: DncWashRecord): Promise<void>;
}

export interface AttemptStore {
  forContact(contactId: string): Promise<AttemptRecord[]>;
  forAccountSince(accountId: string, since: Date): Promise<AttemptRecord[]>;
  accountHasConversed(accountId: string): Promise<boolean>;
  countSince(since: Date): Promise<number>;
  countForNumberSince(e164: string, since: Date): Promise<number>;
  record(attempt: AttemptRecord): Promise<void>;
}

export interface CallStateStore {
  liveCalls(): Promise<number>;
}

export interface ContactStore {
  /** Whether this contact is a test number or a real prospect. Null if unknown. */
  kind(contactId: string): Promise<ContactKind | null>;
}

export interface DayPlanStore {
  /**
   * The live plan for this campaign on this operational date, and whether this
   * contact is on it. Returns null when no plan has been drawn up at all.
   */
  current(campaignId: string, planDate: string, contactId: string): Promise<DayPlanState | null>;
}

export class InMemorySuppressionStore implements SuppressionStore {
  private readonly entries: SuppressionEntry[] = [];

  async find(subject: SuppressionSubject): Promise<SuppressionEntry[]> {
    return applicableSuppressions(this.entries, subject);
  }

  async add(entry: SuppressionEntry): Promise<void> {
    this.entries.push(entry);
  }

  async list(): Promise<SuppressionEntry[]> {
    return [...this.entries];
  }
}

export class InMemoryDncStore implements DncStore {
  private readonly washes = new Map<string, DncWashRecord>();

  async latestWash(e164: string): Promise<DncWashRecord | null> {
    return this.washes.get(e164) ?? null;
  }

  async record(wash: DncWashRecord): Promise<void> {
    const existing = this.washes.get(wash.e164);
    if (existing === undefined || existing.washedAt <= wash.washedAt) {
      this.washes.set(wash.e164, wash);
    }
  }
}

export class InMemoryAttemptStore implements AttemptStore {
  private readonly attempts: AttemptRecord[] = [];

  async forContact(contactId: string): Promise<AttemptRecord[]> {
    return this.attempts.filter((a) => a.contactId === contactId);
  }

  async forAccountSince(accountId: string, since: Date): Promise<AttemptRecord[]> {
    return this.attempts.filter((a) => a.accountId === accountId && a.at >= since);
  }

  async accountHasConversed(accountId: string): Promise<boolean> {
    return this.attempts.some((a) => a.accountId === accountId && a.hadConversation);
  }

  async countSince(since: Date): Promise<number> {
    return this.attempts.filter((a) => a.at >= since).length;
  }

  async countForNumberSince(e164: string, since: Date): Promise<number> {
    return this.attempts.filter((a) => a.e164 === e164 && a.at >= since).length;
  }

  async record(attempt: AttemptRecord): Promise<void> {
    this.attempts.push(attempt);
  }
}

export class InMemoryContactStore implements ContactStore {
  private readonly kinds = new Map<string, ContactKind>();

  async kind(contactId: string): Promise<ContactKind | null> {
    return this.kinds.get(contactId) ?? null;
  }

  set(contactId: string, kind: ContactKind): void {
    this.kinds.set(contactId, kind);
  }
}

export class InMemoryDayPlanStore implements DayPlanStore {
  private readonly plans = new Map<string, Omit<DayPlanState, 'includesContact'> & { contactIds: string[] }>();

  async current(campaignId: string, planDate: string, contactId: string): Promise<DayPlanState | null> {
    const plan = this.plans.get(`${campaignId}:${planDate}`) ?? [...this.plans.values()].at(-1);
    if (plan === undefined) return null;
    const { contactIds, ...rest } = plan;
    return { ...rest, includesContact: contactIds.includes(contactId) };
  }

  set(plan: Omit<DayPlanState, 'includesContact'> & { campaignId: string; contactIds: string[] }): void {
    const { campaignId, ...rest } = plan;
    this.plans.set(`${campaignId}:${plan.planDate}`, rest);
  }
}

export class InMemoryCallStateStore implements CallStateStore {
  private count = 0;

  async liveCalls(): Promise<number> {
    return this.count;
  }

  set(count: number): void {
    this.count = count;
  }
}
