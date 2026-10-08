/**
 * Run one Campaign Director tick and print what it decided.
 *
 *   npm run tick
 *
 * The scheduler in later phases calls the same `tick()`; this is the same thing
 * by hand, so the decisions an operator sees here are the decisions the system
 * makes on its own.
 */

import '../config/env-autoload.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlackboard } from '../blackboard/client.js';
import { CallPlanRepository } from '../blackboard/call-plans.js';
import {
  EscalationRepository,
  PrismaJournal,
  SpendLedger,
  TaskRepository
} from '../blackboard/repositories.js';
import { PrismaAuditLog } from '../blackboard/compliance-stores.js';
import { KillSwitch } from '../compliance/kill-switch.js';
import { loadPolicy } from '../compliance/policy.js';
import { FileKillSwitchStore } from '../ops/kill-switch-store.js';
import { CampaignDirector } from './director.js';
import { TaskRegistry } from './registry.js';
import { prospectAccountKind, researchContactKind } from './kinds.js';
import { createStubProspector, type FixturePerson } from '../agents/prospector/stub.js';
import { createStubScout, type AccountResearch } from '../agents/scout/stub.js';
import { createPhase3Runtime } from '../data/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

interface Fixtures {
  people?: Record<string, FixturePerson[]>;
  research?: Record<string, AccountResearch>;
}

/** Development fixtures for the stub agents. Absent in any real deployment. */
function loadFixtures(): Fixtures {
  const path = process.env.STUB_FIXTURES ?? resolve(ROOT, 'config/fixtures.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Fixtures;
}

async function main(): Promise<void> {
  const db = createBlackboard();
  const policy = loadPolicy(resolve(ROOT, 'config/policy.yaml'));
  const killSwitch = new KillSwitch(
    new FileKillSwitchStore(process.env.KILL_SWITCH_PATH ?? resolve(ROOT, 'data/kill-switch.json')),
    new PrismaAuditLog(db)
  );

  // Phase 3 supplies the real Prospector (needs APOLLO_API_KEY) and Scout (needs
  // ANTHROPIC_API_KEY). Where one is not configured the Phase 2 stub stands in,
  // so a tick without keys still runs against fixtures and spends nothing.
  const fixtures = loadFixtures();
  const phase3 = await createPhase3Runtime({ db, spend: new SpendLedger(db) });
  for (const note of phase3.notes) console.log(`  note: ${note}`);
  const registry = new TaskRegistry()
    .register(phase3.prospectKind ?? prospectAccountKind(createStubProspector(fixtures.people ?? {})))
    .register(phase3.researchKind ?? researchContactKind(createStubScout(fixtures.research ?? {})));

  const director = new CampaignDirector({
    db,
    tasks: new TaskRepository(db),
    escalations: new EscalationRepository(db),
    spend: new SpendLedger(db),
    journal: new PrismaJournal(db),
    killSwitch,
    policy,
    registry,
    plans: new CallPlanRepository(db),
    ...(process.env.WEEKLY_USD_CEILING !== undefined
      ? { weeklyUsdCeiling: Number(process.env.WEEKLY_USD_CEILING) }
      : {})
  });

  const report = await director.tick();
  for (const decision of report.decisions) console.log(`  ${decision}`);
  console.log(
    `\nran ${report.ranTasks} task(s): ${report.succeeded} finished, ${report.escalated} escalated, $${report.usdSpent.toFixed(4)} spent`
  );
  if (report.stopped !== null) console.log(`stopped: ${report.stopped}`);

  await phase3.close();
  await db.$disconnect();
}

await main();
