/**
 * Place one test call, to a contact marked `test`, through the compliance gate.
 *
 *   npm run voice:testcall -- --contact <testContactId>          show what would happen; call nobody
 *   npm run voice:testcall -- --contact <testContactId> --yes    place the call
 *
 * This is the only command that can ring a phone, and it rings only numbers you
 * control: the contact must be recorded as `test` on the blackboard, and the
 * compliance gate must allow the dial (calling hours, an approved plan for
 * today, the caller ID, the kill switch, and everything else it checks). If the
 * gate says no, so does this, and it prints why. There is no flag that goes
 * round either check.
 *
 * Find a contact id with:  npm run voice:doctor  (it lists the test contacts).
 */

import '../src/config/env-autoload.js';
import { placeTestCall } from '../src/voice/dial.js';
import { buildVapiAdapter, loadCore } from '../src/voice/runtime.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : (process.argv[i + 1] ?? '');
}

async function serverIsUp(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/healthz`, { signal: AbortSignal.timeout(8000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const contactId = flag('--contact');
  if (contactId === undefined || contactId === '') {
    console.error('Usage: npm run voice:testcall -- --contact <testContactId> [--yes]\nnpm run voice:doctor lists the test contacts.');
    process.exit(2);
  }
  const confirmed = process.argv.includes('--yes');

  const core = loadCore(process.env);
  try {
    const contact = await core.db.contact.findUnique({ where: { id: contactId }, include: { account: true } });
    if (contact === null) {
      console.error(`No contact ${contactId} on the blackboard.`);
      process.exit(1);
    }
    if (contact.kind !== 'test') {
      console.error(`REFUSED: ${contact.firstName} ${contact.lastName} is not marked as a test contact.`);
      console.error('This command rings only numbers you control, and a contact is a test contact only if config/contacts.csv says kind=test.');
      process.exit(1);
    }

    console.log(`Test call to ${contact.firstName} ${contact.lastName} (${contact.phoneE164 ?? 'no number'}), recorded as a test contact.`);
    if (!confirmed) {
      console.log('\nThis is what would happen. Nothing has been dialled.');
      console.log('  1. the compliance gate is asked: hours, plan, caller ID, kill switch, suppression, caps');
      console.log('  2. if it allows the dial, the voice provider rings the number from your caller ID');
      console.log('  3. when you answer, Lexi opens with the frozen opening: name, that she is an AI, Hexaware and Vinay, the reason, the recording notice');
      console.log('\nRun it with --yes to place the call. Have  npm run voice:serve  running and your tunnel up first.');
      process.exitCode = 2;
      return;
    }

    const publicBase = (process.env.PUBLIC_BASE_URL ?? '').trim();
    if (publicBase === '') {
      console.error('PUBLIC_BASE_URL is not set, so the provider has nowhere to ask what Lexi should say.');
      process.exit(1);
    }
    // A number may be dialled once a day. Spending that on a call nobody answers
    // on our side is a poor trade, so check the server is there first.
    if (!process.argv.includes('--no-health-check') && !(await serverIsUp(publicBase))) {
      console.error(`REFUSED: ${publicBase}/healthz did not answer.`);
      console.error('Start the server (npm run voice:serve) and your tunnel first. (--no-health-check skips this.)');
      process.exit(1);
    }

    const adapter = buildVapiAdapter(process.env, { assistantRequired: true });
    if (adapter === null) {
      console.error('VAPI_API_KEY and VAPI_ASSISTANT_ID are both needed to place a call. npm run voice:doctor says what is missing.');
      process.exit(1);
    }

    const result = await placeTestCall(
      {
        db: core.db,
        gate: core.gate,
        policy: core.policy,
        adapter,
        briefing: { db: core.db, identity: core.identity, claims: core.claims, pack: core.pack }
      },
      contactId
    );

    if (!result.ok) {
      console.error(`\nNOT PLACED (${result.refused})`);
      console.error(`  ${result.detail}`);
      for (const reason of result.reasons ?? []) console.error(`  - ${reason.code}: ${reason.detail}`);
      if (result.refused === 'GATE_DENIED') console.error('\nnpm run voice:doctor explains how to clear each of these.');
      if (result.refused === 'PROVIDER_UNCERTAIN') console.error(`\nThe call may have been placed. Call ${result.callId ?? ''} is recorded; the attempt has been counted.`);
      process.exit(1);
    }

    console.log(`\nCalling ${result.e164} from ${result.callerId}.`);
    console.log(`  call ${result.callId}`);
    console.log(`  provider id ${result.providerCallId}`);
    console.log('Answer it. Afterwards:  npm run voice:latency -- --call ' + result.callId.slice(0, 8));
  } finally {
    await core.db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
