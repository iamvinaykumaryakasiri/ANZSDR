/**
 * The endpoint as the voice provider uses it: the opening before anyone speaks,
 * our own call id in the metadata, a prospect talking over Lexi, a turn that
 * closes the call, an objection to being recorded.
 *
 * (The shape on the wire, the door, and Guardian's three layers are covered in
 * endpoint.test.ts and the phase 4 scenarios; this file is what phase 5 adds.)
 */

import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOpening, renderOpening } from '../../src/agents/caller/opening.js';
import type { CallerModel, ModelToolCall, TurnRequest } from '../../src/agents/caller/brain.js';
import type { CheckModel } from '../../src/agents/guardian/check.js';
import { StreamFilter } from '../../src/agents/guardian/stream-filter.js';
import type { CallJournal, TurnMeta } from '../../src/voice/call-journal.js';
import {
  NO_BRIEFING,
  OPENING_SPOKEN_NOTE,
  closingCall,
  prepareHistory,
  registerVoiceEndpoint,
  type EndpointDeps
} from '../../src/voice/endpoint.js';
import { callRefFrom, chatCompletionRequestSchema } from '../../src/voice/openai-shape.js';
import { IDENTITY, frames, spoken } from './support.js';

const SECRET = 'provider-shared-secret-0123456789';
const auth = { authorization: `Bearer ${SECRET}` };
const OPENING = renderOpening(buildOpening({ identity: IDENTITY, reason: 'I wanted to ask you one question about how your data platform is set up.' }));

let apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps) await app.close();
  apps = [];
});

class MemoryJournal implements CallJournal {
  readonly prospect: string[] = [];
  readonly lexi: Array<{ text: string; meta: TurnMeta }> = [];
  readonly tools: Array<{ name: string; value: unknown }> = [];
  readonly defects: Array<{ kind: string; detail: string }> = [];
  async prospectTurn(_c: string, text: string) {
    this.prospect.push(text);
  }
  async lexiTurn(_c: string, text: string, meta: TurnMeta) {
    this.lexi.push({ text, meta });
  }
  async tool(_c: string, name: string, value: unknown) {
    this.tools.push({ name, value });
  }
  async defect(_c: string, kind: string, detail: string) {
    this.defects.push({ kind, detail });
  }
}

interface Scripted extends CallerModel {
  requests: TurnRequest[];
}

function scripted(text: string, toolCalls: ModelToolCall[] = []): Scripted {
  const requests: TurnRequest[] = [];
  return {
    requests,
    async *stream(request: TurnRequest) {
      requests.push(request);
      for (let i = 0; i < text.length; i += 8) yield text.slice(i, i + 8);
    },
    toolCalls: () => toolCalls
  };
}

const neverCalled: CallerModel = {
  async *stream() {
    throw new Error('the model must not be asked');
  }
};
const safe: CheckModel = { judge: async () => ({ verdict: 'safe' }) };

function server(deps: Partial<EndpointDeps> & { caller: CallerModel }): { app: FastifyInstance; journal: MemoryJournal } {
  const app = Fastify({ logger: false });
  const journal = new MemoryJournal();
  registerVoiceEndpoint(app, {
    check: safe,
    briefingFor: async () => 'BRIEFING',
    assertableClaims: () => [],
    sharedSecret: SECRET,
    journal,
    ...deps
  });
  apps.push(app);
  return { app, journal };
}

const post = (app: FastifyInstance, payload: Record<string, unknown>, url = '/v1/chat/completions') =>
  app.inject({ method: 'POST', url, headers: auth, payload: { stream: true, ...payload } });

const sys = { role: 'system', content: 'placeholder' };

describe('the first request, before anyone has spoken', () => {
  it('is answered with the frozen opening, word for word, without a model', async () => {
    const opened: string[] = [];
    const { app, journal } = server({
      caller: neverCalled,
      openingFor: async () => OPENING,
      onOpeningServed: (id) => opened.push(id)
    });

    const response = await post(app, { call: { id: 'p1' }, metadata: { callId: 'ours-1' }, messages: [sys] });
    expect(spoken(response.body)).toBe(OPENING);
    expect(response.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(opened).toEqual(['ours-1']);
    expect(journal.lexi).toEqual([{ text: OPENING, meta: expect.objectContaining({ opening: true, deterministic: 'opening' }) }]);
  });

  it('says it is an AI, says it is recorded, and clears layer one untouched', () => {
    expect(OPENING).toMatch(/I'm an AI assistant, not a person/);
    expect(OPENING).toMatch(/recorded/);
    const filter = new StreamFilter();
    const step = filter.push(OPENING);
    const end = filter.end();
    expect(step.breach).toBeUndefined();
    expect(end.breach).toBeUndefined();
    expect(step.emit + end.emit).toBe(OPENING);
  });

  it('says nothing when asked again with only Lexi\'s own words in the conversation', async () => {
    const { app, journal } = server({ caller: neverCalled, openingFor: async () => OPENING });
    const response = await post(app, {
      call: { id: 'p1' },
      messages: [sys, { role: 'assistant', content: OPENING }]
    });
    expect(spoken(response.body)).toBe('');
    expect(journal.lexi).toEqual([]);
  });

  it('closes politely if the opening cannot be built', async () => {
    const { app } = server({ caller: neverCalled, openingFor: async () => null });
    const response = await post(app, { call: { id: 'p1' }, messages: [sys] });
    expect(spoken(response.body)).toBe(NO_BRIEFING);
  });
});

describe('the turns after it', () => {
  it('tells the model the opening has been said, and shows it the call as it was', async () => {
    const caller = scripted('Thanks. Have you got a minute?');
    const { app, journal } = server({ caller, openingFor: async () => OPENING });

    const response = await post(app, {
      call: { id: 'p1' },
      messages: [sys, { role: 'assistant', content: OPENING }, { role: 'user', content: 'Yes, go on.' }]
    });
    expect(spoken(response.body)).toContain('Thanks.');

    const request = caller.requests[0] as TurnRequest;
    expect(request.system).toBe('BRIEFING' + OPENING_SPOKEN_NOTE);
    // A conversation starts with the other party; the connected line stands in for it.
    expect(request.history.map((h) => h.role)).toEqual(['user', 'assistant', 'user']);
    expect(request.history[0]?.content).toBe('[The call has just connected.]');
    expect(journal.prospect).toEqual(['Yes, go on.']);
  });

  it('leaves the briefing alone when the endpoint is not serving the opening', async () => {
    const caller = scripted('Hello.');
    const { app } = server({ caller });
    await post(app, { call: { id: 'p1' }, messages: [{ role: 'user', content: 'hi' }] });
    expect(caller.requests[0]?.system).toBe('BRIEFING');
  });
});

describe('knowing which call this is', () => {
  const messages = [{ role: 'user', content: 'hello' }];

  it('prefers our own id from the metadata to the provider\'s', async () => {
    const seen: string[] = [];
    const { app } = server({ caller: scripted('Hi.'), briefingFor: async (id) => (seen.push(id), 'B') });
    await post(app, { call: { id: 'provider-id' }, metadata: { callId: 'our-id' }, messages });
    await post(app, { call: { id: 'provider-id' }, messages });
    expect(seen).toEqual(['our-id', 'provider-id']);
  });

  it('finds it wherever the provider put it', () => {
    const parse = (body: Record<string, unknown>) => callRefFrom(chatCompletionRequestSchema.parse({ messages: [{ role: 'user', content: 'x' }], ...body }));
    expect(parse({ metadata: { callId: 'a' } }).callId).toBe('a');
    expect(parse({ call: { id: 'p', metadata: { callId: 'b' } } }).callId).toBe('b');
    expect(parse({ call: { id: 'p', assistantOverrides: { metadata: { callId: 'c' } } } }).callId).toBe('c');
    expect(parse({ callId: 'd' }).callId).toBe('d');
    expect(parse({ call: { id: 'p' } })).toEqual({ callId: null, providerCallId: 'p' });
    // An absurd id is not an id.
    expect(parse({ metadata: { callId: 'x'.repeat(200) } }).callId).toBeNull();
  });

  it('says nothing useful, politely, for a call it does not know', async () => {
    const { app, journal } = server({ caller: neverCalled, resolveCallId: async () => null });
    const defects: string[] = [];
    const response = await post(app, { call: { id: 'stranger' }, messages });
    expect(spoken(response.body)).toBe(NO_BRIEFING);
    expect(defects).toEqual([]);
    expect(journal.lexi).toEqual([]);
  });

  it('asks for the briefing under the id it resolved', async () => {
    const seen: string[] = [];
    const { app } = server({
      caller: scripted('Hi.'),
      resolveCallId: async (key) => (key === 'provider-id' ? 'ours-resolved' : null),
      briefingFor: async (id) => (seen.push(id), 'B')
    });
    await post(app, { call: { id: 'provider-id' }, messages });
    expect(seen).toEqual(['ours-resolved']);
  });
});

describe('accepting what the provider actually sends', () => {
  it('copes with list-form content, a null assistant message, extra roles and extra fields', async () => {
    const caller = scripted('Right.');
    const { app } = server({ caller });
    const response = await post(app, {
      model: 'anz-voice-sdr',
      temperature: 0.7,
      tools: [{ type: 'function', function: { name: 'endCall' } }],
      customer: { number: '+61400000000' },
      phoneNumber: { id: 'pn' },
      call: { id: 'p1', type: 'outboundPhoneCall', monitor: { controlUrl: 'x' } },
      messages: [
        { role: 'system', content: 'ignored' },
        { role: 'developer', content: 'ignored too' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'endCall', arguments: '{}' } }] },
        { role: 'tool', content: 'ok', tool_call_id: 't' },
        { role: 'user', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }] }
      ]
    });
    expect(response.statusCode).toBe(200);
    expect(caller.requests[0]?.history.at(-1)).toEqual({ role: 'user', content: 'Hello there' });
  });

  it('answers on the path without the /v1 prefix too, behind the same secret', async () => {
    const { app } = server({ caller: scripted('Hi.') });
    const messages = [{ role: 'user', content: 'hi' }];
    expect((await post(app, { messages }, '/chat/completions')).statusCode).toBe(200);
    const open = await app.inject({ method: 'POST', url: '/chat/completions', payload: { messages } });
    expect(open.statusCode).toBe(401);
  });

  it('prepares history: speech only, in order, starting with the other party', () => {
    const history = prepareHistory([
      { role: 'system', content: 's' },
      { role: 'assistant', content: 'Opening.' },
      { role: 'assistant', content: '   ' },
      { role: 'tool', content: 'result' },
      { role: 'user', content: 'Yes?' }
    ]);
    expect(history).toEqual([
      { role: 'user', content: '[The call has just connected.]' },
      { role: 'assistant', content: 'Opening.' },
      { role: 'user', content: 'Yes?' }
    ]);
    expect(prepareHistory([{ role: 'user', content: 'Hi' }])).toEqual([{ role: 'user', content: 'Hi' }]);
  });
});

describe('a prospect who objects to being recorded', () => {
  it('gets the deterministic reply, not a model\'s, and the call is closed', async () => {
    const closed: string[] = [];
    const { app, journal } = server({
      caller: neverCalled,
      hangUpOnClose: true,
      onRecordingObjection: async () => ({ line: 'Understood. I will end the call here.', endCall: true }),
      onClose: (_id, why) => closed.push(why)
    });

    const response = await post(app, { call: { id: 'p1' }, messages: [sys, { role: 'user', content: "I don't want to be recorded." }] });
    expect(spoken(response.body)).toBe('Understood. I will end the call here.');
    const last = frames(response.body).at(-1);
    expect(last?.choices[0]?.finish_reason).toBe('tool_calls');
    expect(JSON.stringify(frames(response.body))).toContain('endCall');
    expect(closed).toEqual(['the prospect objected to being recorded']);
    expect(journal.lexi[0]?.meta.deterministic).toBe('recording-objection');
  });

  it('carries on, without hanging up, when the recording could be stopped', async () => {
    const { app } = server({
      caller: neverCalled,
      hangUpOnClose: true,
      onRecordingObjection: async () => ({ line: "I've stopped the recording, as you asked.", endCall: false })
    });
    const response = await post(app, { call: { id: 'p1' }, messages: [sys, { role: 'user', content: 'Please stop recording.' }] });
    expect(spoken(response.body)).toContain('stopped the recording');
    expect(frames(response.body).at(-1)?.choices[0]?.finish_reason).toBe('stop');
  });

  it('is not triggered by a question about recording, which Lexi answers', async () => {
    const caller = scripted('Yes, the call is being recorded, as I mentioned.');
    const { app } = server({ caller, onRecordingObjection: async () => ({ line: 'x', endCall: true }) });
    const response = await post(app, { call: { id: 'p1' }, messages: [sys, { role: 'user', content: 'Are you recording this?' }] });
    expect(caller.requests).toHaveLength(1);
    expect(spoken(response.body)).toContain('being recorded');
  });
});

describe('a turn that closes the call', () => {
  const escalate: ModelToolCall = { name: 'escalate', args: { reason: 'hostility', saidAs: 'Stop ringing me!', closedPolitely: true } };
  const suppress: ModelToolCall = { name: 'suppress_contact', args: { reason: 'asked-not-to-be-called', saidAs: 'Take me off your list.' } };
  const mark: ModelToolCall = { name: 'mark_outcome', args: { outcome: 'not_interested', note: '' } };

  it('records its tools, asks the provider to hang up, and tells the caller', async () => {
    const closed: string[] = [];
    const { app, journal } = server({
      caller: scripted('Of course, I will take you off. Sorry for the interruption.', [suppress]),
      hangUpOnClose: true,
      onClose: (_id, why) => closed.push(why)
    });
    const response = await post(app, { call: { id: 'p1' }, messages: [sys, { role: 'user', content: 'Take me off your list.' }] });

    expect(journal.tools.map((t) => t.name)).toEqual(['suppress_contact']);
    expect(frames(response.body).at(-1)?.choices[0]?.finish_reason).toBe('tool_calls');
    expect(JSON.stringify(frames(response.body))).toContain('"name":"endCall"');
    expect(closed).toHaveLength(1);
  });

  it('closes on an escalation Lexi has already closed, not on one she has not', () => {
    expect(closingCall([{ name: 'escalate', value: { ...escalate.args as object, closedPolitely: true } }])).not.toBeNull();
    expect(closingCall([{ name: 'escalate', value: { ...escalate.args as object, closedPolitely: false } }])).toBeNull();
    expect(closingCall([{ name: 'suppress_contact', value: suppress.args }])).not.toBeNull();
    expect(closingCall([{ name: 'mark_outcome', value: mark.args }])).toBeNull();
  });

  it('does not hang up for a mere outcome mark: the prospect may have a last word', async () => {
    const { app, journal } = server({ caller: scripted('No problem, thanks for your time.', [mark]), hangUpOnClose: true });
    const response = await post(app, { call: { id: 'p1' }, messages: [sys, { role: 'user', content: 'Not interested.' }] });
    expect(journal.tools.map((t) => t.name)).toEqual(['mark_outcome']);
    expect(frames(response.body).at(-1)?.choices[0]?.finish_reason).toBe('stop');
  });

  it('does not ask the provider to hang up unless told it may', async () => {
    const { app } = server({ caller: scripted('Sorry about that.', [suppress]) });
    const response = await post(app, { call: { id: 'p1' }, messages: [sys, { role: 'user', content: 'Stop calling.' }] });
    expect(JSON.stringify(frames(response.body))).not.toContain('endCall');
  });

  it('drops a malformed tool call as a defect and still speaks', async () => {
    const { app, journal } = server({ caller: scripted('Okay.', [{ name: 'capture_email', args: { email: 'not-an-email' } }]) });
    const response = await post(app, { call: { id: 'p1' }, messages: [sys, { role: 'user', content: 'My email is whatever' }] });
    expect(spoken(response.body)).toBe('Okay.');
    expect(journal.tools).toEqual([]);
    expect(journal.defects.map((d) => d.kind)).toContain('bad-tool-call');
  });
});

describe('when Guardian replaces a turn', () => {
  it('discards the tool calls that came with the draft, except the careful ones', async () => {
    const unsafe: CheckModel = { judge: async () => ({ verdict: 'unsafe', reason: 'evasive', replacement: "I'm an AI assistant — happy to say so." }) };
    const { app, journal } = server({
      caller: scripted('What makes you ask that?', [
        { name: 'capture_email', args: { email: 'priya@example.com', confidence: 'heard-once' } },
        { name: 'mark_outcome', args: { outcome: 'meeting_requested', note: '' } },
        { name: 'suppress_contact', args: { reason: 'asked-not-to-be-called', saidAs: 'Stop.' } }
      ]),
      check: unsafe
    });
    const response = await post(app, { call: { id: 'p1' }, messages: [sys, { role: 'user', content: 'Are you a real person?' }] });

    expect(spoken(response.body)).toContain("I'm an AI assistant");
    expect(journal.tools.map((t) => t.name)).toEqual(['suppress_contact']);
    expect(journal.defects.map((d) => d.kind)).toContain('guardian-override');
    expect(journal.defects.find((d) => d.kind === 'tool-discarded')?.detail).toContain('capture_email, mark_outcome');
  });

  it('classes an unavailable Guardian as operational, not as a script defect', async () => {
    const down: CheckModel = {
      judge: async () => {
        throw new Error('timed out');
      }
    };
    const { app, journal } = server({ caller: scripted('What makes you ask that?'), check: down });
    await post(app, { call: { id: 'p1' }, messages: [sys, { role: 'user', content: 'Are you a real person?' }] });
    expect(journal.defects.map((d) => d.kind)).toContain('guardian-unavailable');
    expect(journal.defects.map((d) => d.kind)).not.toContain('guardian-override');
  });
});

describe('a prospect who talks over Lexi', () => {
  it('stops the turn, and what it asked for does not count', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let producedAfterAbort = 0;

    const caller: CallerModel = {
      async *stream() {
        yield 'Thanks for taking the call. ';
        await gate;
        producedAfterAbort += 1;
        yield 'I wanted to ask about your data platform. ';
        producedAfterAbort += 1;
        yield 'Would twenty minutes with Vinay suit you?';
      },
      toolCalls: () => [{ name: 'mark_outcome', args: { outcome: 'meeting_requested', note: '' } }]
    };

    const { app, journal } = server({ caller });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    // A real client that hangs up after the first spoken sentence, as the
    // provider does when the prospect speaks.
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { ...auth, 'content-type': 'application/json' } },
        (res) => {
          res.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('Thanks for taking the call')) {
              req.destroy();
              resolve();
            }
          });
          res.on('error', () => {});
        }
      );
      req.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
      });
      req.end(JSON.stringify({ stream: true, call: { id: 'p1' }, messages: [sys, { role: 'user', content: 'Hello?' }] }));
    });

    // Let the server see the hang-up, then let the model carry on if it is going to.
    await new Promise((r) => setTimeout(r, 50));
    release();
    for (let i = 0; i < 100 && journal.lexi.length === 0; i++) await new Promise((r) => setTimeout(r, 20));

    expect(journal.lexi).toHaveLength(1);
    expect(journal.lexi[0]?.meta.interrupted).toBe(true);
    // Only the sentence that went out is on the record.
    expect(journal.lexi[0]?.text).toBe('Thanks for taking the call.');
    expect(producedAfterAbort).toBeLessThanOrEqual(1);
    // The outcome mark belonged to words nobody heard.
    expect(journal.tools).toEqual([]);
  });
});

describe('how long a turn takes', () => {
  it('records time to first words, and time to the end', async () => {
    let t = 1000;
    const caller: CallerModel = {
      async *stream() {
        t += 250;
        yield 'Good question. ';
        t += 100;
        yield 'Let me think about that.';
      },
      toolCalls: () => []
    };
    const { app, journal } = server({ caller, clock: () => t });
    await post(app, { call: { id: 'p1' }, messages: [sys, { role: 'user', content: 'Hello?' }] });

    expect(journal.lexi[0]?.meta).toMatchObject({ firstTokenMs: 250, totalMs: 350, interrupted: false });
  });

  it('counts a held turn from request to reply, since nothing is spoken before Guardian has ruled', async () => {
    let t = 0;
    const slow: CheckModel = {
      judge: async () => {
        t += 600;
        return { verdict: 'safe' };
      }
    };
    const caller: CallerModel = {
      async *stream() {
        t += 200;
        yield 'I am an AI assistant.';
      },
      toolCalls: () => []
    };
    const { app, journal } = server({ caller, check: slow, clock: () => t });
    await post(app, { call: { id: 'p1' }, messages: [sys, { role: 'user', content: 'Are you a real person?' }] });

    expect(journal.lexi[0]?.meta).toMatchObject({ held: true, firstTokenMs: 800, totalMs: 800 });
  });
});
