/**
 * Shared fixtures for the Phase 7 tests: a claim index, fake reviewers and
 * simulators for the gate, and a way to put calls with a known history onto the
 * blackboard.
 */

import { randomUUID } from 'node:crypto';
import type { Blackboard } from '../../src/blackboard/client.js';
import type { CallOutcome } from '../../src/blackboard/schemas.js';
import { ClaimIndex } from '../../src/knowledge/claims.js';
import { loadCoachConfigFromObject, type CoachConfig } from '../../src/playbook/config.js';
import { preflightVariant, type GateReport } from '../../src/playbook/gate.js';
import type { ComplianceReviewer } from '../../src/playbook/review.js';
import type { PlaybookContent, PlaybookSet } from '../../src/playbook/schema.js';
import { SCENARIO_KINDS, type AdversarialSimulator, type SimulationReport } from '../../src/playbook/simulation-types.js';
import { PlaybookStore, type Assignment } from '../../src/playbook/store.js';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');

export function coachConfig(overrides: { promotion?: Record<string, unknown> } = {}): CoachConfig {
  const raw = parseYaml(readFileSync(resolve(ROOT, 'config/coach.yaml'), 'utf8')) as { promotion: Record<string, unknown> };
  return loadCoachConfigFromObject({ ...raw, promotion: { ...raw.promotion, ...overrides.promotion } });
}

export const CLAIM_ID = 'company.ownership';
export const CLAIM_TEXT = 'Hexaware has been part of the Carlyle Group since 2021.';

export function claimIndex(statuses: Partial<Record<string, 'approved' | 'draft' | 'rejected'>> = {}): ClaimIndex {
  const claim = (id: string, text: string, status: 'approved' | 'draft' | 'rejected', markets: string[] = ['AU', 'NZ']) => ({
    id,
    text,
    kind: 'fact',
    status,
    markets,
    sources: [{ kind: 'operator', ref: 'Vinay Kumar', quote: text, retrievedAt: '2026-10-01' }],
    conflictsWith: []
  });
  return ClaimIndex.fromObject({
    version: 1,
    claims: [
      claim(CLAIM_ID, CLAIM_TEXT, statuses[CLAIM_ID] ?? 'approved'),
      claim('company.draft', 'Hexaware has an office in somewhere.', statuses['company.draft'] ?? 'draft'),
      claim('company.au-only', 'Hexaware has a team in Sydney.', statuses['company.au-only'] ?? 'approved', ['AU'])
    ]
  });
}

export const GOOD_HOOK = {
  slot: 'hook',
  template: 'I read about {{company}} and one thing stood out to me: {{hook}}.'
} satisfies PlaybookContent;

export const GOOD_VALUE = {
  slot: 'value-statement',
  template: `{{claim:${CLAIM_ID}}} That is why a short conversation might be worth your time, {{firstName}}.`
} satisfies PlaybookContent;

/** A reviewer that returns what it is told. */
export function reviewer(answer: unknown = { compliant: true, violations: [] }, instanceId = 'reviewer-1'): ComplianceReviewer & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    instanceId,
    prompts,
    review: async (prompt) => {
      prompts.push(prompt);
      return answer;
    }
  };
}

export function passingReport(): SimulationReport {
  return {
    scenarios: SCENARIO_KINDS.map((kind) => ({ id: `${kind}-1`, kind, passed: true, failures: [] })),
    openingIntact: true
  };
}

export function simulator(report: SimulationReport = passingReport()): AdversarialSimulator & { calls: number } {
  const sim = {
    calls: 0,
    run: async (_c: PlaybookContent, _champions: PlaybookSet): Promise<SimulationReport> => {
      sim.calls += 1;
      return report;
    }
  };
  return sim;
}

/** A gate report that passed, made by the real gate over fakes. */
export async function passed(content: PlaybookContent, champions: PlaybookSet = {}): Promise<GateReport> {
  const report = await preflightVariant(content, {
    claims: claimIndex(),
    markets: ['AU', 'NZ'],
    reviewer: reviewer(),
    proposerInstanceId: 'proposer-1',
    simulator: simulator(),
    champions
  });
  if (report.verdict !== 'pass') throw new Error(`fixture should pass the gate: ${report.reasons.join('; ')}`);
  return report;
}

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

export interface World {
  campaignId: string;
  accountId: string;
  contactId: string;
}

export async function world(db: Blackboard, over: { seniority?: string; industry?: string; country?: 'AU' | 'NZ'; phone?: string } = {}): Promise<World> {
  const campaignId = randomUUID();
  const accountId = randomUUID();
  const contactId = randomUUID();
  await db.campaign.create({
    data: {
      id: campaignId,
      name: 'NZ banking pilot',
      market: over.country ?? 'NZ',
      status: 'active',
      icp: JSON.stringify({ titles: [], seniorities: [], industries: [], disqualifiers: [] }),
      goal: JSON.stringify({ meetingsPerWeek: 3, maxUsdPerWeek: 25 })
    }
  });
  await db.account.create({
    data: {
      id: accountId,
      campaignId,
      name: 'Kiwibank',
      domain: `${accountId.slice(0, 8)}.example.co.nz`,
      country: over.country ?? 'NZ',
      industry: over.industry ?? 'financial services',
      priority: 1,
      status: 'calling'
    }
  });
  await db.contact.create({
    data: {
      id: contactId,
      accountId,
      campaignId,
      firstName: 'Priya',
      lastName: 'Raman',
      title: 'Head of Data',
      seniority: over.seniority ?? 'director',
      status: 'contacted',
      kind: 'test',
      phoneE164: over.phone ?? '+6444960000',
      phoneLine: 'fixed'
    }
  });
  return { campaignId, accountId, contactId };
}

export interface CallSpec {
  at: Date;
  durationSec?: number;
  outcome?: CallOutcome | null;
  sentiment?: 'positive' | 'neutral' | 'negative' | 'unknown';
  defects?: Array<{ kind: string; detail: string; atSecond?: number }>;
  marks?: Array<{ section: string; atSecond: number }>;
  assignment?: Assignment;
  hook?: string;
  objections?: Array<{ saidAs: string; handledAs: string }>;
  attentionLostAtSec?: number;
  endedReason?: string;
}

export async function addCall(db: Blackboard, w: World, spec: CallSpec, store?: PlaybookStore): Promise<string> {
  const id = randomUUID();
  const duration = spec.durationSec ?? 60;
  await db.call.create({
    data: {
      id,
      contactId: w.contactId,
      accountId: w.accountId,
      campaignId: w.campaignId,
      startedAt: spec.at,
      endedAt: new Date(spec.at.getTime() + duration * 1000),
      durationSec: duration,
      outcome: spec.outcome === undefined ? 'not_interested' : spec.outcome,
      sectionMarks: JSON.stringify(spec.marks ?? []),
      defects: JSON.stringify(spec.defects ?? []),
      endedReason: spec.endedReason ?? null
    }
  });
  await db.callRecord.create({
    data: {
      id: `${id}-record`,
      callId: id,
      sentiment: spec.sentiment ?? 'neutral',
      hook: spec.hook ?? '',
      objections: JSON.stringify(spec.objections ?? []),
      attentionLostAtSec: spec.attentionLostAtSec ?? null
    }
  });
  if (spec.assignment !== undefined) {
    if (store === undefined) throw new Error('an assignment needs a store to record it');
    await store.recordAssignment(id, spec.assignment);
  }
  return id;
}

/**
 * `n` eligible conversations for one arm, `requests` of which asked for a meeting.
 * Every call is past the opener, has an outcome and a known neutral sentiment.
 */
export async function addArm(
  db: Blackboard,
  w: World,
  store: PlaybookStore,
  arm: { assignment: Assignment; n: number; requests: number; at: Date; extra?: (i: number) => Partial<CallSpec> }
): Promise<void> {
  for (let i = 0; i < arm.n; i++) {
    await addCall(
      db,
      w,
      {
        at: new Date(arm.at.getTime() + i * 60_000),
        outcome: i < arm.requests ? 'meeting_requested' : 'not_interested',
        assignment: arm.assignment,
        ...(arm.extra?.(i) ?? {})
      },
      store
    );
  }
}
