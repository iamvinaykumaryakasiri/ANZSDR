/**
 * Latency, measured and reported.
 *
 * Section 13 phase 5 asks for "sub-800ms perceived response latency". Perceived
 * latency is what the prospect experiences: from the moment they stop talking to
 * the moment they hear Lexi start. That interval has five parts (transport,
 * end-of-speech detection, speech-to-text, the model's first token, text-to-
 * speech) and only one of them is ours.
 *
 * So two numbers are kept, and the difference between them is not hidden.
 *
 *   first-token   Ours. From our endpoint receiving the turn to the first
 *                 speakable words leaving it. It includes Guardian's layer-one
 *                 hold-back and, for a held turn, the wait for layer two. It is
 *                 a floor on the perceived figure, never the figure itself.
 *   perceived     The provider's own per-turn figure, end of the prospect's
 *                 speech to the start of Lexi's audio, from its end-of-call
 *                 report. When the provider gives none, there is no perceived
 *                 number, and the report says so instead of estimating one.
 */

import type { LatencyStats, LatencySummary, LatencyTurn } from './call-store.js';

/** Nearest-rank percentile of a non-empty, ascending list. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

export function stats(values: number[]): LatencyStats | null {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const sum = clean.reduce((a, b) => a + b, 0);
  return {
    n: clean.length,
    p50: Math.round(percentile(clean, 50)),
    p95: Math.round(percentile(clean, 95)),
    max: Math.round(clean[clean.length - 1] as number),
    mean: Math.round(sum / clean.length)
  };
}

export interface MeasuredTurn {
  firstTokenMs: number;
  totalMs: number;
  held: boolean;
  interrupted: boolean;
}

/**
 * Combine our per-turn measurements with the provider's. The provider's list is
 * paired turn by turn only when it is exactly as long as ours; interruptions and
 * regenerated turns can make the two drift, and a wrong pairing is worse than
 * none. Either way the provider's numbers feed the perceived statistics.
 */
export function summariseLatency(
  measured: MeasuredTurn[],
  providerTurnMs: Array<number | null>,
  targetMs: number
): LatencySummary {
  const paired = providerTurnMs.length === measured.length;
  const turns: LatencyTurn[] = measured.map((m, i) => ({
    turn: i + 1,
    firstTokenMs: Math.round(m.firstTokenMs),
    totalMs: Math.round(m.totalMs),
    held: m.held,
    interrupted: m.interrupted,
    perceivedMs: paired ? (providerTurnMs[i] ?? null) : null
  }));

  // An interrupted turn was cut short by the prospect, so its timings describe
  // a response nobody waited for.
  const firstToken = stats(turns.filter((t) => !t.interrupted).map((t) => t.firstTokenMs));
  const perceivedSamplesMs = providerTurnMs.filter((v): v is number => v !== null).map(Math.round);
  const perceived = stats(perceivedSamplesMs);

  const basis: LatencySummary['basis'] = perceived !== null ? 'perceived' : firstToken !== null ? 'first-token' : 'none';
  const judged = basis === 'perceived' ? perceived : basis === 'first-token' ? firstToken : null;

  return {
    targetMs,
    turns,
    firstToken,
    perceived,
    perceivedSamplesMs,
    withinTarget: judged === null ? null : judged.p95 <= targetMs,
    basis
  };
}

export interface ReportCall {
  callId: string;
  startedAt: Date;
  summary: LatencySummary;
}

const pad = (v: string | number, n: number): string => String(v).padStart(n);
const fmt = (s: LatencyStats | null): string =>
  s === null ? '          -' : `n=${pad(s.n, 3)} p50=${pad(s.p50, 4)} p95=${pad(s.p95, 4)} max=${pad(s.max, 4)}`;

/** The text-mode latency report: per call, then across all of them. */
export function formatLatencyReport(calls: ReportCall[], targetMs: number): string {
  const lines: string[] = [];
  lines.push(`Latency against a ${targetMs}ms target (judged on the 95th percentile)`);
  lines.push('');

  if (calls.length === 0) {
    lines.push('No calls with latency data yet.');
    lines.push('Place a test call (npm run voice:testcall) or measure the brain alone (npm run voice:latency -- --probe).');
    return lines.join('\n');
  }

  lines.push('first-token = our endpoint only (a floor). perceived = the provider\'s figure, end of speech to first audio.');
  lines.push('');
  for (const call of calls) {
    const s = call.summary;
    const verdict = s.withinTarget === null ? 'no data' : s.withinTarget ? 'within target' : 'OVER TARGET';
    lines.push(`${call.startedAt.toISOString().slice(0, 16).replace('T', ' ')}Z  ${call.callId.slice(0, 8)}  ${verdict} (judged on ${s.basis})`);
    lines.push(`    first-token ${fmt(s.firstToken)}`);
    lines.push(`    perceived   ${fmt(s.perceived)}`);
    const slow = s.turns.filter((t) => !t.interrupted && t.firstTokenMs > targetMs);
    for (const t of slow) {
      lines.push(`    turn ${t.turn} took ${t.firstTokenMs}ms to first words${t.held ? ' (held for Guardian layer two)' : ''}`);
    }
  }

  const allFirst = stats(calls.flatMap((c) => c.summary.turns.filter((t) => !t.interrupted).map((t) => t.firstTokenMs)));
  const allPerceived = stats(calls.flatMap((c) => c.summary.perceivedSamplesMs));
  lines.push('');
  lines.push(`All ${calls.length} call(s)`);
  lines.push(`    first-token ${fmt(allFirst)}`);
  lines.push(`    perceived   ${fmt(allPerceived)}`);
  if (allPerceived === null) {
    lines.push('    No perceived figures: the provider has not reported per-turn latency for these calls.');
  }
  return lines.join('\n');
}
