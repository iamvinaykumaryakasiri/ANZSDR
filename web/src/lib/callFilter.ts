import type { CallLogEntry, CallLogSegments, FunnelStageId, HangupCurveView } from '../contract';

/*
 * Funnel-stage and segment filtering, derived on the client from the call log.
 *
 * The contract carries no per-stage call lists, so which calls "reached" a stage
 * is inferred from what the call log does carry: how long it ran and how it
 * ended. This is display filtering only. It is deliberately in one file so it
 * can be swapped for server-supplied ids (a `callIds` on each funnel stage)
 * without touching a component.
 */

export type SegmentKey = 'market' | 'variant' | 'industry' | 'seniority';
export type Segments = Record<SegmentKey, string | null>;
export const NO_SEGMENTS: Segments = { market: null, variant: null, industry: null, seniority: null };

type CallRow = CallLogEntry & CallLogSegments;

const NOT_ANSWERED = new Set(['no_answer', 'voicemail', 'invalid_number']);
const OPENER_SECONDS = 15;
const CONVERSATION_SECONDS = 45;

/** null means the stage is not about calls at all (queued, gate passed). */
export function reachedStage(
  call: CallLogEntry,
  stage: FunnelStageId,
  ctx: { askFromSecond: number; confirmedCallIds: ReadonlySet<string> }
): boolean | null {
  const answered = call.durationSeconds > 0 && !NOT_ANSWERED.has(call.outcome);
  switch (stage) {
    case 'queued':
    case 'gate_passed':
      return null;
    case 'dialled':
      return true;
    case 'answered':
      return answered;
    case 'survived_opener':
      return answered && call.durationSeconds >= OPENER_SECONDS;
    case 'real_conversation':
      return answered && call.durationSeconds >= CONVERSATION_SECONDS;
    case 'ask_made':
      return answered && (call.durationSeconds >= ctx.askFromSecond || call.outcome === 'meeting_requested');
    case 'meeting_requested':
      return call.outcome === 'meeting_requested';
    case 'confirmed':
      return ctx.confirmedCallIds.has(call.id);
  }
}

export function askStartsAt(curve: HangupCurveView): number {
  return curve.sections.find((s) => s.id === 'ask')?.fromSecond ?? 60;
}

export interface CallFilter {
  stage: FunnelStageId | null;
  segments: Segments;
}

export function isFiltering(filter: CallFilter): boolean {
  return filter.stage !== null || Object.values(filter.segments).some((v) => v !== null);
}

/** The ids of calls that pass the filter, or null when nothing is filtered. */
export function matchingCallIds(
  calls: readonly CallRow[],
  filter: CallFilter,
  ctx: { askFromSecond: number; confirmedCallIds: ReadonlySet<string> }
): Set<string> | null {
  if (!isFiltering(filter)) return null;
  const out = new Set<string>();
  for (const call of calls) {
    if (filter.segments.market && call.market !== filter.segments.market) continue;
    if (filter.segments.variant && call.variant !== filter.segments.variant) continue;
    if (filter.segments.industry && call.industry !== filter.segments.industry) continue;
    if (filter.segments.seniority && call.seniority !== filter.segments.seniority) continue;
    if (filter.stage) {
      const reached = reachedStage(call, filter.stage, ctx);
      if (reached === false) continue;
    }
    out.add(call.id);
  }
  return out;
}

export function distinct(calls: readonly CallRow[], key: SegmentKey): string[] {
  const values = new Set<string>();
  for (const call of calls) {
    const v = call[key];
    if (typeof v === 'string' && v !== '') values.add(v);
  }
  return [...values].sort();
}
