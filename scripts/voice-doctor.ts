/**
 * What stands between this checkout and a first test call.
 *
 *   npm run voice:doctor                     offline: environment, config, the gate
 *   npm run voice:doctor -- --online         also read the assistant, phone numbers and Twilio credentials back
 *   npm run voice:doctor -- --contact <id>   ask the gate about one test contact
 *   npm run voice:doctor -- --at 2026-10-13T11:00:00+11:00   ask as of another moment
 *
 * Read-only. It places no call, writes no audit record and changes nothing; it
 * exits 1 when something is missing, so it can sit in a script.
 */

import '../src/config/env-autoload.js';
import { formatDoctorReport, runDoctor } from '../src/voice/doctor.js';
import { buildVapiAdapter, loadCore } from '../src/voice/runtime.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : (process.argv[i + 1] ?? '');
}

async function main(): Promise<void> {
  const online = process.argv.includes('--online');
  const at = flag('--at');
  const when = at === undefined ? new Date() : new Date(at);
  if (Number.isNaN(when.getTime())) {
    console.error(`--at "${at}" is not a date`);
    process.exit(2);
  }

  const core = loadCore(process.env);
  try {
    const adapter = online ? buildVapiAdapter(process.env, { assistantRequired: false }) : null;
    const contactId = flag('--contact');
    const report = await runDoctor({
      env: process.env,
      policy: core.policy,
      calendar: core.calendar,
      identity: core.identity,
      voice: core.voice,
      claims: core.claims(),
      db: core.db,
      gate: core.gate,
      now: when,
      ...(contactId !== undefined ? { contactId } : {}),
      ...(online ? { online: adapter === null ? {} : { provider: { getAssistant: (id) => adapter.getAssistant(id), getPhoneNumber: (id) => adapter.getPhoneNumber(id) } } } : {})
    });
    console.log(formatDoctorReport(report, when));
    process.exitCode = report.ready ? 0 : 1;
  } finally {
    await core.db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
