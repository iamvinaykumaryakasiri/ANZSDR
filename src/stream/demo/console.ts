/**
 * Assembling the demo console.
 *
 * A separate SQLite file, a gate that is the real gate, a kill switch that is the
 * real kill switch with nothing behind it but memory, and a simulator for the live
 * call. What it does not have is any way out: no dialler, no voice provider, no
 * Twilio, no mailer. The deps it hands the routes contain none of those, so
 * "demo mode can never dial or send" is a property of what is wired, not a promise
 * about what will not be called.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { loadIdentity } from '../../agents/caller/identity.js';
import { buildOpening } from '../../agents/caller/opening.js';
import { CallPlanRepository } from '../../blackboard/call-plans.js';
import { applyMigrations, createBlackboard, resolveDatabaseUrl, type Blackboard } from '../../blackboard/client.js';
import {
  PrismaAttemptStore,
  PrismaAuditLog,
  PrismaCallStateStore,
  PrismaContactStore,
  PrismaDncStore,
  PrismaSuppressionStore
} from '../../blackboard/compliance-stores.js';
import { MeetingRequestRepository } from '../../blackboard/meetings.js';
import { InMemoryAuditLog } from '../../compliance/audit.js';
import { HolidayCalendar } from '../../compliance/holidays.js';
import { InMemoryKillSwitchStore, KillSwitch } from '../../compliance/kill-switch.js';
import { loadPolicy, loadPolicyFromObject, type CompliancePolicy } from '../../compliance/policy.js';
import { ComplianceGate } from '../../compliance/service.js';
import { REPO_ROOT } from '../../config/env.js';
import { consoleBus, type ConsoleBus } from '../bus.js';
import { operatorFrom, type ConsoleDeps } from '../deps.js';
import { stamp } from '../util.js';
import { illustrativeGateInstant } from './clock.js';
import { LiveCallSimulator, type SimulatorOptions } from './simulator.js';
import { seedDemo, type SeedSummary } from './seed.js';

export const DEFAULT_DEMO_DB = 'data/demo/console-demo.db';

/**
 * The demo database must be unmistakably the demo's: "demo" in its name, and not
 * the file the real system uses. Checked before anything is created or deleted,
 * because starting the demo deletes and rebuilds its file.
 */
export function assertDemoDatabase(path: string, env: Record<string, string | undefined> = process.env): string {
  const absolute = resolve(REPO_ROOT, path);
  if (!/demo/i.test(basename(absolute))) {
    throw new Error(`the demo database must have "demo" in its file name, and ${absolute} does not`);
  }
  const real = new Set<string>([resolve(REPO_ROOT, 'data/anzsdr.db')]);
  const fromEnv = env.DATABASE_URL;
  if (fromEnv !== undefined && fromEnv.startsWith('file:')) {
    real.add(resolveDatabaseUrl(fromEnv).slice('file:'.length).split('?')[0] as string);
  }
  if (real.has(absolute)) {
    throw new Error(`${absolute} is the real blackboard; the demo will not touch it`);
  }
  return absolute;
}

/**
 * The real policy with the few things a sample world needs. The statutory windows
 * are not here to loosen: they live in code, and the demo's gate applies them like
 * any other. The demo needs a caller ID (so the queue is not blocked wholesale by
 * its absence), test mode off (its people are not the operator's phones), and the
 * holiday calendar not demanded to be signed off.
 */
export function demoPolicy(real: CompliancePolicy): CompliancePolicy {
  return loadPolicyFromObject({
    ...real,
    caller_id: { ...real.caller_id, au_number: '+61255500100', nz_number: '+6495550100' },
    holidays: { require_verified_calendar: false },
    dialling: { test_contacts_only: false }
  });
}

export interface DemoConsole {
  deps: ConsoleDeps;
  db: Blackboard;
  simulator: LiveCallSimulator;
  summary: SeedSummary;
  dbPath: string;
  gateAt: Date;
  close(): Promise<void>;
}

export interface DemoOptions {
  dbPath?: string;
  now?: () => Date;
  bus?: ConsoleBus;
  root?: string;
  simulator?: Partial<Pick<SimulatorOptions, 'sleep' | 'random' | 'turnDelayMs' | 'gapMs'>>;
}

export async function createDemoConsole(options: DemoOptions = {}): Promise<DemoConsole> {
  const root = options.root ?? REPO_ROOT;
  const dbPath = assertDemoDatabase(options.dbPath ?? DEFAULT_DEMO_DB);
  const now = options.now ?? (() => new Date());
  const bus = options.bus ?? consoleBus;

  // A fresh world each time, so the dates in it are always about now.
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = createBlackboard(`file:${dbPath}`);
  await applyMigrations(db);

  const policy = demoPolicy(loadPolicy(resolve(root, 'config/policy.yaml')));
  const calendar = HolidayCalendar.fromFiles([resolve(root, 'config/holidays/au.json'), resolve(root, 'config/holidays/nz.json')]);
  const plans = new CallPlanRepository(db);
  const audit = new PrismaAuditLog(db);
  // The real KillSwitch, backed by memory: Stop all works in the demo and cannot
  // touch the file the real system's switch lives in.
  const killSwitch = new KillSwitch(new InMemoryKillSwitchStore(), new InMemoryAuditLog());

  const gate = new ComplianceGate({
    policy,
    calendar,
    killSwitch,
    suppression: new PrismaSuppressionStore(db),
    dnc: new PrismaDncStore(db),
    attempts: new PrismaAttemptStore(db),
    calls: new PrismaCallStateStore(db),
    dayPlans: plans,
    contacts: new PrismaContactStore(db),
    audit
  });

  const identity = loadIdentity(resolve(root, 'config/agent.yaml'));
  // Nothing in the demo mails anyone, so the operator address is left out of it.
  identity.operator.email = '';

  const gateAt = illustrativeGateInstant(now(), policy, calendar);
  const summary = await seedDemo(db, { now: now(), gateAt, policy, calendar, gate, plans, identity });

  const simulator = new LiveCallSimulator({
    bus,
    killSwitch,
    now,
    openingFor: (prospect) =>
      buildOpening({ identity, reason: `I'm calling about ${prospect.hook}.` }).map((segment) => segment.text),
    ...options.simulator
  });

  const gateNote =
    gateAt.getTime() <= now().getTime()
      ? 'Queue verdicts are the real compliance gate, evaluated now.'
      : `Queue verdicts are the real compliance gate, evaluated as at ${stamp(gateAt, policy.operational_timezone)} Sydney time, the next time calling is lawful.`;

  const deps: ConsoleDeps = {
    mode: 'demo',
    db,
    policy,
    calendar,
    gate,
    killSwitch,
    plans,
    meetings: new MeetingRequestRepository(db),
    suppressions: new PrismaSuppressionStore(db),
    audit,
    operator: operatorFrom(identity.operator),
    bus,
    live: simulator,
    now,
    gateAt: () => gateAt,
    env: {},
    demo: {
      note: `Demo data: ${gateNote}`,
      apolloCreditsRemaining: 1840,
      providers: [
        { name: 'Blackboard (database)', status: 'ok', detail: 'demo: a separate sample database' },
        { name: 'Holiday calendar', status: 'ok', detail: 'demo' },
        { name: 'Anthropic', status: 'ok', detail: 'demo: simulated' },
        { name: 'Apollo', status: 'ok', detail: 'demo: simulated; the credit balance is a sample figure' },
        { name: 'Voice provider', status: 'degraded', detail: 'demo: a simulated latency warning, to show how one reads' },
        { name: 'Twilio', status: 'ok', detail: 'demo: simulated' },
        { name: 'Meeting-request mail', status: 'not_configured', detail: 'demo: this mode can never send mail' }
      ]
    }
  };

  return {
    deps,
    db,
    simulator,
    summary,
    dbPath,
    gateAt,
    close: async () => {
      simulator.stop();
      await db.$disconnect();
    }
  };
}

