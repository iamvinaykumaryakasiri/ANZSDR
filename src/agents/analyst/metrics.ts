/**
 * Analyst's figures: the pure functions the digest, Coach and the console backend
 * compute their numbers with.
 *
 * Everything here that takes `CallFact[]` is a pure function; the few that touch the
 * blackboard (`loadSpend`, `loadQueueCounts`, `loadSafetySignals`...) say so in
 * their names and do nothing but read. The return types are plain interfaces so the
 * console can import them, and the funnel, hang-up curve, objection ranking,
 * gatekeeper table and wrong-number rate are structurally the same as the console
 * contract's views (src/stream/contract.ts) - a test pins that, so the two cannot
 * drift apart without a type error.
 *
 * Stage vocabulary. The blackboard records script sections as `disclosure`,
 * `reason`, `hook`, `value-statement`, `ask`, `close`. The console names the fourth
 * `value`. This module speaks the console's vocabulary at its edges
 * (`ScriptStage`) and maps from the blackboard's once, in `stageOfSection`.
 */

import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Blackboard } from '../../blackboard/client.js';
import type { SpendCategory } from '../../blackboard/schemas.js';
import type { SafetySignals } from '../../compliance/kill-switch.js';
import { parseVersionName, type PlaybookSlot } from '../../playbook/schema.js';
import { CONVERSATION_SECONDS, OPENER_SECONDS, loadCallFacts, type CallFact, type ObjectionKind } from './facts.js';

export { CONVERSATION_SECONDS, OPENER_SECONDS };

/* ================================================================== */
/* Small arithmetic                                                    */
/* ================================================================== */

export function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** numerator / denominator, 0 when there is nothing to divide by. Rounded to 4 places. */
export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/* ================================================================== */
/* Days, on the operator's clock                                       */
/* ================================================================== */

export const OPERATOR_ZONE = 'Australia/Sydney';

export interface DayWindow {
  /** yyyy-MM-dd in `zone`. */
  date: string;
  zone: string;
  from: Date;
  /** Exclusive: the start of the next day. */
  to: Date;
}

/** The calendar day `date` (yyyy-MM-dd) on `zone`'s clock, as UTC instants. */
export function dayWindow(date: string, zone: string = OPERATOR_ZONE): DayWindow {
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  if (!start.isValid) throw new Error(`"${date}" is not a date in ${zone}`);
  return { date, zone, from: start.toJSDate(), to: start.plus({ days: 1 }).toJSDate() };
}

/** The day containing `at` on `zone`'s clock. */
export function dayContaining(at: Date, zone: string = OPERATOR_ZONE): DayWindow {
  return dayWindow(DateTime.fromJSDate(at, { zone }).toFormat('yyyy-MM-dd'), zone);
}

export function shiftDays(window: DayWindow, days: number): DayWindow {
  return dayWindow(DateTime.fromISO(window.date, { zone: window.zone }).plus({ days }).toFormat('yyyy-MM-dd'), window.zone);
}

/* ================================================================== */
/* Script sections                                                     */
/* ================================================================== */

export const SCRIPT_STAGES = ['disclosure', 'reason', 'hook', 'value', 'ask', 'close'] as const;
export type ScriptStage = (typeof SCRIPT_STAGES)[number];

export const STAGE_LABELS: Record<ScriptStage, string> = {
  disclosure: 'Disclosure',
  reason: 'Reason for the call',
  hook: 'Hook',
  value: 'Value statement',
  ask: 'The ask',
  close: 'Close'
};

const STAGE_OF_SECTION: Record<string, ScriptStage> = {
  disclosure: 'disclosure',
  reason: 'reason',
  hook: 'hook',
  'value-statement': 'value',
  value: 'value',
  ask: 'ask',
  close: 'close'
};

export function stageOfSection(section: string): ScriptStage | null {
  return STAGE_OF_SECTION[section] ?? null;
}

/** A call's section marks as console stages, in script order, dropping anything unrecognised. */
function stageMarks(fact: CallFact): Array<{ stage: ScriptStage; atSecond: number }> {
  return fact.marks
    .flatMap((m) => {
      const stage = stageOfSection(m.section);
      return stage === null ? [] : [{ stage, atSecond: m.atSecond }];
    })
    .sort((a, b) => a.atSecond - b.atSecond || SCRIPT_STAGES.indexOf(a.stage) - SCRIPT_STAGES.indexOf(b.stage));
}

/* ================================================================== */
/* The funnel (section 14.2)                                           */
/* ================================================================== */

export type FunnelStageId =
  | 'queued'
  | 'gate_passed'
  | 'dialled'
  | 'answered'
  | 'survived_opener'
  | 'real_conversation'
  | 'ask_made'
  | 'meeting_requested'
  | 'confirmed';

export interface FunnelStage {
  id: FunnelStageId;
  label: string;
  count: number;
  /** Fraction of the previous stage that reached this one, 0..1. */
  rate: number;
  /** How many fell out between the previous stage and this one. */
  loss: number;
  /** The same rate over the baseline period. Equal to `rate` when the baseline had nothing to compare. */
  baselineRate: number;
}

export const FUNNEL_STAGES: ReadonlyArray<{ id: FunnelStageId; label: string }> = Object.freeze([
  { id: 'queued', label: 'Queued' },
  { id: 'gate_passed', label: 'Passed the compliance gate' },
  { id: 'dialled', label: 'Dialled' },
  { id: 'answered', label: 'Answered' },
  { id: 'survived_opener', label: `Survived the opener (${OPENER_SECONDS}s)` },
  { id: 'real_conversation', label: `Real conversation (${CONVERSATION_SECONDS}s+)` },
  { id: 'ask_made', label: 'Ask made' },
  { id: 'meeting_requested', label: 'Meeting requested' },
  { id: 'confirmed', label: 'Confirmed by Vinay' }
]);

/**
 * The nine counts, forced into a funnel: nobody dialled was not queued, and nobody
 * dialled failed the gate. The queue-side numbers come from different tables than
 * the call-side ones, so this is where they are made to agree.
 */
export function funnelCounts(facts: CallFact[], queued: number, gatePassed: number): number[] {
  const dialled = facts.length;
  const q = Math.max(queued, dialled);
  const g = Math.min(q, Math.max(gatePassed, dialled));
  const n = (pick: (f: CallFact) => boolean): number => facts.filter(pick).length;
  return [
    q,
    g,
    dialled,
    n((f) => f.answered),
    n((f) => f.survivedOpener),
    n((f) => f.realConversation),
    n((f) => f.askMade),
    n((f) => f.requested),
    n((f) => f.confirmed)
  ];
}

export interface FunnelInput {
  /** Calls in the period being shown. */
  today: CallFact[];
  /** Calls in the baseline period: the seven days before it. */
  baseline: CallFact[];
  queued: number;
  gatePassed: number;
  baselineQueued: number;
  baselineGatePassed: number;
}

export function buildFunnel(input: FunnelInput): FunnelStage[] {
  const counts = funnelCounts(input.today, input.queued, input.gatePassed);
  const base = funnelCounts(input.baseline, input.baselineQueued, input.baselineGatePassed);

  return FUNNEL_STAGES.map((stage, i) => {
    const count = counts[i] as number;
    const previous = i === 0 ? count : (counts[i - 1] as number);
    const rate = i === 0 ? 1 : ratio(count, previous);
    // With nothing behind a step in the baseline there is no baseline to compare
    // with, so the day is shown level with itself rather than against a made-up
    // zero that would make every day look better than usual.
    const baselinePrevious = i === 0 ? 0 : (base[i - 1] as number);
    const baselineRate = i === 0 ? 1 : baselinePrevious === 0 ? rate : ratio(base[i] as number, baselinePrevious);
    return { id: stage.id, label: stage.label, count, rate, loss: i === 0 ? 0 : Math.max(0, previous - count), baselineRate };
  });
}

/** The stage that lost the most ground against its own baseline, with the size of the gap. */
export function worstStageAgainstBaseline(funnel: FunnelStage[], minimumPrevious = 5): { stage: FunnelStage; gap: number } | null {
  let worst: { stage: FunnelStage; gap: number } | null = null;
  funnel.forEach((stage, i) => {
    if (i === 0) return;
    const previous = funnel[i - 1] as FunnelStage;
    if (previous.count < minimumPrevious) return;
    const gap = round(stage.baselineRate - stage.rate);
    if (gap > 0 && (worst === null || gap > worst.gap)) worst = { stage, gap };
  });
  return worst;
}

/* ================================================================== */
/* Seconds-to-hangup (section 14.2)                                    */
/* ================================================================== */

export interface HangupBin {
  fromSecond: number;
  count: number;
  callIds: string[];
}

export interface HangupSection {
  id: ScriptStage;
  label: string;
  fromSecond: number;
  toSecond: number;
}

export interface HangupCurve {
  binSeconds: number;
  bins: HangupBin[];
  sections: HangupSection[];
}

/** Where each section begins on a typical call, used until there are marks to measure. */
const DEFAULT_STARTS: Record<ScriptStage, number> = { disclosure: 0, reason: 10, hook: 22, value: 38, ask: 58, close: 80 };

export const CURVE_BIN_SECONDS = 5;
const CURVE_MIN_SECONDS = 120;
const CURVE_MAX_SECONDS = 300;

/**
 * A density of call length, with the script sections overlaid. Only people who
 * picked up and have finished: a voicemail drop is not someone losing interest, and
 * a call still running has not hung up yet.
 */
export function buildHangupCurve(facts: CallFact[], binSeconds = CURVE_BIN_SECONDS): HangupCurve {
  const sample = facts.filter((f) => f.answered && f.finished);
  const longest = sample.reduce((max, f) => Math.max(max, f.durationSec), 0);
  const maxSecond = Math.min(CURVE_MAX_SECONDS, Math.max(CURVE_MIN_SECONDS, Math.ceil((longest + 1) / binSeconds) * binSeconds));
  const binCount = Math.ceil(maxSecond / binSeconds);

  const bins: HangupBin[] = Array.from({ length: binCount }, (_, i) => ({ fromSecond: i * binSeconds, count: 0, callIds: [] }));
  for (const f of sample) {
    // Anything longer than the chart is drawn goes in the last bin rather than off the end.
    const bin = bins[Math.min(binCount - 1, Math.floor(f.durationSec / binSeconds))] as HangupBin;
    bin.count += 1;
    bin.callIds.push(f.id);
  }

  // Section starts are measured, not assumed: the median second each call reached
  // it. The overlay is therefore the script as it was really paced.
  const starts = {} as Record<ScriptStage, number>;
  let floor = -1;
  for (const stage of SCRIPT_STAGES) {
    const seen = facts.flatMap((f) => stageMarks(f).filter((m) => m.stage === stage).map((m) => m.atSecond));
    const start = Math.round(median(seen) ?? DEFAULT_STARTS[stage]);
    starts[stage] = Math.max(start, floor + 1);
    floor = starts[stage];
  }

  const sections: HangupSection[] = SCRIPT_STAGES.map((stage, i) => {
    const next = SCRIPT_STAGES[i + 1];
    return {
      id: stage,
      label: STAGE_LABELS[stage],
      fromSecond: starts[stage],
      toSecond: next === undefined ? Math.max(maxSecond, starts[stage] + 1) : starts[next]
    };
  });

  return { binSeconds, bins, sections };
}

export interface SectionHangup {
  stage: ScriptStage;
  label: string;
  /** Answered, finished calls that got as far as this section. */
  reached: number;
  /** Of those, how many ended while it was the section being spoken. */
  endedHere: number;
  /** endedHere / reached: how likely a call that arrives here is to end here. The "which sentence loses people" number. */
  hazard: number;
  /** Share of all attributed calls that ended here. */
  share: number;
  /** Ended here without a meeting or callback being asked for: people actually lost. */
  lostHere: number;
}

export interface SectionHangupReport {
  stages: SectionHangup[];
  /** Calls that could be placed in a section. */
  attributed: number;
  /** Answered, finished calls with no section marks at all, so no section to blame. */
  unattributed: number;
}

const POSITIVE_OUTCOMES = ['meeting_requested', 'callback_requested'];

/**
 * The seconds-to-hangup distribution by script section: for each section, how many
 * calls reached it and how many ended inside it.
 *
 * A call "ended in" the last section whose mark is at or before the call's length.
 * A call that ran past its last mark ended in that last section, which is why
 * `close` collects the calls that were allowed to finish.
 */
export function sectionHangups(facts: CallFact[]): SectionHangupReport {
  const sample = facts.filter((f) => f.answered && f.finished);
  const reached = new Map<ScriptStage, number>();
  const ended = new Map<ScriptStage, number>();
  const lost = new Map<ScriptStage, number>();
  let attributed = 0;
  let unattributed = 0;

  for (const f of sample) {
    const marks = stageMarks(f).filter((m) => m.atSecond <= f.durationSec);
    if (marks.length === 0) {
      unattributed += 1;
      continue;
    }
    attributed += 1;
    const seen = new Set<ScriptStage>(marks.map((m) => m.stage));
    for (const stage of seen) reached.set(stage, (reached.get(stage) ?? 0) + 1);
    const endedIn = (marks[marks.length - 1] as { stage: ScriptStage }).stage;
    ended.set(endedIn, (ended.get(endedIn) ?? 0) + 1);
    if (f.outcome === null || !POSITIVE_OUTCOMES.includes(f.outcome)) lost.set(endedIn, (lost.get(endedIn) ?? 0) + 1);
  }

  const stages = SCRIPT_STAGES.map((stage) => {
    const r = reached.get(stage) ?? 0;
    const e = ended.get(stage) ?? 0;
    return {
      stage,
      label: STAGE_LABELS[stage],
      reached: r,
      endedHere: e,
      hazard: ratio(e, r),
      share: ratio(e, attributed),
      lostHere: lost.get(stage) ?? 0
    };
  });
  return { stages, attributed, unattributed };
}

/** The section where an arriving call is most likely to end, among those with enough calls to say. */
export function leakiestSection(report: SectionHangupReport, minimumReached = 5): SectionHangup | null {
  const candidates = report.stages.filter((s) => s.reached >= minimumReached && s.stage !== 'close' && s.lostHere > 0);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.hazard > a.hazard ? b : a));
}

/* ================================================================== */
/* Objections, gatekeepers, wrong numbers                              */
/* ================================================================== */

export const OBJECTION_LABELS: Record<ObjectionKind, string> = {
  'has-a-partner': 'Already has a partner',
  'no-budget': 'No budget',
  'no-time-now': 'No time right now',
  'send-email': 'Asked for an email instead',
  'not-the-right-person': 'Not the right person',
  'not-interested': 'Not interested',
  'wants-pricing': 'Wanted pricing',
  'asked-where-number-came-from': 'Asked where we got their number',
  'asked-if-human': 'Asked whether Lexi is a person',
  other: 'Something else'
};

export function rankObjections(facts: CallFact[], limit = 8): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const f of facts) {
    for (const o of f.objections) {
      const label = OBJECTION_LABELS[o.kind];
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export interface ObjectionStat {
  kind: ObjectionKind;
  label: string;
  /** Calls on which it was raised. */
  calls: number;
  /** Of those, calls that went on to a refusal, an escalation or no outcome at all: handled badly. */
  badOutcomes: number;
  badRate: number;
}

const BAD_OUTCOMES: readonly (string | null)[] = ['not_interested', 'do_not_contact', 'escalated', 'wrong_person', null];

/** For Coach: which objections are raised, and how often the call went badly afterwards. */
export function objectionStats(facts: CallFact[]): ObjectionStat[] {
  const byKind = new Map<ObjectionKind, { calls: number; bad: number }>();
  for (const f of facts) {
    if (!f.answered) continue;
    for (const kind of new Set(f.objections.map((o) => o.kind))) {
      const entry = byKind.get(kind) ?? { calls: 0, bad: 0 };
      entry.calls += 1;
      if (BAD_OUTCOMES.includes(f.outcome)) entry.bad += 1;
      byKind.set(kind, entry);
    }
  }
  return [...byKind]
    .map(([kind, v]) => ({ kind, label: OBJECTION_LABELS[kind], calls: v.calls, badOutcomes: v.bad, badRate: ratio(v.bad, v.calls) }))
    .sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));
}

export function gatekeeperByAccount(facts: CallFact[], limit = 8): Array<{ company: string; blocks: number; calls: number }> {
  const byAccount = new Map<string, { blocks: number; calls: number }>();
  for (const f of facts) {
    const entry = byAccount.get(f.company) ?? { blocks: 0, calls: 0 };
    entry.calls += 1;
    if (f.outcome === 'gatekeeper_blocked') entry.blocks += 1;
    byAccount.set(f.company, entry);
  }
  return [...byAccount]
    .filter(([, v]) => v.blocks > 0)
    .map(([company, v]) => ({ company, ...v }))
    .sort((a, b) => b.blocks - a.blocks || ratio(b.blocks, b.calls) - ratio(a.blocks, a.calls) || a.company.localeCompare(b.company))
    .slice(0, limit);
}

/** Wrong and dead numbers as a share of finished calls: a data-quality signal, not a script one. */
export function wrongNumberRate(facts: CallFact[]): number {
  const finished = facts.filter((f) => f.finished);
  const wrong = finished.filter((f) => f.outcome === 'wrong_person' || f.outcome === 'invalid_number').length;
  return ratio(wrong, finished.length);
}

/* ================================================================== */
/* Outcomes and the day's numbers                                      */
/* ================================================================== */

export function outcomeCounts(facts: CallFact[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of facts) {
    const key = f.outcome ?? 'no_outcome_marked';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export interface TodayNumbers {
  dialled: number;
  connected: number;
  conversations: number;
  requests: number;
  spendUsd: number;
  /** Spend divided by meeting requests. Null with no requests: there is no honest figure. */
  costPerMeetingUsd: number | null;
}

export function costPerMeeting(spendUsd: number, requests: number): number | null {
  return requests === 0 ? null : round(spendUsd / requests, 2);
}

export function todayNumbers(facts: CallFact[], spendUsd: number): TodayNumbers {
  const requests = facts.filter((f) => f.outcome === 'meeting_requested').length;
  return {
    dialled: facts.length,
    connected: facts.filter((f) => f.answered).length,
    conversations: facts.filter((f) => f.realConversation).length,
    requests,
    spendUsd: round(spendUsd, 2),
    costPerMeetingUsd: costPerMeeting(spendUsd, requests)
  };
}

/* ================================================================== */
/* Variant performance by segment (Coach)                              */
/* ================================================================== */

export type SegmentDimension = 'all' | 'market' | 'industry' | 'seniority';

export interface VariantPerformanceRow {
  slot: PlaybookSlot;
  /** Null: calls that ran with no content in this slot at all. */
  version: number | null;
  dimension: SegmentDimension;
  value: string;
  /** Answered by a person and past the opener: the population the playbook can affect. */
  eligible: number;
  completed: number;
  requests: number;
  requestRate: number;
}

/** The version of `slot` a call ran with: null if it ran without one, undefined if that is unknown. */
export function versionRunWith(fact: CallFact, slot: PlaybookSlot): number | null | undefined {
  if (fact.assignment !== null) return fact.assignment.versions[slot] ?? null;
  const named = parseVersionName(fact.variant);
  return named !== null && named.slot === slot ? named.version : undefined;
}

/**
 * How each version of a slot performed, overall and separately by market,
 * industry and seniority. Section 11: "a hook that works on a NZ CIO will not work
 * on a Sydney CDO", so a version is never judged on its overall number alone.
 */
export function variantPerformance(facts: CallFact[], slot: PlaybookSlot): VariantPerformanceRow[] {
  const rows = new Map<string, VariantPerformanceRow>();
  const bump = (version: number | null, dimension: SegmentDimension, value: string, f: CallFact): void => {
    const key = `${version ?? 'none'}|${dimension}|${value}`;
    const row = rows.get(key) ?? { slot, version, dimension, value, eligible: 0, completed: 0, requests: 0, requestRate: 0 };
    row.eligible += 1;
    if (f.outcome !== null) row.completed += 1;
    if (f.outcome === 'meeting_requested') row.requests += 1;
    row.requestRate = ratio(row.requests, row.eligible);
    rows.set(key, row);
  };

  for (const f of facts) {
    if (!f.survivedOpener) continue;
    const version = versionRunWith(f, slot);
    if (version === undefined) continue;
    bump(version, 'all', 'all', f);
    bump(version, 'market', f.market, f);
    bump(version, 'industry', f.industry, f);
    bump(version, 'seniority', f.seniority, f);
  }
  return [...rows.values()].sort(
    (a, b) =>
      (a.version ?? -1) - (b.version ?? -1) ||
      a.dimension.localeCompare(b.dimension) ||
      b.eligible - a.eligible ||
      a.value.localeCompare(b.value)
  );
}

/* ================================================================== */
/* Defects                                                             */
/* ================================================================== */

/** The words an audit finding quotes: `"quote" - why`. The whole detail if it does not follow that form. */
export function quoteOf(detail: string): string {
  const match = /^"([\s\S]*?)"\s+[—-]\s/.exec(detail);
  return (match?.[1] ?? detail).trim();
}

function squash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this quoted line part of the frozen opening?
 *
 * Guardian's post-call audit asks a model to find every assertion not on the
 * approved-claims list, and the opening's mandated lines - who Lexi works for, the
 * generic reason for the call - are not on it. That is a known behaviour, left
 * as it is by decision. Telling those flags apart from a genuine unsupported claim
 * is a matter of whether the quote is a line the opening is required to contain, so
 * it is a text match against the opening, nothing cleverer.
 */
export function isOpeningLine(quote: string, openingTexts: string[]): boolean {
  const q = squash(quote);
  if (q.length < 12) return false;
  const lines = openingTexts.map(squash).filter((t) => t !== '');
  const joined = lines.join(' ');
  return lines.some((line) => line.includes(q) || q.includes(line)) || joined.includes(q);
}

export interface UnsupportedClaimExample {
  callId: string;
  company: string;
  quote: string;
  atSecond?: number;
  openingLine: boolean;
}

export interface DefectSummary {
  calls: number;
  callsWithDefects: number;
  total: number;
  byKind: Record<string, number>;
  unsupportedClaims: {
    /** Everything the audit reported. */
    total: number;
    /** Of those, quotes of lines the frozen opening is required to contain. */
    openingLineFlags: number;
    /** Everything else: the ones to read. */
    other: number;
    examples: UnsupportedClaimExample[];
  };
}

export function summariseDefects(facts: CallFact[], openingTexts: string[], exampleLimit = 5): DefectSummary {
  const byKind: Record<string, number> = {};
  const examples: UnsupportedClaimExample[] = [];
  let total = 0;
  let callsWithDefects = 0;
  let unsupported = 0;
  let openingLine = 0;

  for (const f of facts) {
    if (f.defects.length > 0) callsWithDefects += 1;
    for (const d of f.defects) {
      total += 1;
      byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      if (d.kind !== 'unsupported-claim') continue;
      unsupported += 1;
      const quote = quoteOf(d.detail);
      const inOpening = isOpeningLine(quote, openingTexts);
      if (inOpening) openingLine += 1;
      examples.push({
        callId: f.id,
        company: f.company,
        quote,
        ...(d.atSecond !== undefined ? { atSecond: d.atSecond } : {}),
        openingLine: inOpening
      });
    }
  }

  return {
    calls: facts.length,
    callsWithDefects,
    total,
    byKind,
    unsupportedClaims: {
      total: unsupported,
      openingLineFlags: openingLine,
      other: unsupported - openingLine,
      // The ones to read first are the ones that are not the opening.
      examples: examples.sort((a, b) => Number(a.openingLine) - Number(b.openingLine)).slice(0, exampleLimit)
    }
  };
}

/* ================================================================== */
/* Safety signals: what src/ops reads to decide whether to trip        */
/* ================================================================== */

export interface DefectRateMetric {
  calls: number;
  /** Calls with at least one defect of a kind the caller asked to count. */
  callsWithDefects: number;
  /** callsWithDefects / calls. Zero when there were no calls. */
  defectRate: number;
  /** Unsupported-claim defects exactly as the audit reported them. */
  claimDefectsRaw: number;
  /**
   * Unsupported-claim defects excluding quotes of the frozen opening's mandated
   * lines. This is the figure meant for the kill switch: the raw one grows by two
   * or three on every call whatever Lexi says, which would trip a threshold of five
   * after two calls. Equal to the raw figure when no opening text is supplied.
   */
  claimDefectsNet: number;
  byKind: Record<string, number>;
}

export const DEFAULT_DEFECT_KINDS = ['unsupported-claim', 'banned-topic', 'over-commitment', 'disclosure-missing'] as const;

export function defectRateMetric(
  facts: CallFact[],
  openingTexts: string[] = [],
  kinds: readonly string[] = DEFAULT_DEFECT_KINDS
): DefectRateMetric {
  const summary = summariseDefects(facts, openingTexts);
  const counted = facts.filter((f) => f.defects.some((d) => kinds.includes(d.kind)));
  return {
    calls: facts.length,
    callsWithDefects: counted.length,
    defectRate: ratio(counted.length, facts.length),
    claimDefectsRaw: summary.unsupportedClaims.total,
    claimDefectsNet: summary.unsupportedClaims.other,
    byKind: summary.byKind
  };
}

const ERROR_ENDINGS = /error|fail|exception|time-?out|unavailable|crash/i;

/**
 * The signals `evaluateAutoTrip` takes, plus the defect rate and the raw claim
 * count alongside. Structurally a `SafetySignals`, so `src/ops` can pass it straight
 * to the kill switch; `claimDefectsToday` is the NET figure (see `DefectRateMetric`).
 */
export interface SafetySignalsReport extends SafetySignals {
  defectRate: number;
  claimDefectsRaw: number;
  window: { from: Date; to: Date };
}

export function safetySignalsFromFacts(
  facts: CallFact[],
  escalationsToday: number,
  window: { from: Date; to: Date },
  openingTexts: string[] = []
): SafetySignalsReport {
  const metric = defectRateMetric(facts, openingTexts);
  const known = facts.filter((f) => f.sentiment !== 'unknown');
  return {
    callsToday: facts.length,
    escalationsToday,
    claimDefectsToday: metric.claimDefectsNet,
    errorRate: ratio(facts.filter((f) => f.endedReason !== null && ERROR_ENDINGS.test(f.endedReason)).length, facts.length),
    negativeSentimentRate: ratio(known.filter((f) => f.sentiment === 'negative').length, known.length),
    blackboardReachable: true,
    defectRate: metric.defectRate,
    claimDefectsRaw: metric.claimDefectsRaw,
    window
  };
}

/** Reads today's calls and escalations and returns the kill switch's inputs. `blackboardReachable` is false if the read fails. */
export async function loadSafetySignals(
  db: Blackboard,
  now: Date,
  openingTexts: string[] = [],
  zone: string = OPERATOR_ZONE
): Promise<SafetySignalsReport> {
  const window = dayContaining(now, zone);
  try {
    const facts = await loadCallFacts(db, { from: window.from, to: window.to });
    const escalations = await db.escalation.count({ where: { createdAt: { gte: window.from, lt: window.to } } });
    return safetySignalsFromFacts(facts, escalations, window, openingTexts);
  } catch {
    return {
      callsToday: 0,
      escalationsToday: 0,
      claimDefectsToday: 0,
      errorRate: 0,
      negativeSentimentRate: 0,
      blackboardReachable: false,
      defectRate: 0,
      claimDefectsRaw: 0,
      window
    };
  }
}

/* ================================================================== */
/* Spend                                                               */
/* ================================================================== */

export interface SpendSummary {
  totalUsd: number;
  byCategory: Partial<Record<SpendCategory, number>>;
}

export async function loadSpend(db: Blackboard, range: { from: Date; to: Date }): Promise<SpendSummary> {
  const rows = await db.spendRecord.groupBy({
    by: ['category'],
    where: { at: { gte: range.from, lt: range.to } },
    _sum: { usd: true }
  });
  const byCategory: Partial<Record<SpendCategory, number>> = {};
  let total = 0;
  for (const row of rows) {
    const usd = row._sum.usd ?? 0;
    byCategory[row.category as SpendCategory] = round(usd, 4);
    total += usd;
  }
  return { totalUsd: round(total, 4), byCategory };
}

/* ================================================================== */
/* Queue and gate (from the plan and the audit log)                    */
/* ================================================================== */

const auditDecisionSchema = z.object({
  decision: z.object({
    allowed: z.boolean(),
    reasons: z.array(z.object({ code: z.string() }).passthrough()).default([])
  })
});

export interface QueueCounts {
  /** Distinct people on a live plan for the window's days, or with a gate decision in it. */
  queued: number;
  /** Distinct people the gate allowed in the window. */
  gatePassed: number;
}

export async function loadQueueCounts(db: Blackboard, range: { from: Date; to: Date }, zone: string = OPERATOR_ZONE): Promise<QueueCounts> {
  const dates: string[] = [];
  for (let d = DateTime.fromJSDate(range.from, { zone }).startOf('day'); d.toMillis() < range.to.getTime(); d = d.plus({ days: 1 })) {
    dates.push(d.toFormat('yyyy-MM-dd'));
  }

  const entries = await db.callPlanEntry.findMany({
    where: { plan: { planDate: { in: dates }, status: { not: 'superseded' } } },
    select: { contactId: true }
  });
  const decisions = await db.auditRecord.findMany({
    where: { kind: 'dial-decision', at: { gte: range.from, lt: range.to } },
    select: { subject: true, data: true }
  });

  const queued = new Set<string>(entries.map((e) => e.contactId));
  const passed = new Set<string>();
  for (const d of decisions) {
    queued.add(d.subject);
    try {
      const parsed = auditDecisionSchema.safeParse(JSON.parse(d.data));
      if (parsed.success && parsed.data.decision.allowed) passed.add(d.subject);
    } catch {
      // A decision record that will not parse does not count as a pass.
    }
  }
  return { queued: queued.size, gatePassed: passed.size };
}

/** Why the gate refused, in the window, by reason code, most common first. */
export async function loadGateRejections(db: Blackboard, range: { from: Date; to: Date }): Promise<Array<{ reason: string; count: number }>> {
  const decisions = await db.auditRecord.findMany({
    where: { kind: 'dial-decision', at: { gte: range.from, lt: range.to } },
    select: { data: true }
  });
  const counts = new Map<string, number>();
  for (const d of decisions) {
    try {
      const parsed = auditDecisionSchema.safeParse(JSON.parse(d.data));
      if (!parsed.success || parsed.data.decision.allowed) continue;
      for (const reason of parsed.data.decision.reasons) counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1);
    } catch {
      // skip
    }
  }
  return [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

