/**
 * The daily digest from the terminal.
 *
 *   npm run analyst:digest                     yesterday, on the operator's clock
 *   npm run analyst:digest -- --day 2026-10-06
 *   npm run analyst:digest -- --print          print it, write nothing
 *   npm run analyst:digest -- --json           the structured figures as JSON
 *
 * Unless `--print` is given, the digest is written to the outbox as an .eml,
 * addressed to the operator and nobody else: the mailer is wrapped in `operatorOnly`
 * inside `deliverDigest`, so no flag here can send it elsewhere. Like the
 * Concierge's mail, it is a file for now, not a message sent by a provider.
 */

import '../../config/env-autoload.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlackboard } from '../../blackboard/client.js';
import { FileKillSwitchStore } from '../../ops/kill-switch-store.js';
import { loadCoachConfig } from '../../playbook/config.js';
import { PlaybookStore } from '../../playbook/store.js';
import { describeError } from '../../playbook/util.js';
import { FileMailer } from '../concierge/file-mailer.js';
import { loadIdentity } from '../caller/identity.js';
import { InMemoryJournal } from '../journal.js';
import { runAgent } from '../runner.js';
import { createAnalyst, deliverDigest } from './agent.js';
import { dayContaining, shiftDays, OPERATOR_ZONE } from './metrics.js';
import { analystTools } from './tools.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): boolean => args.includes(name);
  const dayIndex = args.indexOf('--day');
  const now = new Date();
  const day = dayIndex >= 0 ? (args[dayIndex + 1] as string) : shiftDays(dayContaining(now, OPERATOR_ZONE), -1).date;

  const db = createBlackboard();
  try {
    const identity = loadIdentity(resolve(ROOT, 'config/agent.yaml'));
    const analyst = createAnalyst({
      tools: analystTools({
        db,
        store: new PlaybookStore(db),
        config: loadCoachConfig(resolve(ROOT, 'config/coach.yaml')),
        identity,
        killSwitch: new FileKillSwitchStore(process.env.KILL_SWITCH_PATH ?? resolve(ROOT, 'data/kill-switch.json'))
      })
    });

    const outcome = await runAgent(analyst, { day, generatedAt: now.toISOString() }, { taskId: 'analyst-digest', journal: new InMemoryJournal() });
    if (outcome.status !== 'succeeded') {
      console.error(`The digest could not be built (${outcome.failure.kind}): ${outcome.failure.message}`);
      process.exit(1);
    }
    const digest = outcome.output;

    if (flag('--json')) console.log(JSON.stringify(digest, null, 2));
    else console.log(`${digest.subject}\n\n${digest.text}`);

    if (flag('--print')) return;

    const to = identity.operator.email.trim();
    if (to === '') {
      console.error('No operator email is set in config/agent.yaml, so the digest was printed and not written to the outbox.');
      return;
    }
    const outbox = resolve(ROOT, process.env.OUTBOX_DIR ?? 'data/outbox');
    const sent = await deliverDigest(
      new FileMailer({ dir: outbox, from: process.env.MAIL_FROM ?? 'anz-voice-sdr@localhost' }),
      to,
      digest
    );
    console.error(`Written to ${sent.where ?? outbox}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});
