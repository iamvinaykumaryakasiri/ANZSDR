/**
 * `npm run voice:serve`: the process the voice provider talks to.
 *
 * It needs a public HTTPS address (a tunnel is fine; docs/VOICE-SETUP.md). It
 * does not place calls - `npm run voice:testcall` does that, through the
 * compliance gate - it answers the provider's requests for the next thing Lexi
 * should say, and processes what the provider reports afterwards.
 *
 * Alongside the routes it runs two timers: the watchdog, which closes calls
 * nobody is reporting on (so a stuck call cannot hold the one live-call slot),
 * and the recording purge, which deletes recordings past their retention period.
 * The purge is automatic here; the command line defaults to a dry run.
 */

import '../config/env-autoload.js';
import { handleInboundSms } from '../agents/concierge/inbound-sms.js';
import { PrismaSuppressionStore } from '../blackboard/compliance-stores.js';
import { composeEnded } from './compose.js';
import { formatPurgeReport, runPurge } from './recordings.js';
import { buildVapiAdapter, loadCore } from './runtime.js';
import { buildVoiceServer, wireVoice } from './server.js';
import { sweepCalls } from './watchdog.js';

const stamp = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (line: string): void => console.log(`${stamp()}  ${line}`);

function need(name: string, why: string): string {
  const value = (process.env[name] ?? '').trim();
  if (value === '') {
    console.error(`\n${name} is not set: ${why}\nRun  npm run voice:doctor  to see everything that is missing.\n`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const env = process.env;
  need('ANTHROPIC_API_KEY', 'Lexi has no model to think with');
  const sharedSecret = need('VOICE_SHARED_SECRET', 'the LLM endpoint would be open to anyone');
  need('VAPI_WEBHOOK_SECRET', 'the webhook would be open to anyone');
  const publicBase = need('PUBLIC_BASE_URL', 'the provider has nowhere to send turns and reports').replace(/\/+$/, '');

  const core = loadCore(env);
  const adapter = buildVapiAdapter(env, { assistantRequired: false });
  if (adapter === null) need('VAPI_API_KEY', 'needed to hang up calls and delete recordings');
  const provider = adapter as NonNullable<typeof adapter>;

  const now = (): Date => new Date();
  const composed = composeEnded(core, env, provider, log);
  if (composed.recordingStore === undefined) {
    log('RECORDING_ENCRYPTION_KEY is not set: recordings will not be archived here (the provider keeps its own copy)');
  }

  const wired = wireVoice({
    db: core.db,
    identity: core.identity,
    adapter: provider,
    briefing: { db: core.db, identity: core.identity, claims: core.claims, pack: core.pack },
    killSwitch: core.killSwitch,
    caller: composed.caller,
    check: composed.check,
    sharedSecret,
    closeGraceMs: core.voice.limits.close_grace_ms,
    now,
    log,
    ended: composed.ended
  });

  const mailer = composed.mailer;
  const operatorEmail = core.identity.operator.email.trim();
  const twilioToken = (env.TWILIO_AUTH_TOKEN ?? '').trim();
  const app = buildVoiceServer({
    endpoint: wired.endpoint,
    webhook: { adapter: provider, ended: wired.ended, log },
    sms:
      twilioToken === ''
        ? undefined
        : {
            authToken: twilioToken,
            publicUrl: `${publicBase}/twilio/sms`,
            handle: (message) =>
              handleInboundSms(
                { db: core.db, suppressions: new PrismaSuppressionStore(core.db), mailer, operatorEmail, now },
                message
              )
          },
    health: async () => ({ ok: true, liveCalls: (await wired.calls.liveCalls()).length })
  });

  const limits = {
    maxCallSeconds: core.voice.limits.max_call_seconds,
    ringTimeoutSeconds: core.voice.limits.ring_timeout_seconds,
    reportGraceSeconds: core.voice.limits.report_grace_seconds
  };

  const watchdog = setInterval(() => {
    void sweepCalls(wired.ended, limits).then(
      (closed) => closed.forEach((c) => log(`watchdog closed ${c.callId.slice(0, 8)} (${c.reason}): ${c.processing}`)),
      (error: unknown) => log(`watchdog failed: ${(error as Error).message}`)
    );
  }, 30_000);

  const purge = async (): Promise<void> => {
    const report = await runPurge({
      db: core.db,
      store: composed.recordingStore,
      adapter: provider,
      now,
      retentionDays: core.policy.recording.retention_days,
      dryRun: false
    });
    if (report.due.length > 0) log(formatPurgeReport(report));
  };
  const autoPurge = (env.RECORDINGS_AUTO_PURGE ?? 'on').toLowerCase() !== 'off';
  const purgeFirst = autoPurge ? setTimeout(() => void purge().catch((e: unknown) => log(`purge failed: ${(e as Error).message}`)), 5 * 60_000) : null;
  const purgeEvery = autoPurge ? setInterval(() => void purge().catch((e: unknown) => log(`purge failed: ${(e as Error).message}`)), 24 * 3_600_000) : null;

  const port = Number(env.VOICE_PORT ?? 8081);
  await app.listen({ port, host: env.HOST ?? '0.0.0.0' });
  log(`voice server listening on :${port}, public address ${publicBase}`);
  log(`  brain     POST ${publicBase}/v1/chat/completions`);
  log(`  webhook   POST ${publicBase}/vapi/webhook`);
  log(`  recording retention ${core.policy.recording.retention_days} days, automatic purge ${autoPurge ? 'on' : 'OFF'}`);

  const stop = async (): Promise<void> => {
    clearInterval(watchdog);
    if (purgeFirst !== null) clearTimeout(purgeFirst);
    if (purgeEvery !== null) clearInterval(purgeEvery);
    await app.close();
    await core.db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
