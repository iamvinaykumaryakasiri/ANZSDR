/**
 * Scout's model, behind a seam.
 *
 * Scout makes one kind of model call: given the evidence it retrieved, write the
 * dossier as JSON. This interface is that call and nothing more, which is what
 * lets the whole of Scout - including everything that decides what survives -
 * be tested against a scripted model with no key and no network.
 *
 * Which model is `config/models.yaml`, not source.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { REPO_ROOT } from '../../config/env.js';

export interface SynthesisRequest {
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface SynthesisResponse {
  /** The model's reply, expected to be one JSON object. */
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** What the call cost, from the price table. */
  usd: number;
}

export interface ScoutModel {
  synthesize(request: SynthesisRequest): Promise<SynthesisResponse>;
}

export const scoutModelConfigSchema = z.object({
  scout: z.string().min(1),
  scout_search: z.string().min(1),
  prices_usd_per_mtok: z.record(z.tuple([z.number(), z.number()])).default({})
});
export type ScoutModelConfig = z.infer<typeof scoutModelConfigSchema>;

export function loadScoutModelConfig(path: string = resolve(REPO_ROOT, 'config/models.yaml')): ScoutModelConfig {
  const raw = existsSync(path) ? ((parseYaml(readFileSync(path, 'utf8')) ?? {}) as unknown) : {};
  return scoutModelConfigSchema.parse(raw);
}

/** A model missing from the table is priced at the dearest entry, so a budget fails safe. */
export function priceCall(
  config: Pick<ScoutModelConfig, 'prices_usd_per_mtok'>,
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const table = Object.values(config.prices_usd_per_mtok);
  const fallback: [number, number] = table.length === 0 ? [15, 75] : [Math.max(...table.map((p) => p[0])), Math.max(...table.map((p) => p[1]))];
  const [inRate, outRate] = config.prices_usd_per_mtok[model] ?? fallback;
  return Number(((tokensIn * inRate + tokensOut * outRate) / 1_000_000).toFixed(6));
}

export interface ClaudeScoutOptions {
  client: Pick<Anthropic, 'messages'>;
  config: ScoutModelConfig;
}

export function claudeScoutModel(options: ClaudeScoutOptions): ScoutModel {
  const model = options.config.scout;
  return {
    async synthesize(request: SynthesisRequest): Promise<SynthesisResponse> {
      const response = await options.client.messages.create(
        {
          model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }]
        },
        request.signal === undefined ? undefined : { signal: request.signal }
      );
      if (response.stop_reason === 'refusal') {
        throw new Error(`the model declined to write this dossier (${response.stop_details?.category ?? 'no category given'})`);
      }
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const tokensIn = response.usage.input_tokens;
      const tokensOut = response.usage.output_tokens;
      return { text, tokensIn, tokensOut, usd: priceCall(options.config, model, tokensIn, tokensOut) };
    }
  };
}

/** Pull the first JSON object out of a reply, tolerating a code fence around it. */
export function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced !== null ? (fenced[1] as string) : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}
