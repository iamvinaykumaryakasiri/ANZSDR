/**
 * Jarvis: the command bar (section 14.3).
 *
 * Natural language in, grounded answers out. It queries the blackboard, never
 * guesses, and always says what it read.
 *
 * Three rules shape every line of this file.
 *
 *   1. Asking is free; telling is not. A question is answered at once from
 *      read-only queries. An instruction (pause a campaign, suppress someone,
 *      requeue, roll back, halt dialling) comes back as `needs_confirmation` with
 *      exactly what will happen and an action id, and nothing has changed. Only
 *      `confirm(actionId)` executes it, once, within a few minutes. Parsing an
 *      instruction is not permission to act on it.
 *   2. A model, if one is configured, is a reader and nothing more. It is given
 *      read-only tools and is never asked to decide what to change; instructions
 *      are recognised by the deterministic parser in jarvis-intents.ts. A model's
 *      answer with nothing read behind it is refused, not shown.
 *   3. Anything not understood is refused. Guessing at an instruction that can
 *      suppress a person for good is the one thing this module must not do.
 *
 * Jarvis never dials, never emails, never texts and never approves a plan: those
 * belong to the dialler, to Concierge and to the operator, in that order.
 */

import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { narrowForTestContact } from '../agents/concierge/followup.js';
import { suppressionRecord } from '../compliance/audit.js';
import { jarvisAnswerSchema, type JarvisAnswer } from './contract.js';
import { listCalls, callDetail } from './calls.js';
import type { ConsoleDeps } from './deps.js';
import {
  ANALYSIS_DAYS,
  closeness,
  hookPerformance,
  loadCallFacts,
  OBJECTION_LABELS,
  STAGE_LABELS,
  type CallFact
} from './facts.js';
import { describeReasons } from './gate-text.js';
import { HELP_TEXT, parseIntent, rangeOf, subjectTokens, type Command, type Intent, type PeriodRange } from './jarvis-intents.js';
import { setKillSwitch } from './kill.js';
import { planRollback, rollBackPlaybook, versionLabel, type RollbackPlan } from './playbook.js';
import { dialVerdict } from './queue.js';
import { SnapshotService } from './snapshot.js';
import { DAY_MS, money, plural, stamp, truncate, usd } from './util.js';

/* ------------------------------------------------------------------ */
/* The model seam                                                      */
/* ------------------------------------------------------------------ */

/** A read the model may make. There is no write tool anywhere in this interface. */
export interface JarvisReadTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: unknown): Promise<unknown>;
}

export interface JarvisModel {
  /** Answer `question` using only these tools, and return the answer as plain text. */
  answer(input: { question: string; system: string; tools: JarvisReadTool[] }): Promise<string>;
}

export const JARVIS_SYSTEM = `You are Jarvis, the read-only command bar of an outbound sales system for one operator.
Answer the operator's question using ONLY the tools provided, which read the system's records.
Rules:
- Every fact in your answer must come from a tool result. If the tools do not hold the answer, say so plainly. Never estimate, never fill gaps.
- You cannot change anything and must never say or imply that you have. If asked to change something, say that instructions such as pausing a campaign or suppressing a contact are handled by exact commands which the operator confirms separately.
- Keep it short, in plain sentences, with the numbers. No markdown.`;

export interface JarvisContext {
  /** The contact "this contact" refers to, when the console knows (for example, the open call). */
  contactId?: string;
}

export interface JarvisOptions {
  model?: JarvisModel | undefined;
  /** How long a proposed action can be confirmed for. Five minutes. */
  ttlMs?: number;
  /** Called after any confirmed action, so the room can redraw. */
  onChanged?: () => Promise<unknown> | unknown;
  newId?: () => string;
}

/* ------------------------------------------------------------------ */
/* Proposed actions                                                    */
/* ------------------------------------------------------------------ */

type ActionPlan =
  | { kind: 'pause_campaign'; campaignId: string }
  | { kind: 'resume_campaign'; campaignId: string }
  | { kind: 'suppress_contact'; contactId: string }
  | { kind: 'requeue_contact'; contactId: string; date: string }
  | { kind: 'rollback_playbook'; plan: RollbackPlan }
  | { kind: 'engage_kill'; reason: string }
  | { kind: 'release_kill' };

interface StoredAction {
  id: string;
  plan: ActionPlan;
  description: string;
  expiresAt: number;
  /** Set once executed; a second confirm returns this and does nothing. */
  result: JarvisAnswer | null;
}

const MAX_PENDING = 50;
const DEFAULT_TTL_MS = 5 * 60_000;

type ContactRow = Prisma.ContactGetPayload<{ include: { account: true } }>;

const answer = (text: string, sources: string[]): JarvisAnswer => ({ kind: 'answer', text, sources });
const refused = (text: string, sources: string[] = []): JarvisAnswer => ({ kind: 'refused', text, sources });

export class Jarvis {
  private readonly actions = new Map<string, StoredAction>();

  constructor(
    private readonly c: ConsoleDeps,
    private readonly snapshots: SnapshotService,
    private readonly options: JarvisOptions = {}
  ) {}

  private get zone(): string {
    return this.c.policy.operational_timezone;
  }

  /* ---------------------------------------------------------------- */
  /* Asking                                                            */
  /* ---------------------------------------------------------------- */

  async ask(query: string, context: JarvisContext = {}): Promise<JarvisAnswer> {
    const text = query.trim();
    if (text === '') return refused('Ask me something, for example what needs me.');
    if (text.length > 600) return refused('That is too long for me to act on. Say it shorter.');

    const intent = parseIntent(text);
    const result = await this.dispatch(intent, text, context);
    // The wire contract is the last word on what leaves here.
    return jarvisAnswerSchema.parse(result);
  }

  private async dispatch(intent: Intent, original: string, context: JarvisContext): Promise<JarvisAnswer> {
    switch (intent.kind) {
      case 'forbidden':
        return refused(intent.why);
      case 'help':
        return answer(HELP_TEXT, []);
      case 'command':
        return this.propose(intent.command, context);
      case 'cost_per_meeting':
        return this.costPerMeeting(rangeOf(intent.period, this.c.now(), this.zone));
      case 'early_hangups':
        return this.earlyHangups(intent.seconds, rangeOf(intent.period, this.c.now(), this.zone));
      case 'why_stopped':
        return this.whyStopped(intent.subject);
      case 'best_hook':
        return this.bestHook(intent.market);
      case 'closest_calls':
        return this.closestCalls(intent.count);
      case 'needs_me':
        return this.needsMe();
      case 'today':
        return this.todaySummary();
      case 'queue':
        return this.queueStatus();
      case 'kill_status':
        return this.killStatus();
      case 'plan_status':
        return this.planStatus();
      case 'objections':
        return this.objections();
      case 'spend':
        return this.spend(rangeOf(intent.period, this.c.now(), this.zone));
      case 'unknown':
        return this.askModel(original);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Reads                                                             */
  /* ---------------------------------------------------------------- */

  private async spendByCategory(range: PeriodRange): Promise<{ total: number; parts: string[] }> {
    const groups = await this.c.db.spendRecord.groupBy({
      by: ['category'],
      _sum: { usd: true },
      where: { at: { gte: range.from, lt: range.to } }
    });
    const parts = groups
      .map((g) => ({ category: g.category, usd: usd(g._sum.usd ?? 0) }))
      .filter((g) => g.usd > 0)
      .sort((a, b) => b.usd - a.usd)
      .map((g) => `${g.category} ${money(g.usd)}`);
    return { total: usd(groups.reduce((sum, g) => sum + (g._sum.usd ?? 0), 0)), parts };
  }

  private async costPerMeeting(range: PeriodRange): Promise<JarvisAnswer> {
    const [{ total, parts }, facts] = await Promise.all([
      this.spendByCategory(range),
      loadCallFacts(this.c.db, { from: range.from, to: range.to }, this.c.now())
    ]);
    const requested = facts.filter((f) => f.outcome === 'meeting_requested');
    const confirmed = requested.filter((f) => f.meetingStatus === 'confirmed');
    const sources = [
      `SpendRecord: every category ${range.label} (${parts.length === 0 ? 'nothing recorded' : parts.join(', ')})`,
      `Call and MeetingRequest: ${plural(facts.length, 'call')} ${range.label}, ${requested.length} ending in a meeting request, ${confirmed.length} confirmed`
    ];

    if (requested.length === 0) {
      return answer(
        `No meeting requests ${range.label}, so there is no cost per meeting yet. ${money(total)} has been spent ${range.label}.`,
        sources
      );
    }
    const perRequest = usd(total / requested.length);
    const confirmedPart =
      confirmed.length === 0
        ? 'None of them has been confirmed by you yet.'
        : `${confirmed.length} ${confirmed.length === 1 ? 'has' : 'have'} been confirmed, which is ${money(usd(total / confirmed.length))} per confirmed meeting.`;
    return answer(
      `${money(total)} spent ${range.label} (${parts.join(', ')}) across ${plural(requested.length, 'meeting request')}: ${money(perRequest)} per meeting request. ${confirmedPart} Spend counts everything on the ledger, not only call minutes.`,
      sources
    );
  }

  private stageAt(f: CallFact, second: number): string {
    const reached = f.marks.filter((m) => m.atSecond <= second).sort((a, b) => b.atSecond - a.atSecond)[0];
    return STAGE_LABELS[reached?.stage ?? 'disclosure'].toLowerCase();
  }

  private async earlyHangups(seconds: number, range: PeriodRange): Promise<JarvisAnswer> {
    const facts = await loadCallFacts(this.c.db, { from: range.from, to: range.to }, this.c.now());
    // An unmarked call counts: when someone hangs up in the opener Lexi has no
    // chance to record an outcome, and that is exactly the call being asked about.
    const early = facts
      .filter((f) => !f.live && f.durationSec > 0 && f.durationSec <= seconds)
      .filter((f) => f.outcome === null || (f.outcome !== 'no_answer' && f.outcome !== 'voicemail' && f.outcome !== 'invalid_number'))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const sources = [`Call: ${plural(facts.length, 'call')} ${range.label}, ${early.length} ended within ${seconds} seconds`];

    if (early.length === 0) {
      return answer(`No call that was picked up ended within the first ${plural(seconds, 'second')} ${range.label}.`, sources);
    }
    const lines = early.slice(0, 15).map(
      (f) => `${f.name}, ${f.company}: ${plural(f.durationSec, 'second')}, during the ${this.stageAt(f, f.durationSec)} (${stamp(f.startedAt, this.zone)})`
    );
    const more = early.length > 15 ? `\nAnd ${early.length - 15} more; the call log has them all.` : '';
    return answer(
      `${plural(early.length, 'call')} ended within the first ${plural(seconds, 'second')} ${range.label}:\n${lines.join('\n')}${more}`,
      sources
    );
  }

  private async bestHook(market: 'AU' | 'NZ' | null): Promise<JarvisAnswer> {
    const now = this.c.now();
    const facts = (await loadCallFacts(this.c.db, { from: new Date(now.getTime() - ANALYSIS_DAYS * DAY_MS), to: now }, now)).filter(
      (f) => market === null || f.market === market
    );
    const where = market === null ? 'across Australia and New Zealand' : market === 'NZ' ? 'in New Zealand' : 'in Australia';
    const sources = [
      `Call and CallRecord: ${plural(facts.length, 'call')} ${where} in the last ${ANALYSIS_DAYS} days, hooks as recorded by Scribe`
    ];

    const hooks = hookPerformance(facts);
    const conversations = facts.filter((f) => f.realConversation).length;
    if (hooks.length === 0) {
      return answer(
        `No hook has been recorded against a real conversation ${where} in the last ${ANALYSIS_DAYS} days, so I cannot say which is working.`,
        sources
      );
    }
    const lines = hooks.slice(0, 3).map(
      (h) => `"${h.hook}": ${plural(h.requests, 'meeting request')} from ${plural(h.conversations, 'real conversation')} (${Math.round(h.rate * 100)}%)`
    );
    const caution = conversations < 10 ? ` That is only ${plural(conversations, 'real conversation')} in total, so treat it as a lead and not a result.` : '';
    return answer(`Best hooks ${where}, by meeting requests per real conversation:\n${lines.join('\n')}${caution}`, sources);
  }

  private async closestCalls(count: number): Promise<JarvisAnswer> {
    const now = this.c.now();
    const facts = await loadCallFacts(this.c.db, { from: new Date(now.getTime() - ANALYSIS_DAYS * DAY_MS), to: now }, now);
    const closest = facts
      .filter((f) => !f.live)
      .sort((a, b) => closeness(b) - closeness(a))
      .slice(0, count);
    const sources = [`Call and CallRecord: ${plural(facts.length, 'call')} in the last ${ANALYSIS_DAYS} days, ranked by how near each came to a meeting`];
    if (closest.length === 0) return answer('There are no finished calls to read yet.', sources);

    const ordinal = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
    const lines = closest.map((f, i) => {
      const what = f.outcome === null ? 'no outcome recorded' : f.outcome.replace(/_/g, ' ');
      const said = f.summary.length === 0 ? 'No summary was written for it.' : f.summary.slice(0, 3).join(' ');
      return `${ordinal[i] ?? String(i + 1)}: ${f.name} at ${f.company}, ${plural(f.durationSec, 'second')}, ${what}. ${said}`;
    });
    return answer(lines.join('\n'), sources);
  }

  private async needsMe(): Promise<JarvisAnswer> {
    const snapshot = await this.snapshots.get(500);
    const { meetingRequests, escalations } = snapshot.needsYou;
    const sources = ['MeetingRequest: requests not yet answered', 'Escalation and Call: open escalations and calls escalated in the last day'];

    const lines: string[] = [];
    for (const e of escalations) lines.push(`Escalation: ${e.contact}${e.company !== '' ? `, ${e.company}` : ''}: ${e.reason}.`);
    for (const m of meetingRequests) {
      const first = m.windows[0];
      lines.push(
        `${m.status === 'rescheduled' ? 'To reschedule' : 'Meeting request'} ${m.ref}: ${m.name}, ${m.company}${first !== undefined ? `, free ${first.localLabel} (${first.sydneyLabel})` : ''}.`
      );
    }
    return answer(lines.length === 0 ? 'Nothing is waiting on you.' : `${plural(lines.length, 'thing')} waiting on you:\n${lines.join('\n')}`, sources);
  }

  private async todaySummary(): Promise<JarvisAnswer> {
    const { today } = await this.snapshots.get(500);
    return answer(
      `Today so far: ${today.dialled} dialled, ${today.connected} picked up, ${today.conversations} real conversations, ${plural(today.requests, 'meeting request')}. ${money(today.spendUsd)} spent${today.costPerMeetingUsd === null ? '' : `, ${money(today.costPerMeetingUsd)} per meeting`}.`,
      ['Call: calls started today on the operator clock', 'MeetingRequest', 'SpendRecord: spend today']
    );
  }

  private async queueStatus(): Promise<JarvisAnswer> {
    const snapshot = await this.snapshots.get(500);
    const { next, note } = snapshot.standingBy;
    const sources = ['CallPlan and CallPlanEntry: the plan for the day', 'Compliance gate: its verdict on each person, as evaluated now'];
    if (snapshot.upNext.length === 0) return answer(`Nobody is queued. ${note}`, sources);

    const lines = snapshot.upNext.slice(0, 5).map((q) =>
      q.gate.allowed ? `${q.name}, ${q.company}: cleared by the gate.` : `${q.name}, ${q.company}: held, ${describeReasons(q.gate.reasons)}.`
    );
    return answer(
      `${next === null ? '' : `Next is ${next.name} at ${next.company}. `}${note}\n${lines.join('\n')}`,
      sources
    );
  }

  private async killStatus(): Promise<JarvisAnswer> {
    const { killSwitch } = await this.snapshots.get(500);
    return answer(
      killSwitch.engaged
        ? `Dialling is halted${killSwitch.since !== undefined ? ` since ${stamp(new Date(killSwitch.since), this.zone)}` : ''}${killSwitch.reason !== undefined ? `: ${killSwitch.reason}` : ''}. Only a person can lift it.`
        : 'Dialling is not halted. Whether anything dials still depends on the day plan and the compliance gate.',
      ['Kill switch state file, the same one the compliance gate reads on every dial']
    );
  }

  private async planStatus(): Promise<JarvisAnswer> {
    const { briefing } = await this.snapshots.get(500);
    const section = briefing.sections.find((s) => s.title === "Today's queue");
    return answer(section?.body ?? 'There is no plan information to read.', [
      'CallPlan and CallPlanEntry: the plan for the day and its status',
      'Compliance gate: its verdict on each person on it'
    ]);
  }

  private async objections(): Promise<JarvisAnswer> {
    const { objections } = await this.snapshots.get(500);
    const sources = [`CallRecord: objections Scribe recorded in the last ${ANALYSIS_DAYS} days`];
    if (objections.length === 0) return answer('No objections have been recorded yet.', sources);
    return answer(
      `Objections, most common first:\n${objections.slice(0, 6).map((o) => `${o.label}: ${o.count}`).join('\n')}`,
      sources
    );
  }

  private async spend(range: PeriodRange): Promise<JarvisAnswer> {
    const { total, parts } = await this.spendByCategory(range);
    const { health } = await this.snapshots.get(500);
    return answer(
      `${money(total)} spent ${range.label}${parts.length === 0 ? '' : ` (${parts.join(', ')})`}. This month: ${money(health.spendMonthUsd)}${health.spendCeilingUsd === null ? '' : ` of a ${money(health.spendCeilingUsd)} ceiling`}.`,
      [`SpendRecord: ${range.label}`, 'SpendRecord: this month']
    );
  }

  /* ---- why did we stop ---- */

  private async findContacts(phrase: string): Promise<ContactRow[]> {
    const tokens = subjectTokens(phrase);
    if (tokens.length === 0) return [];
    const rows = await this.c.db.contact.findMany({ include: { account: true }, take: 5000 });
    return rows.filter((c) => {
      const hay = `${c.firstName} ${c.lastName}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }

  private async findAccounts(phrase: string) {
    const tokens = subjectTokens(phrase);
    if (tokens.length === 0) return [];
    const rows = await this.c.db.account.findMany({ take: 5000 });
    return rows.filter((a) => {
      const hay = `${a.name} ${a.domain}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }

  /** What is known about one person, in the order a reader would ask. */
  private async explainContact(contact: ContactRow): Promise<string> {
    const { db } = this.c;
    const parts: string[] = [];

    const keys = [contact.id, contact.phoneE164, contact.accountId, contact.account.domain].filter((k): k is string => k !== null);
    const suppressions = await db.suppression.findMany({ where: { key: { in: keys } }, orderBy: { createdAt: 'asc' } });
    for (const s of suppressions) {
      parts.push(`suppressed permanently (${s.scope}, ${s.source}) on ${stamp(s.createdAt, this.zone)}: ${s.reason}`);
    }

    const [attempts, lastCall] = await Promise.all([
      db.dialAttempt.count({ where: { contactId: contact.id } }),
      db.call.findFirst({ where: { contactId: contact.id }, orderBy: { startedAt: 'desc' } })
    ]);
    const cap = this.c.policy.volume.max_attempts_per_contact;
    parts.push(`${attempts} of ${cap} attempts used`);
    if (lastCall !== null) {
      parts.push(`the last call was ${stamp(lastCall.startedAt, this.zone)} and ended ${lastCall.outcome === null ? 'with no outcome recorded' : lastCall.outcome.replace(/_/g, ' ')}`);
    }
    if (contact.status === 'done') parts.push('the contact is closed, so no further calls are planned');

    if (contact.phoneE164 !== null) {
      const { decision } = await dialVerdict(this.c, contact, contact.phoneE164, this.c.gateAt(this.c.now()));
      parts.push(
        decision.allowed
          ? 'the compliance gate would let a call through right now'
          : `the compliance gate would hold a call now: ${describeReasons(decision.reasons.map((r) => r.code))}`
      );
    } else {
      parts.push('no phone number is held for them');
    }
    return `${contact.firstName} ${contact.lastName} (${contact.title}): ${parts.join('; ')}.`;
  }

  private async whyStopped(subject: string): Promise<JarvisAnswer> {
    const [accounts, people] = await Promise.all([this.findAccounts(subject), this.findContacts(subject)]);
    const sources = [`Account and Contact: searched for "${subject}"`];

    if (accounts.length === 0 && people.length === 0) {
      return answer(`I cannot find an organisation or a person matching "${subject}".`, sources);
    }

    const lines: string[] = [];
    const shown = new Set<string>();
    for (const account of accounts.slice(0, 3)) {
      const orgSuppressions = await this.c.db.suppression.findMany({
        where: { key: { in: [account.id, account.domain] } },
        orderBy: { createdAt: 'asc' }
      });
      lines.push(
        orgSuppressions.length === 0
          ? `${account.name} (${account.status}): the organisation is not suppressed.`
          : `${account.name}: the whole organisation is suppressed permanently (${orgSuppressions.map((s) => `${s.source}: ${s.reason}`).join('; ')}).`
      );
      const contacts = await this.c.db.contact.findMany({ where: { accountId: account.id }, include: { account: true }, take: 8 });
      for (const contact of contacts) {
        shown.add(contact.id);
        lines.push(`  ${await this.explainContact(contact)}`);
      }
      sources.push(`Account ${account.name}: Suppression, DialAttempt, Call and the compliance gate's verdict for ${plural(contacts.length, 'contact')}`);
    }
    for (const person of people.filter((p) => !shown.has(p.id)).slice(0, 3)) {
      lines.push(await this.explainContact(person));
      sources.push(`Contact ${person.firstName} ${person.lastName}: Suppression, DialAttempt, Call and the compliance gate's verdict`);
    }
    return answer(lines.join('\n'), sources);
  }

  /* ---- free text, through a model that can only read ---- */

  private async askModel(question: string): Promise<JarvisAnswer> {
    const model = this.options.model;
    if (model === undefined) {
      return refused(`I did not understand that, and I do not guess. ${HELP_TEXT}`);
    }

    const used: string[] = [];
    const tools = this.readTools(used);
    let text: string;
    try {
      text = (await model.answer({ question, system: JARVIS_SYSTEM, tools })).trim();
    } catch (error) {
      return refused(`I could not get an answer: ${(error as Error).message}`);
    }
    // An answer nobody read anything for is a guess, whatever it sounds like.
    if (used.length === 0 || text === '') {
      return refused('I could not ground that in the records, so I will not answer it.');
    }
    return answer(text, [...new Set(used)]);
  }

  private readTools(used: string[]): JarvisReadTool[] {
    const note = (source: string): void => {
      used.push(source);
    };
    const callsInput = z.object({
      days: z.number().int().min(1).max(365).optional(),
      market: z.enum(['AU', 'NZ']).optional(),
      outcome: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional()
    });
    return [
      {
        name: 'get_snapshot',
        description:
          "The console's current picture: today's numbers, the funnel, objections, the playbook, the queue, what needs the operator and spend.",
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => {
          const s = await this.snapshots.get(500);
          note('Console snapshot: Call, MeetingRequest, CallPlan, SpendRecord, Playbook, Escalation');
          return {
            today: s.today,
            funnel: s.funnel,
            objections: s.objections,
            gatekeeperByAccount: s.gatekeeperByAccount,
            wrongNumberRate: s.wrongNumberRate,
            playbook: s.playbook,
            upNext: s.upNext,
            needsYou: { meetingRequests: s.needsYou.meetingRequests.length, escalations: s.needsYou.escalations },
            health: { spendMonthUsd: s.health.spendMonthUsd, spendCeilingUsd: s.health.spendCeilingUsd, gateRejections: s.health.gateRejections }
          };
        }
      },
      {
        name: 'list_calls',
        description: 'The call log, newest first. Filter by days, market (AU or NZ) and outcome.',
        inputSchema: {
          type: 'object',
          properties: {
            days: { type: 'integer', minimum: 1, maximum: 365 },
            market: { type: 'string', enum: ['AU', 'NZ'] },
            outcome: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100 }
          },
          additionalProperties: false
        },
        run: async (input) => {
          const args = callsInput.parse(input ?? {});
          const calls = await listCalls(this.c, {
            ...(args.days !== undefined ? { days: args.days } : {}),
            ...(args.market !== undefined ? { market: args.market } : {}),
            ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
            limit: args.limit ?? 50
          });
          note(`Call log: ${plural(calls.length, 'call')} read`);
          return calls;
        }
      },
      {
        name: 'get_call',
        description: 'One call in full: transcript, defects and the dossier summary.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
        run: async (input) => {
          const { id } = z.object({ id: z.string() }).parse(input);
          const detail = await callDetail(this.c, id);
          if (detail === null) return { error: `no call ${id}` };
          note(`Call ${id}: CallEvent transcript and Call record`);
          return detail;
        }
      },
      {
        name: 'get_spend',
        description: 'Spend by category over a period: today, yesterday, week (last seven days) or month (so far).',
        inputSchema: {
          type: 'object',
          properties: { period: { type: 'string', enum: ['today', 'yesterday', 'week', 'month'] } },
          required: ['period'],
          additionalProperties: false
        },
        run: async (input) => {
          const { period } = z.object({ period: z.enum(['today', 'yesterday', 'week', 'month']) }).parse(input);
          const range = rangeOf(period, this.c.now(), this.zone);
          const spend = await this.spendByCategory(range);
          note(`SpendRecord: ${range.label}`);
          return { period: range.label, totalUsd: spend.total, byCategory: spend.parts };
        }
      },
      {
        name: 'find_suppressions',
        description: 'Suppression list entries whose reason or source contains the text given.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        run: async (input) => {
          const { text } = z.object({ text: z.string().min(1) }).parse(input);
          const rows = await this.c.db.suppression.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
          const needle = text.toLowerCase();
          const hits = rows.filter((r) => `${r.reason} ${r.source} ${r.scope}`.toLowerCase().includes(needle)).slice(0, 25);
          note(`Suppression: ${plural(hits.length, 'entry', 'entries')} matching "${text}"`);
          return hits.map((r) => ({ scope: r.scope, source: r.source, reason: r.reason, at: r.createdAt.toISOString() }));
        }
      }
    ];
  }

  /* ---------------------------------------------------------------- */
  /* Instructions: propose, then confirm                               */
  /* ---------------------------------------------------------------- */

  private store(plan: ActionPlan, description: string, sources: string[]): JarvisAnswer {
    // Bounded, oldest out first. A proposal nobody confirmed is forgotten, which
    // is the safe direction: the cost of a lapsed proposal is asking again.
    while (this.actions.size >= MAX_PENDING) {
      const oldest = this.actions.keys().next().value;
      if (oldest === undefined) break;
      this.actions.delete(oldest);
    }
    const id = (this.options.newId ?? (() => `act_${randomUUID()}`))();
    this.actions.set(id, {
      id,
      plan,
      description,
      expiresAt: this.c.now().getTime() + (this.options.ttlMs ?? DEFAULT_TTL_MS),
      result: null
    });
    return { kind: 'needs_confirmation', text: `${description}\nNothing has changed yet. Confirm to go ahead.`, sources, action: { actionId: id, description } };
  }

  private async currentContact(context: JarvisContext): Promise<ContactRow | null> {
    const { db } = this.c;
    if (context.contactId !== undefined) {
      return db.contact.findUnique({ where: { id: context.contactId }, include: { account: true } });
    }
    const live = await this.c.live.current(this.c.now());
    if (live !== null) {
      const call = await db.call.findUnique({ where: { id: live.callId }, include: { contact: { include: { account: true } } } });
      if (call !== null) return call.contact;
    }
    const last = await db.call.findFirst({ orderBy: { startedAt: 'desc' }, include: { contact: { include: { account: true } } } });
    return last?.contact ?? null;
  }

  /** One contact from a phrase, or the reason there isn't exactly one. */
  private async oneContact(who: string, context: JarvisContext): Promise<{ contact: ContactRow; how: string } | { problem: JarvisAnswer }> {
    if (who.trim() === '') {
      const contact = await this.currentContact(context);
      return contact === null
        ? { problem: refused('I do not know which contact you mean. Name them, for example: suppress Priya Raman.') }
        : { contact, how: 'the contact on the current or most recent call' };
    }
    const matches = await this.findContacts(who);
    if (matches.length === 0) return { problem: refused(`I cannot find anyone matching "${who.trim()}".`, [`Contact: searched for "${who.trim()}"`]) };
    if (matches.length > 1) {
      const names = matches.slice(0, 5).map((m) => `${m.firstName} ${m.lastName} at ${m.account.name}`).join('; ');
      return { problem: refused(`"${who.trim()}" matches ${matches.length} people (${names}). Say which one.`, [`Contact: ${matches.length} matches for "${who.trim()}"`]) };
    }
    return { contact: matches[0] as ContactRow, how: `the one contact matching "${who.trim()}"` };
  }

  private async oneCampaign(name: string, wantStatus: 'active' | 'paused'): Promise<{ campaign: { id: string; name: string; market: string; status: string } } | { problem: JarvisAnswer }> {
    const tokens = subjectTokens(name);
    const all = await this.c.db.campaign.findMany({ orderBy: { createdAt: 'asc' } });
    const matches = all.filter((camp) => (tokens.length === 0 ? true : tokens.every((t) => camp.name.toLowerCase().includes(t))));
    const sources = [`Campaign: ${plural(all.length, 'campaign')}, ${matches.length} matching`];

    if (matches.length === 0) {
      const known = all.map((camp) => `"${camp.name}" (${camp.status})`).join('; ');
      return { problem: refused(`I cannot find a campaign matching "${name.trim()}". The campaigns are: ${known === '' ? 'none' : known}.`, sources) };
    }
    if (matches.length > 1) {
      return { problem: refused(`"${name.trim()}" matches ${matches.length} campaigns (${matches.map((m) => `"${m.name}"`).join('; ')}). Be more specific.`, sources) };
    }
    const campaign = matches[0] as (typeof matches)[number];
    if (campaign.status === wantStatus) {
      return { problem: refused(`"${campaign.name}" is already ${wantStatus}.`, sources) };
    }
    if (wantStatus === 'active' && campaign.status !== 'paused') {
      return { problem: refused(`"${campaign.name}" is ${campaign.status}, not paused, so I cannot resume it.`, sources) };
    }
    if (wantStatus === 'paused' && campaign.status !== 'active') {
      return { problem: refused(`"${campaign.name}" is ${campaign.status}, not active, so there is nothing to pause.`, sources) };
    }
    return { campaign };
  }

  private async propose(command: Command, context: JarvisContext): Promise<JarvisAnswer> {
    switch (command.kind) {
      case 'engage_kill':
        return this.store(
          { kind: 'engage_kill', reason: command.reason },
          'Halt all dialling now. This trips the kill switch, which the compliance gate checks on every dial request, so no new call will be placed until a person lifts it. A call already in progress is not cut off.',
          ['Kill switch state file']
        );

      case 'release_kill': {
        const state = await this.c.killSwitch.state();
        if (!state.active) return refused('Dialling is not halted, so there is nothing to lift.', ['Kill switch state file']);
        return this.store(
          { kind: 'release_kill' },
          `Lift the halt on dialling${state.reason !== undefined ? ` (it was tripped: ${state.reason})` : ''}. Calls still need the day's plan to be approved and the compliance gate to say yes; this only removes the stop.`,
          ['Kill switch state file']
        );
      }

      case 'pause_campaign':
      case 'resume_campaign': {
        const pausing = command.kind === 'pause_campaign';
        const found = await this.oneCampaign(command.name, pausing ? 'paused' : 'active');
        if ('problem' in found) return found.problem;
        const { campaign } = found;
        const [contacts, accounts] = await Promise.all([
          this.c.db.contact.count({ where: { campaignId: campaign.id } }),
          this.c.db.account.count({ where: { campaignId: campaign.id } })
        ]);
        const description = pausing
          ? `Pause the campaign "${campaign.name}" (${campaign.market}, ${plural(accounts, 'account')}, ${plural(contacts, 'contact')}). Its status changes from active to paused, and the Campaign Director works only active campaigns, so prospecting, research and new day plans stop for it until you resume it. It does not cancel a plan already approved for today; to stop calls now, halt dialling instead.`
          : `Resume the campaign "${campaign.name}" (${campaign.market}, ${plural(accounts, 'account')}, ${plural(contacts, 'contact')}). Its status changes from paused to active, so the Campaign Director works it again and a new day plan can include its people. Nobody is dialled by this change.`;
        return this.store({ kind: pausing ? 'pause_campaign' : 'resume_campaign', campaignId: campaign.id }, description, [`Campaign "${campaign.name}"`]);
      }

      case 'suppress_contact': {
        const found = await this.oneContact(command.who, context);
        if ('problem' in found) return found.problem;
        const { contact, how } = found;
        const targets = narrowForTestContact(contact.kind === 'test' ? 'test' : 'prospect', ['contact', 'number']);
        const what = targets.includes('number') && contact.phoneE164 !== null
          ? `the contact and the number ${contact.phoneE164} are added to the suppression list`
          : 'the contact is added to the suppression list';
        return this.store(
          { kind: 'suppress_contact', contactId: contact.id },
          `Suppress ${contact.firstName} ${contact.lastName} (${contact.title}, ${contact.account.name}) permanently: ${what}, and the contact is closed. The suppression list has no removal path, so this cannot be undone from the console.`,
          [`Contact: ${how}`]
        );
      }

      case 'requeue_contact': {
        const found = await this.oneContact(command.who, context);
        if ('problem' in found) return found.problem;
        const { contact, how } = found;

        const suppressed = await this.c.suppressions.find({
          contactId: contact.id,
          e164: contact.phoneE164 ?? '',
          accountId: contact.accountId
        });
        if (suppressed.length > 0) {
          return refused(`${contact.firstName} ${contact.lastName} is suppressed (${suppressed[0]?.reason ?? 'no reason recorded'}), and a suppression is permanent, so I cannot requeue them.`, [`Contact: ${how}`, 'Suppression']);
        }
        const open = await this.c.db.meetingRequest.findFirst({ where: { contactId: contact.id, status: { in: ['requested', 'confirmed'] } } });
        if (open !== null) {
          return refused(`${contact.firstName} ${contact.lastName} already has a ${open.status === 'confirmed' ? 'confirmed meeting' : 'meeting request waiting on you'}, so they should not be called again.`, [`Contact: ${how}`, 'MeetingRequest']);
        }

        const date = this.nextWeekday(command.weekday);
        const when = date === null ? 'the next day plan' : DateTime.fromISO(date, { zone: this.zone }).toFormat('cccc d LLLL');
        return this.store(
          { kind: 'requeue_contact', contactId: contact.id, date: date ?? '' },
          `Requeue ${contact.firstName} ${contact.lastName} (${contact.title}, ${contact.account.name}) for ${when}: the contact goes back to queued and a retry is noted for that day. It does not dial anyone. The day plan still has to include them and you still have to approve it, and the compliance gate still rules, including the attempt limit and the five-day gap between attempts.`,
          [`Contact: ${how}`, 'Suppression and MeetingRequest checked: neither stands in the way']
        );
      }

      case 'rollback_playbook': {
        const planned = await planRollback(this.c.db);
        if (!planned.ok) return refused(planned.why, ['Playbook']);
        const { plan } = planned;
        const challenger = plan.challengerVersion === null ? '' : ` The challenger under test (${plan.slot} v${plan.challengerVersion}) keeps running against the restored champion.`;
        return this.store(
          { kind: 'rollback_playbook', plan },
          `Roll the ${plan.slot} script back from ${plan.slot} v${plan.current.version} to ${plan.slot} v${plan.previous.version}. The current champion is retired and marked rolled back, and the earlier version becomes champion again, in one step.${challenger} Calls after this use the earlier wording. The opening, the AI disclosure and the recording announcement are not affected; they are not part of the playbook.`,
          ['Playbook: champion and retired versions of the slot']
        );
      }
    }
  }

  private nextWeekday(weekday: number | null): string | null {
    if (weekday === null) return null;
    const today = DateTime.fromJSDate(this.c.now(), { zone: this.zone }).startOf('day');
    const ahead = (weekday - today.weekday + 7) % 7;
    return today.plus({ days: ahead }).toFormat('yyyy-MM-dd');
  }

  /* ---------------------------------------------------------------- */
  /* Confirming                                                        */
  /* ---------------------------------------------------------------- */

  async confirm(actionId: string): Promise<JarvisAnswer> {
    const stored = this.actions.get(actionId);
    if (stored === undefined) {
      return jarvisAnswerSchema.parse(refused('I have no such pending action. It may have lapsed, or the server restarted; ask again and I will propose it afresh.'));
    }
    // A second confirm of something already done returns what happened and does
    // nothing more, so a double-tap cannot suppress anyone twice.
    if (stored.result !== null) return stored.result;
    if (this.c.now().getTime() > stored.expiresAt) {
      this.actions.delete(actionId);
      return jarvisAnswerSchema.parse(refused('That confirmation has lapsed. Ask again and I will propose it afresh.'));
    }

    let result: JarvisAnswer;
    try {
      result = await this.execute(stored.plan);
    } catch (error) {
      // Not recorded as done: a failed action can be tried again, within its time.
      return jarvisAnswerSchema.parse(refused(`That did not go through, and nothing was recorded as done: ${(error as Error).message}`));
    }
    if (result.kind === 'done') stored.result = result;
    else this.actions.delete(actionId);

    if (result.kind === 'done') await this.options.onChanged?.();
    return jarvisAnswerSchema.parse(result);
  }

  private async trace(summary: string, detail: Record<string, unknown>): Promise<void> {
    await this.c.db.traceEvent.create({
      data: { id: randomUUID(), actor: 'operator-console', kind: 'decided', summary, detail: JSON.stringify(detail) }
    });
  }

  private done(text: string, sources: string[]): JarvisAnswer {
    return { kind: 'done', text, sources };
  }

  /**
   * Carry out a confirmed action. Everything is read again first: a minute may
   * have passed, and the confirmation was for the world as it was then.
   */
  private async execute(plan: ActionPlan): Promise<JarvisAnswer> {
    const { db } = this.c;
    const now = this.c.now();

    switch (plan.kind) {
      case 'engage_kill': {
        const view = await setKillSwitch(this.c, true, plan.reason);
        await this.trace('The operator halted all dialling from Jarvis.', { reason: plan.reason });
        return this.done(`Dialling is halted${view.reason !== undefined ? `: ${view.reason}` : ''}.`, ['Kill switch state file']);
      }

      case 'release_kill': {
        await setKillSwitch(this.c, false);
        await this.trace('The operator lifted the dialling halt from Jarvis.', {});
        return this.done('The halt is lifted. Calls still need an approved day plan and a yes from the compliance gate.', ['Kill switch state file']);
      }

      case 'pause_campaign':
      case 'resume_campaign': {
        const pausing = plan.kind === 'pause_campaign';
        const campaign = await db.campaign.findUnique({ where: { id: plan.campaignId } });
        if (campaign === null) return refused('That campaign no longer exists.');
        const from = pausing ? 'active' : 'paused';
        const to = pausing ? 'paused' : 'active';
        if (campaign.status !== from) return refused(`"${campaign.name}" is now ${campaign.status}, not ${from}, so I changed nothing.`);
        await db.campaign.update({ where: { id: campaign.id }, data: { status: to } });
        await this.trace(`The operator ${pausing ? 'paused' : 'resumed'} the campaign "${campaign.name}" from Jarvis.`, { campaignId: campaign.id });
        return this.done(`"${campaign.name}" is now ${to}.`, ['Campaign.status updated']);
      }

      case 'suppress_contact': {
        const contact = await db.contact.findUnique({ where: { id: plan.contactId }, include: { account: true } });
        if (contact === null) return refused('That contact no longer exists.');
        const done: string[] = [];
        for (const scope of narrowForTestContact(contact.kind === 'test' ? 'test' : 'prospect', ['contact', 'number'])) {
          const key = scope === 'contact' ? contact.id : contact.phoneE164;
          if (key === null) continue;
          const existing = await this.c.suppressions.find({ contactId: contact.id, e164: contact.phoneE164 ?? '', accountId: contact.accountId });
          if (existing.some((e) => e.scope === scope && e.key === key)) continue;
          const entry = {
            scope,
            key,
            source: 'operator' as const,
            reason: 'suppressed by the operator from the console',
            createdAt: now,
            permanent: true as const
          };
          await this.c.suppressions.add(entry);
          await this.c.audit.append(suppressionRecord(entry, 'operator (console)'));
          done.push(scope);
        }
        await db.contact.update({ where: { id: contact.id }, data: { status: 'done', updatedAt: now } });
        await this.trace(`The operator suppressed ${contact.firstName} ${contact.lastName} from Jarvis.`, { contactId: contact.id });
        return this.done(
          done.length === 0
            ? `${contact.firstName} ${contact.lastName} was already suppressed; the contact is closed.`
            : `${contact.firstName} ${contact.lastName} is suppressed permanently (${done.join(' and ')}) and closed.`,
          ['Suppression: permanent entry added', 'Contact.status set to done']
        );
      }

      case 'requeue_contact': {
        const contact = await db.contact.findUnique({ where: { id: plan.contactId }, include: { account: true } });
        if (contact === null) return refused('That contact no longer exists.');
        const suppressed = await this.c.suppressions.find({ contactId: contact.id, e164: contact.phoneE164 ?? '', accountId: contact.accountId });
        if (suppressed.length > 0) return refused(`${contact.firstName} ${contact.lastName} has been suppressed since this was proposed, so I changed nothing.`);
        const open = await db.meetingRequest.findFirst({ where: { contactId: contact.id, status: { in: ['requested', 'confirmed'] } } });
        if (open !== null) return refused('They now have a meeting request in progress, so I changed nothing.');

        const today = DateTime.fromJSDate(now, { zone: this.zone }).toFormat('yyyy-MM-dd');
        if (plan.date !== '' && plan.date < today) return refused('That day has passed, so I changed nothing.');

        await db.contact.update({ where: { id: contact.id }, data: { status: 'queued', updatedAt: now } });
        await db.memory.create({
          data: {
            id: randomUUID(),
            scope: 'contact',
            key: contact.id,
            kind: 'retry-requested',
            summary: plan.date === '' ? 'Requeued by the operator for the next day plan.' : `Requeued by the operator for ${plan.date}.`,
            content: JSON.stringify({ requestedBy: 'console', onDate: plan.date === '' ? null : plan.date })
          }
        });
        await this.trace(`The operator requeued ${contact.firstName} ${contact.lastName} from Jarvis.`, { contactId: contact.id, date: plan.date });
        return this.done(
          `${contact.firstName} ${contact.lastName} is queued again. Nothing is dialled by this: the day plan must include them and you must approve it.`,
          ['Contact.status set to queued', 'Memory: retry noted']
        );
      }

      case 'rollback_playbook': {
        await rollBackPlaybook(db, plan.plan, now);
        const label = (n: number): string => versionLabel({ slot: plan.plan.slot, version: n });
        await this.trace(`The operator rolled the ${plan.plan.slot} script back to ${label(plan.plan.previous.version)} from Jarvis.`, { plan: plan.plan });
        return this.done(
          `${label(plan.plan.previous.version)} is the champion again; ${label(plan.plan.current.version)} is retired as rolled back.`,
          ['Playbook: two rows updated in one transaction']
        );
      }
    }
  }
}

export { truncate as _truncate, OBJECTION_LABELS as _OBJECTION_LABELS };
