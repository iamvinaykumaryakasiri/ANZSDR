/**
 * What Coach learns from: the week's calls, boiled down to where people were lost.
 *
 * All of this is deterministic. Which slot to work on is decided here from the
 * evidence, not by a model: a model asked "what should we improve?" will always
 * have an opinion, and the point of the seconds-to-hangup curve is that the
 * answer is in the data. The model's job comes after - writing the variant for
 * the slot the numbers pick.
 *
 * The mapping from where people are lost to what Coach may rewrite is:
 *
 *   lost in the hook section          -> the hook phrasing
 *   lost in the value section         -> the value statement (only if a claim can support one)
 *   lost at the start of the ask      -> the transition
 *   asked, but no preference captured -> the preference-request wording
 *   objections that end badly         -> the objection responses
 *
 * It is a heuristic, and it says so in the reason it gives. Vinay can override it
 * with `--slot`.
 */

import { objectionStats, sectionHangups, variantPerformance, ratio, type ObjectionStat, type SectionHangupReport, type VariantPerformanceRow } from '../analyst/metrics.js';
import type { CallFact } from '../analyst/facts.js';
import { PLAYBOOK_SLOTS, REWRITABLE_OBJECTIONS, type PlaybookSlot } from '../../playbook/schema.js';

export interface WeeklyOutcomes {
  window: { from: string; to: string };
  conversations: {
    calls: number;
    connected: number;
    /** Answered and past the opener: the population the playbook can affect. */
    eligible: number;
    completed: number;
    requests: number;
    requestRate: number;
  };
  sections: SectionHangupReport;
  objections: ObjectionStat[];
  /** The overall row for each version of each slot, plus the same split by market, industry and seniority. */
  variants: VariantPerformanceRow[];
  /** Hooks that got a real reaction, from Scribe's summary of each call. */
  landedHooks: Array<{ hook: string; conversations: number; requests: number }>;
}

export function weeklyOutcomes(facts: CallFact[], window: { from: Date; to: Date }): WeeklyOutcomes {
  const eligible = facts.filter((f) => f.survivedOpener);
  const requests = eligible.filter((f) => f.outcome === 'meeting_requested').length;

  const hooks = new Map<string, { conversations: number; requests: number }>();
  for (const f of eligible) {
    const hook = f.hook.trim();
    if (hook === '') continue;
    const entry = hooks.get(hook) ?? { conversations: 0, requests: 0 };
    entry.conversations += 1;
    if (f.outcome === 'meeting_requested') entry.requests += 1;
    hooks.set(hook, entry);
  }

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    conversations: {
      calls: facts.length,
      connected: facts.filter((f) => f.answered).length,
      eligible: eligible.length,
      completed: eligible.filter((f) => f.outcome !== null).length,
      requests,
      requestRate: ratio(requests, eligible.length)
    },
    sections: sectionHangups(facts),
    objections: objectionStats(facts),
    variants: PLAYBOOK_SLOTS.flatMap((slot) => variantPerformance(facts, slot)),
    landedHooks: [...hooks]
      .map(([hook, v]) => ({ hook, ...v }))
      .sort((a, b) => b.requests - a.requests || b.conversations - a.conversations || a.hook.localeCompare(b.hook))
  };
}

export interface FocusContext {
  /** Slots that currently have a champion. */
  championSlots: readonly PlaybookSlot[];
  /** Whether at least one claim is approved, so a value statement can exist at all. */
  hasApprovedClaims: boolean;
  /** Slots left alone for now because a variant for them failed recently. */
  cooldownSlots: readonly PlaybookSlot[];
  /** A test is already running: Coach waits for its verdict. */
  challengerRunning: boolean;
  minimumEligible: number;
}

export interface Focus {
  slot: PlaybookSlot | null;
  /** Why, in plain English, for the change note. */
  reason: string;
  /** What each candidate slot scored, for the trace. */
  scores: Array<{ slot: PlaybookSlot; score: number; why: string }>;
}

/** The smallest score worth acting on. Below it the week has nothing to teach. */
const MINIMUM_SCORE = 0.15;
/** Fewer calls than this reaching a section and its hazard is not a number worth acting on. */
const MINIMUM_REACHED = 5;

export function chooseFocus(outcomes: WeeklyOutcomes, context: FocusContext): Focus {
  const none = (reason: string, scores: Focus['scores'] = []): Focus => ({ slot: null, reason, scores });

  if (context.challengerRunning) return none('A challenger is already being tested, and one slot is tested at a time. Coach waits for its verdict.');
  if (outcomes.conversations.eligible < context.minimumEligible) {
    return none(
      `Only ${outcomes.conversations.eligible} conversation(s) got past the opener this period; Coach needs ${context.minimumEligible} before it proposes anything.`
    );
  }

  const stage = (id: string) => outcomes.sections.stages.find((s) => s.stage === id);
  const hazard = (id: string): { value: number; reached: number } => {
    const s = stage(id);
    return s === undefined || s.reached < MINIMUM_REACHED
      ? { value: 0, reached: s?.reached ?? 0 }
      : { value: ratio(s.lostHere, s.reached), reached: s.reached };
  };

  const scores: Focus['scores'] = [];

  const hook = hazard('hook');
  scores.push({ slot: 'hook', score: hook.value, why: `${pctOf(hook.value)} of the ${hook.reached} calls that reached the hook were lost in it` });

  if (context.hasApprovedClaims) {
    if (!context.championSlots.includes('value-statement')) {
      scores.push({ slot: 'value-statement', score: 0.35, why: 'claims are approved but there is no value statement yet, so Lexi has nothing specific to offer' });
    } else {
      const value = hazard('value');
      scores.push({ slot: 'value-statement', score: value.value, why: `${pctOf(value.value)} of the ${value.reached} calls that reached the value statement were lost in it` });
    }
  }

  const ask = hazard('ask');
  scores.push({ slot: 'transition', score: ask.value * 0.3, why: `${pctOf(ask.value)} of the ${ask.reached} calls that reached the ask were lost in it, which the transition into it shares in` });

  const asked = stage('ask')?.reached ?? 0;
  if (asked >= MINIMUM_REACHED) {
    const notConverted = ratio(asked - outcomes.conversations.requests, asked);
    scores.push({ slot: 'preference-request', score: notConverted * 0.25, why: `${asked} calls reached the ask and ${outcomes.conversations.requests} produced a meeting request` });
  } else {
    scores.push({ slot: 'preference-request', score: 0, why: 'too few calls reached the ask to judge it' });
  }

  const badlyHandled = outcomes.objections
    .filter((o) => (REWRITABLE_OBJECTIONS as readonly string[]).includes(o.kind) && o.calls >= 3)
    .reduce((sum, o) => sum + o.badOutcomes, 0);
  scores.push({
    slot: 'objection',
    score: ratio(badlyHandled, outcomes.conversations.eligible),
    why: `${badlyHandled} conversation(s) raised an objection and then went badly`
  });

  const candidates = scores.filter((s) => !context.cooldownSlots.includes(s.slot));
  const best = candidates.reduce<Focus['scores'][number] | null>((a, b) => (a === null || b.score > a.score ? b : a), null);

  if (outcomes.sections.attributed === 0 && best !== null && best.score < MINIMUM_SCORE && !context.cooldownSlots.includes('hook')) {
    return {
      slot: 'hook',
      reason:
        'No script-section timings have been recorded yet, so Coach cannot see where people are lost. It starts with the hook, which is the first thing after the fixed opening.',
      scores
    };
  }
  if (best === null || best.score < MINIMUM_SCORE) {
    return none('Nothing stands out: no slot is losing enough people to justify changing it.', scores);
  }
  return { slot: best.slot, reason: `${best.why}. That is the biggest leak, so this week is about the ${best.slot.replace('-', ' ')}.`, scores };
}

function pctOf(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export interface ObservedFailure {
  kind: 'hook-died' | 'objection-handled-badly';
  key: string;
  summary: string;
  slot?: PlaybookSlot;
  detail: Record<string, unknown>;
}

/**
 * Patterns worth remembering as failures, from the week's numbers.
 *
 *  - A hook version with enough conversations behind it and no meeting request.
 *  - An objection kind that was raised often and went badly most of the time.
 */
export function observedFailures(outcomes: WeeklyOutcomes): ObservedFailure[] {
  const out: ObservedFailure[] = [];

  for (const row of outcomes.variants) {
    if (row.slot !== 'hook' || row.dimension !== 'all' || row.version === null) continue;
    if (row.eligible >= 10 && row.requests === 0) {
      out.push({
        kind: 'hook-died',
        key: `hook:v${row.version}`,
        slot: 'hook',
        summary: `hook v${row.version} produced no meeting request in ${row.eligible} conversations`,
        detail: { version: row.version, eligible: row.eligible }
      });
    }
  }

  for (const o of outcomes.objections) {
    if (o.calls >= 5 && o.badRate >= 0.6) {
      out.push({
        kind: 'objection-handled-badly',
        key: `objection:${o.kind}`,
        slot: 'objection',
        summary: `"${o.label}" came up on ${o.calls} calls and ${o.badOutcomes} went badly afterwards`,
        detail: { objection: o.kind, calls: o.calls, badOutcomes: o.badOutcomes }
      });
    }
  }
  return out;
}
