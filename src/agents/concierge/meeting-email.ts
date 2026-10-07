/**
 * The meeting-request email.
 *
 * Section 13 phase 6 is accepted on one sentence: "a simulated interested call
 * produces a meeting-request email I'd actually act on without opening anything
 * else". That is the design brief for this whole module. Everything Vinay needs
 * to decide is in the body; the transcript and recording are linked for the
 * times he wants them, not required to act.
 *
 * Three things follow from "without opening anything else":
 *
 *   - Every window appears twice, in their time and in Sydney time. He should
 *     never do the arithmetic, and section 12.1 asks for both explicitly.
 *   - The draft reply is ready to copy and send from his own Outlook, because
 *     section 12.2 says prospect email leaves from his mailbox and not ours.
 *   - What was actually said is summarised in the body, not attached.
 *
 * Nothing here sends anything. It builds a message; delivery is the caller's,
 * and prospect-facing mail is never sent by this system at all.
 */

import { DateTime } from 'luxon';
import { buildIcs } from './ics.js';
import { refFor } from './ref.js';

export interface PreferredWindow {
  /** The prospect's own words. Kept because the normalisation may be wrong. */
  saidAs: string;
  startsAt: string;
  endsAt: string;
}

export type EmailSource = 'confirmed_on_call' | 'heard_once' | 'apollo_work' | 'apollo_personal' | 'none';

/** What the email says about an address's provenance. Plain, and never flattering. */
export function describeEmailSource(source: EmailSource): string {
  switch (source) {
    case 'confirmed_on_call':
      return '(confirmed on the call)';
    case 'heard_once':
      return '(heard once on the call and NOT read back: check it before you send)';
    case 'apollo_work':
      return '(from the data provider, not confirmed with them)';
    case 'apollo_personal':
      return '(a personal address from the data provider, not confirmed with them)';
    case 'none':
      return '';
  }
}

export interface MeetingRequest {
  requestId: string;
  prospect: {
    name: string;
    firstName: string;
    title: string;
    company: string;
    phone: string;
    /** Absent when no address is held at all. */
    email?: string;
    /**
     * Where the address came from, because it is not all the same thing. One
     * Vinay heard confirmed on the call and one a data provider sold us are not
     * equally safe to write to, and the email must not blur them.
     */
    emailSource: EmailSource;
    /** A second address on file, shown only when the first was heard once. */
    alsoOnFile?: string;
    linkedinUrl?: string;
  };
  windows: PreferredWindow[];
  /** IANA zone the windows were given in. */
  timezone: string;
  attendees: string[];
  hypothesis: string;
  hookUsed: string;
  /** Five lines of what was actually said. */
  summary: string[];
  /** `unavailable` when no model could write one. Defaults to `model`. */
  summarySource?: 'model' | 'unavailable';
  objections: Array<{ saidAs: string; handledAs: string }>;
  transcriptUrl?: string;
  recordingUrl?: string;
  operator: { name: string; firstName: string; email: string };
  stamp?: Date;
}

export interface BuiltEmail {
  to: string;
  subject: string;
  body: string;
  attachments: Array<{ filename: string; contentType: string; content: string }>;
}

const SYDNEY = 'Australia/Sydney';

/** Section 8: the ask is twenty minutes with Vinay. */
export const MEETING_MINUTES = 20;

function inZone(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { setZone: true }).setZone(zone).toFormat('cccc d LLLL, HH:mm');
}

/**
 * "NZST", not "GMT+12".
 *
 * Luxon's short form is an offset, which is not how anyone refers to their own
 * timezone, and it changes across daylight saving so it reads like a different
 * place in March than in September. The long form is correct but too long for a
 * line that already carries two clocks, so the initials are taken from it -
 * "New Zealand Standard Time" is NZST, "Australian Western Standard Time" is
 * AWST. A zone whose long form does not reduce cleanly falls back to the offset
 * rather than printing something invented.
 *
 * Resolved at the instant being displayed, not at now(), so a window in March
 * is labelled with the rule in force in March.
 */
export function shortZone(zone: string, at: string): string {
  const long = DateTime.fromISO(at, { setZone: true }).setZone(zone).toFormat('ZZZZZ');
  const initials = long
    .split(/\s+/)
    .map((word) => word.charAt(0))
    .join('')
    .toUpperCase();
  if (/^[A-Z]{3,5}$/.test(initials)) return initials;
  return DateTime.fromISO(at, { setZone: true }).setZone(zone).toFormat('ZZZZ');
}

function clock(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { setZone: true }).setZone(zone).toFormat('HH:mm');
}

/**
 * Both clocks on one line, as a range.
 *
 * A range, because "Tuesday morning" is 09:00 to 12:00 and showing only the
 * start makes it read as though they asked for 09:00 sharp - which Vinay would
 * then confirm. The window is when they are free, not when the meeting is.
 */
export function renderWindow(window: PreferredWindow, timezone: string): string {
  const day = (zone: string): string =>
    DateTime.fromISO(window.startsAt, { setZone: true }).setZone(zone).toFormat('cccc d LLLL');
  const theirs = `${day(timezone)}, ${clock(window.startsAt, timezone)}-${clock(window.endsAt, timezone)} ${shortZone(timezone, window.startsAt)}`;
  const sydney = `${day(SYDNEY)}, ${clock(window.startsAt, SYDNEY)}-${clock(window.endsAt, SYDNEY)} Sydney`;
  const line = theirs.replace(/ [A-Z]{3,5}$/, '') === sydney.replace(/ Sydney$/, '') ? theirs : `${theirs}  ·  ${sydney}`;
  return `${line}\n      they said: "${window.saidAs}"`;
}

/**
 * The reply Vinay pastes into Outlook.
 *
 * Written as him, not as the system, and it confirms only what was actually
 * agreed: the prospect offered windows, and he is picking one. Lexi promised
 * an email today and nothing more, so this cannot promise more either.
 */
export function draftReply(request: MeetingRequest): string {
  const first = request.windows[0];
  // With the zone spelled out. He is writing from Sydney to someone in
  // Auckland, and a bare "09:00" is two different times depending on who reads
  // it - which is the one mistake that wastes the meeting this email exists for.
  const when =
    first === undefined
      ? 'a time that suits you'
      : `${inZone(first.startsAt, request.timezone)} ${shortZone(request.timezone, first.startsAt)}`;
  const others = request.attendees.length > 0 ? ` Happy to include ${request.attendees.join(' and ')} if that helps.` : '';

  return `Hi ${request.prospect.firstName},

Thanks for taking the call from Lexi earlier — she passed your details straight on to me.

${when} works well on my side. I'll send an invite across shortly to confirm.${others}

Twenty minutes is all I'll need. If something has changed and the timing no longer suits, just say and I'll work around you.

Best,
${request.operator.firstName}`;
}

export function subjectFor(request: MeetingRequest): string {
  const first = request.windows[0];
  // With the zone, as in the draft reply: on a lock screen a bare "09:00" reads
  // as Sydney time, and the window is the prospect's.
  const when =
    first === undefined
      ? 'time TBC'
      : `${inZone(first.startsAt, request.timezone)} ${shortZone(request.timezone, first.startsAt)}`;
  return `[MEETING REQUEST] ${request.prospect.name} — ${request.prospect.company} — ${when}`;
}

export function buildMeetingEmail(request: MeetingRequest): BuiltEmail {
  const p = request.prospect;
  const lines: string[] = [];

  lines.push(`${p.name} — ${p.title} at ${p.company} — would like twenty minutes.`);
  lines.push('');
  lines.push('WHEN THEY SUGGESTED');
  if (request.windows.length === 0) {
    lines.push('  No window was captured on the call.');
  } else {
    request.windows.forEach((window, i) => {
      lines.push(`  ${i + 1}. ${renderWindow(window, request.timezone)}`);
    });
  }
  if (request.attendees.length > 0) {
    lines.push('');
    lines.push(`  They would also like on the call: ${request.attendees.join(', ')}`);
  }

  lines.push('');
  lines.push('WHO THEY ARE');
  lines.push(`  ${p.name}, ${p.title}, ${p.company}`);
  lines.push(`  ${p.phone}`);
  if (p.email === undefined || p.emailSource === 'none') {
    lines.push('  No email address held. Ring them, or try LinkedIn.');
  } else {
    lines.push(`  ${p.email}   ${describeEmailSource(p.emailSource)}`);
    if (p.alsoOnFile !== undefined && p.emailSource === 'heard_once') {
      lines.push(`  also on file: ${p.alsoOnFile}   (from the data provider, if that one bounces)`);
    }
  }
  if (p.linkedinUrl !== undefined) lines.push(`  ${p.linkedinUrl}`);

  lines.push('');
  lines.push('WHY LEXI CALLED');
  lines.push(`  ${request.hypothesis}`);
  if (request.hookUsed.trim() !== '') {
    lines.push(`  What landed: ${request.hookUsed}`);
  }

  lines.push('');
  lines.push('WHAT WAS ACTUALLY SAID');
  if ((request.summarySource ?? 'model') === 'unavailable' || request.summary.length === 0) {
    // No summary beats an invented one: this is the section he reads as fact.
    lines.push('  No summary was written, because the summariser was not available.');
    lines.push('  Read the transcript below before you reply.');
  } else {
    lines.push('  (written by an AI from the transcript: check the transcript if anything surprises you)');
    for (const line of request.summary.slice(0, 5)) lines.push(`  ${line}`);
  }

  if (request.objections.length > 0) {
    lines.push('');
    lines.push('WHAT THEY PUSHED BACK ON');
    for (const objection of request.objections) {
      lines.push(`  "${objection.saidAs}"`);
      lines.push(`    → ${objection.handledAs}`);
    }
  }

  lines.push('');
  lines.push('REPLY TO ME WITH ONE WORD');
  lines.push('  CONFIRMED   — I will mark it arranged and stop calling them');
  lines.push('  RESCHEDULE  — I will keep it open and stop the reminder; you arrange the new time');
  lines.push('  REJECT      — I will drop it and suppress them permanently');
  lines.push('');
  lines.push(`  Leave this line in your reply so I know which request it is:  ${refFor(request.requestId)}`);

  lines.push('');
  lines.push('──── DRAFT REPLY TO THEM — copy from the next line ────');
  lines.push('');
  // Flush left on purpose. Indenting this block would mean stripping two spaces
  // off every line in Outlook before it could be sent, which is exactly the
  // friction "without opening anything else" is meant to remove.
  lines.push(draftReply(request));

  lines.push('──── end of draft ────');

  if (request.transcriptUrl !== undefined || request.recordingUrl !== undefined) {
    lines.push('');
    lines.push('IF YOU WANT THE DETAIL');
    if (request.transcriptUrl !== undefined) lines.push(`  transcript: ${request.transcriptUrl}`);
    if (request.recordingUrl !== undefined) lines.push(`  recording:  ${request.recordingUrl}`);
  }

  lines.push('');

  const attachments: BuiltEmail['attachments'] = [];
  const first = request.windows[0];
  // An invite needs an address to invite. Without one there is nothing for the
  // attendee line to point at, so no file is attached rather than a broken one.
  if (first !== undefined && p.email !== undefined && p.emailSource !== 'none') {
    attachments.push({
      filename: `${p.company.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${p.firstName.toLowerCase()}.ics`,
      contentType: 'text/calendar; charset=utf-8; method=REQUEST',
      content: buildIcs({
        uid: `${request.requestId}@hexaware-anz-sdr`,
        startsAt: first.startsAt,
        // The ask is twenty minutes (section 8), not the whole of the window
        // they are free in. A "Tuesday morning" window made a three-hour event.
        endsAt: DateTime.fromISO(first.startsAt, { setZone: true }).plus({ minutes: MEETING_MINUTES }).toISO() as string,
        summary: `${request.operator.firstName} & ${p.firstName} — Hexaware`,
        description: `Twenty minutes, requested on a call with Lexi.\n\n${request.hypothesis}`,
        organiserName: request.operator.name,
        organiserEmail: request.operator.email,
        attendeeName: p.name,
        attendeeEmail: p.email,
        ...(request.stamp !== undefined ? { stamp: request.stamp } : {})
      })
    });
  }

  return { to: request.operator.email, subject: subjectFor(request), body: lines.join('\n'), attachments };
}
