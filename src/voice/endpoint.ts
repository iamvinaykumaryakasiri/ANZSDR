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
 * turn does not stream at all until layer two has finished with it. Two things
 * are said without a model at all: the frozen opening, and the reply to someone
 * who objects to being recorded. Both are fixed text because both are
 * obligations.
 *
 * What the provider does that shapes this file:
 *
 *   - It asks for the first thing to say before anyone has spoken (the
 *     assistant is configured with a model-generated first message and no
 *     first message of its own). That request has no user turn in it, and the
 *     answer is the opening from `opening.ts`, word for word.
 *   - When the prospect talks over Lexi it drops this connection and, once they
 *     have finished, sends a fresh request. A dropped connection stops the
 *     turn: no further words are written, and the tool calls of a turn the
 *     prospect cut off are not recorded, since the words that went with them
 *     were not heard. The next request carries the conversation as it really
 *     was, and the model decides again.
 *   - It re-sends the whole conversation every time, so nothing here keeps
 *     conversation state between requests.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { runTurn, type CallerModel, type TurnResult } from '../agents/caller/brain.js';
import { checkTurn, type CheckModel } from '../agents/guardian/check.js';
import { triageTurn } from '../agents/guardian/triage.js';
import type { CallJournal } from './call-journal.js';
import { detectRecordingObjection } from './lifecycle.js';
import {
  callRefFrom,
  chatCompletionRequestSchema,
  chunkFrame,
  completionBody,
  DONE_FRAME,
  END_CALL_TOOL,
  latestUserMessage,
  toolCallFrame,
  type ChatMessage
} from './openai-shape.js';

export interface EndpointDeps {
  caller: CallerModel;
  check: CheckModel;
  /** The briefing pack for a live call, by call id. Null when there is none. */
  briefingFor: (callId: string) => Promise<string | null>;
  /** What Lexi may assert, for the layer-two judge. */
  assertableClaims: (callId: string) => string[];
  /** Shared secret the provider sends. The endpoint is public by necessity. */
  sharedSecret: string;
  onDefect?: (callId: string, defect: string) => void;
  model?: string;

  /**
   * Our id for the call, from whatever the provider sent (our id, or its own).
   * Null means a call we do not know, which gets the no-briefing line and
   * nothing else. Defaults to taking the id as given.
   */
  resolveCallId?: (key: string) => Promise<string | null>;
  /**
   * The frozen opening for this call. When set, a request with nobody having
   * spoken yet is answered with it, without a model, and the system prompt is
   * told it has already been said.
   */
  openingFor?: (callId: string) => Promise<string | null>;
  /** Told when the opening has been sent, so "recording was announced" can be recorded. */
  onOpeningServed?: (callId: string) => void;
  /** What happens when the prospect objects to being recorded. Without it, the model is left to cope. */
  onRecordingObjection?: (callId: string) => Promise<{ line: string; endCall: boolean }>;
  /** Everything said and done, as it happens. */
  journal?: CallJournal;
  /**
   * When a turn closes the call (an escalation, a suppression, a recording
   * objection that ends it), ask the provider to hang up with its end-call tool.
   */
  hangUpOnClose?: boolean;
  /** Told when a turn closed the call, so the caller can hang up from its side too. */
  onClose?: (callId: string, why: string) => void;
  /** A monotonic clock in milliseconds. Injected so latency is testable. */
  clock?: () => number;
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
export const NO_BRIEFING =
  "I'm sorry — I don't have the details for this call in front of me, so I won't take up your time. Apologies for the interruption.";

/**
 * Appended to the system prompt when the endpoint has already said the opening.
 * The briefing tells the model to say it, which is right for a text harness and
 * wrong here, where the opening is the first thing in the conversation already.
 */
export const OPENING_SPOKEN_NOTE =
  '\n\nNOTE FROM THE SYSTEM: your opening has already been spoken to the prospect. It is the first thing under your name in this conversation. Do not say it again, and do not repeat the AI disclosure unprompted. Carry on from where the conversation is.';

/** What the model is shown first when the conversation begins with Lexi speaking. */
const CALL_CONNECTED = '[The call has just connected.]';

type HistoryTurn = { role: 'user' | 'assistant'; content: string };

/**
 * The conversation as the model should see it.
 *
 * Only speech: system prompts are ours to supply, and tool plumbing is the
 * provider's. A conversation has to start with the other party, so when Lexi's
 * opening comes first, a line saying the call connected stands in front of it.
 */
export function prepareHistory(messages: ChatMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: CALL_CONNECTED });
  return turns;
}

/**
 * A Guardian layer-two defect, classified. An override is a finding about what
 * Lexi was about to say; the others are about Guardian itself being unavailable,
 * which is an operational matter and not a defect in the script.
 */
function guardianDefect(detail: string): { kind: string; detail: string } {
  return { kind: detail.startsWith('guardian overrode') ? 'guardian-override' : 'guardian-unavailable', detail };
}

/** Wrap a model so that it stops the moment the prospect has talked over it. */
function abortable(model: CallerModel, aborted: () => boolean): CallerModel {
  return {
    async *stream(request) {
      for await (const chunk of model.stream(request)) {
        if (aborted()) return;
        yield chunk;
      }
    },
    // A turn that was cut off did not finish, so nothing it asked for happened.
    toolCalls: () => (aborted() ? [] : (model.toolCalls?.() ?? []))
  };
}

/** The tool calls that end a call: an escalation Lexi has already closed, or a suppression. */
export function closingCall(toolCalls: TurnResult['toolCalls']): string | null {
  for (const call of toolCalls) {
    if (call.name === 'suppress_contact') return 'the prospect asked not to be called again';
    if (call.name === 'escalate' && (call.value as { closedPolitely?: boolean }).closedPolitely === true) {
      return 'the call was escalated and Lexi has closed it';
    }
  }
  return null;
}

/**
 * When Guardian replaced a turn, the tool calls that came with the draft are
 * suspect: the words they belonged to were never spoken. Only the ones that
 * make the system more careful survive - a suppression or an escalation can
 * never be the wrong thing to have recorded.
 */
function survivingToolCalls(turn: TurnResult, overridden: boolean): { kept: TurnResult['toolCalls']; dropped: string[] } {
  if (!overridden) return { kept: turn.toolCalls, dropped: [] };
  const kept = turn.toolCalls.filter((c) => c.name === 'suppress_contact' || c.name === 'escalate');
  const dropped = turn.toolCalls.filter((c) => !kept.includes(c)).map((c) => c.name);
  return { kept, dropped };
}

export function registerVoiceEndpoint(app: FastifyInstance, deps: EndpointDeps): void {
  const modelName = deps.model ?? 'anz-voice-sdr';
  const clock = deps.clock ?? (() => performance.now());

  const record = async (work: Promise<void> | undefined): Promise<void> => {
    if (work !== undefined) await work;
  };

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const began = clock();

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
    const ref = callRefFrom(body);
    const key = ref.callId ?? ref.providerCallId ?? 'unknown';
    const callId = deps.resolveCallId === undefined ? key : await deps.resolveCallId(key);
    const id = `chatcmpl-${randomUUID()}`;
    const prospectSaid = latestUserMessage(body.messages);
    const streaming = body.stream;

    const respond = (text: string, endCall = false): FastifyReply =>
      streaming ? sendStream(reply, id, modelName, [text], endCall && deps.hangUpOnClose === true) : reply.send(completionBody(id, modelName, text));

    const briefing = callId === null ? null : await deps.briefingFor(callId);
    if (callId === null || briefing === null) {
      deps.onDefect?.(callId ?? key, 'a call arrived with no briefing pack, so Lexi said nothing and closed');
      if (callId !== null) await record(deps.journal?.defect(callId, 'no-briefing', 'a call arrived with no briefing pack'));
      return respond(NO_BRIEFING);
    }

    const history = prepareHistory(body.messages);
    const journal = deps.journal;

    // 1. Nobody has said anything yet: this is the request for the first words.
    if (history.length === 0 && deps.openingFor !== undefined) {
      const opening = await deps.openingFor(callId);
      if (opening === null) {
        deps.onDefect?.(callId, 'the opening could not be built, so Lexi said nothing and closed');
        await record(journal?.defect(callId, 'no-briefing', 'the opening could not be built'));
        return respond(NO_BRIEFING);
      }
      deps.onOpeningServed?.(callId);
      await record(journal?.lexiTurn(callId, opening, { opening: true, deterministic: 'opening', totalMs: clock() - began }));
      return respond(opening);
    }

    // Nothing from the prospect to answer (a duplicate request, or the provider
    // asking again after a dropped connection). Silence is the correct reply.
    if (history.at(-1)?.role !== 'user') return respond('');

    await record(journal?.prospectTurn(callId, prospectSaid));

    // 2. They have objected to being recorded. Section 7.4: stop recording and
    // continue, or end the call; never carry on covertly. Not a model's call.
    if (deps.onRecordingObjection !== undefined && detectRecordingObjection(prospectSaid)) {
      const objection = await deps.onRecordingObjection(callId);
      await record(journal?.lexiTurn(callId, objection.line, { deterministic: 'recording-objection', totalMs: clock() - began }));
      if (objection.endCall) deps.onClose?.(callId, 'the prospect objected to being recorded');
      return respond(objection.line, objection.endCall);
    }

    const system = deps.openingFor === undefined ? briefing : briefing + OPENING_SPOKEN_NOTE;

    // A held turn cannot stream: layer two has to finish before a word of it is
    // spoken. Everything else streams, and layer one gates each sentence.
    const held = triageTurn({ prospectSaid, draftReply: '' }).level === 'hold';

    let aborted = false;
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) aborted = true;
    });
    const model = abortable(deps.caller, () => aborted);

    const noteDefects = async (defects: Array<{ kind: string; detail: string }>): Promise<void> => {
      for (const defect of defects) {
        deps.onDefect?.(callId, defect.detail);
        await record(journal?.defect(callId, defect.kind, defect.detail));
      }
    };
    const noteToolCalls = async (turn: TurnResult, overridden: boolean): Promise<TurnResult['toolCalls']> => {
      const { kept, dropped } = survivingToolCalls(turn, overridden);
      for (const call of kept) await record(journal?.tool(callId, call.name, call.value));
      if (dropped.length > 0) {
        await noteDefects([
          { kind: 'tool-discarded', detail: `Guardian replaced the turn, so these tool calls were discarded with it: ${dropped.join(', ')}` }
        ]);
      }
      return kept;
    };

    // 3. A held turn, or a request that did not ask for a stream.
    if (held || !streaming) {
      const turn = await runTurn({ model, system, history, prospectSaid });
      await noteDefects(turn.defects);

      const checked = await checkTurn({
        model: deps.check,
        prospectSaid,
        draftReply: turn.spoken,
        assertableClaims: deps.assertableClaims(callId)
      });
      await noteDefects(checked.defects.map(guardianDefect));

      if (aborted) {
        await record(journal?.lexiTurn(callId, '', { held, interrupted: true }));
        return reply;
      }

      const kept = await noteToolCalls(turn, checked.overridden);
      const closes = closingCall(kept);
      const took = clock() - began;
      await record(journal?.lexiTurn(callId, checked.reply, { held, firstTokenMs: took, totalMs: took }));
      if (closes !== null) deps.onClose?.(callId, closes);
      return respond(checked.reply, closes !== null);
    }

    // 4. The common case: stream it, one cleared sentence at a time.
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    const write = (frame: string): void => {
      if (aborted || reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(frame);
    };
    write(chunkFrame(id, modelName, { role: 'assistant' }));

    let sent = '';
    let firstTokenAt: number | null = null;
    const turn = await runTurn({
      model,
      system,
      history,
      prospectSaid,
      onSpeak: (text) => {
        if (aborted) return;
        if (firstTokenAt === null) firstTokenAt = clock();
        sent += text;
        write(chunkFrame(id, modelName, { content: text }));
      }
    });
    const finished = clock();
    const interrupted = aborted;

    // Close the stream first. Bookkeeping must never delay the end of a turn, and
    // least of all the end of a turn that is hanging the call up.
    const kept = interrupted ? [] : survivingToolCalls(turn, false).kept;
    const closes = interrupted ? null : closingCall(kept);
    if (closes !== null && deps.hangUpOnClose === true) {
      write(toolCallFrame(id, modelName, END_CALL_TOOL));
      write(chunkFrame(id, modelName, {}, 'tool_calls'));
    } else {
      write(chunkFrame(id, modelName, {}, 'stop'));
    }
    write(DONE_FRAME);
    if (!reply.raw.writableEnded) reply.raw.end();

    // Layer two runs against what was actually said, alongside the speech. On a
    // streamed turn it produces a defect and a correction next turn rather than
    // prevention - the words are already on their way.
    const review = checkTurn({
      model: deps.check,
      prospectSaid,
      draftReply: turn.spoken,
      assertableClaims: deps.assertableClaims(callId)
    })
      .then((checked) => noteDefects(checked.defects.map(guardianDefect)))
      .catch(() => {});

    await noteDefects(turn.defects);
    for (const call of kept) await record(journal?.tool(callId, call.name, call.value));
    await record(
      journal?.lexiTurn(callId, sent, {
        held: false,
        interrupted,
        firstTokenMs: (firstTokenAt ?? finished) - began,
        totalMs: finished - began
      })
    );
    if (closes !== null) deps.onClose?.(callId, closes);
    await review;
    return reply;
  };

  // The provider appends /chat/completions to the URL it is given. We give it
  // `<host>/v1`, and also answer without the prefix, so a provider that drops it
  // still lands somewhere that checks the secret.
  app.post('/v1/chat/completions', handler);
  app.post('/chat/completions', handler);
}

function sendStream(reply: FastifyReply, id: string, model: string, parts: string[], endCall = false): FastifyReply {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  reply.raw.write(chunkFrame(id, model, { role: 'assistant' }));
  for (const part of parts) if (part !== '') reply.raw.write(chunkFrame(id, model, { content: part }));
  if (endCall) {
    reply.raw.write(toolCallFrame(id, model, END_CALL_TOOL));
    reply.raw.write(chunkFrame(id, model, {}, 'tool_calls'));
  } else {
    reply.raw.write(chunkFrame(id, model, {}, 'stop'));
  }
  reply.raw.write(DONE_FRAME);
  reply.raw.end();
  return reply;
}
