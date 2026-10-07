/**
 * Meeting requests and their state.
 *
 * Section 12.1: Vinay confirms by replying CONFIRMED, RESCHEDULE or REJECT, and
 * the system "updates the blackboard and stops or adjusts follow-up
 * accordingly". This is the record and the rules for changing it.
 *
 *   requested -> confirmed | reschedule | rejected
 *   reschedule -> confirmed | reschedule | rejected
 *   confirmed, rejected -> nothing
 *
 * The last line is the important one. A stray later reply must not be able to
 * flip a terminal state: REJECT suppresses a person permanently, so a late or
 * duplicated reply turning a confirmed meeting into a suppression would be the
 * worst thing this module could do. Changing a terminal state takes a person at
 * a console, not a message arriving.
 */

import { randomUUID } from 'node:crypto';
import { idPrefixFor } from '../agents/concierge/ref.js';
import type { Blackboard } from './client.js';

export type MeetingStatus = 'requested' | 'confirmed' | 'reschedule' | 'rejected';
export type Decision = Exclude<MeetingStatus, 'requested'>;
export type DecidedVia = 'email-reply' | 'console';

export const TERMINAL: readonly MeetingStatus[] = Object.freeze(['confirmed', 'rejected']);

/** One nudge, a day after the request went out, if Vinay has not answered. */
export const NUDGE_AFTER_MS = 24 * 60 * 60_000;

export interface MeetingRequestRecord {
  id: string;
  callId: string;
  contactId: string;
  status: MeetingStatus;
  createdAt: Date;
  emailSentAt: Date | null;
  nudgedAt: Date | null;
  decidedAt: Date | null;
  decisionNote: string;
  decidedVia: DecidedVia | null;
}

export type DecisionResult =
  | { applied: true; from: MeetingStatus; to: Decision }
  | { applied: false; reason: string; /** The request is already in the state asked for. */ noop: boolean };

export type RefLookup =
  | { kind: 'found'; record: MeetingRequestRecord }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number };

function toRecord(row: {
  id: string;
  callId: string;
  contactId: string;
  status: string;
  createdAt: Date;
  emailSentAt: Date | null;
  nudgedAt: Date | null;
  decidedAt: Date | null;
  decisionNote: string;
  decidedVia: string | null;
}): MeetingRequestRecord {
  return {
    id: row.id,
    callId: row.callId,
    contactId: row.contactId,
    status: row.status as MeetingStatus,
    createdAt: row.createdAt,
    emailSentAt: row.emailSentAt,
    nudgedAt: row.nudgedAt,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    decidedVia: row.decidedVia as DecidedVia | null
  };
}

/**
 * Whether a reply may still change this request.
 *
 * It depends only on where the request is, not where it is going: from
 * `requested` or `reschedule` any decision is allowed, and from a terminal
 * state none is. Written as a question about the state so a future status has
 * to be placed on one side of that line deliberately.
 */
export function canBeDecided(from: MeetingStatus): boolean {
  return !TERMINAL.includes(from);
}

export class MeetingRequestRepository {
  constructor(private readonly db: Blackboard) {}

  /**
   * One request per call. Scribe running twice for the same call - a retry, a
   * replayed webhook - returns the existing request rather than a duplicate,
   * so Vinay is never sent the same request twice.
   */
  async create(input: { callId: string; contactId: string }, now: Date): Promise<{ record: MeetingRequestRecord; created: boolean }> {
    const existing = await this.db.meetingRequest.findUnique({ where: { callId: input.callId } });
    if (existing !== null) return { record: toRecord(existing), created: false };

    const row = await this.db.meetingRequest.create({
      data: { id: randomUUID(), callId: input.callId, contactId: input.contactId, status: 'requested', createdAt: now }
    });
    return { record: toRecord(row), created: true };
  }

  async find(id: string): Promise<MeetingRequestRecord | null> {
    const row = await this.db.meetingRequest.findUnique({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  async findByCall(callId: string): Promise<MeetingRequestRecord | null> {
    const row = await this.db.meetingRequest.findUnique({ where: { callId } });
    return row === null ? null : toRecord(row);
  }

  /**
   * Resolve a reference from a reply. More than one match is reported as
   * ambiguous rather than resolved by picking one: eight hex digits is plenty
   * for a few hundred requests and not a guarantee, and a wrong guess here is
   * applied to a real person.
   */
  async findByRef(ref: string): Promise<RefLookup> {
    const rows = await this.db.meetingRequest.findMany({ where: { id: { startsWith: idPrefixFor(ref) } } });
    if (rows.length === 0) return { kind: 'none' };
    if (rows.length > 1) return { kind: 'ambiguous', count: rows.length };
    return { kind: 'found', record: toRecord(rows[0] as (typeof rows)[number]) };
  }

  async markEmailSent(id: string, at: Date): Promise<void> {
    await this.db.meetingRequest.update({ where: { id }, data: { emailSentAt: at } });
  }

  async decide(id: string, decision: Decision, note: string, via: DecidedVia, at: Date): Promise<DecisionResult> {
    const current = await this.find(id);
    if (current === null) return { applied: false, reason: `no meeting request ${id}`, noop: false };

    if (current.status === decision) {
      return { applied: false, reason: `already ${decision}`, noop: true };
    }
    if (!canBeDecided(current.status)) {
      return {
        applied: false,
        reason: `it is already ${current.status}, and a reply cannot change that; this takes a person at the console`,
        noop: false
      };
    }

    await this.db.meetingRequest.update({
      where: { id },
      data: { status: decision, decidedAt: at, decisionNote: note, decidedVia: via }
    });
    return { applied: true, from: current.status, to: decision };
  }

  /** Requests still waiting on Vinay: not answered, and never nudged. */
  async dueForNudge(now: Date): Promise<MeetingRequestRecord[]> {
    const rows = await this.db.meetingRequest.findMany({
      where: {
        status: 'requested',
        nudgedAt: null,
        emailSentAt: { not: null, lte: new Date(now.getTime() - NUDGE_AFTER_MS) }
      },
      orderBy: { emailSentAt: 'asc' }
    });
    return rows.map(toRecord);
  }

  async markNudged(id: string, at: Date): Promise<void> {
    await this.db.meetingRequest.update({ where: { id }, data: { nudgedAt: at } });
  }

  /** Everything not yet closed, oldest first: what "needs you" shows. */
  async open(): Promise<MeetingRequestRecord[]> {
    const rows = await this.db.meetingRequest.findMany({
      where: { status: { in: ['requested', 'reschedule'] } },
      orderBy: { createdAt: 'asc' }
    });
    return rows.map(toRecord);
  }
}
