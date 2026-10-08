/**
 * Run the end-of-call processing again for a call whose first run failed.
 *
 *   npm run voice:reprocess -- --call <callId>
 *
 * Works from the end-of-call report the server stored, so the provider does not
 * need to send it again. Everything downstream (Scribe, the follow-up, the
 * workbook) is idempotent; running this on a call that was processed fine does
 * nothing.
 */

import '../src/config/env-autoload.js';
import { CallContextProvider } from '../src/voice/briefing-source.js';
import { CallStore } from '../src/voice/call-store.js';
import { composeEnded } from '../src/voice/compose.js';
import { processReport } from '../src/voice/ended-call.js';
import { buildVapiAdapter, loadCore } from '../src/voice/runtime.js';

async function main(): Promise<void> {
  const i = process.argv.indexOf('--call');
  const wanted = i === -1 ? undefined : process.argv[i + 1];
  if (wanted === undefined || wanted === '') {
    console.error('Usage: npm run voice:reprocess -- --call <callId>');
    process.exit(2);
  }

  const core = loadCore(process.env);
  try {
    const calls = new CallStore(core.db);
    const call = await calls.find(wanted);
    if (call === null) {
      console.error(`No call ${wanted}.`);
      process.exit(1);
    }
    const adapter = buildVapiAdapter(process.env, { assistantRequired: false }) ?? undefined;
    const composed = composeEnded(core, process.env, adapter, (line) => console.log(line));
    const contexts = new CallContextProvider({ db: core.db, identity: core.identity, claims: core.claims, pack: core.pack });
    const outcome = await processReport({ ...composed.ended, calls, contexts }, call.id);
    console.log(`${outcome.status}: ${outcome.detail}`);
    if (outcome.status === 'failed') process.exitCode = 1;
  } finally {
    await core.db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
