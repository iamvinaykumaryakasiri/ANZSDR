/**
 * Carrying out a follow-up plan.
 *
 * `planFollowUp` decides; this does. The split is the point: the decisions are
 * pure and tested over every combination, and everything here that touches the
 * world is a thin step that does one thing and records that it did.
 *
 * Three properties shape it.
 *
 * Safety first. Suppression and retiring a contact run before any email or
 * text. If the process dies half way, what is left should be the safe state -
 * someone who asked to be left alone is suppressed - and never the reverse,
 * where the courtesy went out and the suppression did not.
 *
 * One failure does not block the rest. A mail outage must not stop a
 * suppression, so each action is attempted on its own and its result recorded.
 *
 * Re-running is safe. Every action is idempotent or guarded by what it records
 * (a request row per call, `smsSentAt`, `voicemailDraftedAt`, the suppression
 * list itself), and an action that already completed is carried over rather
 * than repeated. A retry after a partial failure finishes the job; it does not
 * text someone twice.
 */

import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Blackboard } from '../../blackboard/client.js';
import type { MeetingRequestRepository } from '../../blackboard/meetings.js';
import type { SuppressionStore } from '../../compliance/ports.js';
import type { AgentIdentity } from '../caller/identity.js';
import type { ScribeResult } from '../scribe/scribe.js';
import { wrapDraft, escalationAlert, type DraftKind, type DraftOperator, type DraftPerson } from './drafts.js';
import { planFollowUp, type ActionKind, type FollowUpContext, type FollowUpPlan, type PlannedAction } from './followup.js';
import { buildMeetingEmail, type MeetingRequest } from './meeting-email.js';
import type { Mailer, SmsSender } from './ports.js';
import {
  buildSms,
  missingFromSms,
  senderCanReceiveReplies,
  smsEligibility,
  type LineType,
  type SmsPurpose
} from './sms.js';

export type ResultStatus = 'done' | 'skipped' | 'failed';

export interface ActionResult {
  kind: ActionKind | 'suppress';
  status: ResultStatus;
  detail: string;
}

export interface FollowUpRun {
  plan: FollowUpPlan;
  results: ActionResult[];
  /** True when the whole follow-up had already completed and nothing was repeated. */
  alreadyRun: boolean;
  /** False while anything failed, so a retry has something to finish. */
  complete: boolean;
}

export interface RunDeps {
  db: Blackboard;
  meetings: MeetingRequestRepository;
  suppressions: SuppressionStore;
  /** Wrap in `operatorOnly` before passing it in. This module does not assume it. */
  mailer: Mailer;
  sms?: SmsSender | undefined;
  /** The number texts are sent from. It has to be one a reply can reach. */
  smsFrom: string;
  identity: AgentIdentity;
  killSwitch: { state(): Promise<{ active: boolean }> };
  now: () => Date;
}

/** Safety before courtesy: the order actions are attempted in. */
const PRIORITY: Array<ActionKind | 'suppress'> = [
  'suppress',
  'retire-contact',
  'alert-operator',
  'meeting-request-email',
  'draft-reply',
  'draft-one-pager-email',
  'draft-thank-you',
  'draft-voicemail-followup',
  'sms-confirmation',
  'linkedin-queue',
  'log-routing',
  'schedule-retry'
];

export function inExecutionOrder(actions: PlannedAction[]): PlannedAction[] {
  return [...actions].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
}

/** "on Thursday at 2pm", in the prospect's own clock, and plain ASCII for SMS. */
export function callbackLabel(startsAt: string, timezone: string): string {
  const dt = DateTime.fromISO(startsAt, { setZone: true }).setZone(timezone);
  const hour = dt.toFormat(dt.minute === 0 ? 'h' : 'h:mm');
  return `on ${dt.toFormat('cccc')} at ${hour}${dt.toFormat('a').toLowerCase()}`;
}

const LINE_TYPES: LineType[] = ['mobile', 'fixed', 'non-geographic'];

function lineTypeOf(raw: string | null): LineType {
  // An unknown line type is treated as one that cannot receive a text.
  return LINE_TYPES.includes(raw as LineType) ? (raw as LineType) : 'fixed';
}

interface Loaded {
  contact: Awaited<ReturnType<typeof loadContact>>;
  endedAt: Date;
}

async function loadContact(db: Blackboard, contactId: string) {
  return db.contact.findUniqueOrThrow({
    where: { id: contactId },
    include: { account: true, dossiers: { orderBy: { createdAt: 'desc' }, take: 1 } }
  });
}

function parseStored(raw: string): { results: ActionResult[] } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { results?: unknown }).results)) {
      return { results: (parsed as { results: ActionResult[] }).results };
    }
  } catch {
    // An unreadable snapshot is treated as none: the actions are all guarded.
  }
  return { results: [] };
}

export async function runFollowUp(deps: RunDeps, scribe: ScribeResult): Promise<FollowUpRun> {
  const { db } = deps;

  const record = await db.callRecord.findUniqueOrThrow({ where: { callId: scribe.callId } });
  const call = await db.call.findUniqueOrThrow({ where: { id: scribe.callId } });
  const contact = await loadContact(db, scribe.contactId);
  const loaded: Loaded = { contact, endedAt: call.endedAt ?? deps.now() };

  const stored = parseStored(record.followUp);
  if (record.followedUpAt !== null) {
    const storedPlan = JSON.parse(record.followUp) as { plan?: FollowUpPlan };
    return {
      plan: storedPlan.plan ?? { actions: [], withheld: [] },
      results: stored.results,
      alreadyRun: true,
      complete: true
    };
  }

  // An outcome nobody marked has no follow-up: every outcome's follow-up can be
  // irreversible, and a hung-up call is not evidence of any of them.
  if (scribe.outcome === null) {
    const plan: FollowUpPlan = {
      actions: [],
      withheld: [{ kind: 'suppress', why: 'no outcome was recorded, so nothing irreversible follows from this call' }]
    };
    const results: ActionResult[] = [
      { kind: 'suppress', status: 'skipped', detail: 'no outcome was recorded; the call needs a look' }
    ];
    await persist(deps, scribe.callId, plan, results, true);
    return { plan, results, alreadyRun: false, complete: true };
  }

  const killed = (await deps.killSwitch.state()).active;
  const suppressionHits = await deps.suppressions.find({
    contactId: contact.id,
    e164: contact.phoneE164 ?? '',
    accountId: contact.accountId
  });
  const optedOut = await db.memory.findFirst({ where: { scope: 'contact', key: contact.id, kind: 'sms-opt-out' } });
  const voicemailBefore = await db.callRecord.count({
    where: { voicemailDraftedAt: { not: null }, call: { contactId: contact.id } }
  });

  const firstWindow = scribe.windows[0];
  const ctx: FollowUpContext = {
    outcome: scribe.outcome,
    contactKind: contact.kind === 'test' ? 'test' : 'prospect',
    // Judged on what was said, not on the outcome Lexi marked.
    conversationOccurred: scribe.prospectTurns >= 2,
    lineType: lineTypeOf(contact.phoneLine),
    endedAt: loaded.endedAt,
    now: deps.now(),
    hasEmail: scribe.email !== null,
    windowsCaptured: scribe.windows.length,
    ...(scribe.outcome === 'callback_requested' && firstWindow !== undefined
      ? {
          callbackAt: new Date(firstWindow.startsAt),
          callbackLabel: callbackLabel(firstWindow.startsAt, scribe.timezone ?? 'Pacific/Auckland')
        }
      : {}),
    ...(scribe.escalationReason !== undefined ? { escalationReason: scribe.escalationReason } : {}),
    killSwitchActive: killed,
    smsOptedOut: optedOut !== null,
    smsAlreadySent: record.smsSentAt !== null,
    smsSenderConfigured: deps.sms !== undefined && senderCanReceiveReplies(deps.smsFrom),
    alreadySuppressed: suppressionHits.length > 0,
    voicemailEmailAlreadyDrafted: voicemailBefore > 0
  };

  const plan = planFollowUp(ctx);
  const done = new Map(stored.results.filter((r) => r.status === 'done').map((r) => [r.kind, r]));
  const results: ActionResult[] = [];

  for (const action of inExecutionOrder(plan.actions)) {
    const earlier = done.get(action.kind);
    if (earlier !== undefined) {
      results.push(earlier);
      continue;
    }
    try {
      results.push(await execute(deps, scribe, action, ctx, loaded, results));
    } catch (error) {
      results.push({ kind: action.kind, status: 'failed', detail: (error as Error).message });
    }
  }

  const complete = !results.some((r) => r.status === 'failed');
  await persist(deps, scribe.callId, plan, results, complete);
  return { plan, results, alreadyRun: false, complete };
}

async function persist(
  deps: RunDeps,
  callId: string,
  plan: FollowUpPlan,
  results: ActionResult[],
  complete: boolean
): Promise<void> {
  await deps.db.callRecord.update({
    where: { callId },
    data: {
      followUp: JSON.stringify({ plan, results }),
      followedUpAt: complete ? deps.now() : null
    }
  });
}

function personOf(scribe: ScribeResult, contact: Awaited<ReturnType<typeof loadContact>>): DraftPerson {
  return {
    name: `${contact.firstName} ${contact.lastName}`,
    firstName: contact.firstName,
    title: contact.title,
    company: contact.account.name,
    ...(scribe.email !== null ? { email: scribe.email.address } : {}),
    emailSource: scribe.email?.source ?? 'none'
  };
}

function operatorOf(identity: AgentIdentity): DraftOperator {
  return {
    name: identity.operator.name,
    firstName: identity.operator.name.split(/\s+/)[0] ?? identity.operator.name,
    title: identity.operator.title,
    company: identity.operator.company,
    email: identity.operator.email
  };
}

const DRAFT_FOR: Partial<Record<ActionKind, { kind: DraftKind; why: string }>> = {
  'draft-thank-you': { kind: 'thank-you', why: 'they said no. A short thank-you, or bin it.' },
  'draft-one-pager-email': { kind: 'one-pager', why: 'they asked for a call back but gave no time.' },
  'draft-voicemail-followup': { kind: 'voicemail-follow-up', why: 'Lexi left a voicemail, and one follow-up email is allowed.' }
};

async function execute(
  deps: RunDeps,
  scribe: ScribeResult,
  action: PlannedAction,
  ctx: FollowUpContext,
  loaded: Loaded,
  earlier: ActionResult[]
): Promise<ActionResult> {
  const { db, identity } = deps;
  const contact = loaded.contact;
  const operatorEmail = identity.operator.email.trim();

  switch (action.kind) {
    case 'suppress': {
      const added: string[] = [];
      for (const target of action.targets) {
        const key = target === 'contact' ? contact.id : target === 'number' ? contact.phoneE164 : contact.accountId;
        if (key === null) continue;
        const found = await deps.suppressions.find({
          contactId: contact.id,
          e164: contact.phoneE164 ?? '',
          accountId: contact.accountId
        });
        if (found.some((e) => e.scope === target && e.key === key)) continue;
        await deps.suppressions.add({
          scope: target,
          key,
          source: action.source,
          reason: action.detail,
          createdAt: deps.now(),
          permanent: true
        });
        added.push(target);
      }
      return {
        kind: 'suppress',
        status: 'done',
        detail: added.length === 0 ? 'already on the suppression list' : `suppressed ${added.join(' and ')} permanently`
      };
    }

    case 'retire-contact':
      await db.contact.update({ where: { id: contact.id }, data: { status: 'done', updatedAt: deps.now() } });
      return { kind: 'retire-contact', status: 'done', detail: 'contact closed: no further attempts' };

    case 'alert-operator': {
      if (operatorEmail === '') return failNoOperatorEmail('alert-operator');
      const sent = await deps.mailer.send(
        escalationAlert({
          person: { name: `${contact.firstName} ${contact.lastName}`, title: contact.title, company: contact.account.name },
          phone: contact.phoneE164 ?? 'no number held',
          reason: scribe.escalationReason,
          saidAs: scribe.escalationSaidAs,
          summary: scribe.summary,
          summarySource: scribe.summarySource,
          done: earlier.filter((r) => r.status === 'done').map((r) => r.detail),
          operatorEmail
        })
      );
      return { kind: 'alert-operator', status: 'done', detail: `alerted ${operatorEmail}${sent.where ? ` (${sent.where})` : ''}` };
    }

    case 'meeting-request-email': {
      // The request is recorded before anything is sent, so it exists - and
      // shows up as needing him - even if the email cannot go.
      const { record } = await deps.meetings.create({ callId: scribe.callId, contactId: contact.id }, deps.now());
      if (operatorEmail === '') return failNoOperatorEmail('meeting-request-email');

      const request: MeetingRequest = {
        requestId: record.id,
        prospect: {
          name: `${contact.firstName} ${contact.lastName}`,
          firstName: contact.firstName,
          title: contact.title,
          company: contact.account.name,
          phone: contact.phoneE164 ?? 'no number held',
          emailSource: scribe.email?.source ?? 'none',
          ...(scribe.email !== null ? { email: scribe.email.address } : {}),
          ...(scribe.email?.alsoOnFile !== undefined ? { alsoOnFile: scribe.email.alsoOnFile } : {}),
          ...(contact.linkedinUrl !== null ? { linkedinUrl: contact.linkedinUrl } : {})
        },
        windows: scribe.windows,
        timezone: scribe.timezone ?? 'Pacific/Auckland',
        attendees: scribe.attendees,
        hypothesis: contact.dossiers[0]?.hypothesis ?? 'No dossier was on file for this contact.',
        hookUsed: scribe.hook,
        summary: scribe.summary,
        summarySource: scribe.summarySource,
        objections: scribe.objections,
        operator: { name: identity.operator.name, firstName: operatorOf(identity).firstName, email: operatorEmail }
      };

      const built = buildMeetingEmail(request);
      const sent = await deps.mailer.send({
        to: built.to,
        subject: built.subject,
        body: built.body,
        attachments: built.attachments
      });
      await deps.meetings.markEmailSent(record.id, deps.now());
      return {
        kind: 'meeting-request-email',
        status: 'done',
        detail: `sent to ${operatorEmail}${sent.where ? ` (${sent.where})` : ''}`
      };
    }

    case 'draft-reply': {
      // The draft reply lives inside the meeting request email, so it succeeds
      // or fails with it.
      const email = earlier.find((r) => r.kind === 'meeting-request-email');
      if (email === undefined || email.status !== 'done') {
        return { kind: 'draft-reply', status: 'failed', detail: 'the meeting request email did not go, and the draft reply is part of it' };
      }
      return { kind: 'draft-reply', status: 'done', detail: 'included in the meeting request email' };
    }

    case 'draft-thank-you':
    case 'draft-one-pager-email':
    case 'draft-voicemail-followup': {
      if (operatorEmail === '') return failNoOperatorEmail(action.kind);
      const draft = DRAFT_FOR[action.kind];
      if (draft === undefined) throw new Error(`no draft is defined for ${action.kind}`);
      const sent = await deps.mailer.send(
        wrapDraft(draft.kind, personOf(scribe, contact), operatorOf(identity), draft.why)
      );
      if (action.kind === 'draft-voicemail-followup') {
        await db.callRecord.update({ where: { callId: scribe.callId }, data: { voicemailDraftedAt: deps.now() } });
      }
      return { kind: action.kind, status: 'done', detail: `draft sent to ${operatorEmail}${sent.where ? ` (${sent.where})` : ''}` };
    }

    case 'sms-confirmation': {
      if (deps.sms === undefined) {
        return { kind: 'sms-confirmation', status: 'skipped', detail: 'no SMS sender is configured' };
      }
      // The text promises an email from Vinay today. If the request never
      // reached him - his address is not configured, or the mail failed - nobody
      // knows to send it, and the text would be a promise with no one behind it.
      if (scribe.outcome === 'meeting_requested') {
        const request = earlier.find((r) => r.kind === 'meeting-request-email');
        if (request === undefined || request.status !== 'done') {
          return {
            kind: 'sms-confirmation',
            status: 'skipped',
            detail: 'the request has not reached Vinay, so promising the prospect an email from him would be a promise nobody knows about'
          };
        }
      }
      // Eligibility is checked again now, not trusted from planning: time has
      // passed, and "just spoken to us" is thirty minutes. A delayed message is
      // dropped rather than sent late.
      const verdict = smsEligibility({
        lineType: ctx.lineType,
        conversationOccurred: ctx.conversationOccurred,
        endedAt: ctx.endedAt,
        now: deps.now(),
        optedOut: ctx.smsOptedOut,
        alreadySent: ctx.smsAlreadySent,
        killSwitchActive: (await deps.killSwitch.state()).active,
        suppressed: ctx.alreadySuppressed,
        senderConfigured: senderCanReceiveReplies(deps.smsFrom)
      });
      if (!verdict.ok) return { kind: 'sms-confirmation', status: 'skipped', detail: verdict.why };

      const first = operatorOf(identity).firstName;
      const smsIdentity = {
        agentName: identity.agent.name,
        operatorName: identity.operator.name,
        operatorFirstName: first,
        company: 'Hexaware'
      };
      const purpose: SmsPurpose =
        scribe.outcome === 'callback_requested' && ctx.callbackLabel !== undefined
          ? { kind: 'callback-requested', firstName: contact.firstName, whenLabel: ctx.callbackLabel }
          : { kind: 'meeting-requested', firstName: contact.firstName };

      const text = buildSms(smsIdentity, purpose);
      const missing = missingFromSms(text, smsIdentity);
      if (missing.length > 0) {
        return { kind: 'sms-confirmation', status: 'failed', detail: `the message is missing ${missing.join(', ')}, so it was not sent` };
      }
      const to = contact.phoneE164;
      if (to === null) return { kind: 'sms-confirmation', status: 'skipped', detail: 'no number is held for them' };

      await deps.sms.send(to, deps.smsFrom, text);
      await db.callRecord.update({ where: { callId: scribe.callId }, data: { smsSentAt: deps.now() } });
      return { kind: 'sms-confirmation', status: 'done', detail: 'confirmation text sent' };
    }

    case 'linkedin-queue': {
      // Queued for Vinay to send by hand. Automating it breaches LinkedIn's
      // terms and risks his account (section 12.3), so this only writes a note.
      await db.memory.create({
        data: {
          id: randomUUID(),
          scope: 'contact',
          key: contact.id,
          kind: 'linkedin-queue',
          summary: `Send a connect request to ${contact.firstName} ${contact.lastName}, ${contact.title} at ${contact.account.name}`,
          content: JSON.stringify({ linkedinUrl: contact.linkedinUrl, callId: scribe.callId })
        }
      });
      return {
        kind: 'linkedin-queue',
        status: 'done',
        detail: contact.linkedinUrl === null ? 'queued, with no profile URL on file' : 'queued for you to send by hand'
      };
    }

    case 'log-routing': {
      await db.memory.create({
        data: {
          id: randomUUID(),
          scope: 'account',
          key: contact.accountId,
          kind: 'routing',
          summary: scribe.summary[0] ?? 'A routing detail was learned on a call; see the transcript.',
          content: JSON.stringify({ callId: scribe.callId, summary: scribe.summary })
        }
      });
      return { kind: 'log-routing', status: 'done', detail: 'recorded against the account' };
    }

    case 'schedule-retry': {
      await db.memory.create({
        data: {
          id: randomUUID(),
          scope: 'contact',
          key: contact.id,
          kind: 'retry-requested',
          summary: action.at === undefined ? 'Try again per the cadence.' : `Ring back at ${action.at.toISOString()}.`,
          content: JSON.stringify({ callId: scribe.callId, at: action.at?.toISOString() ?? null })
        }
      });
      // A request, not a dial. The daily plan and the compliance gate decide
      // whether and when it happens, and the gate's five-day minimum interval
      // applies to a callback the prospect asked for exactly as to any other.
      return {
        kind: 'schedule-retry',
        status: 'done',
        detail: 'recorded as a request; the daily plan and the compliance gate decide whether it happens'
      };
    }
  }
}

function failNoOperatorEmail(kind: ActionKind): ActionResult {
  return {
    kind,
    status: 'failed',
    detail: 'no operator email is configured, so nothing could be sent (brief section 15 item 6); it will go once there is one'
  };
}
