/**
 * Scribe: owns the record (brief section 3.3).
 *
 * After a call it writes down what happened: the outcome, a summary, the
 * objections, the email and times Lexi captured, and the defects. It reads the
 * journal of the call and writes to the blackboard. It sends nothing and
 * decides nothing about what follows - that is the follow-up matrix, and
 * carrying it out is Concierge's.
 *
 * It is idempotent. Every write is an upsert keyed on the call, so a retry, a
 * replayed webhook or a second run after a crash leaves one record, not two.
 *
 * The only thing here that needs a model is the summary, and the design is
 * built around that model being unavailable. A summary is the nicest part of
 * the meeting email and the one part that can fail without making the email
 * wrong, so when it fails the email still goes, says plainly that there is no
 * summary, and links the transcript. An invented summary would be worse than
 * none: it is the section Vinay reads as "what was actually said".
 */

import { z } from 'zod';
import type { Blackboard } from '../../blackboard/client.js';
import type { CallOutcome } from '../../blackboard/schemas.js';
import type { AuditFinding, TranscriptTurn } from '../guardian/audit.js';
import type { EscalationReason } from '../concierge/followup.js';
import type { EmailSource, PreferredWindow } from '../concierge/meeting-email.js';
import {
  bestEmail,
  checkWindows,
  contactStatusAfter,
  resolveOutcome,
  validCalls,
  type ChosenEmail,
  type JournalToolCall,
  type RuleDefect
} from './rules.js';

/** The seam. The endpoint supplies Claude; tests supply a script. */
export interface ScribeModel {
  summarise(prompt: string): Promise<unknown>;
}

const sentimentSchema = z.enum(['positive', 'neutral', 'negative']);

/**
 * What the summariser must return. Out-of-contract output is treated as no
 * output (rule three): a malformed summary is not salvaged, because salvage is
 * guesswork about what a model meant.
 */
export const summaryOutputSchema = z.object({
  summary: z.array(z.string().trim().min(1)).min(1),
  hook: z.string().default(''),
  sentiment: sentimentSchema,
  sentimentTrace: z.array(z.object({ atSecond: z.number().nonnegative(), sentiment: sentimentSchema })).default([]),
  attentionLostAtSec: z.number().nonnegative().nullable().default(null)
});
export type SummaryOutput = z.infer<typeof summaryOutputSchema>;

export const MAX_SUMMARY_LINES = 5;

export function summaryPrompt(transcript: TranscriptTurn[]): string {
  const lines = transcript
    .map((t) => `[${t.atSecond}s] ${t.speaker === 'lexi' ? 'LEXI' : 'PROSPECT'}: ${t.text}`)
    .join('\n');

  return `Summarise this cold call for the salesperson who will follow up. Lexi is an AI assistant calling for Hexaware.

Rules:
- State only what was said. Do not infer, guess or tidy up. If the prospect did not say something, it is not in the summary.
- At most five lines, one fact each, plain and short.
- Say what the prospect actually said about their situation, what they asked, and what was agreed.
- If Lexi declined or deferred a question, say so.
- If little of substance was said, say that rather than padding.

Also report:
- "hook": the opener that got a real reaction, in a few words, or "" if none did
- "sentiment": the prospect's overall tone: positive, neutral or negative
- "sentimentTrace": the tone at a few points, each with the second it applies at
- "attentionLostAtSec": the second at which the prospect disengaged, or null if they did not

TRANSCRIPT:
${lines}

Reply with JSON only:
{"summary":["..."],"hook":"...","sentiment":"neutral","sentimentTrace":[{"atSecond":0,"sentiment":"neutral"}],"attentionLostAtSec":null}`;
}

export interface ScribeInput {
  callId: string;
  endedAt: Date;
  durationSec: number;
  transcript: TranscriptTurn[];
  /** The calls Lexi made during the call, as journalled. Re-validated here. */
  toolCalls: JournalToolCall[];
  /** Defects Guardian found while the call was live. */
  turnDefects: Array<{ kind: string; detail: string; atSecond?: number }>;
  /** What Guardian's post-call audit found. */
  audit: AuditFinding[];
}

export interface ScribeDeps {
  db: Blackboard;
  model?: ScribeModel;
  now: () => Date;
}

export interface RecordedDefect {
  kind: string;
  detail: string;
  atSecond?: number;
}

export interface ScribeResult {
  callId: string;
  contactId: string;
  accountId: string;
  outcome: CallOutcome | null;
  escalationReason?: EscalationReason;
  escalationSaidAs?: string;
  /**
   * How many times the prospect actually spoke. "Just spoken to us" is judged on
   * this and not only on the outcome Lexi marked: a model can mark a meeting
   * request on a call where nobody said anything, and a text must not follow.
   */
  prospectTurns: number;
  email: ChosenEmail | null;
  windows: PreferredWindow[];
  timezone: string | null;
  attendees: string[];
  objections: Array<{ saidAs: string; handledAs: string }>;
  summary: string[];
  summarySource: 'model' | 'unavailable';
  hook: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'unknown';
  attentionLostAtSec: number | null;
  defects: RecordedDefect[];
}

/** Map an audit finding onto a stored defect kind. */
function auditKind(kind: AuditFinding['kind']): string {
  return kind; // every audit kind is already a defect kind
}

export async function scribeCall(deps: ScribeDeps, input: ScribeInput): Promise<ScribeResult> {
  const call = await deps.db.call.findUniqueOrThrow({
    where: { id: input.callId },
    include: { contact: true }
  });

  const ruleDefects: RuleDefect[] = [];

  const { valid, defects: badCalls } = validCalls(input.toolCalls);
  ruleDefects.push(...badCalls);

  const resolved = resolveOutcome(valid);
  ruleDefects.push(...resolved.defects);

  // Times: the last capture wins, because a correction is the last thing said.
  const timesCall = [...valid].reverse().find((c) => c.name === 'capture_preferred_times');
  let windows: PreferredWindow[] = [];
  let timezone: string | null = null;
  let attendees: string[] = [];
  if (timesCall !== undefined) {
    const v = timesCall.value as { slots: PreferredWindow[]; timezone: string; attendees: string[] };
    const checked = checkWindows(v.slots, input.endedAt);
    windows = checked.windows;
    timezone = v.timezone;
    attendees = v.attendees;
    ruleDefects.push(...checked.defects);
  }
  if (resolved.outcome === 'meeting_requested' && windows.length === 0) {
    ruleDefects.push({
      kind: 'window-missing',
      detail: 'a meeting was requested but no usable time window was captured'
    });
  }

  // Email: the last capture wins. Stored as confirmed_on_call whether or not it
  // was read back, with `verified` carrying the difference.
  const emailCall = [...valid].reverse().find((c) => c.name === 'capture_email');
  if (emailCall !== undefined) {
    const v = emailCall.value as { email: string; confidence: 'read-back-confirmed' | 'heard-once' };
    await deps.db.contactEmail.upsert({
      where: { contactId_kind: { contactId: call.contactId, kind: 'confirmed_on_call' } },
      create: {
        id: `${call.contactId}-confirmed`,
        contactId: call.contactId,
        address: v.email,
        kind: 'confirmed_on_call',
        verified: v.confidence === 'read-back-confirmed',
        verifiedAt: v.confidence === 'read-back-confirmed' ? deps.now() : null
      },
      update: {
        address: v.email,
        verified: v.confidence === 'read-back-confirmed',
        verifiedAt: v.confidence === 'read-back-confirmed' ? deps.now() : null
      }
    });
  }
  const held = await deps.db.contactEmail.findMany({ where: { contactId: call.contactId } });
  const email = bestEmail(held.map((e) => ({ address: e.address, kind: e.kind, verified: e.verified })));

  const objections = valid
    .filter((c) => c.name === 'log_objection')
    .map((c) => {
      const v = c.value as { saidAs: string; handledAs: string };
      return { saidAs: v.saidAs, handledAs: v.handledAs };
    });

  // The summary: a model, or an honest absence.
  let summary: string[] = [];
  let summarySource: 'model' | 'unavailable' = 'unavailable';
  let hook = '';
  let sentiment: ScribeResult['sentiment'] = 'unknown';
  let sentimentTrace: SummaryOutput['sentimentTrace'] = [];
  let attentionLostAtSec: number | null = null;
  const summaryProblems: string[] = [];

  if (input.transcript.length === 0) {
    summaryProblems.push('there was no transcript to summarise');
  } else if (deps.model === undefined) {
    summaryProblems.push('no summariser is configured');
  } else {
    try {
      const raw = await deps.model.summarise(summaryPrompt(input.transcript));
      const parsed = summaryOutputSchema.safeParse(raw);
      if (parsed.success) {
        summary = parsed.data.summary.slice(0, MAX_SUMMARY_LINES);
        summarySource = 'model';
        hook = parsed.data.hook;
        sentiment = parsed.data.sentiment;
        sentimentTrace = parsed.data.sentimentTrace;
        attentionLostAtSec = parsed.data.attentionLostAtSec;
      } else {
        summaryProblems.push('the summariser returned something that was not a summary');
      }
    } catch (error) {
      summaryProblems.push(`the summariser did not return: ${(error as Error).message}`);
    }
  }

  const defects: RecordedDefect[] = [
    ...input.turnDefects,
    ...input.audit.map((f) => ({
      kind: auditKind(f.kind),
      detail: f.certainty === 'likely' ? `${f.detail} (a model's reading, not certain)` : f.detail,
      ...(f.atSecond !== undefined ? { atSecond: f.atSecond } : {})
    })),
    ...ruleDefects.map((d) => ({ kind: d.kind, detail: d.detail })),
    ...summaryProblems.map((detail) => ({ kind: 'summary-unavailable', detail }))
  ];

  await deps.db.call.update({
    where: { id: input.callId },
    data: {
      outcome: resolved.outcome,
      endedAt: input.endedAt,
      durationSec: input.durationSec,
      sentiment: sentiment === 'unknown' ? null : sentiment,
      defects: JSON.stringify(defects)
    }
  });

  const record = {
    summary: JSON.stringify(summary),
    summarySource,
    hook,
    objections: JSON.stringify(objections),
    sentiment,
    sentimentTrace: JSON.stringify(sentimentTrace),
    attentionLostAtSec,
    windows: JSON.stringify(windows),
    timezone,
    attendees: JSON.stringify(attendees)
  };
  await deps.db.callRecord.upsert({
    where: { callId: input.callId },
    create: { id: `${input.callId}-record`, callId: input.callId, ...record },
    update: record
  });

  const nextStatus = contactStatusAfter(resolved.outcome, call.contact.status);
  if (nextStatus !== call.contact.status) {
    await deps.db.contact.update({ where: { id: call.contactId }, data: { status: nextStatus, updatedAt: deps.now() } });
  }

  return {
    callId: input.callId,
    contactId: call.contactId,
    accountId: call.accountId,
    outcome: resolved.outcome,
    ...(resolved.escalationReason !== undefined ? { escalationReason: resolved.escalationReason } : {}),
    ...(resolved.escalationSaidAs !== undefined ? { escalationSaidAs: resolved.escalationSaidAs } : {}),
    prospectTurns: input.transcript.filter((t) => t.speaker === 'prospect').length,
    email,
    windows,
    timezone,
    attendees,
    objections,
    summary,
    summarySource,
    hook,
    sentiment,
    attentionLostAtSec,
    defects
  };
}

export type { EmailSource };
