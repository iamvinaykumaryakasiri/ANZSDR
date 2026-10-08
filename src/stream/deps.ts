/**
 * What the console backend needs, gathered in one place.
 *
 * The console never builds its own rules. It is handed the same gate, kill
 * switch, policy and stores the rest of the system uses, and it reads them. That
 * is how "the console holds no business logic" stays true on this side too: the
 * only decisions made here are decisions about what to show.
 */

import { resolve } from 'node:path';
import type { z } from 'zod';
import { loadIdentity } from '../agents/caller/identity.js';
import type { Blackboard } from '../blackboard/client.js';
import { CallPlanRepository } from '../blackboard/call-plans.js';
import {
  PrismaAttemptStore,
  PrismaAuditLog,
  PrismaCallStateStore,
  PrismaContactStore,
  PrismaDncStore,
  PrismaSuppressionStore
} from '../blackboard/compliance-stores.js';
import { MeetingRequestRepository } from '../blackboard/meetings.js';
import { JsonlAuditLog, type AuditLog } from '../compliance/audit.js';
import { HolidayCalendar } from '../compliance/holidays.js';
import { KillSwitch } from '../compliance/kill-switch.js';
import { loadPolicy, type CompliancePolicy } from '../compliance/policy.js';
import type { SuppressionStore } from '../compliance/ports.js';
import { ComplianceGate } from '../compliance/service.js';
import { REPO_ROOT } from '../config/env.js';
import { FileKillSwitchStore } from '../ops/kill-switch-store.js';
import { consoleBus, type ConsoleBus } from './bus.js';
import type { healthSchema } from './contract.js';
import type { JarvisModel } from './jarvis.js';
import { DbLiveCallSource, type LiveCallSource } from './live-source.js';

export interface OperatorView {
  name: string;
  firstName: string;
  title: string;
  company: string;
  email: string;
}

export interface ConsoleDeps {
  /** 'demo' only on the separate sample database; the snapshot says so and the console must too. */
  mode: 'demo' | 'live';
  db: Blackboard;
  policy: CompliancePolicy;
  calendar: HolidayCalendar;
  /** Read for its verdicts. The console never calls `gate.request`, so it writes no dial audit of its own. */
  gate: ComplianceGate;
  killSwitch: KillSwitch;
  plans: CallPlanRepository;
  meetings: MeetingRequestRepository;
  suppressions: SuppressionStore;
  audit: AuditLog;
  operator: OperatorView;
  bus: ConsoleBus;
  live: LiveCallSource;
  now: () => Date;
  /**
   * The instant queue verdicts are evaluated at. The real clock on a real system.
   * Demo mode moves it to the next lawful window so the sample queue shows the
   * gate saying yes as well as no; see demo/clock.ts.
   */
  gateAt: (now: Date) => Date;
  env: Record<string, string | undefined>;
  /** Optional free-text routing for Jarvis. Read-only tools only; see jarvis.ts. */
  jarvisModel?: JarvisModel | undefined;
  /** Present only in demo mode: what the sample says about itself, and the figures a real system would fetch. */
  demo?: DemoOverrides | undefined;
}

export interface DemoOverrides {
  /** Appended to the standing-by note, to say how the sample differs from the real thing. */
  note: string;
  providers: z.infer<typeof healthSchema>['providers'];
  apolloCreditsRemaining: number;
}

export function operatorFrom(identity: { name: string; title: string; company: string; email: string }): OperatorView {
  return {
    name: identity.name,
    firstName: identity.name.split(/\s+/)[0] ?? identity.name,
    title: identity.title,
    company: identity.company,
    email: identity.email.trim()
  };
}

export interface LiveDepsOptions {
  db: Blackboard;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  bus?: ConsoleBus;
  root?: string;
  jarvisModel?: JarvisModel | undefined;
}

/**
 * The console wired to the real system: the same policy file, holiday calendars
 * and kill-switch file the command line uses, so Stop all here and `npm run kill`
 * are one switch.
 */
export function createLiveConsoleDeps(options: LiveDepsOptions): ConsoleDeps {
  const env = options.env ?? process.env;
  const root = options.root ?? REPO_ROOT;
  const { db } = options;

  const policy = loadPolicy(resolve(root, 'config/policy.yaml'));
  const calendar = HolidayCalendar.fromFiles([resolve(root, 'config/holidays/au.json'), resolve(root, 'config/holidays/nz.json')]);
  const plans = new CallPlanRepository(db);
  const dbAudit = new PrismaAuditLog(db);

  // The kill switch audits to the same JSONL file `npm run kill` does. It is a
  // file, not a row, so that it still works when the database is what has failed.
  const killSwitch = new KillSwitch(
    new FileKillSwitchStore(env.KILL_SWITCH_PATH ?? resolve(root, 'data/kill-switch.json')),
    new JsonlAuditLog(env.COMPLIANCE_AUDIT_PATH ?? resolve(root, 'data/compliance-audit.jsonl'))
  );

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
    audit: dbAudit
  });

  const identity = loadIdentity(resolve(root, 'config/agent.yaml'));

  return {
    mode: 'live',
    db,
    policy,
    calendar,
    gate,
    killSwitch,
    plans,
    meetings: new MeetingRequestRepository(db),
    suppressions: new PrismaSuppressionStore(db),
    audit: dbAudit,
    operator: operatorFrom(identity.operator),
    bus: options.bus ?? consoleBus,
    live: new DbLiveCallSource(db),
    now: options.now ?? (() => new Date()),
    gateAt: (now) => now,
    env,
    jarvisModel: options.jarvisModel
  };
}
