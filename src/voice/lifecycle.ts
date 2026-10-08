/**
 * A call's life, as rules.
 *
 * Everything here is deterministic and pure: no model, no clock of its own, no
 * network. That is on purpose. What a prospect's "I don't want to be recorded"
 * does to a call, and how long a call that nobody is reporting on is allowed to
 * hold the single live-call slot, are not matters for a prompt.
 */

import type { CallOutcome } from '../blackboard/schemas.js';
import type { CallState, StoredMetrics } from './call-store.js';

/* ------------------------------------------------------------------ */
/* Why a call ended                                                    */
/* ------------------------------------------------------------------ */

export interface EndedClass {
  /** What happened if nobody was there to have a conversation. Null when someone was. */
  outcome: CallOutcome | null;
  /** Something broke on the provider's side. Counted towards the error rate. */
  technical: boolean;
  /** Plain English, for the trace and the digest. */
  note: string;
}

const TECHNICAL = [/^pipeline-error/, /^call\.(start|in-progress)\.error/, /^assistant-request/, /^database-error$/, /^unknown-error$/, /^worker-shutdown$/, /^phone-call-provider-closed-websocket$/, /^twilio-failed-to-connect-call$/, /^failed-to-connect-call$/, /^assistant-not-found$/, /^assistant-not-valid$/];

/**
 * Read the provider's `endedReason`.
 *
 * Only the reasons that mean "no conversation happened" produce an outcome, and
 * only the ones the provider is certain of. A hang-up, a silence timeout or a
 * maximum-duration stop says nothing about whether the prospect was interested,
 * so those leave the outcome to what Lexi marked on the call - or to nothing,
 * which Scribe records honestly as unmarked rather than guessing.
 */
export function classifyEndedReason(reason: string): EndedClass {
  const r = reason.trim().toLowerCase();
  if (r === 'customer-did-not-answer') return { outcome: 'no_answer', technical: false, note: 'nobody answered' };
  if (r === 'customer-busy') return { outcome: 'no_answer', technical: false, note: 'the line was busy' };
  // Our own watchdog gave up on a call that never connected. Nobody picked up.
  if (r === 'watchdog:never-connected') return { outcome: 'no_answer', technical: false, note: 'nobody answered within the ring timeout' };
  if (r === 'voicemail') return { outcome: 'voicemail', technical: false, note: 'an answering machine picked up' };
  if (r === 'twilio-reported-customer-misdialed') {
    return { outcome: 'invalid_number', technical: false, note: 'the carrier says the number is not a working number' };
  }
  const technical = TECHNICAL.some((pattern) => pattern.test(r));
  return {
    outcome: null,
    technical,
    note: technical ? `a technical failure on the provider side (${r})` : `the call ended: ${r || 'no reason given'}`
  };
}

/* ------------------------------------------------------------------ */
/* Recording (section 7.4)                                             */
/* ------------------------------------------------------------------ */

/**
 * Has the prospect objected to being recorded?
 *
 * Section 7.4: announce recording in the opening; if the prospect objects, stop
 * recording and continue, or end the call - never continue covertly. A pattern
 * rather than a model, because this is a legal line and because it must run on
 * every prospect turn without costing a round trip.
 *
 * It errs towards hearing an objection. Ending a call that did not need ending
 * costs one conversation; carrying on recording someone who asked us not to is a
 * breach. A *question* about recording ("are you recording this?") is not an
 * objection and is left to Lexi, who answers it truthfully.
 */
const NEGATION = /\b(?:don'?t|do not|dont|doesn'?t|did not|didn'?t|not|never|won'?t|wouldn'?t|can'?t|cannot|refuse|object)\b/i;
const RECORDING_WORD = /\b(?:record(?:ing|ed)|record\s+(?:this|me|us|it|that|the\s+call|our|my|any))\b/i;
const DOESNT_MIND = /\b(?:mind|problem|bothered|fussed|issue|worried|concern)\b/i;

export function detectRecordingObjection(said: string): boolean {
  const text = said.replace(/\s+/g, ' ').trim();
  if (text === '' || !/record/i.test(text)) return false;

  // "stop the recording", "turn off the recording", "switch the recording off".
  if (/\b(?:stop|turn off|switch off|pause|disable|cancel|end)\s+(?:the\s+|this\s+|that\s+|your\s+)?(?:call\s+)?record(?:ing|ed)?\b/i.test(text)) return true;
  if (/\b(?:turn|switch)\s+(?:the\s+|this\s+|that\s+)?record(?:ing|er)\s+off\b/i.test(text)) return true;
  if (/\b(?:no|without)\s+(?:the\s+)?record(?:ing|ed)\b/i.test(text)) return true;
  if (/\boff\s+the\s+record\b/i.test(text)) return true;
  if (/\b(?:do|would)\s+mind\b[^.?!]{0,40}\brecord/i.test(text)) return true;
  // "Recorded? I'd rather not." - the refusal comes after the word.
  if (/\brecord(?:ing|ed)?\b[\s\S]{0,40}?\b(?:rather not|no thanks|no thank you|not ok(?:ay)?|not happy|not comfortable|not fine)\b/i.test(text)) return true;

  // Sentence by sentence: a negation that sits next to a recording word, unless
  // that same sentence says they don't mind ("I don't mind you recording").
  for (const sentence of text.split(/[.?!;]+/)) {
    if (!NEGATION.test(sentence) || !RECORDING_WORD.test(sentence)) continue;
    if (DOESNT_MIND.test(sentence)) continue;
    // "don't" ... "recording" within a short span, not across a whole paragraph.
    if (/\b(?:don'?t|do not|dont|doesn'?t|did not|didn'?t|not|never|won'?t|wouldn'?t|can'?t|cannot|refuse|object)\b[^]{0,50}?\brecord/i.test(sentence)) return true;
  }
  return false;
}

export interface RecordingObjectionResponse {
  /** What Lexi says. Fixed, so Coach and the model cannot soften it. */
  line: string;
  /** Whether the call ends with it. */
  endCall: boolean;
  handling: 'call-ended' | 'recording-stopped';
}

/**
 * What happens when someone objects to being recorded.
 *
 * If the provider can stop recording mid-call we say so, carry on, and the
 * adapter does it. If it cannot, we end the call - saying that we are doing so
 * and why. Claiming "I've stopped the recording" when it has not stopped would
 * be the covert recording the brief rules out, said out loud.
 */
export function recordingObjectionResponse(
  canStopMidCall: boolean,
  stoppedLine: string
): RecordingObjectionResponse {
  if (canStopMidCall) return { line: stoppedLine, endCall: false, handling: 'recording-stopped' };
  return {
    line: "Understood, and thank you for telling me. I can't switch the recording off during a call, so I won't carry on. I'm sorry for the interruption, and thanks for your time.",
    endCall: true,
    handling: 'call-ended'
  };
}

/* ------------------------------------------------------------------ */
/* Timeouts                                                            */
/* ------------------------------------------------------------------ */

export interface LifecycleLimits {
  maxCallSeconds: number;
  ringTimeoutSeconds: number;
  reportGraceSeconds: number;
}

export type StaleReason = 'never-connected' | 'overran' | 'report-missing';

export interface StaleVerdict {
  reason: StaleReason;
  detail: string;
  /** The call may still be up at the provider, so try to hang it up. */
  hangUp: boolean;
}

export interface StaleInput {
  startedAt: Date;
  endedAt: Date | null;
  metrics: StoredMetrics;
  now: Date;
  limits: LifecycleLimits;
}

const seconds = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / 1000;

/**
 * Is a call stuck?
 *
 * A call that never ends holds the one live-call slot, and the gate then refuses
 * every dial with CONCURRENCY_LIMIT until someone notices. Three ways to get
 * stuck, each with a limit that comes from the call's own configuration:
 * ringing for too long; running past the longest call the assistant allows plus
 * time for the report; or ending without the provider ever sending its report,
 * which leaves a call unrecorded.
 */
export function assessStale(input: StaleInput): StaleVerdict | null {
  const { startedAt, endedAt, metrics, now, limits } = input;
  const state: CallState = endedAt !== null ? 'ended' : (metrics.state ?? 'dialling');
  const anchor = metrics.answeredAt !== undefined ? new Date(metrics.answeredAt) : startedAt;

  if (state === 'ended') {
    if (metrics.pipeline !== undefined) return null; // processed, or being processed
    const waited = seconds(endedAt as Date, now);
    return waited > limits.reportGraceSeconds
      ? {
          reason: 'report-missing',
          detail: `the call ended ${Math.round(waited)}s ago and the provider has not sent its report`,
          hangUp: false
        }
      : null;
  }

  if (state === 'dialling' || state === 'ringing') {
    const age = seconds(startedAt, now);
    return age > limits.ringTimeoutSeconds
      ? {
          reason: 'never-connected',
          detail: `${Math.round(age)}s since dialling and the call has not been answered`,
          hangUp: true
        }
      : null;
  }

  const age = seconds(anchor, now);
  const ceiling = limits.maxCallSeconds + limits.reportGraceSeconds;
  return age > ceiling
    ? {
        reason: 'overran',
        detail: `the call has been up ${Math.round(age)}s; the longest it can run is ${limits.maxCallSeconds}s`,
        hangUp: true
      }
    : null;
}
