/**
 * The Apollo phone-delivery webhook (section 5.2).
 *
 * `reveal_phone_number=true` makes Apollo deliver numbers minutes later, by
 * POSTing to a URL we gave it. Three things about that shape this handler:
 *
 *   - It is on the public internet, so it checks a shared secret before it reads
 *     a byte of the body. Anything without the secret is turned away, and if no
 *     secret is configured the route refuses everything rather than accepting
 *     all.
 *   - Apollo retries. The same delivery can arrive twice or ten times, and the
 *     second must change nothing. Idempotency is by delivery key (a hash of the
 *     person and the numbers), recorded in the enrichment ledger.
 *   - It only accepts numbers for people we asked about. A delivery for an
 *     Apollo id we never requested is acknowledged and dropped, not stored, so a
 *     forged or misrouted request cannot put a number on anyone.
 *
 * Authenticated duplicates and unmatched deliveries are answered 200, because a
 * non-2xx would make Apollo keep retrying something that will never change.
 *
 * Registered by the server as a plugin:
 *
 *     app.register(apolloWebhook, { db: options.db });
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { Blackboard } from '../blackboard/client.js';
import { PrismaEnrichmentLedger } from './enrichment-ledger.js';
import { loadPhase3Config } from './config.js';
import { EnrichmentService, type DeliveryResult } from './enrichment.js';
import { normalisePhones, phoneWebhookPayloadSchema } from './apollo-types.js';

export const APOLLO_WEBHOOK_PATH = '/webhooks/apollo';
export const APOLLO_WEBHOOK_SECRET_HEADER = 'x-apollo-webhook-secret';

export interface ApolloWebhookOptions {
  db: Blackboard;
  /** Shared secret. Defaults to APOLLO_WEBHOOK_SECRET; with neither, the route refuses everything. */
  secret?: string;
  /** Replace the default service, for tests. */
  service?: Pick<EnrichmentService, 'applyPhoneDelivery'>;
  path?: string;
}

function secretsMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // Lengths first: timingSafeEqual throws on a mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The URL to hand Apollo as `webhook_url`. https is required, and Apollo will not accept anything else. */
export function buildWebhookUrl(publicBaseUrl: string, secret: string, path: string = APOLLO_WEBHOOK_PATH): string | undefined {
  const base = publicBaseUrl.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base) || secret.trim() === '') return undefined;
  return `${base}${path}?secret=${encodeURIComponent(secret)}`;
}

export const apolloWebhook: FastifyPluginAsync<ApolloWebhookOptions> = async (app, options) => {
  const expected = (options.secret ?? process.env.APOLLO_WEBHOOK_SECRET ?? '').trim();
  const service =
    options.service ??
    new EnrichmentService({
      db: options.db,
      ledger: new PrismaEnrichmentLedger(options.db),
      config: loadPhase3Config().enrichment
    });

  app.post(options.path ?? APOLLO_WEBHOOK_PATH, async (request, reply) => {
    if (expected === '') {
      return reply.code(503).send({ error: 'webhook secret is not configured' });
    }
    const header = request.headers[APOLLO_WEBHOOK_SECRET_HEADER];
    const query = (request.query as Record<string, unknown> | undefined)?.secret;
    const supplied = typeof header === 'string' ? header : typeof query === 'string' ? query : '';
    if (!secretsMatch(supplied, expected)) {
      return reply.code(401).send({ error: 'unauthorised' });
    }

    const parsed = phoneWebhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'unrecognised payload' });
    }

    const tally = { applied: 0, duplicate: 0, unrequested: 0 };
    for (const person of parsed.data.people) {
      const result: DeliveryResult = await service.applyPhoneDelivery(person.id, normalisePhones(person.phone_numbers));
      tally[result.status] += 1;
    }
    return reply.code(200).send({ status: 'ok', ...tally });
  });
};
