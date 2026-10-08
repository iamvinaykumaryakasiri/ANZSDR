/**
 * Meeting requests, as the console shows them and as the console answers them.
 *
 * The console is the second door to the same room. Vinay can answer a request by
 * replying CONFIRMED, RESCHEDULE or REJECT to the email (section 12.1), or tap
 * the same word here; both go through `applyOperatorReply`, so there is exactly
 * one state machine and one set of refusals. A late tap cannot un-confirm a
 * meeting, and a REJECT here suppresses the person for good for the same reason
 * it does there.
 */

import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';
import { applyOperatorReply } from '../agents/concierge/apply-reply.js';
import { draftReply, shortZone, type MeetingRequest, type PreferredWindow } from '../agents/concierge/meeting-email.js';
import { findRef, refFor } from '../agents/concierge/ref.js';
import { bestEmail } from '../agents/scribe/rules.js';
import type { MeetingRequestRecord, MeetingStatus } from '../blackboard/meetings.js';
import type { MeetingRequestView } from './contract.js';
import type { ConsoleDeps } from './deps.js';
import { readJson } from './util.js';

const SYDNEY = 'Australia/Sydney';

const windowsSchema = z.array(z.object({ saidAs: z.string(), startsAt: z.string(), endsAt: z.string() }));
const objectionsSchema = z.array(z.object({ saidAs: z.string(), handledAs: z.string().optional() }).passthrough());

export const STATUS_VIEW: Record<MeetingStatus, MeetingRequestView['status']> = {
  requested: 'pending',
  confirmed: 'confirmed',
  reschedule: 'rescheduled',
  rejected: 'rejected'
};

function clock(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { setZone: true }).setZone(zone).toFormat('HH:mm');
}

function day(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { setZone: true }).setZone(zone).toFormat('cccc d LLLL');
}

/** One window on both clocks, as a range: "Tuesday morning" is when they are free, not a start time. */
export function windowView(window: PreferredWindow, timezone: string): MeetingRequestView['windows'][number] {
  return {
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    said: window.saidAs,
    localLabel: `${day(window.startsAt, timezone)}, ${clock(window.startsAt, timezone)}-${clock(window.endsAt, timezone)} ${shortZone(timezone, window.startsAt)}`,
    sydneyLabel: `${day(window.startsAt, SYDNEY)}, ${clock(window.startsAt, SYDNEY)}-${clock(window.endsAt, SYDNEY)} Sydney`
  };
}

export async function meetingView(deps: ConsoleDeps, record: MeetingRequestRecord): Promise<MeetingRequestView> {
  const row = await deps.db.meetingRequest.findUniqueOrThrow({
    where: { id: record.id },
    include: {
      call: { include: { record: true } },
      contact: { include: { account: true, emails: true, dossiers: { orderBy: { createdAt: 'desc' }, take: 1 } } }
    }
  });
  const { contact, call } = row;
  const callRecord = call.record;

  const fallbackZone = contact.account.country === 'NZ' ? 'Pacific/Auckland' : SYDNEY;
  const timezone = callRecord?.timezone != null && IANAZone.isValidZone(callRecord.timezone) ? callRecord.timezone : fallbackZone;

  const windows: PreferredWindow[] = readJson(callRecord?.windows, windowsSchema, []);
  const attendees = readJson(callRecord?.attendees, z.array(z.string()), []);
  const objections = readJson(callRecord?.objections, objectionsSchema, []).map((o) => ({
    saidAs: o.saidAs,
    handledAs: typeof o.handledAs === 'string' ? o.handledAs : ''
  }));
  const summaryLines = readJson(callRecord?.summary, z.array(z.string()), []);
  const summaryUnavailable = callRecord === null || callRecord.summarySource === 'unavailable' || summaryLines.length === 0;

  const email = bestEmail(contact.emails.map((e) => ({ address: e.address, kind: e.kind, verified: e.verified })));
  const name = `${contact.firstName} ${contact.lastName}`.trim();
  const hypothesis = contact.dossiers[0]?.hypothesis ?? 'No dossier was on file for this contact.';
  const hook = callRecord?.hook ?? '';

  // The same draft the email carries, built by the same function, so what he
  // copies from the console is what he would have copied from his inbox.
  const forDraft: MeetingRequest = {
    requestId: record.id,
    prospect: {
      name,
      firstName: contact.firstName,
      title: contact.title,
      company: contact.account.name,
      phone: contact.phoneE164 ?? 'no number held',
      emailSource: email?.source ?? 'none',
      ...(email !== null ? { email: email.address } : {}),
      ...(contact.linkedinUrl !== null ? { linkedinUrl: contact.linkedinUrl } : {})
    },
    windows,
    timezone,
    attendees,
    hypothesis,
    hookUsed: hook,
    summary: summaryLines,
    objections,
    operator: { name: deps.operator.name, firstName: deps.operator.firstName, email: deps.operator.email }
  };

  return {
    ref: refFor(record.id),
    status: STATUS_VIEW[record.status],
    createdAt: record.createdAt.toISOString(),
    name,
    title: contact.title,
    company: contact.account.name,
    email: email?.address ?? null,
    phone: contact.phoneE164 ?? '',
    linkedinUrl: contact.linkedinUrl,
    windows: windows.map((w) => windowView(w, timezone)),
    attendees,
    hypothesis,
    hookThatWorked: hook.trim() === '' ? null : hook,
    // No summary beats an invented one: this is the section he reads as fact.
    summary: summaryUnavailable
      ? ['No summary was written because the summariser was not available. Read the transcript before you reply.']
      : summaryLines.slice(0, 5),
    objections: objections.map((o) => (o.handledAs === '' ? `"${o.saidAs}"` : `"${o.saidAs}" - handled: ${o.handledAs}`)),
    draftReply: draftReply(forDraft),
    callId: record.callId
  };
}

/** Everything still waiting on him: not yet answered, or answered "reschedule" and his to arrange. */
export async function openMeetingViews(deps: ConsoleDeps): Promise<MeetingRequestView[]> {
  const open = await deps.meetings.open();
  return Promise.all(open.map((record) => meetingView(deps, record)));
}

export type MeetingDecisionWord = 'CONFIRMED' | 'RESCHEDULE' | 'REJECT';

export type MeetingDecisionResult =
  | { kind: 'applied'; view: MeetingRequestView; effects: string[] }
  /** The request was already in the state asked for; nothing was done a second time. */
  | { kind: 'unchanged'; view: MeetingRequestView }
  | { kind: 'refused'; status: 400 | 404 | 409; error: string; view?: MeetingRequestView };

/**
 * Answer a request from the console.
 *
 * The decision is turned into the one-word reply the email flow expects and given
 * to `applyOperatorReply` unchanged. Nothing here decides whether a transition is
 * allowed; that is the state machine's, and its refusals come back as 409s with the
 * request as it now stands.
 */
export async function decideMeeting(deps: ConsoleDeps, ref: string, decision: MeetingDecisionWord): Promise<MeetingDecisionResult> {
  const reference = findRef(ref);
  if (reference === null) {
    return { kind: 'refused', status: 400, error: `"${ref}" is not a meeting reference; they look like MR-1A2B3C4D` };
  }

  const result = await applyOperatorReply(
    { db: deps.db, meetings: deps.meetings, suppressions: deps.suppressions, now: deps.now, via: 'console' },
    `${decision}\n\n${reference}`
  );

  switch (result.kind) {
    case 'applied': {
      const record = await deps.meetings.find(result.requestId);
      if (record === null) return { kind: 'refused', status: 404, error: `no meeting request ${reference}` };
      return { kind: 'applied', view: await meetingView(deps, record), effects: result.effects };
    }
    case 'not-applied': {
      const record = await deps.meetings.find(result.requestId);
      const view = record === null ? undefined : await meetingView(deps, record);
      if (result.noop && view !== undefined) return { kind: 'unchanged', view };
      return { kind: 'refused', status: 409, error: result.reason, ...(view !== undefined ? { view } : {}) };
    }
    case 'unknown-reference':
      return { kind: 'refused', status: 404, error: `no meeting request ${result.ref}` };
    case 'ambiguous-reference':
      return {
        kind: 'refused',
        status: 409,
        error: `${result.ref} matches ${result.count} requests, so none was changed; answer it from the email instead`
      };
    case 'unclear':
    case 'no-reference':
      return { kind: 'refused', status: 400, error: 'that was not a decision the system could read' };
  }
}
