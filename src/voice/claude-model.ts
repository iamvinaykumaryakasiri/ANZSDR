/**
 * Claude, behind the seams Caller and Guardian already use.
 *
 * Everything that decides what Lexi says lives elsewhere and is tested without
 * a network. This module is the one place that knows about the Anthropic SDK,
 * which is why the thirty acceptance scenarios can run on every commit for
 * nothing and this file can stay thin.
 *
 * Model choice is config, not code. The brief's section 4 names
 * `claude-sonnet-4-6` for in-call turns and "a stronger model" for Guardian's
 * audit pass; `config/models.yaml` carries both so a change is one line rather
 * than a hunt through the source.
 */

import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { CallerModel, ModelToolCall, TurnRequest } from '../agents/caller/brain.js';
import type { CheckModel } from '../agents/guardian/check.js';
import type { AuditModel } from '../agents/guardian/audit.js';
import { CALLER_TOOL_SCHEMAS, type CallerToolName } from '../agents/caller/tools.js';

export const modelConfigSchema = z.object({
  /** The in-call brain. Latency matters more here than anywhere else. */
  caller: z.string().min(1),
  /** Guardian's fast check. Runs inside the call, so it must be quick. */
  guardian_check: z.string().min(1),
  /** Guardian's post-call audit. No latency budget, so it gets the good one. */
  guardian_audit: z.string().min(1),
  /** A turn is one or two sentences. A large ceiling here buys nothing. */
  max_turn_tokens: z.number().int().positive()
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export function loadModelConfig(path: string): ModelConfig {
  return modelConfigSchema.parse(parseYaml(readFileSync(path, 'utf8')) as unknown);
}

/** Caller's tools, in the shape the Messages API wants them. */
export function anthropicTools(): Anthropic.Tool[] {
  const described: Record<CallerToolName, string> = {
    capture_email:
      'Record the best email address for this person. Read it back phonetically before calling this.',
    capture_preferred_times:
      'Record two or three windows that suit them, in their own words and as concrete times in their timezone.',
    log_objection: 'Record an objection they raised and how you handled it.',
    mark_outcome: 'Record how the call ended. Call this before the call finishes, always.',
    suppress_contact: 'Record that this person must never be called again. Permanent.',
    escalate: 'Flag this call for Vinay immediately. Close the call politely first.'
  };

  return (Object.keys(CALLER_TOOL_SCHEMAS) as CallerToolName[]).map((name) => ({
    name,
    description: described[name],
    // The zod schema is the contract; this is the shape the model is shown.
    // `validateToolCall` re-validates whatever comes back, so a mismatch here
    // is a rejected call rather than a bad row.
    input_schema: { type: 'object' as const, additionalProperties: false },
    strict: true
  }));
}

export interface ClaudeOptions {
  client: Anthropic;
  config: ModelConfig;
}

/**
 * The in-call brain.
 *
 * Streaming, because the filter releases sentence by sentence and the provider
 * is waiting to speak them. `max_tokens` is deliberately small: a turn here is
 * one or two sentences and section 8 says one question at a time, so a large
 * ceiling would only buy longer wrong answers.
 */
export function claudeCallerModel(options: ClaudeOptions): CallerModel {
  let lastToolCalls: ModelToolCall[] = [];

  return {
    async *stream(request: TurnRequest): AsyncIterable<string> {
      lastToolCalls = [];
      const messages: Anthropic.MessageParam[] = request.history.map((m) => ({
        role: m.role,
        content: m.content
      }));

      const stream = options.client.messages.stream({
        model: options.config.caller,
        max_tokens: options.config.max_turn_tokens,
        system: request.system,
        messages,
        tools: anthropicTools()
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }

      const final = await stream.finalMessage();
      for (const block of final.content) {
        if (block.type === 'tool_use') {
          lastToolCalls.push({ name: block.name, args: block.input });
        }
      }
    },
    toolCalls: () => lastToolCalls
  };
}

/** Pull the first JSON object out of a reply, tolerating a stray fence. */
export function parseJsonReply(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced !== null ? (fenced[1] as string) : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

async function askForJson(
  client: Anthropic,
  model: string,
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await client.messages.create(
    { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
    signal === undefined ? undefined : { signal }
  );
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  return parseJsonReply(text);
}

/** Guardian layer two. Small ceiling: the answer is a verdict and a sentence. */
export function claudeCheckModel(options: ClaudeOptions): CheckModel {
  return {
    judge: (prompt, signal) => askForJson(options.client, options.config.guardian_check, prompt, 512, signal)
  };
}

/** Guardian layer three. No latency budget, so it gets room to read. */
export function claudeAuditModel(options: ClaudeOptions): AuditModel {
  return {
    review: (prompt) => askForJson(options.client, options.config.guardian_audit, prompt, 4096)
  };
}
