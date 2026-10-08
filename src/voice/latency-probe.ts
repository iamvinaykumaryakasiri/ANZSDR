/**
 * Measure the brain's response time without a phone.
 *
 * Drives the real endpoint (the same route, the same Guardian layers, the same
 * stream filter) in-process with a scripted prospect, and records how long each
 * turn took to its first speakable words. With a real model behind it that is the
 * brain's contribution to perceived latency, to within a network hop: useful for
 * choosing a model and tuning the prompt before spending a minute of call time.
 *
 * It measures first-token latency only. The rest of what a prospect waits for
 * (end-of-speech detection, speech-to-text, text-to-speech) belongs to the
 * provider and shows up in the report from a real call.
 */

import Fastify from 'fastify';
import type { CallerModel } from '../agents/caller/brain.js';
import type { CheckModel } from '../agents/guardian/check.js';
import type { CallJournal, TurnMeta } from './call-journal.js';
import { registerVoiceEndpoint } from './endpoint.js';

/** Includes a turn about the agent's nature, which Guardian holds for layer two. */
export const DEFAULT_PROBE_LINES = [
  'Hello?',
  'Sure, go ahead.',
  "We're partway through a platform rebuild, honestly.",
  'What does Hexaware actually do?',
  'Are you a real person?',
  'Okay. What did you want from me?'
];

export interface ProbeTurn {
  prospectSaid: string;
  reply: string;
  firstTokenMs: number;
  totalMs: number;
  held: boolean;
}

export interface ProbeOptions {
  caller: CallerModel;
  check: CheckModel;
  system: string;
  opening: string;
  lines?: string[];
  clock?: () => number;
}

export async function probeLatency(options: ProbeOptions): Promise<ProbeTurn[]> {
  const secret = 'probe-secret';
  const metas: Array<{ text: string; meta: TurnMeta }> = [];
  const journal: CallJournal = {
    prospectTurn: async () => {},
    lexiTurn: async (_callId, text, meta) => {
      metas.push({ text, meta });
    },
    tool: async () => {},
    defect: async () => {}
  };

  const app = Fastify({ logger: false });
  registerVoiceEndpoint(app, {
    caller: options.caller,
    check: options.check,
    sharedSecret: secret,
    briefingFor: async () => options.system,
    assertableClaims: () => [],
    journal,
    ...(options.clock !== undefined ? { clock: options.clock } : {})
  });

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: 'placeholder' },
    { role: 'assistant', content: options.opening }
  ];
  const turns: ProbeTurn[] = [];

  try {
    for (const line of options.lines ?? DEFAULT_PROBE_LINES) {
      messages.push({ role: 'user', content: line });
      metas.length = 0;
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${secret}` },
        payload: { model: 'probe', stream: true, call: { id: 'probe' }, messages }
      });
      const reply = response.body
        .split('\n')
        .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
        .map((l) => JSON.parse(l.slice(6)) as { choices: Array<{ delta: { content?: string } }> })
        .map((f) => f.choices[0]?.delta.content ?? '')
        .join('');
      const recorded = metas.at(-1);
      turns.push({
        prospectSaid: line,
        reply,
        firstTokenMs: Math.round(recorded?.meta.firstTokenMs ?? 0),
        totalMs: Math.round(recorded?.meta.totalMs ?? 0),
        held: recorded?.meta.held === true
      });
      messages.push({ role: 'assistant', content: reply });
    }
  } finally {
    await app.close();
  }
  return turns;
}
