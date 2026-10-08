/**
 * Find and enrich the people worth calling at one account.
 *
 *   npm run prospect -- --account kiwibank.co.nz            a dry run: prints the plan, spends nothing
 *   npm run prospect -- --account kiwibank.co.nz --yes      does it: this is what buys emails
 *
 * The dry run searches Apollo (which is free), scores everyone against the
 * campaign ICP, checks what we already hold and what we already bought, and then
 * prints what the run WOULD buy: how many emails, how many credits, how many
 * dollars, against the ceiling. It runs the real Prospector to do it, with
 * enrichment replaced by a version that plans and cannot buy, so what it prints
 * is what `--yes` will do and not a separate estimate of it.
 *
 * Nothing here dials, and nothing here researches: --yes queues one research task
 * per new contact, which `npm run tick` (or `npm run scout`) runs.
 *
 *   --limit N     how many people at most (default 10, never more than 25)
 *   --campaign    the campaign's name, if the account is in more than one
 */

import '../src/config/env-autoload.js';
import { InMemoryJournal } from '../src/agents/journal.js';
import { runAgent } from '../src/agents/runner.js';
import { createProspector, type EmailEnrichment } from '../src/agents/prospector/prospector.js';
import type { ProspectorInput, ProspectorOutput } from '../src/agents/prospector/contract.js';
import { createBlackboard } from '../src/blackboard/client.js';
import {
  EscalationRepository,
  PrismaJournal,
  SpendLedger,
  TaskRepository,
  TraceRepository
} from '../src/blackboard/repositories.js';
import { campaignGoalSchema, decode, icpSchema } from '../src/blackboard/schemas.js';
import { createPhase3Runtime } from '../src/data/runtime.js';
import { runTaskOnce } from '../src/data/run-task.js';
import { TaskRegistry } from '../src/orchestrator/registry.js';
import { PROSPECT_ACCOUNT } from '../src/orchestrator/kinds.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const domain = arg('account')?.trim().toLowerCase();
  if (domain === undefined || domain === '' || domain.startsWith('--')) {
    console.error('usage: npm run prospect -- --account <domain> [--yes] [--limit N] [--campaign <name>]');
    process.exit(2);
  }
  const spendIt = flag('yes');
  const limit = Math.min(25, Math.max(1, Number(arg('limit') ?? 10) || 10));

  const db = createBlackboard();
  try {
    const accounts = await db.account.findMany({ where: { domain }, include: { campaign: true } });
    const named = arg('campaign');
    const matching = named === undefined ? accounts : accounts.filter((a) => a.campaign.name === named);
    if (matching.length === 0) {
      console.error(`no account with domain ${domain}${named !== undefined ? ` in campaign "${named}"` : ''}.`);
      console.error('Add it on the account desk or in config/accounts.csv and run npm run accounts:import.');
      process.exit(1);
    }
    const account = matching.length === 1 ? matching[0] : matching.find((a) => a.campaign.status === 'active');
    if (account === undefined) {
      console.error(`${domain} is in ${matching.length} campaigns, none active. Pick one with --campaign "<name>".`);
      process.exit(1);
    }

    const spend = new SpendLedger(db);
    const runtime = await createPhase3Runtime({ db, spend });
    if (runtime.prospector === undefined || runtime.apollo === undefined) {
      console.error(`\n${runtime.notes[0] ?? 'The Prospector is not available.'}`);
      console.error('Create a key at Settings > Integrations > API in Apollo and put it in .env (docs/APOLLO-SETUP.md).');
      process.exit(1);
    }

    const icp = icpSchema.parse(JSON.parse(account.campaign.icp));
    const goal = decode(campaignGoalSchema, 'Campaign.goal', account.campaign.goal);
    const input: ProspectorInput = {
      campaignId: account.campaignId,
      accountId: account.id,
      accountName: account.name,
      domain,
      icp,
      limit
    };

    const spentThisWeek = await spend.totalThisWeek(new Date());
    console.log(`\n${account.name} (${domain}) in "${account.campaign.name}"`);
    console.log(`  minimum ICP score to enrich: ${icp.minimumScore}`);
    console.log(`  spent this week: $${spentThisWeek.toFixed(2)} of a $${goal.maxUsdPerWeek.toFixed(2)} ceiling`);
    for (const note of runtime.notes) console.log(`  note: ${note}`);

    if (!spendIt) {
      const planOnly: EmailEnrichment = {
        planEmailStage: (r) => runtime.enrichment.planEmailStage(r),
        enrichEmailsWithinBudget: async (requests) => ({
          outcomes: new Map(),
          deferred: requests,
          credits: 0,
          usd: 0,
          savedContacts: 0,
          notes: ['dry run: nothing was bought']
        })
      };
      const dry = createProspector({ db, directory: runtime.apollo, enrichment: planOnly, config: runtime.config });
      const journal = new InMemoryJournal();
      console.log('\nDRY RUN. Searching Apollo (free), scoring, and working out what would be bought...\n');
      const outcome = await runAgent(dry, input, { taskId: 'dry-run', journal });
      if (outcome.status === 'escalated') {
        console.error(`could not plan: ${outcome.failure.message}`);
        process.exit(1);
      }
      for (const t of journal.traces.filter((x) => x.actor === 'prospector' && x.kind === 'note')) console.log(`  ${t.summary}`);
      const out: ProspectorOutput = outcome.output;
      console.log(`\n  ${out.rejected.length} not taken:`);
      for (const r of out.rejected.slice(0, 15)) console.log(`    ${r.externalId}: ${r.reason}`);
      if (out.rejected.length > 15) console.log(`    ... and ${out.rejected.length - 15} more`);
      console.log('\nNothing was spent. Re-run with --yes to buy the emails and create the contacts.');
      return;
    }

    const registry = new TaskRegistry();
    if (runtime.prospectKind !== undefined) registry.register(runtime.prospectKind);
    const tasks = new TaskRepository(db);
    const task = await tasks.create({
      kind: PROSPECT_ACCOUNT,
      priority: 1,
      campaignId: account.campaignId,
      accountId: account.id,
      payload: input
    });
    console.log('\nSPENDING (--yes). Running the Prospector...\n');
    const result = await runTaskOnce(
      { db, tasks, escalations: new EscalationRepository(db), spend, journal: new PrismaJournal(db), registry },
      task.id
    );
    for (const t of await new TraceRepository(db).forTask(task.id)) console.log(`  ${t.actor}: ${t.summary}`);
    if (result.status === 'escalated') {
      console.error(`\nescalated: ${result.reason}`);
      process.exit(1);
    }
    console.log(`\ndone. ${result.status === 'done' ? result.followOn : 0} research task(s) queued; run npm run tick (or npm run scout -- --contact <id>) to research them.`);
    console.log(`Apollo credits this run: ${runtime.apollo.credits.totalCredits} (about $${runtime.apollo.credits.totalUsd.toFixed(2)}), recorded in the spend ledger.`);
  } finally {
    await db.$disconnect();
  }
}

await main();
