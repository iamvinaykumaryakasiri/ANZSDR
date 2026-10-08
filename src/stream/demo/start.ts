/**
 * npm run console:demo
 *
 * The console, running on invented data. A separate database is built and seeded
 * (data/demo/console-demo.db, rebuilt each time), a pretend call plays on loop so
 * the room is never dead, and the server comes up with the same routes and the
 * same token check as the real one. Nothing in this process can dial, text or
 * email: see demo/console.ts.
 */

import '../../config/env-autoload.js';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../web/server.js';
import { createDemoConsole } from './console.js';

const port = Number(process.env.PORT ?? 8080);
// Bound to this machine unless asked otherwise: it is sample data, but it is
// still a server.
const host = process.env.HOST ?? '127.0.0.1';
const fromEnv = (process.env.ADMIN_TOKEN ?? '').trim();
const token = fromEnv !== '' ? fromEnv : randomBytes(12).toString('hex');

const demo = await createDemoConsole();

// The knowledge routes of the account desk point at a throwaway folder, so the
// demo cannot approve a claim in the real knowledge pack.
const app = buildServer({
  db: demo.db,
  adminToken: token,
  logger: false,
  knowledgeDir: mkdtempSync(join(tmpdir(), 'anzsdr-demo-knowledge-')),
  console: { deps: demo.deps, refreshMs: 4000 }
});

await app.listen({ port, host });
demo.simulator.start();

const shown = host === '0.0.0.0' ? 'localhost' : host === '127.0.0.1' ? 'localhost' : host;
console.log('\nANZ Voice SDR console: DEMO MODE. Everything here is invented.');
console.log(`  seeded:  ${demo.summary.calls} calls, ${demo.summary.contacts} people, ${demo.summary.pendingMeetingRequests} pending meeting requests, ${demo.summary.queue} in the queue`);
console.log(`  database: ${demo.dbPath}  (separate from the real blackboard; rebuilt on every start)`);
console.log(`\n  console:  http://${shown}:${port}/console/`);
console.log(`  API:      http://${shown}:${port}/api/console/snapshot`);
console.log(`  token:    ${token}${fromEnv !== '' ? '  (from ADMIN_TOKEN)' : '  (generated; set ADMIN_TOKEN to choose your own)'}`);
console.log(`\n  curl -H "Authorization: Bearer ${token}" http://${shown}:${port}/api/console/snapshot`);
console.log('\n  If the page is not there, the web app has not been built: npm --prefix web install && npm --prefix web run build');
console.log('  Press Ctrl-C to stop.\n');

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await app.close();
  await demo.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
