/**
 * Coach's week, as the orchestrator carries it out.
 *
 * The agent proposes; this is everything that happens to a proposal, and every
 * decision in it is the promotion gate's. In order:
 *
 *   1. evaluate the live challenger, if there is one: keep collecting, promote,
 *      withdraw it for regressing, or retire it as inconclusive
 *   2. watch any champion promoted recently against the one it replaced, and roll
 *      it back automatically if it regressed
 *   3. if no test is running, run Coach, put each proposal through the gate, and
 *      start the first survivor as the challenger
 *
 * `apply: false` (the default everywhere) does all the thinking - including the
 * gate's model calls, which cost money - and changes nothing: no row, no event, no
 * failure-memory entry. It reports what it would have done.
 */

import { z } from 'zod';
import type { Blackboard } from '../../blackboard/client.js';
import type { Market } from '../../compliance/types.js';
import type { ClaimIndex } from '../../knowledge/claims.js';
import type { CoachConfig } from '../../playbook/config.js';
import { diffContent, renderDiff } from '../../playbook/diff.js';
import { loadTestEvidence, loadWatchEvidence } from '../../playbook/evidence.js';
import { contentText, variantKey, type FailureMemory } from '../../playbook/failure-memory.js';
import {
  decideTest,
  monitorPromotion,
  preflightVariant,
  type ArmEvidence,
  type GateReport,
  type MonitorDecision,
  type TestDecision,
  type TestDecisionKind
} from '../../playbook/gate.js';
import type { ComplianceReviewer } from '../../playbook/review.js';
import { PLAYBOOK_SLOTS, versionName, type PlaybookSlot } from '../../playbook/schema.js';
import type { AdversarialSimulator } from '../../playbook/simulation-types.js';
import { PlaybookError, type PlaybookStore } from '../../playbook/store.js';
import { describeError, pct } from '../../playbook/util.js';
import type { Agent } from '../contract.js';
import type { AgentJournal } from '../journal.js';
import { runAgent, type AgentOutcome } from '../runner.js';
import type { CoachInput, CoachOutput } from './contract.js';

const DAY_MS = 86_400_000;

export interface CycleDeps {
  db: Blackboard;
  store: PlaybookStore;
  memory: FailureMemory;
  config: CoachConfig;
  claims: ClaimIndex;
  /** The markets Lexi calls in. A claim in a variant must be approved for each. */
  markets: Market[];
  reviewer: ComplianceReviewer;
  simulator: AdversarialSimulator;
  /** The proposer's instance id, so the reviewer can be refused if it is the same one. */
  proposerInstanceId: string;
  /** The frozen opening's lines, so audit flags quoting them are not counted against a variant. */
  openingTexts: string[];
  now: () => Date;
}

export interface ApplyOption {
  /** False reports without changing anything. */
  apply: boolean;
}

/* ------------------------------------------------------------------ */
/* 1. The live test                                                    */
/* ------------------------------------------------------------------ */

export interface EvaluationResult {
  slot: PlaybookSlot;
  version: number;
  championVersion: number | null;
  decision: TestDecision;
  champion: ArmEvidence;
  challenger: ArmEvidence;
  /** True when the decision was carried out. */
  applied: boolean;
  /** The change note, plain English. */
  note: string;
}

export interface EvaluateOptions extends ApplyOption {
  /** Carry out only these decisions; report the rest. `promote` uses this to promote and nothing else. */
  only?: readonly TestDecisionKind[];
}

export async function evaluateLiveTest(deps: CycleDeps, options: EvaluateOptions): Promise<EvaluationResult | null> {
  const challenger = await deps.store.liveChallenger();
  if (challenger === null) return null;

  const { slot, version } = challenger;
  const champion = await deps.store.champion(slot);
  const t = deps.config.promotion;
  const now = deps.now();

  const arms = await loadTestEvidence(deps.db, {
    slot,
    championVersion: champion?.version ?? null,
    challengerVersion: version,
    since: challenger.createdAt,
    until: now,
    thresholds: t,
    openingTexts: deps.openingTexts
  });

  let decision = decideTest(arms.champion, arms.challenger, t);
  const ageDays = (now.getTime() - challenger.createdAt.getTime()) / DAY_MS;
  if (decision.decision === 'continue' && ageDays > deps.config.proposals.maxChallengerAgeDays) {
    decision = {
      ...decision,
      decision: 'retire',
      reasons: [
        `retired as inconclusive: after ${Math.floor(ageDays)} days it has ${arms.challenger.completed} of ${t.minConversationsPerArm} completed conversations, and a test that cannot finish is not evidence`
      ]
    };
  }

  const name = versionName(slot, version);
  const reasons = decision.reasons.join('; ');
  const act = options.apply && (options.only === undefined || options.only.includes(decision.decision));
  let note: string;
  let applied = false;

  const evidence = {
    requestRate: decision.comparison.other.requestRate,
    conversations: arms.challenger.completed,
    minConversations: t.minConversationsPerArm,
    decidedAt: now.toISOString(),
    championArm: arms.champion,
    challengerArm: arms.challenger,
    comparison: {
      lift: decision.comparison.lift,
      liftP: decision.comparison.liftP,
      liftInterval: decision.comparison.liftInterval,
      regressions: decision.comparison.regressions
    }
  };

  switch (decision.decision) {
    case 'continue':
      note = `${name} is still being tested: ${reasons}`;
      break;

    case 'promote': {
      const change = renderDiff(diffContent(champion?.content ?? null, challenger.content));
      note = `${name} was promoted to champion: ${reasons}. What changed: ${change}`;
      if (act) {
        await deps.store.promote(slot, version, { note, evidence: { ...evidence, previousArm: arms.champion } });
        applied = true;
      }
      break;
    }

    case 'withdraw':
    case 'retire': {
      const withdrawn = decision.decision === 'withdraw';
      note = withdrawn
        ? `${name} was withdrawn and its calls returned to the champion: ${reasons}`
        : `${name} was retired without a verdict: ${reasons}`;
      if (act) {
        await deps.store.retireChallenger(slot, version, { kind: withdrawn ? 'withdrawn' : 'retired', note, evidence });
        await deps.memory.record({
          kind: withdrawn ? 'variant-withdrawn' : 'variant-inconclusive',
          key: variantKey(challenger.content),
          slot,
          summary: note,
          text: contentText(challenger.content),
          detail: { version, reasons: decision.reasons }
        });
        applied = true;
      }
      break;
    }
  }

  return { slot, version, championVersion: champion?.version ?? null, decision, champion: arms.champion, challenger: arms.challenger, applied, note };
}

/* ------------------------------------------------------------------ */
/* 2. Watching a promotion                                             */
/* ------------------------------------------------------------------ */

const armEvidenceSchema = z.object({
  eligible: z.number(),
  completed: z.number(),
  requests: z.number(),
  sentimentKnown: z.number(),
  negative: z.number(),
  defective: z.number(),
  hardFailures: z.number()
});

export interface MonitorResult {
  slot: PlaybookSlot;
  version: number;
  decision: MonitorDecision;
  applied: boolean;
  note: string;
}

/** Every champion promoted by Coach and not yet cleared, checked against the one it replaced. */
export async function monitorPromotions(deps: CycleDeps, options: ApplyOption): Promise<MonitorResult[]> {
  const results: MonitorResult[] = [];
  const now = deps.now();

  for (const slot of PLAYBOOK_SLOTS) {
    const champion = await deps.store.champion(slot);
    if (champion === null) continue;
    const promotedAt = typeof champion.evidence.promotedAt === 'string' ? new Date(champion.evidence.promotedAt) : null;
    const previous = armEvidenceSchema.safeParse(champion.evidence.previousArm);
    if (promotedAt === null || !previous.success || champion.evidence.monitoring === 'cleared') continue;

    const watch = await loadWatchEvidence(deps.db, {
      slot,
      version: champion.version,
      since: promotedAt,
      until: now,
      thresholds: deps.config.promotion,
      openingTexts: deps.openingTexts
    });
    const decision = monitorPromotion(previous.data, watch, deps.config.promotion, deps.config.monitoring.postPromotionMinConversations);
    const name = versionName(slot, champion.version);
    let note = `${name} is being watched against the version it replaced: ${decision.reasons.join('; ')}`;
    let applied = false;

    if (decision.status === 'rollback') {
      note = `${name} was rolled back automatically: ${decision.reasons.join('; ')}`;
      if (options.apply) {
        try {
          const { to } = await deps.store.rollback(slot, { note, evidence: { reasons: decision.reasons, watch } });
          await deps.memory.record({
            kind: 'variant-withdrawn',
            key: variantKey(champion.content),
            slot,
            summary: note,
            text: contentText(champion.content),
            detail: { version: champion.version, restoredVersion: to.version }
          });
          applied = true;
        } catch (error) {
          if (!(error instanceof PlaybookError)) throw error;
          // A slot promoted from nothing has nothing to return to. Say so loudly.
          note = `${name} regressed (${decision.reasons.join('; ')}) but could not be rolled back: ${describeError(error)}. It needs a person.`;
        }
      }
    } else if (decision.status === 'ok' && options.apply) {
      await deps.store.mergeEvidence(slot, champion.version, { monitoring: 'cleared', clearedAt: now.toISOString() });
      note = `${name} is cleared: ${decision.reasons.join('; ')}`;
      applied = true;
    }

    results.push({ slot, version: champion.version, decision, applied, note });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* 3. Proposals through the gate                                       */
/* ------------------------------------------------------------------ */

export type ProposalVerdict = 'started' | 'would-start' | 'passed-not-started' | 'rejected' | 'duplicate' | 'discarded';

export interface ProposalResult {
  verdict: ProposalVerdict;
  /** What this was, briefly. */
  summary: string;
  reasons: string[];
  report?: GateReport;
  version?: number;
}

export async function registerProposals(deps: CycleDeps, output: CoachOutput, options: ApplyOption): Promise<ProposalResult[]> {
  const results: ProposalResult[] = [];
  const slot = output.slot;
  if (slot === null) return results;

  const snapshot = await deps.store.snapshot();
  let testRunning = snapshot.challenger !== null;

  for (const d of output.discarded) {
    results.push({ verdict: 'discarded', summary: d.excerpt, reasons: [d.reason] });
    if (options.apply) {
      await deps.store.recordRejection(slot, `A proposal was thrown out before the gate: ${d.reason}`, { excerpt: d.excerpt, stage: 'before-gate' });
    }
  }

  for (const proposal of output.proposals) {
    const summary = contentText(proposal.content).slice(0, 160);

    const prior = await deps.memory.priorFailureOf(proposal.content);
    if (prior !== null) {
      results.push({ verdict: 'duplicate', summary, reasons: [`this is the same idea as one that already failed: ${prior.summary}`] });
      continue;
    }

    const report = await preflightVariant(proposal.content, {
      claims: deps.claims,
      markets: deps.markets,
      reviewer: deps.reviewer,
      proposerInstanceId: deps.proposerInstanceId,
      simulator: deps.simulator,
      champions: snapshot.champions,
      expectedSlot: slot
    });

    if (report.verdict === 'reject') {
      results.push({ verdict: 'rejected', summary, reasons: report.reasons, report });
      if (options.apply) {
        await deps.store.recordRejection(
          slot,
          `A ${slot} variant was rejected by the promotion gate at ${report.failedAt}: ${report.reasons.join('; ')}`,
          { failedAt: report.failedAt, reasons: report.reasons, text: contentText(proposal.content) }
        );
        await deps.memory.record({
          kind: 'variant-rejected',
          key: variantKey(proposal.content),
          slot,
          summary: `rejected at ${report.failedAt}: ${report.reasons[0] ?? 'no reason recorded'}`,
          text: contentText(proposal.content),
          detail: { failedAt: report.failedAt, reasons: report.reasons }
        });
      }
      continue;
    }

    if (testRunning) {
      results.push({
        verdict: 'passed-not-started',
        summary,
        reasons: ['it passed the gate, but one slot is tested at a time and a test is already running; it is not kept']
      });
      continue;
    }

    testRunning = true;
    if (!options.apply) {
      results.push({ verdict: 'would-start', summary, reasons: [], report });
      continue;
    }
    const current = snapshot.champions[slot] ?? null;
    const change = renderDiff(diffContent(current, proposal.content));
    const started = await deps.store.startChallenger(report, {
      rationale: `${proposal.rationale} (Aims to fix: ${proposal.targetsProblem}.) What changed: ${change}`,
      evidence: { targetsProblem: proposal.targetsProblem, weekEnding: output.weekEnding, minConversations: deps.config.promotion.minConversationsPerArm }
    });
    results.push({ verdict: 'started', summary, reasons: [], report, version: started.version });
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* The week                                                            */
/* ------------------------------------------------------------------ */

export interface WeeklyReport {
  weekEnding: string;
  applied: boolean;
  seeded: PlaybookSlot[];
  evaluation: EvaluationResult | null;
  monitoring: MonitorResult[];
  coach: AgentOutcome<CoachOutput> | null;
  proposals: ProposalResult[];
  /** Every change, in plain English, for the digest. */
  notes: string[];
}

export interface WeeklyOptions extends ApplyOption {
  weekEnding: string;
  agent: Agent<CoachInput, CoachOutput>;
  journal: AgentJournal;
  taskId: string;
  slot?: PlaybookSlot;
}

export async function runWeekly(deps: CycleDeps, options: WeeklyOptions): Promise<WeeklyReport> {
  const notes: string[] = [];
  const seeded = options.apply ? await deps.store.ensureBaseline() : [];
  for (const slot of seeded) notes.push(`${versionName(slot, 1)} was seeded as the starting champion.`);

  const evaluation = await evaluateLiveTest(deps, options);
  if (evaluation !== null) notes.push(evaluation.note);

  const monitoring = await monitorPromotions(deps, options);
  for (const m of monitoring.filter((r) => r.decision.status !== 'watching')) notes.push(m.note);

  // A test that is still running, or one just decided, leaves nothing to propose
  // this week: one slot at a time, and the next waits for the verdict.
  const stillRunning = (await deps.store.liveChallenger()) !== null;
  let coach: AgentOutcome<CoachOutput> | null = null;
  let proposals: ProposalResult[] = [];

  if (!stillRunning) {
    coach = await runAgent(
      options.agent,
      { weekEnding: options.weekEnding, maxProposals: deps.config.proposals.maxPerRun, ...(options.slot !== undefined ? { slot: options.slot } : {}) },
      { taskId: options.taskId, journal: options.journal }
    );
    if (coach.status === 'succeeded') {
      notes.push(coach.output.changeNote);
      proposals = await registerProposals(deps, coach.output, options);
      for (const p of proposals) {
        if (p.verdict === 'started') notes.push(`A new challenger, ${versionName(coach.output.slot as PlaybookSlot, p.version as number)}, started testing against the champion.`);
        if (p.verdict === 'rejected') notes.push(`A proposed ${coach.output.slot} variant was rejected by the gate: ${p.reasons[0] ?? ''}`);
      }
    } else {
      notes.push(`Coach did not complete this week (${coach.failure.kind}: ${coach.failure.message}), so the script is unchanged.`);
    }
  } else if (evaluation !== null && evaluation.decision.decision === 'continue') {
    notes.push(`No new proposals this week: ${versionName(evaluation.slot, evaluation.version)} is still under test (${pct(evaluation.decision.comparison.other.requestRate)} request rate so far).`);
  }

  return { weekEnding: options.weekEnding, applied: options.apply, seeded, evaluation, monitoring, coach, proposals, notes };
}
