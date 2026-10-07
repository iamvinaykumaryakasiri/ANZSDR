/**
 * Twilio's inbound-SMS webhook.
 *
 * A text a prospect sends to our number arrives here as a form POST. This route
 * is public by necessity, so the one thing it must do before reading a word of
 * the body is establish that Twilio sent it: an unauthenticated STOP endpoint
 * is a way for anyone to suppress any number, and an unauthenticated reply
 * endpoint is a way to put words in front of Vinay under a prospect's name.
 *
 * The check is Twilio's documented one: HMAC-SHA1, keyed with the account auth
 * token, over the full public URL followed by every POST parameter, sorted by
 * name, as name-then-value with nothing between them. It is compared in
 * constant time.
 *
 * The URL is the one Twilio was configured with, not whatever the Host header
 * says: behind a proxy those differ, and a signature computed over the wrong
 * URL never matches. It is therefore a required setting, not derived.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { InboundSms } from '../agents/concierge/inbound-sms.js';

export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const signed = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ''), url);
  return createHmac('sha1', authToken).update(signed, 'utf8').digest('base64');
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  supplied: string
): boolean {
  if (authToken === '' || supplied === '') return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface InboundSmsRouteDeps {
  authToken: string;
  /** The exact URL configured on the Twilio number, scheme and path included. */
  publicUrl: string;
  /** Throws on failure, so Twilio sees a 5xx and redelivers. */
  handle: (message: InboundSms) => Promise<unknown>;
  path?: string;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function registerInboundSms(app: FastifyInstance, deps: InboundSmsRouteDeps): void {
  // Twilio posts a form. Registered inside a child scope so it does not change
  // how the rest of the app parses bodies.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    scope.post(deps.path ?? '/twilio/sms', async (request, reply) => {
      const params = (request.body ?? {}) as Record<string, string>;
      const supplied = String(request.headers['x-twilio-signature'] ?? '');
      if (!verifyTwilioSignature(deps.authToken, deps.publicUrl, params, supplied)) {
        return reply.code(403).send('forbidden');
      }

      const from = params.From ?? '';
      const messageSid = params.MessageSid ?? params.SmsMessageSid ?? '';
      if (from === '' || messageSid === '') return reply.code(400).send('malformed');

      await deps.handle({ from, body: params.Body ?? '', messageSid });
      // An empty TwiML response: whatever we have to say to a prospect is not
      // said automatically, and Twilio sends its own STOP confirmation.
      return reply.code(200).header('content-type', 'text/xml').send(EMPTY_TWIML);
    });
  });
}
