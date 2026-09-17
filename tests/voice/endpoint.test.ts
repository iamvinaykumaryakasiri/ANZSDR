/**
 * The custom LLM endpoint.
 *
 * The provider is on the other side of this, so the things worth asserting are
 * that it speaks the shape the provider expects, that it is not reachable
 * without the shared secret, and that nothing reaches the wire which has not
 * been through Guardian.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerVoiceEndpoint } from '../../src/voice/endpoint.js';
import type { CallerModel } from '../../src/agents/caller/brain.js';
import type { CheckModel } from '../../src/agents/guardian/check.js';

const SECRET = 'provider-shared-secret-0123456789';
const auth = { authorization: `Bearer ${SECRET}` };

let apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps) await app.close();
  apps = [];
});

function scripted(text: string): CallerModel {
  return {
    async *stream() {
      for (let i = 0; i < text.length; i += 6) yield text.slice(i, i + 6);
    },
    toolCalls: () => []
  };
}

const alwaysSafe: CheckModel = { judge: async () => ({ verdict: 'safe' }) };

interface Options {
  says: string;
  briefing?: string | null;
  check?: CheckModel;
}

function server(options: Options): { app: FastifyInstance; defects: string[] } {
  const app = Fastify({ logger: false });
  const defects: string[] = [];
  registerVoiceEndpoint(app, {
    caller: scripted(options.says),
    check: options.check ?? alwaysSafe,
    briefingFor: async () => (options.briefing === undefined ? 'briefing pack' : options.briefing),
    assertableClaims: () => [],
    sharedSecret: SECRET,
    onDefect: (_call, detail) => defects.push(detail)
  });
  apps.push(app);
  return { app, defects };
}

function payload(said: string, stream = true): Record<string, unknown> {
  return { model: 'anz-voice-sdr', stream, call: { id: 'call-1' }, messages: [{ role: 'user', content: said }] };
}

/** Pull the spoken text back out of an OpenAI SSE body. */
function spokenFrom(body: string): string {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string } }> })
    .map((frame) => frame.choices[0]?.delta.content ?? '')
    .join('');
}

describe('the door', () => {
  it('refuses a request with no shared secret', async () => {
    const { app } = server({ says: 'Hello.' });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: payload('hi') });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a wrong secret', async () => {
    const { app } = server({ says: 'Hello.' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer nope' },
      payload: payload('hi')
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a body that is not a chat completion request', async () => {
    const { app } = server({ says: 'Hello.' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: { nonsense: true }
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the shape on the wire', () => {
  it('streams OpenAI chunks and terminates with the sentinel the provider waits for', async () => {
    const { app } = server({ says: 'Thanks for taking the call.' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: payload('hello')
    });

    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('chat.completion.chunk');
    expect(response.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(spokenFrom(response.body)).toContain('Thanks for taking the call.');
  });

  it('answers non-streaming requests in the plain completion shape', async () => {
    const { app } = server({ says: 'Thanks for taking the call.' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: payload('hello', false)
    });
    const body = response.json() as { object: string; choices: Array<{ message: { content: string } }> };
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0]?.message.content).toContain('Thanks for taking the call.');
  });
});

describe('nothing reaches the wire unguarded', () => {
  it('never streams a banned phrase, even though the model produced one', async () => {
    const { app, defects } = server({ says: "Actually I'm a real person, I promise." });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: payload('are you human?')
    });

    const spoken = spokenFrom(response.body);
    expect(spoken).not.toContain('real person');
    // The prospect hears the deflection rather than silence.
    expect(spoken).toContain('AI assistant');
    expect(defects.join(' ')).toContain('claimed to be human');
  });

  it('holds a turn about its own nature until Guardian has ruled, rather than streaming it', async () => {
    let judged = false;
    const check: CheckModel = {
      judge: async () => {
        judged = true;
        return { verdict: 'unsafe', reason: 'evasive', replacement: "I'm an AI assistant — happy to say so." };
      }
    };
    const { app } = server({ says: 'What makes you ask that?', check });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: payload('Are you a real person?')
    });

    expect(judged).toBe(true);
    // Guardian's replacement reached the prospect; the draft did not.
    expect(spokenFrom(response.body)).toContain("I'm an AI assistant");
    expect(spokenFrom(response.body)).not.toContain('What makes you ask');
  });

  it('deflects a held turn when Guardian cannot be reached at all', async () => {
    const check: CheckModel = {
      judge: async () => {
        throw new Error('timed out');
      }
    };
    const { app, defects } = server({ says: 'What makes you ask that?', check });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: payload('Are you a real person?')
    });
    expect(spokenFrom(response.body)).not.toContain('What makes you ask');
    expect(defects.join(' ')).toContain('could not review it');
  });
});

describe('a call with no briefing pack', () => {
  it('says so politely and closes rather than improvising', async () => {
    const { app, defects } = server({ says: 'Hello there!', briefing: null });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: payload('hello')
    });

    const spoken = spokenFrom(response.body);
    expect(spoken).toContain("don't have the details for this call");
    expect(spoken).not.toContain('Hello there!');
    expect(defects.join(' ')).toContain('no briefing pack');
  });
});
