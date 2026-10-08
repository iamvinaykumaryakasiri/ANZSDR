/**
 * The call log, one call in full, and the agent trace.
 *
 * Plain reads. The trace is the one place the system's own reasoning is shown,
 * so it is rendered from the rows the Director and the runner wrote for a person
 * to read (blackboard/repositories.ts) and never from raw JSON.
 */

import { z } from 'zod';
import type { Blackboard } from '../blackboard/client.js';
import type { CallDetail, CallLogEntry, TraceEntry } from './contract.js';
import type { ConsoleDeps } from './deps.js';
import { ANALYSIS_DAYS, loadCallFact, loadCallFacts, type CallFact } from './facts.js';
import { loadTranscript } from './live-source.js';
import { DAY_MS, readJson, truncate } from './util.js';

export const MAX_CALLS = 500;
export const MAX_TRACE = 500;

export interface CallQuery {
  limit?: number;
  days?: number;
  market?: 'AU' | 'NZ';
  outcome?: string;
  variant?: string;
  industry?: string;
  seniority?: string;
  /** A funnel stage id: only calls that got that far. */
  stage?: string;
}

const STAGE_FLAGS: Record<string, (f: CallFact) => boolean> = {
  queued: () => true,
  gate_passed: () => true,
  dialled: () => true,
  answered: (f) => f.answered,
  survived_opener: (f) => f.survivedOpener,
  real_conversation: (f) => f.realConversation,
  ask_made: (f) => f.askMade,
  meeting_requested: (f) => f.requested,
  confirmed: (f) => f.confirmed
};

export function isFunnelStage(value: string): boolean {
  return value in STAGE_FLAGS;
}

function outcomeLabel(f: CallFact): string {
  if (f.outcome !== null) return f.outcome;
  return f.live ? 'live' : 'unrecorded';
}

export function logEntry(f: CallFact): CallLogEntry {
  return {
    id: f.id,
    startedAt: f.startedAt.toISOString(),
    durationSeconds: f.durationSec,
    name: f.name,
    company: f.company,
    market: f.market,
    outcome: outcomeLabel(f),
    variant: f.variant,
    defects: f.defects,
    industry: f.industry,
    seniority: f.seniority
  };
}

export async function listCalls(deps: ConsoleDeps, query: CallQuery = {}): Promise<CallLogEntry[]> {
  const now = deps.now();
  const days = Math.min(Math.max(query.days ?? ANALYSIS_DAYS, 1), 365);
  const limit = Math.min(Math.max(query.limit ?? MAX_CALLS, 1), MAX_CALLS);
  const facts = await loadCallFacts(deps.db, { from: new Date(now.getTime() - days * DAY_MS), to: new Date(now.getTime() + 60_000) }, now);

  const stage = query.stage === undefined ? undefined : STAGE_FLAGS[query.stage];
  return facts
    .filter((f) => (query.market === undefined ? true : f.market === query.market))
    .filter((f) => (query.outcome === undefined ? true : outcomeLabel(f) === query.outcome))
    .filter((f) => (query.variant === undefined ? true : f.variant === query.variant))
    .filter((f) => (query.industry === undefined ? true : f.industry === query.industry))
    .filter((f) => (query.seniority === undefined ? true : f.seniority === query.seniority))
    .filter((f) => (stage === undefined ? true : stage(f)))
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, limit)
    .map(logEntry);
}

const storedDefectSchema = z.object({ kind: z.string(), detail: z.string(), atSecond: z.number().optional() });

export async function callDetail(deps: ConsoleDeps, id: string): Promise<CallDetail | null> {
  const now = deps.now();
  const fact = await loadCallFact(deps.db, id, now);
  if (fact === null) return null;

  const row = await deps.db.call.findUniqueOrThrow({
    where: { id },
    include: { contact: { include: { dossiers: { orderBy: { createdAt: 'desc' }, take: 1 } } } }
  });

  // Defects: what Scribe recorded once the call was over; while it is still being
  // processed, the ones Guardian wrote as the call went.
  const recorded = readJson(row.defects, z.array(storedDefectSchema), []);
  const live =
    recorded.length > 0
      ? []
      : (await deps.db.callEvent.findMany({ where: { callId: id, kind: 'defect' }, orderBy: { id: 'asc' } })).map((e) => ({
          kind: readJson(e.data, z.object({ kind: z.string().optional() }).passthrough(), {}).kind ?? 'defect',
          detail: e.text,
          ...(e.atSecond !== null ? { atSecond: e.atSecond } : {})
        }));
  const defectDetails = recorded.length > 0 ? recorded : live;

  const dossier = row.contact.dossiers[0];
  const dossierSummary =
    dossier === undefined
      ? 'No dossier was on file for this contact.'
      : `${dossier.hypothesis} (confidence: ${dossier.confidence})`;

  return {
    ...logEntry({ ...fact, defects: defectDetails.length }),
    transcript: await loadTranscript(deps.db, id),
    recordingUrl: fact.recordingUrl,
    dossierSummary,
    defectDetails
  };
}

/* ------------------------------------------------------------------ */
/* The agent trace                                                     */
/* ------------------------------------------------------------------ */

const KIND_RESULT: Record<string, string> = {
  decided: 'Decided.',
  dispatched: 'Handed to an agent.',
  validated: 'The agent\'s answer matched its contract and was accepted.',
  rejected: 'The agent\'s answer did not match its contract and was not used.',
  escalated: 'Escalated to a person.',
  spent: 'Money was spent.',
  note: 'Noted.'
};

export interface TraceQuery {
  limit?: number;
  taskId?: string;
}

function resultOf(kind: string, detailRaw: string, usd: number): string {
  const detail = readJson(detailRaw, z.record(z.unknown()), {});
  const stated = typeof detail.result === 'string' ? detail.result : typeof detail.outcome === 'string' ? detail.outcome : null;
  const base = stated ?? KIND_RESULT[kind] ?? `Recorded as "${kind}".`;
  return usd > 0 ? `${base} Cost $${usd.toFixed(2)}.` : base;
}

export async function listTrace(db: Blackboard, query: TraceQuery = {}): Promise<TraceEntry[]> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), MAX_TRACE);
  const rows = await db.traceEvent.findMany({
    where: query.taskId === undefined ? {} : { taskId: query.taskId },
    orderBy: { at: 'desc' },
    take: limit
  });
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    agent: r.actor,
    decision: truncate(r.summary, 400),
    result: resultOf(r.kind, r.detail, r.usd),
    costUsd: r.usd
  }));
}
