/**
 * The calendar attachment.
 *
 * Section 12.1 wants an `.ics` for the top preferred window so adding it is one
 * tap. Written to RFC 5545 by hand rather than pulled from a library: the file
 * is forty lines, the spec's awkward parts are few and known, and a dependency
 * here would be a dependency in the path of the one artefact the operator
 * actually opens on a phone.
 *
 * The awkward parts, all of which bite in practice:
 *   - CRLF line endings, everywhere, including the last line.
 *   - Lines fold at 75 octets, and the continuation starts with one space.
 *     Octets, not characters, so a long subject with an em dash in it folds
 *     differently than its length suggests.
 *   - TEXT values escape backslash, semicolon, comma and newline. A company
 *     name with a comma in it - "Bank of Queensland, Limited" - silently
 *     truncates the field otherwise.
 *   - UTC timestamps end in Z and carry no offset.
 *
 * This is a REQUEST, not a confirmation. Nothing here is booked until Vinay
 * replies, so the event is created as TENTATIVE and the operator is the
 * organiser - Lexi never had the authority to invite anyone.
 */

import { DateTime } from 'luxon';

export interface IcsInvite {
  uid: string;
  startsAt: string;
  endsAt: string;
  summary: string;
  description: string;
  organiserName: string;
  organiserEmail: string;
  attendeeName: string;
  attendeeEmail: string;
  /** When the file was generated. Injected so the output is testable. */
  stamp?: Date;
}

/** RFC 5545 §3.3.11: backslash, semicolon, comma and newline are special. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold at 75 octets with a leading space on continuations.
 *
 * Counted in UTF-8 bytes, and a multi-byte character is never split across the
 * boundary - half a character is not a character, and mail clients render the
 * result as a replacement glyph in the middle of a company name.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let taken = 0;
  let limit = 75;

  while (taken < bytes.length) {
    let end = Math.min(taken + limit, bytes.length);
    // Walk back off a continuation byte so a character is never cut in half.
    while (end > taken && end < bytes.length && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(taken, end).toString('utf8'));
    taken = end;
    limit = 74; // continuations spend one octet on the leading space
  }

  return parts.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n');
}

function utc(iso: string | Date): string {
  const dt = typeof iso === 'string' ? DateTime.fromISO(iso, { setZone: true }) : DateTime.fromJSDate(iso);
  return dt.toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
}

export function buildIcs(invite: IcsInvite): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hexaware//ANZ Voice SDR//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${invite.uid}`,
    `DTSTAMP:${utc(invite.stamp ?? new Date())}`,
    `DTSTART:${utc(invite.startsAt)}`,
    `DTEND:${utc(invite.endsAt)}`,
    `SUMMARY:${escapeText(invite.summary)}`,
    `DESCRIPTION:${escapeText(invite.description)}`,
    // Tentative, because it is: the prospect offered a window and nobody has
    // accepted anything yet.
    'STATUS:TENTATIVE',
    'TRANSP:OPAQUE',
    `ORGANIZER;CN=${escapeText(invite.organiserName)}:mailto:${invite.organiserEmail}`,
    `ATTENDEE;CN=${escapeText(invite.attendeeName)};RSVP=TRUE:mailto:${invite.attendeeEmail}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ];

  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
