/**
 * The operator's small web surface.
 *
 * Two jobs, one process, because the second one forces the first to be publicly
 * reachable anyway:
 *
 *   1. The account desk - the organisations to work and the titles worth calling
 *      at them, maintained without editing YAML or the database by hand.
 *   2. From Phase 3, the Apollo phone-enrichment webhook, which Apollo will only
 *      deliver to a public HTTPS URL.
 *
 * It is not the console in section 14; that is Phase 8 and starts with a design
 * review. This is an admin surface, and it says so.
 */

import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Blackboard } from '../blackboard/client.js';
import { createBlackboard } from '../blackboard/client.js';
import { registerAccountsApi } from './accounts-api.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolved from the repository root rather than from this module, so a compiled
// build that does not copy the HTML still serves the right file.
const PAGE = resolve(HERE, '../..', 'src/web/public/index.html');

export interface ServerOptions {
  db: Blackboard;
  /** Shared secret for every /api route. The server refuses to start without one. */
  adminToken: string;
  logger?: boolean;
}

function tokensMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // Compare lengths first: timingSafeEqual throws on a length mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildServer(options: ServerOptions): FastifyInstance {
  if (options.adminToken.trim() === '') {
    throw new Error('ADMIN_TOKEN is required: this surface edits the prospect list and is not served unauthenticated');
  }

  const app = Fastify({ logger: options.logger ?? false });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const header = request.headers.authorization ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : (request.headers['x-admin-token'] as string ?? '');
    if (!tokensMatch(supplied, options.adminToken)) {
      return reply.code(401).send({ error: 'unauthorised' });
    }
  });

  app.get('/healthz', async () => ({ ok: true, service: 'anz-voice-sdr' }));

  app.get('/', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return readFileSync(PAGE, 'utf8');
  });

  registerAccountsApi(app, options.db);

  return app;
}

export async function startServer(): Promise<void> {
  const adminToken = process.env.ADMIN_TOKEN ?? '';
  if (adminToken.trim() === '') {
    console.error('ADMIN_TOKEN is not set.');
    console.error('This page edits the account list, so it is never served without one.');
    console.error('Generate one with:  openssl rand -hex 24');
    process.exit(1);
  }

  const db = createBlackboard();
  const app = buildServer({ db, adminToken, logger: true });
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen({ port, host });
  console.log(`\naccount desk:  http://localhost:${port}/`);
  if (process.env.PUBLIC_BASE_URL !== undefined) {
    console.log(`public:        ${process.env.PUBLIC_BASE_URL}/`);
    console.log(`apollo webhook (Phase 3): ${process.env.PUBLIC_BASE_URL}/webhooks/apollo`);
  } else {
    console.log('PUBLIC_BASE_URL is not set; Apollo phone enrichment will not work until it is.');
  }
}
