/**
 * Run one Campaign Director tick and print what it decided.
 *
 *   npm run tick
 *
 * The scheduler in later phases calls the same `tick()`; this is the same thing
 * by hand, so the decisions an operator sees here are the decisions the system
 * makes on its own.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlackboard } from '../blackboard/client.js';
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

  // Phase 2 ships stubs. Phase 3 swaps the handlers and the tools; the registry,
  // the contracts and everything below this line stay as they are.
  const fixtures = loadFixtures();
  const registry = new TaskRegistry()
    .register(prospectAccountKind(createStubProspector(fixtures.people ?? {})))
    .register(researchContactKind(createStubScout(fixtures.research ?? {})));

  const director = new CampaignDirector({
    db,
    tasks: new TaskRepository(db),
    escalations: new EscalationRepository(db),
    spend: new SpendLedger(db),
    journal: new PrismaJournal(db),
    killSwitch,
    policy,
    registry,
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

  await db.$disconnect();
}

await main();
