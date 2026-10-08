/**
 * The promotion gate (section 11).
 *
 * This is not an agent. It is deterministic code that asks questions and takes the
 * answers: no model has a vote on whether a variant goes live, and no prompt can
 * argue with it. Where it needs a model's reading - the compliance review, the
 * adversarial calls - it receives that as an interface and decides what the answer
 * means, with a failure to answer counted as a no.
 *
 * Two jobs, in two halves.
 *
 * PREFLIGHT decides whether a proposed variant may start running at all, as a
 * challenger against the champion. Stages run in order and the first failure
 * stops the run, so a model is never paid to review something a pattern has
 * already rejected:
 *
 *   immutable-module   does the candidate name any part of what Coach may never touch?
 *   schema             is it a well-formed, strict, single-slot variant?
 *   linter             section 8 and 9 language, figures, pressure, instructions
 *   claims             every fact is an approved claim, and nothing else asserts one
 *   compliance-review  a SEPARATE model instance reads it against sections 7 to 9
 *   simulation         six kinds of difficult call, through the real Caller and Guardian
 *
 * DECISION compares a live challenger with its champion: whether to keep
 * collecting, promote, withdraw because it regressed, or retire because it never
 * showed anything. The rules are the ones in `config/coach.yaml`, which can make
 * them stricter and, because of the floors in config.ts, never looser than the
 * brief.
 */

import { COACH_MAY_NOT_EDIT } from '../agents/caller/opening.js';
import type { Market } from '../compliance/types.js';
import type { ClaimIndex } from '../knowledge/claims.js';
import { approvedTextAnyMarket, checkClaims } from './claim-check.js';
import type { PromotionThresholds } from './config.js';
import { lintContent } from './linter.js';
import { reviewPrompt, reviewVerdictSchema, verdictPasses, type ComplianceReviewer } from './review.js';
import {
  findImmutableKeys,
  playbookContentSchema,
  type PlaybookContent,
  type PlaybookSet,
  type PlaybookSlot
} from './schema.js';
import { SCENARIO_KINDS, type AdversarialSimulator, type SimulationReport } from './simulation-types.js';
import { fisherGreater, newcombeDifference, rate, type Interval } from './stats.js';
import { describeError, pct } from './util.js';

/* ================================================================== */
/* Preflight                                                           */
/* ================================================================== */

export const STAGE_ORDER = [
  'immutable-module',
  'schema',
  'linter',
  'claims',
  'compliance-review',
  'simulation'
] as const;
export type StageId = (typeof STAGE_ORDER)[number];

export interface StageResult {
  stage: StageId;
  status: 'passed' | 'failed' | 'skipped';
  reasons: string[];
}

export interface GateReport {
  verdict: 'pass' | 'reject';
  /** Known once the candidate parsed far enough to say. */
  slot: PlaybookSlot | null;
  /** The validated content, when the schema stage passed. Never the raw candidate. */
  content: PlaybookContent | null;
  stages: StageResult[];
  failedAt: StageId | null;
  /** Every reason from the stage that failed. Empty on a pass. */
  reasons: string[];
}

export interface PreflightDeps {
  claims: ClaimIndex;
  /** The markets the variant will be spoken in. A claim must be approved for each. */
  markets: Market[];
  reviewer: ComplianceReviewer;
  /** The instance that wrote the variant. The reviewer must not be it. */
  proposerInstanceId: string;
  simulator: AdversarialSimulator;
  /** The champions the variant is tried over, for the simulation. */
  champions: PlaybookSet;
  /** One slot at a time: when set, a candidate for any other slot is rejected. */
  expectedSlot?: PlaybookSlot;
}

/**
 * What a simulation report has to show for the gate to accept it. Exported for the
 * tests, because "all six kinds ran and every one passed" is the part that stops a
 * trimmed scenario set from getting a variant through.
 */
export function simulationReasons(report: SimulationReport): string[] {
  const reasons: string[] = [];
  for (const kind of SCENARIO_KINDS) {
    if (!report.scenarios.some((s) => s.kind === kind)) {
      reasons.push(`the simulation ran no "${kind}" scenario, and every kind is required`);
    }
  }
  for (const scenario of report.scenarios) {
    if (!scenario.passed) {
      reasons.push(`scenario ${scenario.id} (${scenario.kind}) failed: ${scenario.failures.join('; ')}`);
    }
  }
  if (!report.openingIntact) {
    reasons.push('the frozen opening was not delivered in full and in order in every simulated call');
  }
  return reasons;
}

export async function preflightVariant(candidate: unknown, deps: PreflightDeps): Promise<GateReport> {
  const stages: StageResult[] = [];

  const pass = (stage: StageId): void => {
    stages.push({ stage, status: 'passed', reasons: [] });
  };
  const fail = (stage: StageId, reasons: string[], content: PlaybookContent | null, slot: PlaybookSlot | null): GateReport => {
    stages.push({ stage, status: 'failed', reasons });
    for (const later of STAGE_ORDER.slice(STAGE_ORDER.indexOf(stage) + 1)) {
      stages.push({ stage: later, status: 'skipped', reasons: [] });
    }
    return { verdict: 'reject', slot, content, stages, failedAt: stage, reasons };
  };

  // 1. The immutable module. Named before the schema so a rejection can say what
  // was attempted, not merely that the shape was wrong.
  const touched = findImmutableKeys(candidate);
  if (touched.length > 0) {
    return fail(
      'immutable-module',
      [
        `the variant carries ${touched.map((k) => `"${k}"`).join(', ')}, which belongs to what Coach may never touch (${COACH_MAY_NOT_EDIT.join(', ')}, termination on request, the banned-topic list, the approved-claims boundary); there is nowhere in a playbook to put it`
      ],
      null,
      null
    );
  }
  pass('immutable-module');

  // 2. Schema: strict, one slot, well-formed templates.
  const parsed = playbookContentSchema.safeParse(candidate);
  if (!parsed.success) {
    return fail(
      'schema',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(variant)'}: ${i.message}`),
      null,
      null
    );
  }
  const content = parsed.data;
  if (deps.expectedSlot !== undefined && content.slot !== deps.expectedSlot) {
    return fail(
      'schema',
      [`this run is for the "${deps.expectedSlot}" slot and the variant is for "${content.slot}"; one slot at a time`],
      content,
      content.slot
    );
  }
  pass('schema');

  // 3. Linter.
  const lint = lintContent(content, { claimText: approvedTextAnyMarket(deps.claims) });
  if (lint.length > 0) {
    return fail(
      'linter',
      lint.map((f) => `${f.field}: ${f.message}${f.matched !== undefined ? ` ("${f.matched}")` : ''}`),
      content,
      content.slot
    );
  }
  pass('linter');

  // 4. Claim index.
  const claimFindings = checkClaims(content, deps.claims, deps.markets);
  if (claimFindings.length > 0) {
    return fail(
      'claims',
      claimFindings.map((f) => `${f.field}: ${f.message}${f.matched !== undefined ? ` ("${f.matched}")` : ''}`),
      content,
      content.slot
    );
  }
  pass('claims');

  // 5. Compliance review by a separate instance.
  if (deps.reviewer.instanceId === deps.proposerInstanceId) {
    return fail(
      'compliance-review',
      ['the reviewer is the same instance that proposed the variant; the review must be a separate one'],
      content,
      content.slot
    );
  }
  let rawVerdict: unknown;
  try {
    rawVerdict = await deps.reviewer.review(reviewPrompt(content, approvedTextAnyMarket(deps.claims)));
  } catch (error) {
    return fail('compliance-review', [`the reviewer did not return: ${describeError(error)}`], content, content.slot);
  }
  const verdict = reviewVerdictSchema.safeParse(rawVerdict);
  if (!verdict.success) {
    return fail('compliance-review', ['the reviewer returned something that was not a verdict'], content, content.slot);
  }
  if (!verdictPasses(verdict.data)) {
    const violations = verdict.data.violations.map((v) => `${v.rule}: "${v.quote}" - ${v.why}`);
    return fail(
      'compliance-review',
      violations.length > 0 ? violations : ['the reviewer judged the variant non-compliant without saying why'],
      content,
      content.slot
    );
  }
  pass('compliance-review');

  // 6. Adversarial simulation.
  let report: SimulationReport;
  try {
    report = await deps.simulator.run(content, deps.champions);
  } catch (error) {
    return fail('simulation', [`the simulation could not run: ${describeError(error)}`], content, content.slot);
  }
  const simulationProblems = simulationReasons(report);
  if (simulationProblems.length > 0) {
    return fail('simulation', simulationProblems, content, content.slot);
  }
  pass('simulation');

  return { verdict: 'pass', slot: content.slot, content, stages, failedAt: null, reasons: [] };
}

/* ================================================================== */
/* Decision                                                            */
/* ================================================================== */

/** Counts for one arm. Everything is counted over the same population: eligible conversations. */
export interface ArmEvidence {
  /** Answered by a person and past the opener. The denominator for every rate. */
  eligible: number;
  /** Eligible, and Lexi marked an outcome. The count the sample floor applies to. */
  completed: number;
  /** Outcome meeting_requested. */
  requests: number;
  /** Eligible conversations with a sentiment (Scribe's summary can be unavailable). */
  sentimentKnown: number;
  negative: number;
  /** Conversations with at least one counted defect. */
  defective: number;
  /** Conversations with a defect kind that withdraws a variant at once. */
  hardFailures: number;
}

export interface ArmRates {
  eligible: number;
  completed: number;
  requestRate: number;
  completionRate: number;
  negativeRate: number;
  defectRate: number;
  sentimentCoverage: number;
}

export function armRates(arm: ArmEvidence): ArmRates {
  return {
    eligible: arm.eligible,
    completed: arm.completed,
    requestRate: rate(arm.requests, arm.eligible),
    completionRate: rate(arm.completed, arm.eligible),
    negativeRate: rate(arm.negative, arm.sentimentKnown),
    defectRate: rate(arm.defective, arm.eligible),
    sentimentCoverage: rate(arm.sentimentKnown, arm.eligible)
  };
}

/** Worse by more than the tolerance, or worse at all and a one-sided test says so. */
function degraded(worseBy: number, tolerance: number, pWorse: number, alpha: number): boolean {
  return worseBy > tolerance || (worseBy > 0 && pWorse <= alpha);
}

export interface ArmComparison {
  base: ArmRates;
  other: ArmRates;
  /** other minus base, in request rate. Positive is an improvement. */
  lift: number;
  /** One-sided Fisher p that other's request rate is higher than base's. */
  liftP: number;
  liftInterval: Interval;
  /** Everything other is worse at, in plain English. Empty means no regression. */
  regressions: string[];
}

/**
 * Compare `other` with `base`. Used for challenger against champion, and for a new
 * champion against the one it replaced.
 */
export function compareArms(base: ArmEvidence, other: ArmEvidence, t: PromotionThresholds): ArmComparison {
  const b = armRates(base);
  const o = armRates(other);
  const regressions: string[] = [];

  const lift = o.requestRate - b.requestRate;
  const liftP = fisherGreater(other.requests, other.eligible, base.requests, base.eligible);
  const requestWorseP = fisherGreater(base.requests, base.eligible, other.requests, other.eligible);
  if (-lift >= t.minAbsoluteLift && requestWorseP <= t.degradationAlpha) {
    regressions.push(`meeting-request rate fell from ${pct(b.requestRate)} to ${pct(o.requestRate)}`);
  }

  const completionDrop = b.completionRate - o.completionRate;
  const completionP = fisherGreater(base.completed, base.eligible, other.completed, other.eligible);
  if (degraded(completionDrop, t.maxCompletionDrop, completionP, t.degradationAlpha)) {
    regressions.push(`conversation completion fell from ${pct(b.completionRate)} to ${pct(o.completionRate)}`);
  }

  const negativeRise = o.negativeRate - b.negativeRate;
  const negativeP = fisherGreater(other.negative, other.sentimentKnown, base.negative, base.sentimentKnown);
  if (degraded(negativeRise, t.maxNegativeSentimentRise, negativeP, t.degradationAlpha)) {
    regressions.push(`negative sentiment rose from ${pct(b.negativeRate)} to ${pct(o.negativeRate)}`);
  }

  const defectRise = o.defectRate - b.defectRate;
  const defectP = fisherGreater(other.defective, other.eligible, base.defective, base.eligible);
  if (degraded(defectRise, t.maxDefectRateRise, defectP, t.degradationAlpha)) {
    regressions.push(`defect rate rose from ${pct(b.defectRate)} to ${pct(o.defectRate)}`);
  }

  return {
    base: b,
    other: o,
    lift,
    liftP,
    liftInterval: newcombeDifference(other.requests, other.eligible, base.requests, base.eligible),
    regressions
  };
}

export type TestDecisionKind = 'continue' | 'promote' | 'withdraw' | 'retire';

export interface TestDecision {
  decision: TestDecisionKind;
  /** Why, in plain English, for the change note and the console. */
  reasons: string[];
  comparison: ArmComparison;
}

/**
 * Decide what a live test should do next.
 *
 *   withdraw   the challenger regressed. Pulled at once; its traffic returns to the champion.
 *   promote    a meaningful, significant lift and no degradation anywhere.
 *   retire     both arms have run to the ceiling and nothing was shown.
 *   continue   not enough evidence yet.
 *
 * A missing disclosure withdraws the challenger whatever the sample size. Every
 * other judgement waits for the floor: a promotion decision on fewer than the
 * required conversations does not exist.
 */
export function decideTest(champion: ArmEvidence, challenger: ArmEvidence, t: PromotionThresholds): TestDecision {
  const comparison = compareArms(champion, challenger, t);

  if (challenger.hardFailures > 0) {
    return {
      decision: 'withdraw',
      reasons: [`${challenger.hardFailures} conversation(s) hit a defect that withdraws a variant at once (${t.hardFailKinds.join(', ')})`],
      comparison
    };
  }

  const short: string[] = [];
  if (champion.completed < t.minConversationsPerArm) {
    short.push(`the champion has ${champion.completed} of ${t.minConversationsPerArm} completed conversations`);
  }
  if (challenger.completed < t.minConversationsPerArm) {
    short.push(`the challenger has ${challenger.completed} of ${t.minConversationsPerArm} completed conversations`);
  }
  if (short.length > 0) {
    return { decision: 'continue', reasons: [`not enough evidence to decide: ${short.join('; ')}`], comparison };
  }

  if (comparison.regressions.length > 0) {
    return { decision: 'withdraw', reasons: comparison.regressions, comparison };
  }

  const atCeiling =
    champion.completed >= t.maxConversationsPerArm && challenger.completed >= t.maxConversationsPerArm;
  const patience = (reason: string): TestDecision => ({
    decision: atCeiling ? 'retire' : 'continue',
    reasons: [atCeiling ? `retired as inconclusive after ${t.maxConversationsPerArm} conversations per arm: ${reason}` : reason],
    comparison
  });

  if (comparison.base.sentimentCoverage < t.minSentimentCoverage || comparison.other.sentimentCoverage < t.minSentimentCoverage) {
    return patience(
      `sentiment is known for only ${pct(Math.min(comparison.base.sentimentCoverage, comparison.other.sentimentCoverage))} of conversations (need ${pct(t.minSentimentCoverage)}), so "no degradation in sentiment" cannot be shown`
    );
  }

  if (comparison.lift >= t.minAbsoluteLift && comparison.liftP <= t.alpha) {
    return {
      decision: 'promote',
      reasons: [
        `meeting-request rate rose from ${pct(comparison.base.requestRate)} to ${pct(comparison.other.requestRate)} (a ${pct(comparison.lift)} lift, one-sided p = ${comparison.liftP.toFixed(3)}), with no degradation in completion, sentiment or defect rate`
      ],
      comparison
    };
  }

  return patience(
    `meeting-request rate is ${pct(comparison.base.requestRate)} for the champion and ${pct(comparison.other.requestRate)} for the challenger: a ${pct(comparison.lift)} difference (one-sided p = ${comparison.liftP.toFixed(3)}), short of the ${pct(t.minAbsoluteLift)} lift at p <= ${t.alpha} that promotion needs`
  );
}

export type MonitorStatus = 'watching' | 'ok' | 'rollback';

export interface MonitorDecision {
  status: MonitorStatus;
  reasons: string[];
  comparison: ArmComparison;
}

/**
 * Watch a newly promoted champion against the one it replaced.
 *
 * `previous` is the old champion's evidence as it stood when it lost its place;
 * `current` is the new champion's, from calls since. Auto-rollback on regression
 * (section 11 item 6) is this function returning `rollback`.
 */
export function monitorPromotion(
  previous: ArmEvidence,
  current: ArmEvidence,
  t: PromotionThresholds,
  watchMinimum: number
): MonitorDecision {
  const comparison = compareArms(previous, current, t);

  if (current.hardFailures > 0) {
    return {
      status: 'rollback',
      reasons: [`${current.hardFailures} conversation(s) since promotion hit a defect that withdraws a variant at once`],
      comparison
    };
  }
  if (current.completed < watchMinimum) {
    return {
      status: 'watching',
      reasons: [`${current.completed} of ${watchMinimum} completed conversations since promotion`],
      comparison
    };
  }
  if (comparison.regressions.length > 0) {
    return { status: 'rollback', reasons: comparison.regressions, comparison };
  }
  return { status: 'ok', reasons: ['no regression against the champion it replaced'], comparison };
}
