/**
 * `config/voice.yaml`, validated.
 *
 * Every field has a default, so a missing file is a working configuration and
 * not a startup failure. What the file cannot do is as important as what it can:
 * it has no field for the opening, for a number to dial, or for the recording
 * announcement. Those are code, and this schema is not a way round that.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const voiceConfigSchema = z.object({
  provider: z.enum(['vapi', 'retell']).default('vapi'),
  assistant: z.object({ name: z.string().min(1).default('Lexi (ANZ Voice SDR)') }).default({}),
  voice: z
    .object({
      provider: z.string().min(1).default('azure'),
      voice_id: z.string().min(1).default('en-AU-NatashaNeural')
    })
    .default({}),
  transcriber: z
    .object({
      provider: z.string().min(1).default('deepgram'),
      model: z.string().min(1).default('nova-3'),
      language: z.string().min(1).default('en-AU')
    })
    .default({}),
  limits: z
    .object({
      max_call_seconds: z.number().int().min(30).max(900).default(240),
      silence_timeout_seconds: z.number().int().min(5).max(120).default(20),
      ring_timeout_seconds: z.number().int().min(20).max(300).default(90),
      report_grace_seconds: z.number().int().min(30).max(1800).default(180),
      close_grace_ms: z.number().int().min(1000).max(60_000).default(10_000)
    })
    .default({}),
  barge_in: z
    .object({
      num_words: z.number().min(0).default(0),
      voice_seconds: z.number().min(0).default(0.2),
      backoff_seconds: z.number().min(0).default(1),
      wait_seconds: z.number().min(0).max(3).default(0.5)
    })
    .default({}),
  recording: z.object({ format: z.enum(['wav;l16', 'mp3']).default('mp3') }).default({}),
  latency: z.object({ target_ms: z.number().int().positive().default(800) }).default({}),
  assistant_extra: z.record(z.string(), z.unknown()).default({})
});

export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

export function loadVoiceConfigFromObject(raw: unknown): VoiceConfig {
  return voiceConfigSchema.parse(raw ?? {});
}

export function loadVoiceConfig(path: string): VoiceConfig {
  if (!existsSync(path)) return loadVoiceConfigFromObject({});
  return loadVoiceConfigFromObject(parseYaml(readFileSync(path, 'utf8')) as unknown);
}
