/**
 * The opening. Fixed, immutable, never touched by Coach.
 *
 * Section 8 fixes both the content and the order:
 *
 *   agent name -> AI disclosure -> Hexaware, working with Vinay Kumar on the ANZ
 *   sales team -> the reason for the call in one sentence -> recording
 *   announcement -> ask for thirty seconds.
 *
 * Section 11 puts identity disclosure, AI disclosure and the recording
 * announcement out of Coach's reach entirely. That is enforced structurally
 * rather than by instruction: the segment list is frozen, the segments carry no
 * setters, and the only thing any caller of this module can supply is the names
 * and the one-sentence reason. There is no code path that removes a segment.
 *
 * Section 0 rule 2 is the one that matters most here. The agent never claims to
 * be human - not by omission, not under pressure, not if the prospect insists.
 * Omission is the failure mode this file exists to make impossible: the
 * disclosure is not a line Coach might drop, it is a segment the opening cannot
 * be built without.
 */

import type { AgentIdentity } from './identity.js';

export type SegmentId = 'identity' | 'ai-disclosure' | 'affiliation' | 'reason' | 'recording' | 'permission';

export interface OpeningSegment {
  id: SegmentId;
  /** Every segment is required. The field exists to say so, not to vary. */
  required: true;
  text: string;
}

/**
 * The order is part of the obligation, not a style choice: section 7.3 requires
 * who is calling, on whose behalf, and why, *immediately* after the call begins.
 * The AI disclosure sits second so it lands inside the first fifteen seconds
 * whatever else is said.
 */
export const SEGMENT_ORDER: readonly SegmentId[] = Object.freeze([
  'identity',
  'ai-disclosure',
  'affiliation',
  'reason',
  'recording',
  'permission'
]);

export interface OpeningOptions {
  identity: AgentIdentity;
  /** One sentence, from the dossier hypothesis. Section 8: the reason for the call. */
  reason: string;
  /**
   * False when the prospect has already objected to being recorded. The
   * announcement changes; nothing else does, and the AI disclosure in
   * particular does not.
   */
  recording?: boolean;
}

export class OpeningNotAvailableError extends Error {}

/**
 * Build the opening, or refuse.
 *
 * Refusing is the point. An agent with no name cannot satisfy the first segment,
 * and the right response to that is silence rather than a plausible improvisation.
 */
export function buildOpening(options: OpeningOptions): OpeningSegment[] {
  const { identity, reason } = options;
  const recording = options.recording ?? true;

  const name = identity.agent.name.trim();
  if (name === '') {
    throw new OpeningNotAvailableError(
      'the agent has no name configured, so it cannot introduce itself; set agent.name in config/agent.yaml (brief section 15 item 1)'
    );
  }
  if (reason.trim() === '') {
    throw new OpeningNotAvailableError(
      'no reason for the call was supplied, and section 7.3 requires one immediately after the call begins'
    );
  }

  const { operator } = identity;

  const text: Record<SegmentId, string> = {
    identity: `Hi, my name's ${name}.`,
    // Said plainly and without hedging. "Virtual assistant" and "digital
    // colleague" are evasions; this says the thing.
    'ai-disclosure': `I should say up front — I'm an AI assistant, not a person.`,
    affiliation: `I work with ${operator.name}, ${operator.title} at ${operator.company}, on ${operator.team}.`,
    reason: reason.trim(),
    recording: recording
      ? `This call is being recorded — do let me know if you'd rather it wasn't.`
      : `I've stopped the recording, as you asked.`,
    permission: `Have you got thirty seconds for me to explain why I called?`
  };

  return SEGMENT_ORDER.map((id) => Object.freeze({ id, required: true as const, text: text[id] }));
}

/** The opening as one utterance, which is what the voice layer sends. */
export function renderOpening(segments: OpeningSegment[]): string {
  return segments.map((s) => s.text).join(' ');
}

/**
 * Does this opening still satisfy section 8?
 *
 * Guardian runs this over what was *actually said* on the call, not over what
 * was generated - the two can differ if a turn is cut mid-stream, and a
 * disclosure that was composed but never reached the prospect is not a
 * disclosure.
 */
export function missingSegments(segments: readonly OpeningSegment[]): SegmentId[] {
  const present = new Set(segments.map((s) => s.id));
  return SEGMENT_ORDER.filter((id) => !present.has(id));
}

/**
 * The lines Coach is permitted to rewrite: none of them.
 *
 * Exported so the Phase 7 promotion gate can assert against one list rather
 * than re-deriving the rule, and so a variant that touches any of this is
 * rejected by the gate rather than caught by a reviewer.
 */
export const COACH_MAY_NOT_EDIT: readonly SegmentId[] = SEGMENT_ORDER;
