/**
 * Make a test contact eligible for the day plan.
 *
 *   npm run voice:ready -- --contact <testContactId>
 *
 * Contacts imported from config/contacts.csv arrive as `enriched`. The call plan
 * lists only `researched` or `queued` contacts, and the compliance gate lets a
 * dial through only for someone on the approved plan - so without this, approving
 * the plan would never let a test call through.
 *
 * It changes the status of a contact marked `test` and of nothing else; a real
 * prospect is refused, because a prospect becomes `researched` by being
 * researched.
 */

import '../src/config/env-autoload.js';
import { loadCore } from '../src/voice/runtime.js';

async function main(): Promise<void> {
  const i = process.argv.indexOf('--contact');
  const id = i === -1 ? undefined : process.argv[i + 1];
  if (id === undefined || id === '') {
    console.error('Usage: npm run voice:ready -- --contact <testContactId>');
    process.exit(2);
  }
  const core = loadCore(process.env);
  try {
    const contact = await core.db.contact.findUnique({ where: { id } });
    if (contact === null) {
      console.error(`No contact ${id}.`);
      process.exit(1);
    }
    if (contact.kind !== 'test') {
      console.error(`REFUSED: ${contact.firstName} ${contact.lastName} is not a test contact. This command only touches numbers you control.`);
      process.exit(1);
    }
    await core.db.contact.update({ where: { id }, data: { status: 'researched', updatedAt: new Date() } });
    console.log(`${contact.firstName} ${contact.lastName} is now researched, so the next plan will list them.`);
    console.log('Next:  npm run plan -- draft  then  npm run plan -- approve');
  } finally {
    await core.db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
