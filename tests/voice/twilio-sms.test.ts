import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerInboundSms, twilioSignature, verifyTwilioSignature } from '../../src/voice/twilio-sms.js';
import type { InboundSms } from '../../src/agents/concierge/inbound-sms.js';

const TOKEN = 'a-twilio-auth-token';
const URL = 'https://sdr.example.com/twilio/sms';
const PARAMS = { From: '+61448455510', To: '+61412000000', Body: 'STOP', MessageSid: 'SM123' };

// The worked example in Twilio's request-validation documentation
// (twilio.com/docs/usage/security). Not computed by this code: it is the
// published input and the published answer.
const DOC = {
  token: '12345',
  url: 'https://example.com/myapp.php?foo=1&bar=2',
  params: { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' },
  signature: 'L/OH5YylLD5NRKLltdqwSvS0BnU='
};

async function app(handle: (m: InboundSms) => Promise<unknown>) {
  const server = Fastify();
  registerInboundSms(server, { authToken: TOKEN, publicUrl: URL, handle });
  await server.ready();
  return server;
}

const form = (params: Record<string, string>) => new URLSearchParams(params).toString();
const post = (server: Awaited<ReturnType<typeof app>>, params: Record<string, string>, signature?: string) =>
  server.inject({
    method: 'POST',
    url: '/twilio/sms',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(signature !== undefined ? { 'x-twilio-signature': signature } : {})
    },
    payload: form(params)
  });

describe('the signature', () => {
  it('matches the worked example in Twilio’s documentation', () => {
    expect(twilioSignature(DOC.token, DOC.url, DOC.params)).toBe(DOC.signature);
  });

  it('verifies a correct one and rejects any change to token, url, a value, or a parameter', () => {
    const good = twilioSignature(TOKEN, URL, PARAMS);
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, good)).toBe(true);
    expect(verifyTwilioSignature('other-token', URL, PARAMS, good)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, 'https://evil.example.com/twilio/sms', PARAMS, good)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL, { ...PARAMS, Body: 'Hello' }, good)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL, { ...PARAMS, Extra: 'x' }, good)).toBe(false);
  });

  it('never accepts an empty token or an empty signature', () => {
    expect(verifyTwilioSignature('', URL, PARAMS, twilioSignature('', URL, PARAMS))).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, '')).toBe(false);
  });

  it('does not depend on the order parameters arrive in', () => {
    const reversed = Object.fromEntries(Object.entries(PARAMS).reverse());
    expect(twilioSignature(TOKEN, URL, reversed)).toBe(twilioSignature(TOKEN, URL, PARAMS));
  });
});

describe('the route', () => {
  it('hands a signed message to the handler and answers with an empty TwiML response', async () => {
    const seen: InboundSms[] = [];
    const server = await app(async (m) => void seen.push(m));
    const response = await post(server, PARAMS, twilioSignature(TOKEN, URL, PARAMS));

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/xml');
    expect(response.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(seen).toEqual([{ from: '+61448455510', body: 'STOP', messageSid: 'SM123' }]);
  });

  it('refuses an unsigned or wrongly signed request before reading it', async () => {
    const seen: InboundSms[] = [];
    const server = await app(async (m) => void seen.push(m));
    expect((await post(server, PARAMS)).statusCode).toBe(403);
    expect((await post(server, PARAMS, 'AAAA')).statusCode).toBe(403);
    expect((await post(server, PARAMS, twilioSignature('wrong', URL, PARAMS))).statusCode).toBe(403);
    expect(seen).toEqual([]);
  });

  it('refuses a validly signed message with no sender or message id', async () => {
    const server = await app(async () => undefined);
    const noFrom = { Body: 'STOP', MessageSid: 'SM1' };
    const noSid = { From: '+61448455510', Body: 'STOP' };
    expect((await post(server, noFrom, twilioSignature(TOKEN, URL, noFrom))).statusCode).toBe(400);
    expect((await post(server, noSid, twilioSignature(TOKEN, URL, noSid))).statusCode).toBe(400);
  });

  it('answers 5xx when the handler fails, so Twilio redelivers', async () => {
    const server = await app(async () => {
      throw new Error('smtp unreachable');
    });
    const response = await post(server, PARAMS, twilioSignature(TOKEN, URL, PARAMS));
    expect(response.statusCode).toBe(500);
  });

  it('accepts a message with an empty body, which MMS-only replies produce', async () => {
    const seen: InboundSms[] = [];
    const server = await app(async (m) => void seen.push(m));
    const params = { From: '+61448455510', MessageSid: 'SM2' };
    const response = await post(server, params, twilioSignature(TOKEN, URL, params));
    expect(response.statusCode).toBe(200);
    expect(seen[0]?.body).toBe('');
  });
});
