/**
 * Prisma-backed implementations of the compliance engine's storage ports.
 *
 * The compliance engine owns the decisions and knows nothing about Prisma; these
 * adapters let it read the blackboard without the decision logic changing a line
 * from the in-memory implementations it was fuzzed against. The conformance
 * suite in `tests/blackboard/compliance-stores.test.ts` runs both through the
 * same expectations for exactly that reason.
 */

import { randomUUID } from 'node:crypto';
import type {
  AttemptStore,
  CallStateStore,
  DncStore,
  SuppressionStore
} from '../compliance/ports.js';
import type { SuppressionSubject } from '../compliance/suppression.js';
import { applicableSuppressions } from '../compliance/suppression.js';
import type {
  AttemptRecord,
  DncWashRecord,
  SuppressionEntry,
  SuppressionScope,
  SuppressionSource
} from '../compliance/types.js';
import type { AuditLog, AuditRecord } from '../compliance/audit.js';
import type { Blackboard } from './client.js';

export class PrismaSuppressionStore implements SuppressionStore {
  constructor(private readonly db: Blackboard) {}

  private static toEntry(row: {
    scope: string;
    key: string;
    source: string;
    reason: string;
    createdAt: Date;
  }): SuppressionEntry {
    return {
      scope: row.scope as SuppressionScope,
      key: row.key,
      source: row.source as SuppressionSource,
      reason: row.reason,
      createdAt: row.createdAt,
      permanent: true
    };
  }

  async find(subject: SuppressionSubject): Promise<SuppressionEntry[]> {
    const keys = [subject.contactId, subject.e164, subject.accountId];
    if (subject.emailDomain !== undefined) keys.push(subject.emailDomain);
    const rows = await this.db.suppression.findMany({ where: { key: { in: keys } } });
    // Re-checked against the subject rather than trusted, exactly as the
    // in-memory store does: a query that over-fetches must not block the wrong
    // contact, and one that matches loosely must not let a real suppression past.
    return applicableSuppressions(rows.map(PrismaSuppressionStore.toEntry), subject);
  }

  async add(entry: SuppressionEntry): Promise<void> {
    await this.db.suppression.create({
      data: {
        id: randomUUID(),
        scope: entry.scope,
        key: entry.key,
        source: entry.source,
        reason: entry.reason,
        createdAt: entry.createdAt
      }
    });
  }

  async list(): Promise<SuppressionEntry[]> {
    const rows = await this.db.suppression.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(PrismaSuppressionStore.toEntry);
  }
}

export class PrismaDncStore implements DncStore {
  constructor(private readonly db: Blackboard) {}

  async latestWash(e164: string): Promise<DncWashRecord | null> {
    const row = await this.db.dncWash.findFirst({ where: { e164 }, orderBy: { washedAt: 'desc' } });
    if (row === null) return null;
    return {
      e164: row.e164,
      result: row.result as DncWashRecord['result'],
      washedAt: row.washedAt,
      register: row.register
    };
  }

  async record(wash: DncWashRecord): Promise<void> {
    await this.db.dncWash.create({
      data: {
        id: randomUUID(),
        e164: wash.e164,
        result: wash.result,
        washedAt: wash.washedAt,
        register: wash.register
      }
    });
  }
}

export class PrismaAttemptStore implements AttemptStore {
  constructor(private readonly db: Blackboard) {}

  private static toAttempt(row: {
    contactId: string;
    accountId: string;
    e164: string;
    at: Date;
    hadConversation: boolean;
  }): AttemptRecord {
    return {
      contactId: row.contactId,
      accountId: row.accountId,
      e164: row.e164,
      at: row.at,
      hadConversation: row.hadConversation
    };
  }

  async forContact(contactId: string): Promise<AttemptRecord[]> {
    const rows = await this.db.dialAttempt.findMany({ where: { contactId }, orderBy: { at: 'asc' } });
    return rows.map(PrismaAttemptStore.toAttempt);
  }

  async forAccountSince(accountId: string, since: Date): Promise<AttemptRecord[]> {
    const rows = await this.db.dialAttempt.findMany({
      where: { accountId, at: { gte: since } },
      orderBy: { at: 'asc' }
    });
    return rows.map(PrismaAttemptStore.toAttempt);
  }

  async accountHasConversed(accountId: string): Promise<boolean> {
    const row = await this.db.dialAttempt.findFirst({ where: { accountId, hadConversation: true } });
    return row !== null;
  }

  async countSince(since: Date): Promise<number> {
    return this.db.dialAttempt.count({ where: { at: { gte: since } } });
  }

  async countForNumberSince(e164: string, since: Date): Promise<number> {
    return this.db.dialAttempt.count({ where: { e164, at: { gte: since } } });
  }

  async record(attempt: AttemptRecord): Promise<void> {
    await this.db.dialAttempt.create({
      data: {
        id: randomUUID(),
        contactId: attempt.contactId,
        accountId: attempt.accountId,
        e164: attempt.e164,
        at: attempt.at,
        hadConversation: attempt.hadConversation
      }
    });
  }
}

/**
 * Live calls, counted from the blackboard rather than held in memory, so a
 * process restart cannot lose track of a call that is still up and let the
 * concurrency limit be exceeded.
 */
export class PrismaCallStateStore implements CallStateStore {
  constructor(private readonly db: Blackboard) {}

  async liveCalls(): Promise<number> {
    return this.db.call.count({ where: { endedAt: null } });
  }
}

export class PrismaAuditLog implements AuditLog {
  constructor(private readonly db: Blackboard) {}

  async append(record: AuditRecord): Promise<void> {
    await this.db.auditRecord.create({
      data: {
        id: record.id,
        at: new Date(record.at),
        kind: record.kind,
        actor: record.actor,
        subject: record.subject,
        summary: record.summary,
        data: JSON.stringify(record.data)
      }
    });
  }

  async read(): Promise<AuditRecord[]> {
    const rows = await this.db.auditRecord.findMany({ orderBy: { at: 'asc' } });
    return rows.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      kind: row.kind as AuditRecord['kind'],
      actor: row.actor,
      subject: row.subject,
      summary: row.summary,
      data: JSON.parse(row.data) as unknown
    }));
  }
}
