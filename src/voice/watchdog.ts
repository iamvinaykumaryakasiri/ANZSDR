/**
 * The watchdog: calls that nobody is reporting on.
 *
 * A call holds the single live-call slot from the moment it is dialled until it
 * is marked ended. If the provider's report never arrives (our server was down,
 * the webhook was misconfigured, the call never connected at all) the slot is
 * held for ever and the compliance gate refuses every later dial with
 * CONCURRENCY_LIMIT. This is the thing that notices, hangs the call up if it is
 * still there, closes it on the blackboard, and sends it through the same
 * processing a real report would have got - with an honest note that nothing
 * was heard.
 *
 * It only ever closes calls. It cannot place one.
 */

import { acceptReport, processReport, syntheticReport, type EndedCallDeps } from './ended-call.js';
import { assessStale, type LifecycleLimits, type StaleReason } from './lifecycle.js';

export interface SweepResult {
  callId: string;
  reason: StaleReason;
  detail: string;
  hungUp: boolean;
  processing: string;
}

export async function sweepCalls(deps: EndedCallDeps, limits: LifecycleLimits): Promise<SweepResult[]> {
  const log = deps.log ?? (() => {});
  const now = deps.now();
  const out: SweepResult[] = [];

  for (const call of await deps.calls.openCalls()) {
    const verdict = assessStale({ startedAt: call.startedAt, endedAt: call.endedAt, metrics: call.metrics, now, limits });
    if (verdict === null) continue;

    let hungUp = false;
    if (verdict.hangUp && deps.adapter !== undefined && call.providerCallId !== null) {
      try {
        await deps.adapter.hangUp({ providerCallId: call.providerCallId, controlUrl: call.metrics.controlUrl ?? null });
        hungUp = true;
      } catch (error) {
        // The call may already be gone, which is the outcome we wanted.
        log(`could not hang up ${call.id.slice(0, 8)}: ${(error as Error).message}`);
      }
    }

    log(`watchdog: closing call ${call.id.slice(0, 8)} (${verdict.reason}): ${verdict.detail}`);
    const report = syntheticReport(`watchdog:${verdict.reason}`, now);
    // The report-missing case already has an end time; keep it.
    if (call.endedAt !== null) report.endedAt = call.endedAt.toISOString();

    const accepted = await acceptReport(deps, null, { callId: call.id, report });
    const processed = accepted.status === 'unknown-call' ? null : await processReport(deps, call.id);
    out.push({
      callId: call.id,
      reason: verdict.reason,
      detail: verdict.detail,
      hungUp,
      processing: processed === null ? 'unknown call' : `${processed.status}: ${processed.detail}`
    });
  }
  return out;
}
