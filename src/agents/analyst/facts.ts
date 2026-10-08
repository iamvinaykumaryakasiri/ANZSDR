/**
 * Calls as flat facts: the one shape every Analyst and Coach figure is computed from.
 *
 * Everything downstream of this file is a pure function over `CallFact[]`, so the
 * arithmetic can be tested without a database and the digest, the promotion gate
 * and the console cannot disagree about what a number means - they are all reading
 * the same definition of "answered", "survived the opener" and "real conversation".
 *
 * The definitions are deliberately the ones the console backend already uses
 * (src/stream/facts.ts), nested the same way: each funnel flag implies the one
 * before it, so no step can show a rate over 100%.
 *
 * A column that fails to decode does not read as empty. An empty defects list
 * would mean "this call was clean", and a corrupt row is not evidence of that; the
 * fact carries the field name in `unreadable` and the promotion gate counts such a
 * call against the variant.
 */

import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Blackboard } from '../../blackboard/client.js';
import { callOutcomeSchema, sectionMarkSchema, type CallOutcome } from '../../blackboard/schemas.js';
import { marketForDial } from '../../compliance/phone.js';
import type { Market } from '../../compliance/types.js';
import { assignmentFromRow, type Assignment } from '../../playbook/store.js';
import type { objectionKindSchema } from '../caller/tools.js';

/** Section 14.2: the opener is survived at fifteen seconds, a real conversation starts at forty-five. */
export const OPENER_SECONDS = 15;
export const CONVERSATION_SECONDS = 45;
/** With no outcome marked, a call counts as answered once it has run this long. */
export const ANSWERED_AFTER_SECONDS = 10;

const NOT_ANSWERED: readonly CallOutcome[] = ['no_answer', 'voicemail', 'invalid_number'];

export type ObjectionKind = z.infer<typeof objectionKindSchema>;

export interface FactDefect {
  kind: string;
  detail: string;
  atSecond?: number;
}

export interface FactObjection {
  kind: ObjectionKind;
  saidAs: string;
  handledAs: string;
}

export type Sentiment = 'positive' | 'neutral' | 'negative' | 'unknown';

export interface CallFact {
  id: string;
  contactId: string;
  accountId: string;
  campaignId: string;
  startedAt: Date;
  endedAt: Date | null;
  /** False for a call still in progress or one that crashed without an end time. */
  finished: boolean;
  durationSec: number;
  outcome: CallOutcome | null;
  /** `Call.playbookVersion`: the version name the console matches on, or `unversioned`. */
  variant: string;
  /** What the call ran with, when an assignment was recorded for it. */
  assignment: Assignment | null;
  market: Market;
  industry: string;
  seniority: string;
  company: string;
  name: string;
  marks: Array<{ section: string; atSecond: number }>;
  defects: FactDefect[];
  sentiment: Sentiment;
  objections: FactObjection[];
  /** The hook that landed, if one did. */
  hook: string;
  attentionLostAtSec: number | null;
  endedReason: string | null;
  /** The meeting request's status, if the call produced one. */
  meetingStatus: string | null;
  /** Columns that could not be decoded. Empty on a healthy row. */
  unreadable: string[];

  /** Nested: each implies the one before. */
  answered: boolean;
  survivedOpener: boolean;
  realConversation: boolean;
  askMade: boolean;
  requested: boolean;
  confirmed: boolean;
}

const CALL_INCLUDE = { contact: true, account: true, record: true, meetingRequest: true } as const;
type CallRow = Prisma.CallGetPayload<{ include: typeof CALL_INCLUDE }>;

const defectRowSchema = z
  .object({ kind: z.string(), detail: z.string().default(''), atSecond: z.number().optional() })
  .passthrough();

const objectionRowSchema = z
  .object({ saidAs: z.string(), handledAs: z.string().default(''), kind: z.string().optional() })
  .passthrough();

/**
 * A kind for an objection recorded as words only. Scribe keeps what was said and how
 * it was handled, not the label Lexi filed it under. Keyword rules, most specific
 * first, and the same rules the console uses so a ranked list reads identically
 * in both places.
 */
export function classifyObjection(saidAs: string): ObjectionKind {
  const text = saidAs.toLowerCase();
  const rules: Array<[ObjectionKind, RegExp]> = [
    ['asked-if-human', /\b(are you (a )?(real|human|robot|bot|ai|machine|person)|is this a (robot|bot|machine|recording)|talking to a (robot|machine))\b/],
    ['asked-where-number-came-from', /\b(where (did|do) you (get|find)|how did you (get|find)|where('s| is) that number|my (mobile |phone )?number)\b/],
    ['wants-pricing', /\b(price|pricing|how much|rates?|quote|fees?)\b/],
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

/** Decode one JSON column strictly, recording the failure instead of hiding it. */
function column<T>(raw: string | null | undefined, schema: z.ZodType<T>, field: string, unreadable: string[]): T | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through: unparseable is unreadable
  }
  unreadable.push(field);
  return null;
}

const SECTION_MARK_LIST = z.array(sectionMarkSchema);
const DEFECT_LIST = z.array(defectRowSchema);
const OBJECTION_LIST = z.array(objectionRowSchema);
const STRING_LIST = z.array(z.string());

export function toFact(row: CallRow, assignment: Assignment | null): CallFact {
  const unreadable: string[] = [];
  const startedMs = row.startedAt.getTime();
  const durationSec =
    row.durationSec ?? (row.endedAt !== null ? Math.max(0, Math.round((row.endedAt.getTime() - startedMs) / 1000)) : 0);

  const parsedOutcome = callOutcomeSchema.safeParse(row.outcome);
  const outcome = parsedOutcome.success ? parsedOutcome.data : null;
  if (row.outcome !== null && !parsedOutcome.success) unreadable.push('Call.outcome');

  const accountMarket: Market = row.account.country === 'NZ' ? 'NZ' : 'AU';
  const market = marketForDial(row.contact.phoneE164 ?? '', accountMarket);

  const marks = (column(row.sectionMarks, SECTION_MARK_LIST, 'Call.sectionMarks', unreadable) ?? []).map((m) => ({
    section: m.section,
    atSecond: m.atSecond
  }));
  const defects = (column(row.defects, DEFECT_LIST, 'Call.defects', unreadable) ?? []).map((d) => ({
    kind: d.kind,
    detail: d.detail ?? '',
    ...(d.atSecond !== undefined ? { atSecond: d.atSecond } : {})
  }));
  const objections = (column(row.record?.objections, OBJECTION_LIST, 'CallRecord.objections', unreadable) ?? []).map((o) => ({
    kind: classifyObjection(o.saidAs),
    saidAs: o.saidAs,
    handledAs: o.handledAs ?? ''
  }));
  column(row.record?.summary, STRING_LIST, 'CallRecord.summary', unreadable);

  const sentimentRaw = row.record?.sentiment ?? 'unknown';
  const sentiment: Sentiment =
    sentimentRaw === 'positive' || sentimentRaw === 'neutral' || sentimentRaw === 'negative' ? sentimentRaw : 'unknown';

  const answered = outcome !== null ? !NOT_ANSWERED.includes(outcome) : durationSec >= ANSWERED_AFTER_SECONDS;
  const survivedOpener = answered && durationSec >= OPENER_SECONDS;
  const realConversation = survivedOpener && durationSec >= CONVERSATION_SECONDS;
  const reachedAsk =
    marks.some((m) => m.section === 'ask') || outcome === 'meeting_requested' || outcome === 'callback_requested';
  const askMade = realConversation && reachedAsk;
  const requested = askMade && outcome === 'meeting_requested';
  const confirmed = requested && row.meetingRequest?.status === 'confirmed';

  return {
    id: row.id,
    contactId: row.contactId,
    accountId: row.accountId,
    campaignId: row.campaignId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    finished: row.endedAt !== null,
    durationSec,
    outcome,
    variant: row.playbookVersion ?? 'unversioned',
    assignment,
    market,
    industry: row.account.industry,
    seniority: row.contact.seniority,
    company: row.account.name,
    name: `${row.contact.firstName} ${row.contact.lastName}`.trim(),
    marks,
    defects,
    sentiment,
    objections,
    hook: row.record?.hook ?? '',
    attentionLostAtSec: row.record?.attentionLostAtSec ?? null,
    endedReason: row.endedReason,
    meetingStatus: row.meetingRequest?.status ?? null,
    unreadable,
    answered,
    survivedOpener,
    realConversation,
    askMade,
    requested,
    confirmed
  };
}

const IN_CHUNK = 400;

export interface FactRange {
  from: Date;
  /** Exclusive. */
  to: Date;
}

/** Calls that started in the range, oldest first, each with the playbook it ran. */
export async function loadCallFacts(db: Blackboard, range: FactRange): Promise<CallFact[]> {
  const rows = await db.call.findMany({
    where: { startedAt: { gte: range.from, lt: range.to } },
    orderBy: { startedAt: 'asc' },
    include: CALL_INCLUDE
  });

  const assignments = new Map<string, Assignment>();
  for (let i = 0; i < rows.length; i += IN_CHUNK) {
    const ids = rows.slice(i, i + IN_CHUNK).map((r) => r.id);
    const memory = await db.memory.findMany({ where: { scope: 'playbook', kind: 'assignment', key: { in: ids } } });
    for (const m of memory) {
      try {
        assignments.set(m.key, assignmentFromRow(m));
      } catch {
        // A corrupt assignment reads as none: the call then falls back to its
        // variant name, and the evidence loader treats an unassigned call as unknown.
      }
    }
  }

  return rows.map((row) => toFact(row, assignments.get(row.id) ?? null));
}
