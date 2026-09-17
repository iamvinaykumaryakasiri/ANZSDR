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
 */

import { z } from 'zod';

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable().default(''),
  name: z.string().optional(),
  tool_call_id: z.string().optional()
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().default(false),
  /**
   * Vapi puts the call id here on every request. It is how a turn is tied to a
   * call, a briefing pack and a transcript - without it the endpoint has no way
   * to know who is on the phone.
   */
  call: z.object({ id: z.string() }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

export interface StreamChoiceDelta {
  role?: 'assistant';
  content?: string;
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
    if (message?.role === 'user') return message.content ?? '';
  }
  return '';
}
