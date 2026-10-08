/**
 * Work the enrichment queue.
 *
 *   npm run enrich:worker              consume jobs until stopped (needs REDIS_URL)
 *   npm run enrich:worker -- --once    drain what is queued, then exit
 *
 * Phone numbers are requested here once Scout's dossier clears the research gate.
 * Apollo delivers the numbers later to the webhook (src/data/apollo-webhook.ts),
 * which the server registers; this process only places the requests.
 *
 * Without REDIS_URL the queue is in memory and dies with the process that made
 * it, so there is nothing for a separate worker to find. In that case the phone
 * request is placed inline by the task that triggers it, and this exits saying so.
 */

import '../src/config/env-autoload.js';
import { createBlackboard } from '../src/blackboard/client.js';
import { SpendLedger } from '../src/blackboard/repositories.js';
import { createPhase3Runtime } from '../src/data/runtime.js';

async function main(): Promise<void> {
  const db = createBlackboard();
  const runtime = await createPhase3Runtime({ db, spend: new SpendLedger(db) });
  try {
    for (const note of runtime.notes) console.log(`note: ${note}`);
    if (runtime.queue.kind === 'memory') {
      console.log('REDIS_URL is not set, so the queue is in memory and has no jobs from another process. Nothing to do.');
      return;
    }
    if (runtime.apollo === undefined) {
      console.error('APOLLO_API_KEY is not set; a worker could not place any request.');
      process.exit(1);
    }
    const queued = await runtime.enrichment.enqueueEmailBackfill();
    if (queued > 0) console.log(`queued stage-one enrichment for ${queued} contact(s) held without an email`);

    await runtime.enrichment.startWorker();
    if (process.argv.includes('--once')) {
      const report = await runtime.queue.drain();
      console.log(`processed ${report.processed} job(s); ${report.failed.length} failed`);
      for (const f of report.failed) console.log(`  ${f.jobId}: ${f.error}`);
      return;
    }
    console.log('worker running. Ctrl-C to stop.');
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    await runtime.close();
    await db.$disconnect();
  }
}

await main();
