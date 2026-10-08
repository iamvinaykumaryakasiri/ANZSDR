/**
 * The voice layer's view of the blackboard's `Call` and `CallEvent` tables.
 *
 * No schema change: the voice layer writes into columns the Phase 5 groundwork
 * already added (`providerCallId`, `endedReason`, `providerMetrics`, and the
 * append-only `CallEvent`), and keeps its own bookkeeping as JSON in
 * `providerMetrics`. That JSON is read and written through one function that
 * compares the value it read with the value it replaces, so two things updating
 * it at once (a webhook and the watchdog, say) cannot silently lose each other's
 * changes.
 *
 * Event kinds. The blackboard documents three (`turn`, `tool`, `defect`) and the
 * console reads those. The voice layer adds `status` (lifecycle transitions),
 * `recording` (what was announced, objected to, archived, deleted) and `report`
 * (the provider's end-of-call report, kept so processing can be retried). A
 * consumer that does not know a kind should ignore it.
 */

import { randomUUID } from 'node:crypto';
import type { Blackboard } from '../blackboard/client.js';

export const CALL_STATES = ['dialling', 'ringing', 'in-progress', 'ended'] as const;
export type CallState = (typeof CALL_STATES)[number];

export type EventKind = 'turn' | 'tool' | 'defect' | 'status' | 'recording' | 'report';

export interface RecordingMeta {
  /** The opening, which says the call is recorded, was served. */
  announcedAt?: string;
  /** The prospect objected to being recorded. */
  objectedAt?: string;
  /** What was done about it: the call was ended, or the recording was stopped. */
  objectionHandling?: 'call-ended' | 'recording-stopped';
  /** Delete this recording now, whatever the retention period says. */
  deleteNow?: boolean;
  archive?: {
    /** Relative to the recording store. Not a URL. */
    location: string;
    bytes: number;
    sha256: string;
    encrypted: boolean;
    archivedAt: string;
  };
  archiveError?: string;
  /** When the retention period ends. Informational: the purge recomputes it. */
  expiresAt?: string;
  deletedAt?: string;
  providerDeletedAt?: string;
}

export interface LatencyTurn {
  turn: number;
  firstTokenMs: number;
  totalMs: number;
  held: boolean;
  interrupted: boolean;
  /** The provider's figure for the same turn (end of speech to first audio), when it gave one. */
  perceivedMs: number | null;
}

export interface LatencyStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export interface LatencySummary {
  targetMs: number;
  turns: LatencyTurn[];
  firstToken: LatencyStats | null;
  perceived: LatencyStats | null;
  /** The provider's per-turn figures as reported, so calls can be pooled. */
  perceivedSamplesMs: number[];
  /** Whether the target was met, judged on perceived latency if the provider reported it, else first-token. */
  withinTarget: boolean | null;
  basis: 'perceived' | 'first-token' | 'none';
}

export interface StoredMetrics {
  controlUrl?: string;
  state?: CallState;
  answeredAt?: string;
  recording?: RecordingMeta;
  latency?: LatencySummary;
  provider?: { costUsd?: number | null; averagesMs?: Record<string, number> };
  report?: { receivedAt: string; status: 'received' | 'processed' | 'failed'; error?: string };
  pipeline?: { status: 'running' | 'done' | 'failed'; at: string; error?: string };
  /** Anything else a future writer added. Preserved, never dropped. */
  [key: string]: unknown;
}

export interface CallRow {
  id: string;
  contactId: string;
  accountId: string;
  campaignId: string;
  startedAt: Date;
  endedAt: Date | null;
  durationSec: number | null;
  outcome: string | null;
  providerCallId: string | null;
  endedReason: string | null;
  recordingUrl: string | null;
}

export interface NewEvent {
  kind: EventKind;
  speaker?: 'lexi' | 'prospect';
  text?: string;
  atSecond?: number;
  data?: unknown;
}

export interface StoredEvent {
  id: number;
  kind: string;
  speaker: string | null;
  text: string;
  atSecond: number | null;
  data: Record<string, unknown>;
  createdAt: Date;
}

const SELECT = {
  id: true,
  contactId: true,
  accountId: true,
  campaignId: true,
  startedAt: true,
  endedAt: true,
  durationSec: true,
  outcome: true,
  providerCallId: true,
  endedReason: true,
  recordingUrl: true
} as const;

export function parseMetrics(raw: string | null | undefined): StoredMetrics {
  if (raw === null || raw === undefined || raw === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as StoredMetrics) : {};
  } catch {
    // A corrupt value is treated as empty rather than allowed to wedge a call.
    return {};
  }
}

const ORDER: Record<CallState, number> = { dialling: 0, ringing: 1, 'in-progress': 2, ended: 3 };

/** States only move forward, and `ended` is final. A late or repeated update changes nothing. */
export function advanceState(current: CallState | undefined, next: CallState): { state: CallState; changed: boolean } {
  if (current === undefined) return { state: next, changed: true };
  if (ORDER[next] > ORDER[current]) return { state: next, changed: true };
  return { state: current, changed: false };
}

export class CallStore {
  constructor(
    private readonly db: Blackboard,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** By our id, or failing that by the provider's. */
  async find(id: string): Promise<CallRow | null> {
    const byId = await this.db.call.findUnique({ where: { id }, select: SELECT });
    if (byId !== null) return byId;
    return this.db.call.findUnique({ where: { providerCallId: id }, select: SELECT });
  }

  async get(id: string): Promise<CallRow> {
    const row = await this.find(id);
    if (row === null) throw new Error(`no call ${id} on the blackboard`);
    return row;
  }

  async create(input: { contactId: string; accountId: string; campaignId: string }): Promise<CallRow> {
    const id = randomUUID();
    const at = this.now();
    await this.db.call.create({
      data: {
        id,
        contactId: input.contactId,
        accountId: input.accountId,
        campaignId: input.campaignId,
        startedAt: at,
        providerMetrics: JSON.stringify({ state: 'dialling' satisfies CallState })
      }
    });
    await this.append(id, { kind: 'status', data: { state: 'dialling' } });
    return this.get(id);
  }

  async setProvider(callId: string, providerCallId: string, controlUrl: string | null): Promise<void> {
    await this.db.call.update({ where: { id: callId }, data: { providerCallId } });
    if (controlUrl !== null) await this.patchMetrics(callId, (m) => ({ ...m, controlUrl }));
  }

  /* -------- events -------- */

  async append(callId: string, event: NewEvent): Promise<void> {
    await this.db.callEvent.create({
      data: {
        callId,
        kind: event.kind,
        speaker: event.speaker ?? null,
        text: event.text ?? '',
        atSecond: event.atSecond ?? null,
        data: JSON.stringify(event.data ?? {})
      }
    });
  }

  async events(callId: string, kind?: EventKind): Promise<StoredEvent[]> {
    const rows = await this.db.callEvent.findMany({
      where: { callId, ...(kind !== undefined ? { kind } : {}) },
      orderBy: { id: 'asc' }
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      speaker: row.speaker,
      text: row.text,
      atSecond: row.atSecond,
      data: safeObject(row.data),
      createdAt: row.createdAt
    }));
  }

  /** The most recent event of a kind, or null. */
  async lastEvent(callId: string, kind: EventKind): Promise<StoredEvent | null> {
    const row = await this.db.callEvent.findFirst({ where: { callId, kind }, orderBy: { id: 'desc' } });
    if (row === null) return null;
    return {
      id: row.id,
      kind: row.kind,
      speaker: row.speaker,
      text: row.text,
      atSecond: row.atSecond,
      data: safeObject(row.data),
      createdAt: row.createdAt
    };
  }

  /* -------- metrics -------- */

  async metrics(callId: string): Promise<StoredMetrics> {
    const row = await this.db.call.findUnique({ where: { id: callId }, select: { providerMetrics: true } });
    return parseMetrics(row?.providerMetrics);
  }

  /**
   * Change the stored metrics, safely against a concurrent change.
   *
   * Read, compute, then write only if the value is still what was read. If it
   * is not, read again and recompute. `update` is therefore a pure function of
   * the current value, which may be called more than once. Returns what was
   * finally stored.
   */
  async patchMetrics(callId: string, update: (current: StoredMetrics) => StoredMetrics): Promise<StoredMetrics> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await this.db.call.findUnique({ where: { id: callId }, select: { providerMetrics: true } });
      if (row === null) throw new Error(`no call ${callId} on the blackboard`);
      const next = update(parseMetrics(row.providerMetrics));
      const written = await this.db.call.updateMany({
        where: { id: callId, providerMetrics: row.providerMetrics },
        data: { providerMetrics: JSON.stringify(next) }
      });
      if (written.count === 1) return next;
    }
    throw new Error(`could not update the metrics for call ${callId}: it kept changing underneath us`);
  }

  /**
   * Take the right to process this call's end-of-call report, exactly once.
   * The provider retries webhooks and may deliver the same report twice
   * concurrently; only one caller gets `true`.
   */
  async claimReport(callId: string): Promise<boolean> {
    let won = false;
    await this.patchMetrics(callId, (m) => {
      if (m.report !== undefined) {
        won = false;
        return m;
      }
      won = true;
      return { ...m, report: { receivedAt: this.now().toISOString(), status: 'received' } };
    });
    return won;
  }

  /* -------- lifecycle -------- */

  /** Record a state change. Returns the state the call is in afterwards. */
  async transition(callId: string, next: CallState, detail: Record<string, unknown> = {}): Promise<CallState> {
    let result: CallState = next;
    let changed = false;
    await this.patchMetrics(callId, (m) => {
      const step = advanceState(m.state, next);
      result = step.state;
      changed = step.changed;
      if (!step.changed) return m;
      return {
        ...m,
        state: step.state,
        ...(next === 'in-progress' && m.answeredAt === undefined ? { answeredAt: this.now().toISOString() } : {})
      };
    });
    if (changed) await this.append(callId, { kind: 'status', data: { state: next, ...detail } });
    return result;
  }

  /**
   * Mark the call over. Only the first call does anything: a call ended by the
   * watchdog and then reported by the provider keeps its first end time.
   */
  async markEnded(callId: string, input: { at: Date; endedReason: string; durationSec?: number | null }): Promise<boolean> {
    const written = await this.db.call.updateMany({
      where: { id: callId, endedAt: null },
      data: {
        endedAt: input.at,
        endedReason: input.endedReason,
        ...(input.durationSec !== undefined && input.durationSec !== null ? { durationSec: input.durationSec } : {})
      }
    });
    await this.transition(callId, 'ended', { endedReason: input.endedReason });
    return written.count === 1;
  }

  /**
   * Calls the watchdog may need to look at: live, or ended recently and not yet
   * processed. A call from last week that was never processed is a job for a
   * person, not for a timer.
   */
  async openCalls(): Promise<Array<CallRow & { metrics: StoredMetrics }>> {
    const since = new Date(this.now().getTime() - 2 * 86_400_000);
    const rows = await this.db.call.findMany({
      where: { OR: [{ endedAt: null }, { endedAt: { gte: since } }] },
      orderBy: { startedAt: 'desc' },
      take: 200,
      select: { ...SELECT, providerMetrics: true }
    });
    return rows
      .map(({ providerMetrics, ...row }) => ({ ...row, metrics: parseMetrics(providerMetrics) }))
      .filter((row) => row.endedAt === null || row.metrics.pipeline?.status !== 'done');
  }

  /** Calls that are live right now, including ones that never got a provider id. */
  async liveCalls(): Promise<Array<CallRow & { metrics: StoredMetrics }>> {
    const rows = await this.db.call.findMany({
      where: { endedAt: null },
      select: { ...SELECT, providerMetrics: true }
    });
    return rows.map(({ providerMetrics, ...row }) => ({ ...row, metrics: parseMetrics(providerMetrics) }));
  }
}

function safeObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
