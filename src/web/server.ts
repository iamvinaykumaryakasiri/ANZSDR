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
import Anthropic from '@anthropic-ai/sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Blackboard } from '../blackboard/client.js';
import { createBlackboard } from '../blackboard/client.js';
import { loadModelConfig } from '../voice/claude-model.js';
import { createLiveConsoleDeps, type ConsoleDeps } from '../stream/deps.js';
import type { JarvisModel } from '../stream/jarvis.js';
import { claudeJarvisModel } from '../stream/jarvis-model.js';
import { registerConsole, type ConsoleHandle } from '../stream/routes.js';
import { registerConsoleStatic } from '../stream/static.js';
import { registerAccountsApi } from './accounts-api.js';
import { registerKnowledgeApi } from './knowledge-api.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolved from the repository root rather than from this module, so a compiled
// build that does not copy the HTML still serves the right file.
const PAGE = resolve(HERE, '../..', 'src/web/public/index.html');

export interface ServerOptions {
  db: Blackboard;
  /** Shared secret for every /api route. The server refuses to start without one. */
  adminToken: string;
  /** The knowledge pack directory. Overridden in tests so they never touch the real one. */
  knowledgeDir?: string;
  logger?: boolean;
  /**
   * The Phase 8 console (section 14): its API under /api/console and, when the web
   * app has been built, the app itself at /console/. Left out, the account desk is
   * served alone, which is what the desk's own tests want.
   */
  console?: ConsoleMount | undefined;
}

export interface ConsoleMount {
  deps: ConsoleDeps;
  /** Milliseconds between snapshots pushed to a watched console. Defaults to 5000. */
  refreshMs?: number;
  /** Where the built web app is. Defaults to web/dist; false serves no app. */
  webDir?: string | false;
}

function tokensMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // Compare lengths first: timingSafeEqual throws on a length mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildServer(options: ServerOptions): FastifyInstance & { consoleHandle?: ConsoleHandle } {
  if (options.adminToken.trim() === '') {
    throw new Error('ADMIN_TOKEN is required: this surface edits the prospect list and is not served unauthenticated');
  }

  const app = Fastify({
    logger: options.logger ?? false,
    // A capability deck is routinely bigger than Fastify's 1MB default, and a
    // silent 413 on an upload looks like the feature is broken. The knowledge
    // API enforces its own per-file cap inside this.
    bodyLimit: 24 * 1024 * 1024
  });

  // A POST with nothing to say still arrives as `content-type: application/json`
  // from fetch(), and Fastify rejects an empty body as malformed JSON. Buttons
  // like "read the folder" take no arguments, so treat an empty body as {} and
  // let each route's own schema decide whether that is enough.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = (body as string).trim();
    if (text === '') return done(null, {});
    try {
      done(null, JSON.parse(text) as unknown);
    } catch (error) {
      (error as Error & { statusCode?: number }).statusCode = 400;
      done(error as Error, undefined);
    }
  });

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
  registerKnowledgeApi(app, { dir: options.knowledgeDir ?? resolve(HERE, '../..', 'knowledge') });

  const server: FastifyInstance & { consoleHandle?: ConsoleHandle } = app;
  if (options.console !== undefined) {
    server.consoleHandle = registerConsole(app, {
      deps: options.console.deps,
      adminToken: options.adminToken,
      ...(options.console.refreshMs !== undefined ? { refreshMs: options.console.refreshMs } : {})
    });
    const webDir = options.console.webDir;
    if (webDir !== false) registerConsoleStatic(app, webDir ?? resolve(HERE, '../..', 'web/dist'));
  }

  return server;
}

/** Jarvis's free-text path, when there is a key to pay for it. Read-only either way. */
function jarvisModelFromEnv(): JarvisModel | undefined {
  const key = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (key === '') return undefined;
  try {
    const config = loadModelConfig(resolve(HERE, '../..', 'config/models.yaml'));
    return claudeJarvisModel({ client: new Anthropic(), model: process.env.JARVIS_MODEL ?? config.scribe });
  } catch (error) {
    console.warn(`Jarvis will answer only from its built-in questions: ${(error as Error).message}`);
    return undefined;
  }
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

  // The console reads the same policy, calendar and kill-switch file as the
  // command line. If those cannot be loaded the desk still starts, and says why.
  let consoleDeps: ConsoleDeps | undefined;
  try {
    consoleDeps = createLiveConsoleDeps({ db, jarvisModel: jarvisModelFromEnv() });
  } catch (error) {
    console.error(`The console is unavailable: ${(error as Error).message}`);
  }

  const app = buildServer({ db, adminToken, logger: true, ...(consoleDeps !== undefined ? { console: { deps: consoleDeps } } : {}) });
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen({ port, host });
  console.log(`\naccount desk:  http://localhost:${port}/`);
  if (consoleDeps !== undefined) {
    console.log(`console API:   http://localhost:${port}/api/console/snapshot  (Bearer ADMIN_TOKEN)`);
    console.log(`console:       http://localhost:${port}/console/  (needs the web app built: npm --prefix web run build)`);
  }
  if (process.env.PUBLIC_BASE_URL !== undefined) {
    console.log(`public:        ${process.env.PUBLIC_BASE_URL}/`);
    console.log(`apollo webhook (Phase 3): ${process.env.PUBLIC_BASE_URL}/webhooks/apollo`);
  } else {
    console.log('PUBLIC_BASE_URL is not set; Apollo phone enrichment will not work until it is.');
  }
}
