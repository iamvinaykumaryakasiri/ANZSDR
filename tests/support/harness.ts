import { randomUUID } from 'node:crypto';
import { InMemoryKillSwitchStore, KillSwitch } from '../../src/compliance/kill-switch.js';
import { ComplianceGate } from '../../src/compliance/service.js';
import { CallPlanRepository } from '../../src/blackboard/call-plans.js';
import {
  PrismaAttemptStore,
  PrismaAuditLog,
  PrismaCallStateStore,
  PrismaContactStore,
  PrismaDncStore,
  PrismaSuppressionStore
} from '../../src/blackboard/compliance-stores.js';
import { DailyCallPlanner } from '../../src/orchestrator/planner.js';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import {
  EscalationRepository,
  PrismaJournal,
  SpendLedger,
  TaskRepository,
  TraceRepository
} from '../../src/blackboard/repositories.js';
import { CampaignDirector, type CampaignDirectorDeps } from '../../src/orchestrator/director.js';
import { TaskRegistry } from '../../src/orchestrator/registry.js';
import { prospectAccountKind, researchContactKind } from '../../src/orchestrator/kinds.js';
import { createStubProspector, type FixturePerson } from '../../src/agents/prospector/stub.js';
import { createStubScout, type AccountResearch } from '../../src/agents/scout/stub.js';
import type { Icp } from '../../src/blackboard/schemas.js';
import { calendar, policy } from './fixtures.js';

export const ANZ_ICP: Icp = {
  titles: ['chief data officer', 'head of data', 'director of engineering'],
  seniorities: ['c_suite', 'vp', 'director'],
  industries: ['financial services'],
  disqualifiers: ['intern', 'recruiter'],
  minimumScore: 60
};

export const PEOPLE_FIXTURES: Record<string, FixturePerson[]> = {
  'examplebank.com.au': [
    {
      externalId: 'apollo-1',
      firstName: 'Priya',
      lastName: 'Raman',
      title: 'Chief Data Officer',
      seniority: 'c_suite',
      linkedinUrl: 'https://www.linkedin.com/in/example-priya'
    },
    {
      externalId: 'apollo-2',
      firstName: 'Tom',
      lastName: 'Whitcombe',
      title: 'Head of Data Platforms',
      seniority: 'director'
    },
    {
      externalId: 'apollo-3',
      firstName: 'Sam',
      lastName: 'Keller',
      title: 'Technical Recruiter',
      seniority: 'manager'
    }
  ]
};

export const RESEARCH_FIXTURES: Record<string, AccountResearch> = {
  'examplebank.com.au': {
    whatTheyDo: 'A mid-tier Australian retail and business bank',
    size: '4,000 staff',
    findings: [
      {
        kind: 'announcement',
        fact: 'announced a three-year core banking modernisation in its FY25 results',
        sourceUrl: 'https://examplebank.com.au/news/fy25-results'
      },
      {
        kind: 'tech-signal',
        fact: 'is hiring six data platform engineers with Databricks in the requirements',
        sourceUrl: 'https://examplebank.com.au/careers/data-platform-engineer'
      },
      { kind: 'pressure', fact: 'a rumour about cost pressure in technology' },
      {
        kind: 'landmine',
        fact: 'an APRA remediation programme is under way',
        sourceUrl: 'https://examplebank.com.au/news/apra-update'
      }
    ]
  }
};

export interface Harness {
  db: Blackboard;
  tasks: TaskRepository;
  escalations: EscalationRepository;
  spend: SpendLedger;
  trace: TraceRepository;
  journal: PrismaJournal;
  killSwitch: KillSwitch;
  registry: TaskRegistry;
  director: CampaignDirector;
  plans: CallPlanRepository;
  gate: ComplianceGate;
  planner: DailyCallPlanner;
  campaignId: string;
  accountId: string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  now?: () => Date;
  weeklyUsdCeiling?: number;
  maxTasksPerTick?: number;
  people?: Record<string, FixturePerson[]>;
  research?: Record<string, AccountResearch>;
  /** Swap in a differently-behaved agent for a task kind, to exercise failure paths. */
  overrides?: (registry: TaskRegistry) => void;
  requireDailyPlan?: boolean;
  testContactsOnly?: boolean;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestBlackboard();
  const tasks = new TaskRepository(db);
  const escalations = new EscalationRepository(db);
  const spend = new SpendLedger(db);
  const trace = new TraceRepository(db);
  const journal = new PrismaJournal(db);
  const audit = new PrismaAuditLog(db);
  const killSwitch = new KillSwitch(new InMemoryKillSwitchStore(), audit);
  const plans = new CallPlanRepository(db);
  const compliancePolicy = policy({
    ...(options.requireDailyPlan !== undefined ? { requireDailyPlan: options.requireDailyPlan } : {}),
    ...(options.testContactsOnly !== undefined ? { testContactsOnly: options.testContactsOnly } : {})
  });
  const gate = new ComplianceGate({
    policy: compliancePolicy,
    calendar: calendar(),
    killSwitch,
    suppression: new PrismaSuppressionStore(db),
    dnc: new PrismaDncStore(db),
    attempts: new PrismaAttemptStore(db),
    calls: new PrismaCallStateStore(db),
    dayPlans: plans,
    contacts: new PrismaContactStore(db),
    audit
  });

  const registry = new TaskRegistry()
    .register(prospectAccountKind(createStubProspector(options.people ?? PEOPLE_FIXTURES)))
    .register(researchContactKind(createStubScout(options.research ?? RESEARCH_FIXTURES)));
  options.overrides?.(registry);

  const campaignId = randomUUID();
  const accountId = randomUUID();
  await db.campaign.create({
    data: {
      id: campaignId,
      name: 'ANZ BFSI pilot',
      market: 'AU',
      status: 'active',
      icp: JSON.stringify(ANZ_ICP),
      goal: JSON.stringify({ meetingsPerWeek: 5, maxUsdPerWeek: options.weeklyUsdCeiling ?? 50 })
    }
  });
  await db.account.create({
    data: {
      id: accountId,
      campaignId,
      name: 'Example Bank',
      domain: 'examplebank.com.au',
      country: 'AU',
      industry: 'financial services',
      priority: 1,
      status: 'new'
    }
  });

  const deps: CampaignDirectorDeps = {
    db,
    tasks,
    escalations,
    spend,
    journal,
    killSwitch,
    policy: compliancePolicy,
    registry,
    plans,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.weeklyUsdCeiling !== undefined ? { weeklyUsdCeiling: options.weeklyUsdCeiling } : {}),
    ...(options.maxTasksPerTick !== undefined ? { maxTasksPerTick: options.maxTasksPerTick } : {})
  };

  return {
    db,
    tasks,
    escalations,
    spend,
    trace,
    journal,
    killSwitch,
    registry,
    director: new CampaignDirector(deps),
    plans,
    gate,
    planner: new DailyCallPlanner({
      db,
      plans,
      gate,
      policy: compliancePolicy,
      calendar: calendar(),
      ...(options.now !== undefined ? { now: options.now } : {})
    }),
    campaignId,
    accountId,
    close: async () => {
      await db.$disconnect();
    }
  };
}

/** The task that starts the chain: find the people at this account. */
export function prospectTaskSpec(h: Harness) {
  return {
    kind: 'prospect-account',
    priority: 1,
    campaignId: h.campaignId,
    accountId: h.accountId,
    payload: {
      campaignId: h.campaignId,
      accountId: h.accountId,
      accountName: 'Example Bank',
      domain: 'examplebank.com.au',
      icp: ANZ_ICP,
      limit: 10
    }
  };
}
