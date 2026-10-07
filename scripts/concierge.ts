/**
 * Concierge and the CRM from the terminal.
 *
 *   npm run concierge:preview [-- you@x.com]  a sample meeting request, as an .eml in data/outbox
 *                                          (address defaults to operator.email; pass one to preview without editing config)
 *   npm run concierge:nudge                send the one 24-hour reminder to any request still waiting
 *   npm run concierge:reply -- reply.txt   apply a CONFIRMED / RESCHEDULE / REJECT reply from a file
 *   npm run crm:sync [-- path.xlsx]        rebuild the CRM workbook (default data/crm.xlsx)
 *
 * Mail written here goes to data/outbox as .eml files, not to a mail server:
 * no transactional provider is configured yet (brief section 15 item 6), and
 * the system can only ever address the operator whichever mailer it is given.
 *
 * `preview` is also how to answer a question no test can: open the .eml in
 * your own mail client and see whether the .ics attachment survives it.
 */

import '../src/config/env-autoload.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlackboard } from '../src/blackboard/client.js';
import { PrismaSuppressionStore } from '../src/blackboard/compliance-stores.js';
import { MeetingRequestRepository } from '../src/blackboard/meetings.js';
import { loadIdentity } from '../src/agents/caller/identity.js';
import { applyOperatorReply } from '../src/agents/concierge/apply-reply.js';
import { FileMailer } from '../src/agents/concierge/file-mailer.js';
import { buildMeetingEmail, type MeetingRequest } from '../src/agents/concierge/meeting-email.js';
import { runNudges } from '../src/agents/concierge/nudge.js';
import { operatorOnly } from '../src/agents/concierge/ports.js';
import { syncWorkbook } from '../src/crm/workbook.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTBOX = resolve(ROOT, process.env.OUTBOX_DIR ?? 'data/outbox');
const FROM = process.env.MAIL_FROM ?? 'anz-voice-sdr@localhost';

const identity = () => loadIdentity(resolve(ROOT, 'config/agent.yaml'));

function operatorEmail(): string {
  const email = identity().operator.email.trim();
  if (email === '') {
    console.error('No operator email is set. Put it in config/agent.yaml under operator.email (brief section 15 item 6),\nor preview without it:  npm run concierge:preview -- you@example.com');
    process.exit(1);
  }
  return email;
}

function mailer(to: string) {
  return operatorOnly(new FileMailer({ dir: OUTBOX, from: FROM }), [to]);
}

/** A believable request, so the .eml shows what Vinay will actually receive. */
function sample(operator: string): MeetingRequest {
  const operatorName = identity().operator.name;
  return {
    requestId: '3f2a9c10-0000-4000-8000-000000000000',
    prospect: {
      name: 'Priya Raman',
      firstName: 'Priya',
      title: 'Head of Data',
      company: 'Kiwibank',
      phone: '+64211234567',
      email: 'priya@kiwibank.co.nz',
      emailSource: 'confirmed_on_call',
      linkedinUrl: 'https://www.linkedin.com/in/example'
    },
    windows: [
      { saidAs: 'Tuesday morning', startsAt: '2026-10-13T09:00:00+13:00', endsAt: '2026-10-13T12:00:00+13:00' },
      { saidAs: 'after 3pm Thursday', startsAt: '2026-10-15T15:00:00+13:00', endsAt: '2026-10-15T17:00:00+13:00' }
    ],
    timezone: 'Pacific/Auckland',
    attendees: ['her head of architecture'],
    hypothesis: 'SAMPLE: mid-way through a core platform rebuild and likely to want a second view on delivery risk.',
    hookUsed: 'SAMPLE: the platform rebuild',
    summary: [
      'SAMPLE CALL: this is not a real prospect.',
      'She is mid-way through a core platform rebuild.',
      'She was open to twenty minutes with Vinay.',
      'She is free Tuesday morning or Thursday after 3pm, Auckland time.',
      'She gave her work email and asked for an invite.'
    ],
    objections: [{ saidAs: 'We are mid-way through it, honestly.', handledAs: 'Said it was a short permission call and offered twenty minutes later.' }],
    operator: { name: operatorName, firstName: operatorName.split(/\s+/)[0] ?? operatorName, email: operator }
  };
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'preview': {
      const given = process.argv[3];
      if (given !== undefined && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(given)) {
        console.error(`"${given}" does not look like an email address.`);
        process.exit(1);
      }
      const to = given ?? operatorEmail();
      const built = buildMeetingEmail(sample(to));
      const sent = await mailer(to).send(built);
      console.log(`Written to ${sent.where ?? OUTBOX}`);
      console.log('Open it in your mail client and check the invite (.ics) is offered as a calendar event.');
      return;
    }

    case 'nudge': {
      const to = operatorEmail();
      const db = createBlackboard();
      try {
        const results = await runNudges({
          db,
          meetings: new MeetingRequestRepository(db),
          mailer: mailer(to),
          operatorEmail: to,
          now: () => new Date()
        });
        if (results.length === 0) console.log('Nothing is waiting more than 24 hours.');
        for (const r of results) console.log(`${r.status.padEnd(7)} ${r.requestId}  ${r.detail}`);
      } finally {
        await db.$disconnect();
      }
      return;
    }

    case 'reply': {
      const file = process.argv[3];
      if (file === undefined) {
        console.error('Usage: npm run concierge:reply -- <file containing the reply, quoted original included>');
        process.exit(1);
      }
      const db = createBlackboard();
      try {
        const result = await applyOperatorReply(
          {
            db,
            meetings: new MeetingRequestRepository(db),
            suppressions: new PrismaSuppressionStore(db),
            now: () => new Date()
          },
          readFileSync(resolve(file), 'utf8')
        );
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await db.$disconnect();
      }
      return;
    }

    case 'crm': {
      const path = resolve(ROOT, process.argv[3] ?? process.env.CRM_WORKBOOK_PATH ?? 'data/crm.xlsx');
      const db = createBlackboard();
      try {
        const counts = await syncWorkbook(db, path, new Date());
        console.log(`Wrote ${path}`);
        console.log(`  ${counts.meetingRequests} meeting requests, ${counts.calls} calls, ${counts.contacts} contacts, ${counts.accounts} accounts`);
        console.log('It is a view: edits made in Excel are overwritten at the next sync.');
      } finally {
        await db.$disconnect();
      }
      return;
    }

    default:
      console.error('Usage: concierge.ts preview | nudge | reply <file> | crm [path]');
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
