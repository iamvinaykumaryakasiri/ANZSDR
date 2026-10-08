/**
 * Turning calls into the numbers the console shows.
 *
 * Everything the console draws is computed here, on the server, from the
 * blackboard (section 14.6: the console holds no business logic). The pieces are
 * pure functions over a flat `CallFact`, so the funnel arithmetic can be tested
 * without a database and the Jarvis answers read the very same numbers the
 * charts do.
 */

import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { objectionKindSchema } from '../agents/caller/tools.js';
import type { Blackboard } from '../blackboard/client.js';
import { callOutcomeSchema, sectionMarkSchema, type CallOutcome } from '../blackboard/schemas.js';
import { marketForDial } from '../compliance/phone.js';
import type { Market } from '../compliance/types.js';
import { SCRIPT_STAGES, type FunnelStageView, type HangupCurveView, type ScriptStage } from './contract.js';
import { median, ratio, readJson } from './util.js';

/** The look-back the hang-up curve, objections and gatekeeper table are drawn from. */
export const ANALYSIS_DAYS = 30;

/** A call with no end time is only "live" for this long; beyond it the row is a crash, not a call. */
export const LIVE_MAX_MS = 20 * 60_000;

/** Section 14.2: the opener is survived at fifteen seconds, a real conversation starts at forty-five. */
export const OPENER_SECONDS = 15;
export const CONVERSATION_SECONDS = 45;

const NOT_ANSWERED: readonly CallOutcome[] = ['no_answer', 'voicemail', 'invalid_number'];

export interface CallFact {
  id: string;
  contactId: string;
  accountId: string;
  startedAt: Date;
  endedAt: Date | null;
  live: boolean;
  /** For a live call, the seconds so far. */
  durationSec: number;
  outcome: CallOutcome | null;
  variant: string;
  market: Market;
  industry: string;
  seniority: string;
  company: string;
  name: string;
  title: string;
  marks: Array<{ stage: ScriptStage; atSecond: number }>;
  defects: number;
  objections: Array<{ kind: z.infer<typeof objectionKindSchema>; saidAs: string }>;
  hook: string;
  meetingStatus: string | null;
  recordingUrl: string | null;
  attentionLostAtSec: number | null;
  summary: string[];

  /** The funnel is nested: each flag implies the one before it. */
  answered: boolean;
  survivedOpener: boolean;
  realConversation: boolean;
  askMade: boolean;
  requested: boolean;
  confirmed: boolean;
}

const CALL_INCLUDE = { contact: true, account: true, record: true, meetingRequest: true } as const;
type CallRow = Prisma.CallGetPayload<{ include: typeof CALL_INCLUDE }>;

const STAGE_OF_SECTION: Record<string, ScriptStage> = {
  disclosure: 'disclosure',
  reason: 'reason',
  hook: 'hook',
  'value-statement': 'value',
  value: 'value',
  ask: 'ask',
  close: 'close'
};

const storedObjectionSchema = z
  .object({ saidAs: z.string(), handledAs: z.string().optional(), kind: z.string().optional() })
  .passthrough();

/* ------------------------------------------------------------------ */
/* Objections                                                          */
/* ------------------------------------------------------------------ */

export type ObjectionKind = z.infer<typeof objectionKindSchema>;

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

/**
 * A kind for an objection that was recorded as words only.
 *
 * Scribe keeps what was said and how it was handled, not the kind Lexi filed it
 * under, so ranking objections needs one. This is keyword rules, not a model: a
 * ranked list that reshuffles between refreshes would be worse than a
 * slightly-blunt one that doesn't. Order matters, most specific first.
 */
export function classifyObjection(saidAs: string): ObjectionKind {
  const text = saidAs.toLowerCase();
  const rules: Array<[ObjectionKind, RegExp]> = [
    ['asked-if-human', /\b(are you (a )?(real|human|robot|bot|ai|machine|person)|is this a (robot|bot|machine|recording)|talking to a (robot|machine))\b/],
    ['asked-where-number-came-from', /\b(where (did|do) you (get|find)|how did you (get|find)|where('s| is) that number|my (mobile |phone )?number)\b/],
    ['wants-pricing', /\b(price|pricing|how much|what does it cost|what'?s the cost|rates?|quote|fees?)\b/],
    ['send-email', /\b(send (me )?(an? )?(email|info|something|details|it)|email me|in writing|put it in an email)\b/],
    ['not-the-right-person', /\b(not the (right|best) person|wrong person|someone else|talk to|not my (area|remit|department)|doesn'?t sit with me)\b/],
    ['has-a-partner', /\b(partner|already (work|use|have|got)|existing (vendor|supplier|provider|arrangement)|in-?house|incumbent|panel)\b/],
    ['no-budget', /\b(budget|no money|can'?t afford|expensive|funding)\b/],
    ['no-time-now', /\b(busy|no time|bad time|not now|right now|swamped|mid-?way|in the middle|in a meeting|call me back|ring me back|later)\b/],
    ['not-interested', /\b(not interested|no thanks|no thank you|don'?t need|don'?t want)\b/]
  ];
  for (const [kind, pattern] of rules) if (pattern.test(text)) return kind;
  return 'other';
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export function toFact(row: CallRow, now: Date): CallFact {
  const startedMs = row.startedAt.getTime();
  const live = row.endedAt === null && now.getTime() - startedMs < LIVE_MAX_MS;
  const durationSec =
    row.durationSec ??
    (row.endedAt !== null
      ? Math.max(0, Math.round((row.endedAt.getTime() - startedMs) / 1000))
      : live
        ? Math.max(0, Math.round((now.getTime() - startedMs) / 1000))
        : 0);

  const parsedOutcome = callOutcomeSchema.safeParse(row.outcome);
  const outcome = parsedOutcome.success ? parsedOutcome.data : null;

  const accountMarket: Market = row.account.country === 'NZ' ? 'NZ' : 'AU';
  const market = marketForDial(row.contact.phoneE164 ?? '', accountMarket);

  const marks = readJson(row.sectionMarks, z.array(sectionMarkSchema), []).flatMap((m) => {
    const stage = STAGE_OF_SECTION[m.section];
    return stage === undefined ? [] : [{ stage, atSecond: m.atSecond }];
  });

  const record = row.record;
  const objections = readJson(record?.objections, z.array(storedObjectionSchema), []).map((o) => {
    const filed = objectionKindSchema.safeParse(o.kind);
    return { kind: filed.success ? filed.data : classifyObjection(o.saidAs), saidAs: o.saidAs };
  });

  // Nested on purpose: a call that is not "answered" cannot have survived the
  // opener, and so on down. Each stage of the funnel is therefore a subset of the
  // one above it, and no step can show a rate over 100%.
  const answered =
    outcome !== null ? !NOT_ANSWERED.includes(outcome) : durationSec >= 10;
  const survivedOpener = answered && durationSec >= OPENER_SECONDS;
  const realConversation = survivedOpener && durationSec >= CONVERSATION_SECONDS;
  const reachedAsk =
    marks.some((m) => m.stage === 'ask') || outcome === 'meeting_requested' || outcome === 'callback_requested';
  const askMade = realConversation && reachedAsk;
  const requested = askMade && outcome === 'meeting_requested';
  const confirmed = requested && row.meetingRequest?.status === 'confirmed';

  return {
    id: row.id,
    contactId: row.contactId,
    accountId: row.accountId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    live,
    durationSec,
    outcome,
    variant: row.playbookVersion ?? 'unversioned',
    market,
    industry: row.account.industry,
    seniority: row.contact.seniority,
    company: row.account.name,
    name: `${row.contact.firstName} ${row.contact.lastName}`.trim(),
    title: row.contact.title,
    marks,
    defects: readJson(row.defects, z.array(z.unknown()), []).length,
    objections,
    hook: record?.hook ?? '',
    meetingStatus: row.meetingRequest?.status ?? null,
    recordingUrl: row.recordingUrl,
    attentionLostAtSec: record?.attentionLostAtSec ?? null,
    summary: readJson(record?.summary, z.array(z.string()), []),
    answered,
    survivedOpener,
    realConversation,
    askMade,
    requested,
    confirmed
  };
}

export async function loadCallFacts(db: Blackboard, range: { from: Date; to: Date }, now: Date): Promise<CallFact[]> {
  const rows = await db.call.findMany({
    where: { startedAt: { gte: range.from, lt: range.to } },
    orderBy: { startedAt: 'asc' },
    include: CALL_INCLUDE
  });
  return rows.map((row) => toFact(row, now));
}

export async function loadCallFact(db: Blackboard, id: string, now: Date): Promise<CallFact | null> {
  const row = await db.call.findUnique({ where: { id }, include: CALL_INCLUDE });
  return row === null ? null : toFact(row, now);
}

/* ------------------------------------------------------------------ */
/* The funnel (section 14.2)                                           */
/* ------------------------------------------------------------------ */

type FunnelId = FunnelStageView['id'];

export const FUNNEL_STAGES: ReadonlyArray<{ id: FunnelId; label: string }> = Object.freeze([
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

export interface FunnelInput {
  /** Calls in the period being shown. */
  today: CallFact[];
  /** Calls in the seven days before it. */
  baseline: CallFact[];
  /** Queue-side counts for the period: who was lined up, and how many of those cleared the gate. */
  queued: number;
  gatePassed: number;
  baselineQueued: number;
  baselineGatePassed: number;
}

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

export function buildFunnel(input: FunnelInput): FunnelStageView[] {
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

/* ------------------------------------------------------------------ */
/* Seconds-to-hangup (section 14.2)                                    */
/* ------------------------------------------------------------------ */

export const STAGE_LABELS: Record<ScriptStage, string> = {
  disclosure: 'Disclosure',
  reason: 'Reason for the call',
  hook: 'Hook',
  value: 'Value statement',
  ask: 'The ask',
  close: 'Close'
};

/** Where each section begins on a typical call, used until there are marks to measure. */
const DEFAULT_STARTS: Record<ScriptStage, number> = { disclosure: 0, reason: 10, hook: 22, value: 38, ask: 58, close: 80 };

export const CURVE_BIN_SECONDS = 5;
const CURVE_MIN_SECONDS = 120;
const CURVE_MAX_SECONDS = 300;

export function buildHangupCurve(facts: CallFact[], binSeconds = CURVE_BIN_SECONDS): HangupCurveView {
  // Only people who picked up and have finished: a voicemail drop is not someone
  // losing interest, and a live call has not hung up yet.
  const sample = facts.filter((f) => f.answered && !f.live && f.endedAt !== null);
  const longest = sample.reduce((max, f) => Math.max(max, f.durationSec), 0);
  const maxSecond = Math.min(
    CURVE_MAX_SECONDS,
    Math.max(CURVE_MIN_SECONDS, Math.ceil((longest + 1) / binSeconds) * binSeconds)
  );
  const binCount = Math.ceil(maxSecond / binSeconds);

  const bins = Array.from({ length: binCount }, (_, i) => ({ fromSecond: i * binSeconds, count: 0, callIds: [] as string[] }));
  for (const f of sample) {
    // Anything longer than the chart is drawn goes in the last bin rather than off the end.
    const bin = bins[Math.min(binCount - 1, Math.floor(f.durationSec / binSeconds))];
    if (bin === undefined) continue;
    bin.count += 1;
    bin.callIds.push(f.id);
  }

  // Where each section begins is measured, not assumed: the median of the second
  // each call actually reached it. The overlay is therefore this variant's script
  // as it was really paced, which is what lets the eye tie a spike to a sentence.
  const starts = {} as Record<ScriptStage, number>;
  let floor = -1;
  for (const stage of SCRIPT_STAGES) {
    const seen = facts.flatMap((f) => f.marks.filter((m) => m.stage === stage).map((m) => m.atSecond));
    const measured = median(seen);
    const start = Math.round(measured ?? DEFAULT_STARTS[stage]);
    starts[stage] = Math.max(start, floor + 1);
    floor = starts[stage];
  }

  const sections = SCRIPT_STAGES.map((stage, i) => {
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

/* ------------------------------------------------------------------ */
/* Objections, gatekeepers, wrong numbers                              */
/* ------------------------------------------------------------------ */

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

/** Wrong numbers and dead numbers as a share of finished calls: a data-quality signal, not a script one. */
export function wrongNumberRate(facts: CallFact[]): number {
  const finished = facts.filter((f) => !f.live);
  const wrong = finished.filter((f) => f.outcome === 'wrong_person' || f.outcome === 'invalid_number').length;
  return ratio(wrong, finished.length);
}

/* ------------------------------------------------------------------ */
/* Hooks and closeness (used by the snapshot and by Jarvis)            */
/* ------------------------------------------------------------------ */

export interface HookPerformance {
  hook: string;
  /** Real conversations in which Scribe recorded this hook as the one that got a reaction. */
  landed: number;
  /** Of those, how many ended in a meeting request. */
  requests: number;
  rate: number;
}

/**
 * Which opener is landing. Scribe records a hook only when it got a real reaction
 * (an empty hook means none did), so a hook that fell flat leaves no trace here.
 * That makes this a count of what landed and what it led to, not a conversion rate
 * over every use; the fair comparison between scripts is `variantPerformance`.
 */
export function hookPerformance(facts: CallFact[]): HookPerformance[] {
  const byHook = new Map<string, { landed: number; requests: number }>();
  for (const f of facts) {
    if (!f.realConversation || f.hook.trim() === '') continue;
    const entry = byHook.get(f.hook) ?? { landed: 0, requests: 0 };
    entry.landed += 1;
    if (f.requested) entry.requests += 1;
    byHook.set(f.hook, entry);
  }
  return [...byHook]
    .map(([hook, v]) => ({ hook, ...v, rate: ratio(v.requests, v.landed) }))
    .sort((a, b) => b.requests - a.requests || b.rate - a.rate || b.landed - a.landed || a.hook.localeCompare(b.hook));
}

export interface VariantPerformance {
  variant: string;
  conversations: number;
  requests: number;
  rate: number;
}

/** Meeting requests per real conversation, by the script version the call ran: the like-for-like comparison. */
export function variantPerformance(facts: CallFact[]): VariantPerformance[] {
  const byVariant = new Map<string, { conversations: number; requests: number }>();
  for (const f of facts) {
    if (!f.realConversation) continue;
    const entry = byVariant.get(f.variant) ?? { conversations: 0, requests: 0 };
    entry.conversations += 1;
    if (f.requested) entry.requests += 1;
    byVariant.set(f.variant, entry);
  }
  return [...byVariant]
    .map(([variant, v]) => ({ variant, ...v, rate: ratio(v.requests, v.conversations) }))
    .sort((a, b) => b.rate - a.rate || b.conversations - a.conversations || a.variant.localeCompare(b.variant));
}

/**
 * How near a call came to a meeting. A meeting request is the top; a callback is
 * next; then having got as far as the ask; then simply how long they stayed.
 */
export function closeness(f: CallFact): number {
  if (f.outcome === 'meeting_requested') return 1000 + f.durationSec;
  if (f.outcome === 'callback_requested') return 800 + f.durationSec;
  if (f.askMade) return 600 + f.durationSec;
  if (f.realConversation) return 400 + f.durationSec;
  return f.durationSec;
}
