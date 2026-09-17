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

export interface PreferredWindow {
  /** The prospect's own words. Kept because the normalisation may be wrong. */
  saidAs: string;
  startsAt: string;
  endsAt: string;
}

export interface MeetingRequest {
  requestId: string;
  prospect: {
    name: string;
    firstName: string;
    title: string;
    company: string;
    phone: string;
    email: string;
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

/** Both clocks on one line, so nobody converts anything in their head. */
export function renderWindow(window: PreferredWindow, timezone: string): string {
  const theirs = inZone(window.startsAt, timezone);
  const sydney = inZone(window.startsAt, SYDNEY);
  const sameClock = theirs === sydney;
  const line = sameClock
    ? `${theirs} ${shortZone(timezone, window.startsAt)}`
    : `${theirs} ${shortZone(timezone, window.startsAt)}  ·  ${sydney} Sydney`;
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
  const when = first === undefined ? 'time TBC' : inZone(first.startsAt, request.timezone);
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
  lines.push(`  ${p.email}   (confirmed on the call)`);
  if (p.linkedinUrl !== undefined) lines.push(`  ${p.linkedinUrl}`);

  lines.push('');
  lines.push('WHY LEXI CALLED');
  lines.push(`  ${request.hypothesis}`);
  if (request.hookUsed.trim() !== '') {
    lines.push(`  What landed: ${request.hookUsed}`);
  }

  lines.push('');
  lines.push('WHAT WAS ACTUALLY SAID');
  for (const line of request.summary.slice(0, 5)) lines.push(`  ${line}`);

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
  lines.push('  CONFIRMED   — I will stop the follow-up and mark it booked');
  lines.push('  RESCHEDULE  — tell me when and I will go back to them');
  lines.push('  REJECT      — I will drop it and suppress them');

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
  if (first !== undefined) {
    attachments.push({
      filename: `${p.company.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${p.firstName.toLowerCase()}.ics`,
      contentType: 'text/calendar; charset=utf-8; method=REQUEST',
      content: buildIcs({
        uid: `${request.requestId}@hexaware-anz-sdr`,
        startsAt: first.startsAt,
        endsAt: first.endsAt,
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
