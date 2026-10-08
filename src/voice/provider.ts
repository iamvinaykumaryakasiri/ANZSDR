/**
 * What the system needs from a voice provider, and nothing it does not.
 *
 * Section 2 chose Vapi and said Retell is acceptable. The two do the same job -
 * telephony, ASR, TTS, barge-in - and call the same custom-LLM endpoint, so the
 * seam is small: place a call, hang one up, delete what the provider kept, and
 * turn a webhook into something the rest of the system understands. Everything
 * that decides what Lexi says, and everything that decides whether a call may
 * happen at all, sits on our side of it.
 *
 * Only Vapi is implemented (`vapi.ts`). A Retell adapter is a second file that
 * satisfies this interface; nothing else changes.
 */

import type { DialPermit } from './permit.js';

export type ProviderName = 'vapi' | 'retell';

export interface ProviderCapabilities {
  /**
   * Whether the provider can stop recording while a call continues.
   *
   * This decides what Lexi says when a prospect objects to being recorded
   * (section 7.4). If recording can be stopped, the call carries on without it.
   * If it cannot, the only honest options are to end the call or to carry on
   * recording covertly - and the second is not an option. Vapi documents no way
   * to stop a recording mid-call, so for Vapi this is false and an objection ends
   * the call.
   */
  stopRecordingMidCall: boolean;
  /** Whether the provider's own copy of a call's recording can be deleted over the API. */
  deleteArtifacts: boolean;
  /** Whether a live call can be hung up from our side. */
  hangUp: boolean;
}

/** What the provider tells us when it accepts a call. */
export interface PlacedCall {
  providerCallId: string;
  /** Where to send live-call commands such as hang-up. Null if the provider gave none. */
  controlUrl: string | null;
  providerStatus: string;
}

/**
 * The provider definitely refused: nothing was placed. A bad key, a malformed
 * number, an unknown phone-number id. The attempt is not counted against the
 * contact, because no phone rang.
 */
export class ProviderRejectedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ProviderRejectedError';
  }
}

/**
 * We do not know whether the provider placed the call: a timeout, a dropped
 * connection, a 5xx. It is treated as placed. Counting an attempt that did not
 * happen costs a retry; not counting one that did risks ringing someone twice.
 */
export class ProviderUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUncertainError';
  }
}

export interface PlaceCallRequest {
  /**
   * Our id for the call. It travels to the provider as metadata and comes back
   * on every custom-LLM request, which is how a turn is tied to its briefing.
   */
  callId: string;
}

export type ProviderCallStatus = 'queued' | 'ringing' | 'in-progress' | 'ended' | 'other';

/** One thing said on the call, as the provider heard it. */
export interface ProviderMessage {
  speaker: 'lexi' | 'prospect';
  text: string;
  atSecond: number;
}

export interface ProviderMetrics {
  /** Per-turn voice-to-voice latency, in order, null where the provider gave none. */
  turnLatenciesMs: Array<number | null>;
  /** The provider's own averages, by name, in milliseconds. */
  averagesMs: Record<string, number>;
}

export type ProviderEvent =
  | {
      kind: 'status';
      providerCallId: string;
      ourCallId: string | null;
      status: ProviderCallStatus;
      rawStatus: string;
      endedReason: string | null;
      /** Where to send live-call commands, when the event says. */
      controlUrl: string | null;
    }
  | {
      kind: 'report';
      providerCallId: string;
      ourCallId: string | null;
      endedReason: string;
      startedAt: Date | null;
      endedAt: Date | null;
      durationSec: number | null;
      messages: ProviderMessage[];
      recordingUrl: string | null;
      stereoRecordingUrl: string | null;
      metrics: ProviderMetrics;
      costUsd: number | null;
    }
  | { kind: 'ignored'; type: string };

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface ProviderAdapter {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  /**
   * Place an outbound call. This is the only way a call is started, and it takes
   * a permit and no destination: the number and the caller ID come off the
   * permit the compliance gate issued. See `permit.ts`.
   */
  placeCall(permit: DialPermit, request: PlaceCallRequest): Promise<PlacedCall>;

  /** End a live call. Used by the watchdog and when a turn closes the call. */
  hangUp(call: { providerCallId: string; controlUrl: string | null }): Promise<void>;

  /** Delete the provider's copy of a finished call, recording included. */
  deleteArtifacts(providerCallId: string): Promise<void>;

  /** Stop recording a live call. Only called when `capabilities.stopRecordingMidCall` is true. */
  stopRecording?(call: { providerCallId: string; controlUrl: string | null }): Promise<void>;

  /** Headers to send when downloading a recording from this provider, for a URL it hosts. */
  artifactHeaders(url: URL): Record<string, string>;

  /** Is this webhook really from the provider? Constant-time, and false on anything missing. */
  verifyWebhook(headers: HeaderBag): boolean;

  /** Turn a webhook body into an event. Pure. Unknown message types come back as `ignored`. */
  parseWebhook(body: unknown): ProviderEvent;
}
