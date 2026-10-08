/**
 * The Vapi adapter.
 *
 * Vapi does telephony, speech-to-text, text-to-speech and barge-in. We keep the
 * brain: the assistant it runs is configured to call *our* OpenAI-shaped
 * endpoint for every turn (section 2), so the prompt, the tools, the guardrails
 * and the log all stay on our side of the line.
 *
 * Three things here are worth reading before changing anything.
 *
 * 1. No first message. The assistant is created with
 *    `firstMessageMode: assistant-speaks-first-with-model-generated-message` and
 *    no `firstMessage` at all, so the provider asks our endpoint for the first
 *    thing to say, and our endpoint answers with the frozen opening
 *    (`src/agents/caller/opening.ts`). The AI disclosure and the recording
 *    announcement therefore cannot be edited from the provider's dashboard or
 *    from `config/voice.yaml`, and `assertAssistantInvariants` refuses to send
 *    an assistant that says otherwise.
 *
 * 2. `placeCall` takes a permit and no number. See `permit.ts`.
 *
 * 3. Nothing here is verified against a live Vapi account. The shapes below
 *    follow Vapi's published API reference and docs as of this build, and the
 *    first `npm run voice:assistant` and first test call are the verification.
 *    Where the documentation is silent the code is tolerant and says so.
 */

import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { DialPermit } from './permit.js';
import { redeemPermit } from './permit.js';
import {
  ProviderRejectedError,
  ProviderUncertainError,
  type HeaderBag,
  type PlaceCallRequest,
  type PlacedCall,
  type ProviderAdapter,
  type ProviderCallStatus,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderMetrics
} from './provider.js';
import type { VoiceConfig } from './voice-config.js';

export const VAPI_API = 'https://api.vapi.ai';

/** The first-message mode that makes our endpoint, not the dashboard, say the opening. */
export const OPENING_MODE = 'assistant-speaks-first-with-model-generated-message';

/* ------------------------------------------------------------------ */
/* The assistant                                                       */
/* ------------------------------------------------------------------ */

export interface AssistantBuildInput {
  config: VoiceConfig;
  /** Public HTTPS base, no trailing slash. The provider calls back to this. */
  publicBaseUrl: string;
  /** Sent by the provider with every webhook, in `x-vapi-secret`. */
  webhookSecret: string;
  /** Sent by the provider to our LLM endpoint as `Authorization: Bearer`. */
  llmSecret: string;
}

export class AssistantInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantInvariantError';
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: Json, extra: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = out[key];
    out[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

export function llmBaseUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/v1`;
}

export function webhookUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/vapi/webhook`;
}

/**
 * What must be true of any assistant this system sends, whatever
 * `assistant_extra` says. Each line protects a property the brief makes
 * non-negotiable.
 */
export function assertAssistantInvariants(assistant: Json, input: Pick<AssistantBuildInput, 'publicBaseUrl'>): void {
  const model = isRecord(assistant.model) ? assistant.model : {};
  const server = isRecord(assistant.server) ? assistant.server : {};
  const artifact = isRecord(assistant.artifactPlan) ? assistant.artifactPlan : {};

  if (assistant.firstMessage !== undefined) {
    throw new AssistantInvariantError(
      'a firstMessage is set. The opening is frozen in code and served by our endpoint; a provider-side first message would bypass it'
    );
  }
  if (assistant.firstMessageMode !== OPENING_MODE) {
    throw new AssistantInvariantError(`firstMessageMode must be ${OPENING_MODE}, so the opening comes from our endpoint`);
  }
  if (model.provider !== 'custom-llm' || model.url !== llmBaseUrl(input.publicBaseUrl)) {
    throw new AssistantInvariantError('the model must be our custom LLM endpoint; the brain, prompt and guardrails live there');
  }
  if (server.url !== webhookUrl(input.publicBaseUrl)) {
    throw new AssistantInvariantError('the server URL must be our webhook, or end-of-call reports never reach us');
  }
  if (artifact.recordingEnabled !== true) {
    throw new AssistantInvariantError(
      'recording must be enabled: the opening announces that the call is recorded, and an announcement that is not true is not allowed'
    );
  }
}

export function buildVapiAssistant(input: AssistantBuildInput): Json {
  const { config } = input;

  const base: Json = {
    name: config.assistant.name,
    model: {
      provider: 'custom-llm',
      // Vapi appends /chat/completions to this.
      url: llmBaseUrl(input.publicBaseUrl),
      model: 'anz-voice-sdr',
      // The call object and our metadata (our call id) ride on every request.
      metadataSendMode: 'variable',
      // The only built-in tool: lets a turn that has closed the call hang up.
      // Lexi's own six tools are handled inside our endpoint and are never
      // declared here, so the provider never tries to run them.
      tools: [{ type: 'endCall' }],
      // Ignored by our endpoint, which assembles the real prompt per call from
      // the briefing pack. Present because the provider expects a list.
      messages: [
        {
          role: 'system',
          content: 'Placeholder. The briefing pack for each call is assembled by the voice server and replaces this.'
        }
      ]
    },
    // The opening is ours. See the module comment.
    firstMessageMode: OPENING_MODE,
    voice: { provider: config.voice.provider, voiceId: config.voice.voice_id },
    transcriber: {
      provider: config.transcriber.provider,
      model: config.transcriber.model,
      language: config.transcriber.language
    },
    // The LLM credential travels with the assistant, so there is no organisation
    // level key to keep in step with VOICE_SHARED_SECRET.
    credentials: [{ provider: 'custom-llm', apiKey: input.llmSecret, name: 'anz-voice-sdr' }],
    server: {
      url: webhookUrl(input.publicBaseUrl),
      headers: { 'x-vapi-secret': input.webhookSecret },
      timeoutSeconds: 20
    },
    // Only what we use. A transcript stream would be traffic we then ignore.
    serverMessages: ['status-update', 'end-of-call-report'],
    artifactPlan: { recordingEnabled: true, recordingFormat: config.recording.format },
    startSpeakingPlan: { waitSeconds: config.barge_in.wait_seconds },
    stopSpeakingPlan: {
      numWords: config.barge_in.num_words,
      voiceSeconds: config.barge_in.voice_seconds,
      backoffSeconds: config.barge_in.backoff_seconds
    },
    maxDurationSeconds: config.limits.max_call_seconds,
    silenceTimeoutSeconds: config.limits.silence_timeout_seconds,
    // Detect an answering machine and hang up. There is deliberately no
    // voicemailMessage: a voicemail drop is a recorded message left on a stranger's
    // phone, and its wording and the callback number in it are Vinay's to approve
    // (section 12.3). Until then the call simply ends.
    voicemailDetection: { provider: 'vapi' },
    metadata: { app: 'anz-voice-sdr' }
  };

  const merged = deepMerge(base, config.assistant_extra);
  assertAssistantInvariants(merged, input);
  return merged;
}

/* ------------------------------------------------------------------ */
/* The adapter                                                         */
/* ------------------------------------------------------------------ */

export interface VapiAdapterOptions {
  apiKey: string;
  webhookSecret: string;
  assistantId: string;
  /** Vapi's id for the imported Twilio number, per market. */
  phoneNumberIds: { AU?: string | undefined; NZ?: string | undefined };
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Per request. Creating a call can take a few seconds. */
  timeoutMs?: number;
}

const placedSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().optional(),
    monitor: z.object({ controlUrl: z.string().optional() }).passthrough().optional()
  })
  .passthrough();

function digits(number: string): string {
  return number.replace(/[^\d]/g, '');
}

function secretsMatch(supplied: string, expected: string): boolean {
  if (supplied === '' || expected === '') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** A Vapi-hosted address. Live-call commands and artifact downloads go only to these. */
export function isVapiHost(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname === 'vapi.ai' || url.hostname.endsWith('.vapi.ai'));
}

export class VapiAdapter implements ProviderAdapter {
  readonly name = 'vapi' as const;
  readonly capabilities: ProviderCapabilities = {
    // Vapi documents no way to stop a recording while a call continues. If it
    // grows one, this is the line to change - and the lifecycle then says
    // "I've stopped the recording" instead of ending the call.
    stopRecordingMidCall: false,
    deleteArtifacts: true,
    hangUp: true
  };

  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly verifiedNumbers = new Set<string>();

  constructor(private readonly options: VapiAdapterOptions) {
    this.base = (options.baseUrl ?? VAPI_API).replace(/\/+$/, '');
    this.doFetch = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /* -------- placing a call -------- */

  async placeCall(permit: DialPermit, request: PlaceCallRequest): Promise<PlacedCall> {
    // First, before any network traffic of any kind: is this a permit the gate
    // issued, is it still good, and is this its only use?
    redeemPermit(permit, this.now());

    const phoneNumberId = this.options.phoneNumberIds[permit.market];
    if (phoneNumberId === undefined || phoneNumberId.trim() === '') {
      throw new ProviderRejectedError(
        `no Vapi phone number id is configured for ${permit.market} (VAPI_PHONE_NUMBER_ID_${permit.market})`,
        0
      );
    }
    await this.assertCallerIdMatches(phoneNumberId, permit.callerId);

    const body = {
      assistantId: this.options.assistantId,
      // Our id only. No name, no number: the endpoint looks everything else up.
      assistantOverrides: { metadata: { callId: request.callId } },
      phoneNumberId,
      customer: { number: permit.e164, numberE164CheckEnabled: true },
      name: `lexi-${request.callId.slice(0, 8)}`
    };

    const response = await this.send('POST', '/call', body, 'uncertain');
    const parsed = placedSchema.safeParse(response);
    if (!parsed.success) {
      throw new ProviderUncertainError('the provider accepted the request but its reply was not a call; treating the call as placed');
    }
    return {
      providerCallId: parsed.data.id,
      controlUrl: parsed.data.monitor?.controlUrl ?? null,
      providerStatus: parsed.data.status ?? 'queued'
    };
  }

  /**
   * The number presented to the person called must be the number we configured
   * as the contactable one (section 7.3), not whatever the provider has behind
   * the id. Checked once per number per process, before the first dial.
   */
  private async assertCallerIdMatches(phoneNumberId: string, callerId: string): Promise<void> {
    if (this.verifiedNumbers.has(`${phoneNumberId}:${callerId}`)) return;
    const record = await this.send('GET', `/phone-number/${encodeURIComponent(phoneNumberId)}`, undefined, 'rejected');
    const number = isRecord(record) && typeof record.number === 'string' ? record.number : '';
    if (digits(number) === '' || digits(number) !== digits(callerId)) {
      throw new ProviderRejectedError(
        `Vapi phone number ${phoneNumberId} is ${number === '' ? 'not a number we can read' : number}, but the caller ID the gate approved is ${callerId}. Refusing to present a different number than the one configured as contactable`,
        0
      );
    }
    this.verifiedNumbers.add(`${phoneNumberId}:${callerId}`);
  }

  /* -------- live and finished calls -------- */

  async hangUp(call: { providerCallId: string; controlUrl: string | null }): Promise<void> {
    if (call.controlUrl === null) {
      throw new Error(`no control URL is held for ${call.providerCallId}, so the call cannot be hung up from here`);
    }
    const url = new URL(call.controlUrl);
    // A control URL arrives in a webhook body. It is only ever followed if it is
    // the provider's own host, so a forged body cannot make us POST elsewhere.
    if (!isVapiHost(url)) throw new Error(`refusing to send a command to ${url.hostname}, which is not a Vapi host`);
    const response = await this.doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'end-call' }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`Vapi refused the hang-up: ${response.status}`);
  }

  async deleteArtifacts(providerCallId: string): Promise<void> {
    await this.send('DELETE', `/call/${encodeURIComponent(providerCallId)}`, undefined, 'rejected');
  }

  artifactHeaders(url: URL): Record<string, string> {
    // The API key goes only to Vapi, never to whatever host a webhook names.
    return isVapiHost(url) ? { authorization: `Bearer ${this.options.apiKey}` } : {};
  }

  /* -------- assistant management (setup, never in a call) -------- */

  /**
   * Create the assistant, or update it if one with this name already exists (or
   * `assistantId` is given). Idempotent: running it twice leaves one assistant.
   */
  async upsertAssistant(assistant: Json, existingId?: string): Promise<{ id: string; created: boolean }> {
    let id = existingId;
    if (id === undefined || id === '') {
      const list = await this.send('GET', '/assistant?limit=100', undefined, 'rejected');
      const rows = Array.isArray(list) ? list : [];
      const match = rows.find((row) => isRecord(row) && row.name === assistant.name);
      id = isRecord(match) && typeof match.id === 'string' ? match.id : undefined;
    }

    if (id !== undefined) {
      await this.send('PATCH', `/assistant/${encodeURIComponent(id)}`, assistant, 'rejected');
      return { id, created: false };
    }
    const created = await this.send('POST', '/assistant', assistant, 'rejected');
    if (!isRecord(created) || typeof created.id !== 'string') throw new Error('Vapi created an assistant but returned no id');
    return { id: created.id, created: true };
  }

  /** Read-only, for the preflight. */
  async getAssistant(id: string): Promise<Json> {
    const out = await this.send('GET', `/assistant/${encodeURIComponent(id)}`, undefined, 'rejected');
    return isRecord(out) ? out : {};
  }

  /** Read-only, for the preflight. */
  async getPhoneNumber(id: string): Promise<Json> {
    const out = await this.send('GET', `/phone-number/${encodeURIComponent(id)}`, undefined, 'rejected');
    return isRecord(out) ? out : {};
  }

  /* -------- webhooks -------- */

  verifyWebhook(headers: HeaderBag): boolean {
    const secret = this.options.webhookSecret;
    // `x-vapi-secret` is what Vapi sends for a legacy secret; `Authorization:
    // Bearer` is what it sends for a bearer credential. Either proves the same
    // thing, and both are compared in constant time.
    const bearer = first(headers.authorization).replace(/^Bearer\s+/i, '');
    return secretsMatch(first(headers['x-vapi-secret']), secret) || secretsMatch(bearer, secret);
  }

  parseWebhook(body: unknown): ProviderEvent {
    return parseVapiWebhook(body);
  }

  /* -------- plumbing -------- */

  /**
   * One API call. `onFailure` says what a transport failure or a 5xx means for
   * this request: for creating a call it means "we do not know whether it was
   * placed"; for anything else it is just an error.
   */
  private async send(method: string, path: string, body: unknown, onFailure: 'uncertain' | 'rejected'): Promise<unknown> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const why = (error as Error).message;
      if (onFailure === 'uncertain') throw new ProviderUncertainError(`no answer from Vapi (${why}); the call may have been placed`);
      throw new Error(`could not reach Vapi: ${why}`);
    }

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const detail = text.slice(0, 500);
      if (response.status >= 500 && onFailure === 'uncertain') {
        throw new ProviderUncertainError(`Vapi returned ${response.status}; the call may have been placed. ${detail}`);
      }
      throw new ProviderRejectedError(`Vapi returned ${response.status} for ${method} ${path}: ${detail}`, response.status);
    }
    if (text === '') return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (onFailure === 'uncertain') throw new ProviderUncertainError('Vapi replied with something that was not JSON');
      throw new Error('Vapi replied with something that was not JSON');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Webhook parsing                                                     */
/* ------------------------------------------------------------------ */

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Json => (isRecord(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function ourCallIdFrom(call: Json): string | null {
  const candidates = [rec(call.metadata).callId, rec(rec(call.assistantOverrides).metadata).callId];
  for (const c of candidates) {
    const id = str(c);
    if (id !== null && id.length <= 64) return id;
  }
  return null;
}

function statusOf(raw: string): ProviderCallStatus {
  switch (raw) {
    case 'queued':
    case 'scheduled':
      return 'queued';
    case 'ringing':
      return 'ringing';
    case 'in-progress':
    case 'forwarding':
      return 'in-progress';
    case 'ended':
      return 'ended';
    default:
      return 'other';
  }
}

function speakerOf(role: unknown): ProviderMessage['speaker'] | null {
  switch (role) {
    case 'assistant':
    case 'bot':
      return 'lexi';
    case 'user':
      return 'prospect';
    // system prompts, tool calls and their results are not speech.
    default:
      return null;
  }
}

function messagesOf(artifact: Json, startedAt: Date | null): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const raw of arr(artifact.messages)) {
    const m = rec(raw);
    const speaker = speakerOf(m.role);
    const text = str(m.message) ?? str(m.content);
    if (speaker === null || text === null) continue;

    let atSecond = num(m.secondsFromStart);
    if (atSecond === null) {
      const time = num(m.time);
      atSecond = time !== null && startedAt !== null ? Math.max(0, (time - startedAt.getTime()) / 1000) : (out.at(-1)?.atSecond ?? 0);
    }
    out.push({ speaker, text: text.trim(), atSecond: Math.round(atSecond) });
  }
  return out;
}

function metricsOf(artifact: Json): ProviderMetrics {
  const performance = rec(artifact.performanceMetrics);
  const turnLatenciesMs = arr(performance.turnLatencies).map((t) => num(rec(t).turnLatency));
  const averagesMs: Record<string, number> = {};
  for (const [key, value] of Object.entries(performance)) {
    const n = num(value);
    if (n !== null && key.endsWith('Average')) averagesMs[key] = n;
  }
  return { turnLatenciesMs, averagesMs };
}

export function parseVapiWebhook(body: unknown): ProviderEvent {
  const message = rec(rec(body).message);
  const type = str(message.type);
  if (type === null) return { kind: 'ignored', type: 'unknown' };

  const call = rec(message.call);
  const providerCallId = str(call.id);

  if (type === 'status-update') {
    if (providerCallId === null) return { kind: 'ignored', type };
    const rawStatus = str(message.status) ?? 'unknown';
    return {
      kind: 'status',
      providerCallId,
      ourCallId: ourCallIdFrom(call),
      status: statusOf(rawStatus),
      rawStatus,
      endedReason: str(message.endedReason) ?? str(call.endedReason),
      controlUrl: str(rec(call.monitor).controlUrl)
    };
  }

  if (type === 'end-of-call-report') {
    if (providerCallId === null) return { kind: 'ignored', type };
    const artifact = rec(message.artifact);
    const startedAt = date(message.startedAt) ?? date(call.startedAt);
    const endedAt = date(message.endedAt) ?? date(call.endedAt);
    const seconds =
      num(message.durationSeconds) ??
      (num(message.durationMs) !== null ? (num(message.durationMs) as number) / 1000 : null) ??
      (startedAt !== null && endedAt !== null ? (endedAt.getTime() - startedAt.getTime()) / 1000 : null);

    const recording = rec(artifact.recording);
    return {
      kind: 'report',
      providerCallId,
      ourCallId: ourCallIdFrom(call),
      endedReason: str(message.endedReason) ?? str(call.endedReason) ?? 'unknown',
      startedAt,
      endedAt,
      durationSec: seconds === null ? null : Math.max(0, Math.round(seconds)),
      messages: messagesOf(artifact, startedAt),
      recordingUrl: str(artifact.recordingUrl) ?? str(rec(recording.mono).combinedUrl) ?? str(recording.url),
      stereoRecordingUrl: str(artifact.stereoRecordingUrl) ?? str(recording.stereoUrl),
      metrics: metricsOf(artifact),
      costUsd: num(message.cost) ?? num(call.cost)
    };
  }

  return { kind: 'ignored', type };
}
