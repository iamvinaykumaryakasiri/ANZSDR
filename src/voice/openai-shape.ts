/**
 * The wire format the voice provider speaks.
 *
 * Vapi (and Retell) call a "custom LLM" over the OpenAI streaming
 * chat-completions shape. That is the only reason this shape exists here: it is
 * what is on the wire between the provider and us, not what we speak to Claude.
 * Inside the endpoint it is Claude, our prompt, our tools and Guardian - which
 * is the whole point of owning the endpoint (section 2).
 *
 * Keeping the translation in one small module means the provider can be swapped
 * without touching anything that decides what Lexi says.
 *
 * What Vapi actually sends, as far as its public documentation says (it does not
 * publish a sample body, so this is deliberately tolerant rather than exact):
 *   - the OpenAI request fields (`model`, `messages`, `stream`, `tools`, ...);
 *   - with `model.metadataSendMode: "variable"` (the default, and what we set),
 *     the assistant's `metadata` as `metadata`, plus the `call`, `phoneNumber`
 *     and `customer` objects;
 *   - the `messages` list starts with the assistant's system prompt and carries
 *     the whole conversation so far, with tool calls and tool results in OpenAI
 *     form, so `content` can be null and roles beyond user/assistant appear.
 *
 * Anything this module does not recognise it ignores. A provider adding a field
 * must never turn into a 400 on a live call.
 */

import { z } from 'zod';

/** OpenAI allows `content` to be a string or a list of typed parts. Vapi sends strings; be liberal. */
const contentSchema = z
  .union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())])
  .nullish()
  .transform((content): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
    return '';
  });

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  content: contentSchema,
  name: z.string().optional(),
  tool_call_id: z.string().optional()
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(chatMessageSchema).min(1),
    stream: z.boolean().default(false),
    /**
     * Vapi puts its own call object here on every request. `call.id` is the
     * provider's id for the call; it is how a turn is tied to a call when
     * nothing better is available.
     */
    call: z.object({ id: z.string() }).passthrough().optional(),
    /** The assistant's metadata (including per-call overrides): our own call id lives here. */
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough();
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

export interface CallRef {
  /** Our id for the call, which we put in the metadata when we placed it. */
  callId: string | null;
  /** The provider's id for it. */
  providerCallId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function ourId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

/**
 * Which call is this turn part of?
 *
 * Our own id travels in the call metadata, because we choose it and it is the
 * key to everything we hold. The metadata can arrive in three places depending
 * on the provider's send mode and version, so all three are read, in order of
 * how directly we control them. The provider's call id is the fallback.
 */
export function callRefFrom(body: ChatCompletionRequest): CallRef {
  const call = asRecord(body.call);
  const overrides = asRecord(call?.assistantOverrides);
  const candidates = [
    asRecord(body.metadata)?.callId,
    asRecord(call?.metadata)?.callId,
    asRecord(overrides?.metadata)?.callId,
    // `destructured` send mode spreads metadata straight onto the payload.
    (body as Record<string, unknown>).callId
  ];
  const callId = candidates.map(ourId).find((id) => id !== null) ?? null;
  return { callId, providerCallId: ourId(call?.id) };
}

export interface StreamChoiceDelta {
  role?: 'assistant';
  content?: string;
  tool_calls?: Array<{ index: number; id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

/** One `data:` frame of an OpenAI-shaped SSE stream. */
export function chunkFrame(
  id: string,
  model: string,
  delta: StreamChoiceDelta,
  finishReason: string | null = null
): string {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * The name of the provider's built-in hang-up tool. Vapi exposes it as
 * `endCall` when `{ type: "endCall" }` is in the assistant's `model.tools`; a
 * custom LLM asks for it by returning a tool call of that name.
 */
export const END_CALL_TOOL = 'endCall';

/** A single OpenAI-shaped tool call, delivered whole in one delta. */
export function toolCallFrame(id: string, model: string, name: string, args: unknown = {}): string {
  return chunkFrame(id, model, {
    tool_calls: [
      { index: 0, id: `call_${id.slice(-12)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
    ]
  });
}

/** The sentinel that ends an OpenAI SSE stream. Providers wait for it. */
export const DONE_FRAME = 'data: [DONE]\n\n';

/** The non-streaming shape, used by the text harness and for debugging. */
export function completionBody(id: string, model: string, content: string): unknown {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
  };
}

/** The last thing the prospect said, which is what Guardian screens for injection. */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user') return message.content;
  }
  return '';
}
