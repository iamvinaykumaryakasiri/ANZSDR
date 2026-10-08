/**
 * Delete recordings past their retention period (section 7.4).
 *
 *   npm run recordings:purge             DRY RUN: say what is due, delete nothing
 *   npm run recordings:purge -- --apply  delete it
 *
 * Due means the call ended more than `recording.retention_days` ago (config/
 * policy.yaml, default 90), or the prospect objected to being recorded. Both
 * copies go: our encrypted one, and the voice provider's. `npm run voice:serve`
 * runs this automatically once a day.
 */

import '../src/config/env-autoload.js';
import { EncryptedFileRecordingStore, formatPurgeReport, parseEncryptionKey, runPurge } from '../src/voice/recordings.js';
import { buildVapiAdapter, loadCore } from '../src/voice/runtime.js';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const core = loadCore(process.env);
  try {
    const key = (process.env.RECORDING_ENCRYPTION_KEY ?? '').trim();
    const adapter = buildVapiAdapter(process.env, { assistantRequired: false });
    if (apply && adapter === null) {
      console.error("note: VAPI_API_KEY is not set, so the provider's copies cannot be deleted from here; only ours will be.\n");
    }
    const report = await runPurge({
      db: core.db,
      store: key === '' ? undefined : new EncryptedFileRecordingStore(core.paths.recordings, parseEncryptionKey(key)),
      adapter: adapter ?? undefined,
      now: () => new Date(),
      retentionDays: core.policy.recording.retention_days,
      dryRun: !apply
    });
    console.log(formatPurgeReport(report));
    if (report.results.some((r) => r.status !== 'deleted')) process.exitCode = 1;
  } finally {
    await core.db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
