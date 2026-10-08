/**
 * Research one contact and store the dossier.
 *
 *   npm run scout -- --contact <id>              researches, and spends a little (a model call and a few searches)
 *   npm run scout -- --contact <id> --dry-run    prints what it would read and the most it could cost
 *
 * Scout reads the company's own site, whatever a few searches turn up, the
 * exchange announcements if the account is listed, and its job postings. It
 * does not read LinkedIn or any site that prohibits automated access, and it
 * obeys robots.txt. Every claim in the dossier it stores is checked against the
 * page it came from; what cannot be checked is dropped, and listed under
 * "unverified".
 *
 * Needs ANTHROPIC_API_KEY (a model and a search). Job postings also use Apollo
 * if APOLLO_API_KEY is set. Nothing here dials.
 */

import '../src/config/env-autoload.js';
import { createBlackboard } from '../src/blackboard/client.js';
import {
  EscalationRepository,
  PrismaJournal,
  SpendLedger,
  TaskRepository,
  TraceRepository
} from '../src/blackboard/repositories.js';
import { loadScoutModelConfig } from '../src/agents/scout/model.js';
import { SCOUT_BUDGET, type ScoutInput } from '../src/agents/scout/contract.js';
import { createPhase3Runtime } from '../src/data/runtime.js';
import { runTaskOnce } from '../src/data/run-task.js';
import { TaskRegistry } from '../src/orchestrator/registry.js';
import { RESEARCH_CONTACT } from '../src/orchestrator/kinds.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const contactId = arg('contact')?.trim();
  if (contactId === undefined || contactId === '' || contactId.startsWith('--')) {
    console.error('usage: npm run scout -- --contact <id> [--dry-run]');
    process.exit(2);
  }

  const db = createBlackboard();
  try {
    const contact = await db.contact.findUnique({ where: { id: contactId }, include: { account: true } });
    if (contact === null) {
      console.error(`no contact ${contactId}.`);
      process.exit(1);
    }
    const input: ScoutInput = {
      contactId: contact.id,
      contactName: `${contact.firstName} ${contact.lastName}`,
      title: contact.title,
      accountId: contact.accountId,
      accountName: contact.account.name,
      domain: contact.account.domain,
      ...(contact.linkedinUrl !== null ? { linkedinUrl: contact.linkedinUrl } : {})
    };

    const models = loadScoutModelConfig();
    console.log(`\n${input.contactName}, ${input.title} at ${input.accountName} (${input.domain})`);
    console.log(`  model: ${models.scout}; search: ${models.scout_search}`);
    console.log('  reads: the company site, up to four searches, exchange announcements if listed, Apollo job postings if a key is set');
    console.log('  does not read: LinkedIn or any site that prohibits automated access; robots.txt is obeyed');
    console.log(`  budget: at most $${SCOUT_BUDGET.maxUsd.toFixed(2)} and ${SCOUT_BUDGET.maxTurns} model turns`);
    if (input.linkedinUrl !== undefined) console.log('  the profile link is kept on the contact but not fetched');

    if (process.argv.includes('--dry-run')) {
      console.log('\nDry run: nothing was read and nothing was spent.');
      return;
    }

    const spend = new SpendLedger(db);
    const runtime = await createPhase3Runtime({ db, spend });
    for (const note of runtime.notes) console.log(`  note: ${note}`);
    if (runtime.researchKind === undefined) {
      console.error('\nScout is not available.');
      console.error('Set ANTHROPIC_API_KEY in .env (or the environment). Scout needs a model and a search provider.');
      process.exit(1);
    }

    const registry = new TaskRegistry().register(runtime.researchKind);
    const tasks = new TaskRepository(db);
    const task = await tasks.create({
      kind: RESEARCH_CONTACT,
      priority: 1,
      campaignId: contact.campaignId,
      accountId: contact.accountId,
      contactId: contact.id,
      payload: input
    });

    console.log('\nResearching...\n');
    const result = await runTaskOnce(
      { db, tasks, escalations: new EscalationRepository(db), spend, journal: new PrismaJournal(db), registry },
      task.id
    );
    for (const t of await new TraceRepository(db).forTask(task.id)) console.log(`  ${t.actor}: ${t.summary}`);
    if (result.status === 'escalated') {
      console.error(`\nescalated: ${result.reason}`);
      process.exit(1);
    }

    const dossier = await db.dossier.findFirst({ where: { contactId }, orderBy: { createdAt: 'desc' } });
    if (dossier !== null) {
      const hooks = JSON.parse(dossier.hooks) as Array<{ text: string; sourceUrl: string }>;
      const landmines = JSON.parse(dossier.landmines) as Array<{ fact: string; sourceUrl: string }>;
      const unverified = JSON.parse(dossier.unverified) as string[];
      console.log(`\nconfidence: ${dossier.confidence}`);
      console.log(`hypothesis: ${dossier.hypothesis}`);
      console.log(hooks.length === 0 ? 'hooks: none (the opening will be generic)' : 'hooks:');
      for (const h of hooks) console.log(`  - ${h.text}\n    ${h.sourceUrl}`);
      if (landmines.length > 0) {
        console.log('landmines:');
        for (const l of landmines) console.log(`  - ${l.fact}\n    ${l.sourceUrl}`);
      }
      if (unverified.length > 0) {
        console.log('unverified:');
        for (const u of unverified.slice(0, 10)) console.log(`  - ${u}`);
      }
    }
    console.log(`\ncost: $${result.status === 'done' ? result.usd.toFixed(4) : '0'} (model and search). Dossier stored.`);
  } finally {
    await db.$disconnect();
  }
}

await main();
