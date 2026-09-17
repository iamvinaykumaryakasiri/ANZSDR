/**
 * The custom LLM endpoint.
 *
 * Section 2: the voice provider handles telephony, ASR, TTS and barge-in; we
 * keep the brain, the logging and the safety layer. This is the seam. What
 * arrives is an OpenAI-shaped chat completion request; what leaves is an
 * OpenAI-shaped SSE stream. In between is Claude, our briefing pack, our tools
 * and all three Guardian layers.
 *
 * Nothing reaches the provider that has not been through layer one, and a held
 * turn does not stream at all until layer two has finished with it.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { runTurn, type CallerModel } from '../agents/caller/brain.js';
import { checkTurn, type CheckModel } from '../agents/guardian/check.js';
import { triageTurn } from '../agents/guardian/triage.js';
import {
  chatCompletionRequestSchema,
  chunkFrame,
  completionBody,
  DONE_FRAME,
  latestUserMessage
} from './openai-shape.js';

export interface EndpointDeps {
  caller: CallerModel;
  check: CheckModel;
  /** The briefing pack for a live call, by provider call id. */
  briefingFor: (callId: string) => Promise<string | null>;
  /** What Lexi may assert, for the layer-two judge. */
  assertableClaims: () => string[];
  /** Shared secret the provider sends. The endpoint is public by necessity. */
  sharedSecret: string;
  onDefect?: (callId: string, defect: string) => void;
  model?: string;
}

function secretsMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The line spoken when there is no briefing pack for this call.
 *
 * It happens when a call arrives that the system did not plan - a misrouted
 * number, a stale provider session. Section 3.3 says Caller reads nothing
 * outside its pack, so with no pack there is nothing to say, and saying nothing
 * useful politely is the only honest option.
 */
const NO_BRIEFING =
  "I'm sorry — I don't have the details for this call in front of me, so I won't take up your time. Apologies for the interruption.";

export function registerVoiceEndpoint(app: FastifyInstance, deps: EndpointDeps): void {
  const modelName = deps.model ?? 'anz-voice-sdr';

  app.post('/v1/chat/completions', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!secretsMatch(supplied, deps.sharedSecret)) {
      return reply.code(401).send({ error: { message: 'unauthorised' } });
    }

    const parsed = chatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: 'malformed chat completion request' } });
    }

    const body = parsed.data;
    const callId = body.call?.id ?? 'unknown';
    const id = `chatcmpl-${randomUUID()}`;
    const prospectSaid = latestUserMessage(body.messages);

    const briefing = await deps.briefingFor(callId);
    if (briefing === null) {
      deps.onDefect?.(callId, 'a call arrived with no briefing pack, so Lexi said nothing and closed');
      return body.stream
        ? sendStream(reply, id, modelName, [NO_BRIEFING])
        : reply.send(completionBody(id, modelName, NO_BRIEFING));
    }

    const history = body.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content ?? '' }));

    // A held turn cannot stream: layer two has to finish before a word of it is
    // spoken. Everything else streams, and layer one gates each sentence.
    const held = triageTurn({ prospectSaid, draftReply: '' }).level === 'hold';

    if (held || !body.stream) {
      const turn = await runTurn({ model: deps.caller, system: briefing, history, prospectSaid });
      for (const defect of turn.defects) deps.onDefect?.(callId, defect.detail);

      const checked = await checkTurn({
        model: deps.check,
        prospectSaid,
        draftReply: turn.spoken,
        assertableClaims: deps.assertableClaims()
      });
      for (const defect of checked.defects) deps.onDefect?.(callId, defect);

      return body.stream
        ? sendStream(reply, id, modelName, [checked.reply])
        : reply.send(completionBody(id, modelName, checked.reply));
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    reply.raw.write(chunkFrame(id, modelName, { role: 'assistant' }));

    const turn = await runTurn({
      model: deps.caller,
      system: briefing,
      history,
      prospectSaid,
      onSpeak: (text) => reply.raw.write(chunkFrame(id, modelName, { content: text }))
    });
    for (const defect of turn.defects) deps.onDefect?.(callId, defect.detail);

    // Layer two runs against what was actually said, alongside the speech. On a
    // streamed turn it produces a defect and a correction next turn rather than
    // prevention - the words are already on their way.
    void checkTurn({
      model: deps.check,
      prospectSaid,
      draftReply: turn.spoken,
      assertableClaims: deps.assertableClaims()
    }).then((checked) => {
      for (const defect of checked.defects) deps.onDefect?.(callId, defect);
    });

    reply.raw.write(chunkFrame(id, modelName, {}, 'stop'));
    reply.raw.write(DONE_FRAME);
    reply.raw.end();
    return reply;
  });
}

function sendStream(reply: FastifyReply, id: string, model: string, parts: string[]): FastifyReply {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  reply.raw.write(chunkFrame(id, model, { role: 'assistant' }));
  for (const part of parts) reply.raw.write(chunkFrame(id, model, { content: part }));
  reply.raw.write(chunkFrame(id, model, {}, 'stop'));
  reply.raw.write(DONE_FRAME);
  reply.raw.end();
  return reply;
}
