/**
 * What happens when the provider says a call is over.
 *
 * Two stages, deliberately separate.
 *
 * `acceptReport` is the part that has to happen before the webhook is
 * acknowledged, and it is quick and local: work out which of our calls this is,
 * take the exclusive right to process it (the provider retries webhooks and may
 * deliver the same report twice at once), end the call on the blackboard so it
 * stops counting as live, and keep the report itself so nothing depends on the
 * provider sending it again.
 *
 * `processReport` is the slow part: archive or purge the recording, turn the
 * report into what Scribe consumes, run Guardian's post-call audit, and hand the
 * lot to the Phase 6 pipeline (`processEndedCall`: Scribe, then Concierge, then
 * the workbook). It can take as long as the models take, so it runs after the
 * acknowledgement, and it can be run again from the stored report if it fails -
 * every step downstream is idempotent.
 *
 * The report is the better record of what was said than our own journal. The
 * journal knows what we *sent*; the provider's report knows what was *heard*,
 * including a sentence the prospect talked over. The journal is still where the
 * tool calls and the defects come from, because only we saw those.
 */

import { randomUUID } from 'node:crypto';
import type { AuditModel, AuditFinding, TranscriptTurn } from '../agents/guardian/audit.js';
import { auditCall } from '../agents/guardian/audit.js';
import type { OpeningSegment } from '../agents/caller/opening.js';
import type { JournalToolCall } from '../agents/scribe/rules.js';
import type { ScribeInput } from '../agents/scribe/scribe.js';
import { processEndedCall, type PostCallDeps, type PostCallResult } from '../orchestrator/post-call.js';
import type { Blackboard } from '../blackboard/client.js';
import type { ClaimIndex } from '../knowledge/claims.js';
import type { CallContextProvider } from './briefing-source.js';
import { CallStore, type RecordingMeta, type StoredEvent } from './call-store.js';
import { summariseLatency, type MeasuredTurn } from './latency.js';
import { classifyEndedReason } from './lifecycle.js';
import type { ProviderAdapter, ProviderEvent, ProviderMessage, ProviderMetrics } from './provider.js';
import { archiveRecording, runPurge, type RecordingStore } from './recordings.js';

type ReportEvent = Extract<ProviderEvent, { kind: 'report' }>;

/** The part of a report we keep, as the data of a `report` event. */
export interface StoredReport {
  endedReason: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  messages: ProviderMessage[];
  recordingUrl: string | null;
  metrics: ProviderMetrics;
  costUsd: number | null;
  /** Written by the watchdog, not the provider. */
  synthetic?: boolean;
}

export interface EndedCallDeps {
  db: Blackboard;
  calls: CallStore;
  now: () => Date;
  post: PostCallDeps;
  claims: () => ClaimIndex;
  contexts: CallContextProvider;
  auditModel?: AuditModel | undefined;
  adapter?: ProviderAdapter | undefined;
  recordingStore?: RecordingStore | undefined;
  fetch?: typeof fetch;
  retentionDays: number;
  latencyTargetMs: number;
  log?: (line: string) => void;
}

export type AcceptResult =
  | { status: 'accepted'; callId: string }
  | { status: 'duplicate'; callId: string }
  | { status: 'unknown-call' };

function toStored(event: ReportEvent): StoredReport {
  return {
    endedReason: event.endedReason,
    startedAt: event.startedAt?.toISOString() ?? null,
    endedAt: event.endedAt?.toISOString() ?? null,
    durationSec: event.durationSec,
    messages: event.messages,
    recordingUrl: event.recordingUrl,
    metrics: event.metrics,
    costUsd: event.costUsd
  };
}

/** A report for a call the provider never reported on: nothing was heard, and that is all we know. */
export function syntheticReport(endedReason: string, endedAt: Date): StoredReport {
  return {
    endedReason,
    startedAt: null,
    endedAt: endedAt.toISOString(),
    durationSec: null,
    messages: [],
    recordingUrl: null,
    metrics: { turnLatenciesMs: [], averagesMs: {} },
    costUsd: null,
    synthetic: true
  };
}

/* ------------------------------------------------------------------ */
/* Stage one                                                           */
/* ------------------------------------------------------------------ */

/**
 * Which of our calls does this report belong to?
 *
 * The provider's id is the anchor. Our own id (carried in the call's metadata)
 * is accepted only if it names a call that either has no provider id yet or has
 * exactly this one: a report cannot be pointed at somebody else's call by
 * putting that call's id in its metadata.
 */
async function resolveOurCall(calls: CallStore, providerCallId: string, ourCallId: string | null) {
  const byProvider = await calls.find(providerCallId);
  if (byProvider !== null && byProvider.providerCallId === providerCallId) return byProvider;
  if (ourCallId !== null) {
    const ours = await calls.find(ourCallId);
    if (ours !== null && (ours.providerCallId === null || ours.providerCallId === providerCallId)) return ours;
  }
  return null;
}

export async function acceptReport(deps: EndedCallDeps, event: ReportEvent | null, fallback?: { callId: string; report: StoredReport }): Promise<AcceptResult> {
  let callId: string;
  let report: StoredReport;

  if (event !== null) {
    const call = await resolveOurCall(deps.calls, event.providerCallId, event.ourCallId);
    if (call === null) return { status: 'unknown-call' };
    if (call.providerCallId === null) await deps.calls.setProvider(call.id, event.providerCallId, null);
    callId = call.id;
    report = toStored(event);
  } else if (fallback !== undefined) {
    callId = fallback.callId;
    report = fallback.report;
  } else {
    return { status: 'unknown-call' };
  }

  if (!(await deps.calls.claimReport(callId))) return { status: 'duplicate', callId };

  const endedAt = report.endedAt !== null ? new Date(report.endedAt) : deps.now();
  await deps.calls.markEnded(callId, { at: endedAt, endedReason: report.endedReason, durationSec: report.durationSec });
  if (report.recordingUrl !== null) {
    await deps.db.call.update({ where: { id: callId }, data: { recordingUrl: report.recordingUrl } });
  }

  // Latency: ours from the journal, the provider's from the report.
  const turns = await deps.calls.events(callId, 'turn');
  const measured: MeasuredTurn[] = turns
    .filter((t) => t.speaker === 'lexi' && t.data.opening !== true && typeof t.data.firstTokenMs === 'number')
    .map((t) => ({
      firstTokenMs: t.data.firstTokenMs as number,
      totalMs: typeof t.data.totalMs === 'number' ? t.data.totalMs : (t.data.firstTokenMs as number),
      held: t.data.held === true,
      interrupted: t.data.interrupted === true
    }));
  const latency = summariseLatency(measured, report.metrics.turnLatenciesMs, deps.latencyTargetMs);

  await deps.calls.patchMetrics(callId, (m) => ({
    ...m,
    latency,
    provider: { costUsd: report.costUsd, averagesMs: report.metrics.averagesMs }
  }));

  await deps.calls.append(callId, { kind: 'report', data: report });

  if (report.costUsd !== null && report.costUsd > 0) {
    await deps.db.spendRecord.create({
      data: { id: randomUUID(), category: 'voice', usd: report.costUsd, note: `call ${callId} (${report.endedReason})` }
    });
  }
  return { status: 'accepted', callId };
}

/* ------------------------------------------------------------------ */
/* Stage two                                                           */
/* ------------------------------------------------------------------ */

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Which segments of the frozen opening were actually said?
 *
 * Section 8 fixes the opening, and Guardian's audit asks whether each segment
 * reached the prospect. A segment counts as said only if its words are in what
 * Lexi said on the call, compared with punctuation and case stripped. An
 * opening the prospect talked over after "I'm an AI" has said two segments, not
 * six, and the audit then says which are missing.
 */
export function openingSegmentsSaid(transcript: TranscriptTurn[], opening: OpeningSegment[]): OpeningSegment[] {
  const spoken = normalise(transcript.filter((t) => t.speaker === 'lexi').map((t) => t.text).join(' '));
  return opening.filter((segment) => spoken.includes(normalise(segment.text)));
}

/** Defect kinds the rest of the system understands (`defectSchema`). Others stay in the journal. */
const SHARED_DEFECT_KINDS = new Set([
  'unsupported-claim',
  'banned-topic',
  'injection-attempt',
  'disclosure-missing',
  'over-commitment',
  'bad-tool-call'
]);

function scribeDefectKind(kind: string): string | null {
  if (SHARED_DEFECT_KINDS.has(kind)) return kind;
  // Guardian replacing a turn is a finding about what Lexi was about to say.
  if (kind === 'guardian-override') return 'unsupported-claim';
  // Guardian being unavailable, a missing briefing, a discarded tool call: real
  // events, in the journal, but not defects in the script, so they stay out of
  // the defect rate Coach is judged on.
  return null;
}

function transcriptFrom(report: StoredReport, journal: StoredEvent[]): TranscriptTurn[] {
  if (report.messages.length > 0) {
    return report.messages.map((m) => ({ speaker: m.speaker, text: m.text, atSecond: m.atSecond }));
  }
  return journal
    .filter((e) => e.kind === 'turn' && (e.speaker === 'lexi' || e.speaker === 'prospect') && e.text.trim() !== '')
    .map((e) => ({ speaker: e.speaker as 'lexi' | 'prospect', text: e.text, atSecond: e.atSecond ?? 0 }));
}

export interface ProcessOutcome {
  status: 'processed' | 'already-processed' | 'in-progress' | 'failed';
  detail: string;
  result?: PostCallResult;
}

const STALE_RUN_MS = 10 * 60_000;

export async function processReport(deps: EndedCallDeps, callId: string): Promise<ProcessOutcome> {
  const log = deps.log ?? (() => {});
  const nowIso = deps.now().toISOString();

  // One processor at a time; one successful run, ever.
  let claimed = false;
  let already = false;
  await deps.calls.patchMetrics(callId, (m) => {
    claimed = false;
    already = m.pipeline?.status === 'done';
    const running = m.pipeline?.status === 'running' && deps.now().getTime() - new Date(m.pipeline.at).getTime() < STALE_RUN_MS;
    if (already || running) return m;
    claimed = true;
    return { ...m, pipeline: { status: 'running', at: nowIso } };
  });
  if (already) return { status: 'already-processed', detail: 'this call has already been processed' };
  if (!claimed) return { status: 'in-progress', detail: 'this call is being processed' };

  try {
    const events = await deps.calls.events(callId);
    const reportEvent = [...events].reverse().find((e) => e.kind === 'report');
    if (reportEvent === undefined) throw new Error('no end-of-call report is stored for this call');
    const report = reportEvent.data as unknown as StoredReport;
    const call = await deps.calls.get(callId);

    await handleRecording(deps, callId, report, call.endedAt ?? deps.now());

    // What the call produced.
    const transcript = transcriptFrom(report, events);
    const prospectTurns = transcript.filter((t) => t.speaker === 'prospect').length;

    const toolCalls: JournalToolCall[] = events
      .filter((e) => e.kind === 'tool')
      .map((e) => ({ name: String(e.data.name ?? e.text), value: e.data.args }));

    // The provider knows some outcomes for certain: nobody answered, the line was
    // busy, an answering machine picked up. When no conversation took place and
    // Lexi marked nothing, that fact is the outcome. It is journalled as the
    // provider's, not Lexi's.
    const ended = classifyEndedReason(report.endedReason);
    const lexiMarked = toolCalls.some((c) => c.name === 'mark_outcome' || c.name === 'escalate' || c.name === 'suppress_contact');
    if (ended.outcome !== null && prospectTurns === 0 && !lexiMarked) {
      const synthetic = { outcome: ended.outcome, note: `reported by the provider: ${ended.note}` };
      toolCalls.push({ name: 'mark_outcome', value: synthetic });
      await deps.calls.append(callId, { kind: 'tool', text: 'mark_outcome', data: { name: 'mark_outcome', args: synthetic, source: 'provider' } });
    }

    const turnDefects = events
      .filter((e) => e.kind === 'defect')
      .flatMap((e) => {
        const kind = scribeDefectKind(String(e.data.kind ?? ''));
        return kind === null ? [] : [{ kind, detail: e.text, ...(e.atSecond !== null ? { atSecond: e.atSecond } : {}) }];
      });

    // Guardian layer three. Nothing was said on a call nobody answered, and an
    // audit of nothing would report every segment of the opening as missing.
    let audit: AuditFinding[] = [];
    if (transcript.length > 0) {
      const context = await deps.contexts.get(callId);
      const opening = context?.opening ?? [];
      const result = await auditCall({
        transcript,
        claims: deps.claims(),
        openingSaid: openingSegmentsSaid(transcript, opening),
        ...(deps.auditModel !== undefined ? { model: deps.auditModel } : {})
      });
      audit = result.findings;
      if (result.modelUnavailable !== undefined) log(`audit of ${callId.slice(0, 8)} was partial: ${result.modelUnavailable}`);
    }

    const endedAt = call.endedAt ?? deps.now();
    const input: ScribeInput = {
      callId,
      endedAt,
      durationSec: report.durationSec ?? call.durationSec ?? Math.max(0, Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000)),
      transcript,
      toolCalls,
      turnDefects,
      audit
    };

    const result = await processEndedCall(deps.post, input);

    await deps.db.dialAttempt.updateMany({
      where: { callId },
      data: { hadConversation: prospectTurns >= 2 && result.scribe.outcome !== 'voicemail' }
    });
    deps.contexts.forget(callId);

    await deps.calls.patchMetrics(callId, (m) => ({
      ...m,
      report: m.report === undefined ? { receivedAt: nowIso, status: 'processed' } : { receivedAt: m.report.receivedAt, status: 'processed' },
      pipeline: { status: 'done', at: deps.now().toISOString() }
    }));
    return { status: 'processed', detail: `outcome ${result.scribe.outcome ?? 'unmarked'}`, result };
  } catch (error) {
    const message = (error as Error).message;
    await deps.calls
      .patchMetrics(callId, (m) => ({
        ...m,
        report: m.report === undefined ? { receivedAt: nowIso, status: 'failed', error: message } : { receivedAt: m.report.receivedAt, status: 'failed', error: message },
        pipeline: { status: 'failed', at: deps.now().toISOString(), error: message }
      }))
      .catch(() => {});
    log(`processing call ${callId.slice(0, 8)} failed: ${message}`);
    return { status: 'failed', detail: message };
  }
}

/** Archive the recording, or purge it at once if the prospect objected. Never throws. */
async function handleRecording(deps: EndedCallDeps, callId: string, report: StoredReport, endedAt: Date): Promise<void> {
  const log = deps.log ?? (() => {});
  const metrics = await deps.calls.metrics(callId);
  const meta: RecordingMeta = metrics.recording ?? {};

  try {
    if (meta.deleteNow === true) {
      const purge = await runPurge({
        db: deps.db,
        store: deps.recordingStore,
        adapter: deps.adapter,
        now: deps.now,
        retentionDays: deps.retentionDays,
        dryRun: false,
        only: [callId]
      });
      for (const r of purge.results) log(`recording of ${callId.slice(0, 8)} (prospect objected): ${r.status} ${r.detail}`);

      // The report may not carry a recording URL yet (the audio can be prepared
      // after the report is sent), in which case there was nothing for the purge
      // to see. The provider is still told to delete the call, because the
      // recording exists whether or not we have its address.
      const providerCallId = (await deps.calls.get(callId)).providerCallId;
      if (purge.results.length === 0 && deps.adapter !== undefined && providerCallId !== null && meta.providerDeletedAt === undefined) {
        await deps.adapter.deleteArtifacts(providerCallId);
        await deps.calls.patchMetrics(callId, (m) => ({
          ...m,
          recording: { ...(m.recording ?? {}), providerDeletedAt: deps.now().toISOString() }
        }));
        await deps.calls.append(callId, { kind: 'recording', data: { action: 'provider-deleted', reason: 'objection' } });
      }
      return;
    }

    const expiresAt = new Date(endedAt.getTime() + deps.retentionDays * 86_400_000).toISOString();
    if (deps.recordingStore !== undefined && deps.adapter !== undefined && report.recordingUrl !== null) {
      const stored = await archiveRecording(
        { store: deps.recordingStore, adapter: deps.adapter, ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}) },
        callId,
        report.recordingUrl
      );
      await deps.calls.patchMetrics(callId, (m) => {
        const recording: RecordingMeta = { ...(m.recording ?? {}), archive: { ...stored, archivedAt: deps.now().toISOString() }, expiresAt };
        delete recording.archiveError;
        return { ...m, recording };
      });
      await deps.calls.append(callId, { kind: 'recording', data: { action: 'archived', location: stored.location, bytes: stored.bytes, encrypted: stored.encrypted } });
    } else if (report.recordingUrl !== null) {
      await deps.calls.patchMetrics(callId, (m) => ({ ...m, recording: { ...(m.recording ?? {}), expiresAt } }));
    }
  } catch (error) {
    // The audio is not worth failing the call's record for. The provider's copy
    // remains, the purge job still covers it, and the failure is on the record.
    const message = (error as Error).message;
    log(`recording of ${callId.slice(0, 8)} was not archived: ${message}`);
    await deps.calls
      .patchMetrics(callId, (m) => ({ ...m, recording: { ...(m.recording ?? {}), archiveError: message } }))
      .catch(() => {});
  }
}

/** Accept then process, for the callers (the watchdog, the reprocess command) that do both at once. */
export async function finishCall(deps: EndedCallDeps, callId: string, report: StoredReport): Promise<ProcessOutcome> {
  const accepted = await acceptReport(deps, null, { callId, report });
  if (accepted.status === 'unknown-call') return { status: 'failed', detail: 'unknown call' };
  return processReport(deps, callId);
}
