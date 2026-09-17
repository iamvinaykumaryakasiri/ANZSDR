/**
 * Phase 6 acceptance, first half: an email Vinay would act on without opening
 * anything else, and a reply that updates state correctly.
 */

import { describe, expect, it } from 'vitest';
import { buildMeetingEmail, draftReply, renderWindow, subjectFor, type MeetingRequest } from '../../src/agents/concierge/meeting-email.js';
import { buildIcs, escapeText, foldLine } from '../../src/agents/concierge/ics.js';
import { parseReply, stripQuoted } from '../../src/agents/concierge/reply.js';

const STAMP = new Date('2026-09-17T04:00:00.000Z');

function request(over: Partial<MeetingRequest> = {}): MeetingRequest {
  return {
    requestId: 'mr-1',
    prospect: {
      name: 'Priya Raman',
      firstName: 'Priya',
      title: 'Head of Data',
      company: 'Kiwibank',
      phone: '+6444960000',
      email: 'priya.raman@kiwibank.co.nz',
      linkedinUrl: 'https://linkedin.com/in/example'
    },
    windows: [
      { saidAs: 'Tuesday or Wednesday morning', startsAt: '2026-09-22T09:00:00+12:00', endsAt: '2026-09-22T09:20:00+12:00' },
      { saidAs: 'after 3 on Thursday', startsAt: '2026-09-24T15:00:00+12:00', endsAt: '2026-09-24T15:20:00+12:00' }
    ],
    timezone: 'Pacific/Auckland',
    attendees: ['our head of architecture'],
    hypothesis: 'Kiwibank has had data platform roles open since March, which usually means a rebuild.',
    hookUsed: 'Four data platform roles open since March.',
    summary: [
      'Confirmed they are mid-way through a platform rebuild.',
      'Current partner is delivering, but slowly.',
      'Asked what Hexaware had done in New Zealand specifically.',
      'Lexi deferred that to Vinay rather than answering.',
      'Offered two windows and gave a work email unprompted.'
    ],
    objections: [{ saidAs: 'We already have a partner for this.', handledAs: 'Did not compete on it; offered the narrow piece alongside.' }],
    transcriptUrl: 'https://example.com/t/1',
    recordingUrl: 'https://example.com/r/1',
    operator: { name: 'Vinay Kumar', firstName: 'Vinay', email: 'vinay@example.com' },
    stamp: STAMP,
    ...over
  };
}

describe('the subject line', () => {
  it('follows section 12.1 exactly', () => {
    expect(subjectFor(request())).toBe('[MEETING REQUEST] Priya Raman — Kiwibank — Tuesday 22 September, 09:00');
  });

  it('says so rather than inventing a time when no window was captured', () => {
    expect(subjectFor(request({ windows: [] }))).toContain('time TBC');
  });
});

describe('every window, on both clocks', () => {
  it('shows their time and Sydney time on one line', () => {
    const line = renderWindow(request().windows[0] as never, 'Pacific/Auckland');
    expect(line).toContain('09:00');
    // 09:00 Auckland is 07:00 Sydney in September.
    expect(line).toContain('07:00');
    expect(line).toContain('Sydney');
  });

  it('keeps the prospect’s own words next to the normalised time', () => {
    expect(renderWindow(request().windows[0] as never, 'Pacific/Auckland')).toContain('Tuesday or Wednesday morning');
  });

  it('names the zone the way a person would, not as an offset', () => {
    // "GMT+12" is not how anyone refers to New Zealand time, and it reads like
    // a different place in March than in September.
    const line = renderWindow(request().windows[0] as never, 'Pacific/Auckland');
    expect(line).toContain('NZST');
    expect(line).not.toContain('GMT+');
  });

  it('labels the zone for the window being shown, not for today', () => {
    const march = renderWindow(
      { saidAs: 'a March morning', startsAt: '2026-03-10T09:00:00+13:00', endsAt: '2026-03-10T09:20:00+13:00' },
      'Pacific/Auckland'
    );
    // New Zealand is on daylight time in March and standard time in September.
    expect(march).toContain('NZDT');
  });

  it('does not repeat itself when the prospect is already on Sydney time', () => {
    const sydney = renderWindow(
      { saidAs: 'Tuesday morning', startsAt: '2026-09-22T09:00:00+10:00', endsAt: '2026-09-22T09:20:00+10:00' },
      'Australia/Sydney'
    );
    expect(sydney.match(/09:00/g)).toHaveLength(1);
  });
});

describe('the email body', () => {
  const email = buildMeetingEmail(request());

  it('goes to the operator, never the prospect', () => {
    expect(email.to).toBe('vinay@example.com');
  });

  it('carries everything section 12.1 lists', () => {
    for (const needed of [
      'Priya Raman',
      'Head of Data',
      'Kiwibank',
      '+6444960000',
      'priya.raman@kiwibank.co.nz',
      'linkedin.com/in/example',
      'our head of architecture',
      'roles open since March',
      'Current partner is delivering, but slowly.',
      'We already have a partner for this.',
      'https://example.com/t/1',
      'https://example.com/r/1'
    ]) {
      expect(email.body, `missing: ${needed}`).toContain(needed);
    }
  });

  it('tells him the three words he can reply with', () => {
    expect(email.body).toContain('CONFIRMED');
    expect(email.body).toContain('RESCHEDULE');
    expect(email.body).toContain('REJECT');
  });

  it('holds the summary to five lines, because he reads this on a phone', () => {
    const long = buildMeetingEmail(request({ summary: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }));
    expect(long.body).not.toContain('  f');
  });

  it('leaves the draft flush left so it pastes into Outlook cleanly', () => {
    const draftBlock = email.body.split('copy from the next line ────')[1]?.split('──── end of draft')[0] ?? '';
    for (const line of draftBlock.split('\n').filter((l) => l.trim() !== '')) {
      expect(line, `indented: "${line}"`).not.toMatch(/^\s/);
    }
  });

  it('includes a draft he can paste into Outlook as himself', () => {
    expect(email.body).toContain('copy from the next line');
    expect(email.body).toContain('Best,');
    expect(email.body).toContain('Vinay');
  });
});

describe('the draft reply to the prospect', () => {
  const draft = draftReply(request());

  it('is written as Vinay, not as the system', () => {
    expect(draft).toContain('Hi Priya,');
    expect(draft).toContain('she passed your details straight on to me');
  });

  it('promises only what Lexi actually promised', () => {
    // Lexi said Vinay would email today. The draft confirms a time he is
    // choosing; it does not claim anything was already arranged.
    expect(draft).not.toMatch(/\balready booked\b|\bconfirmed your\b/i);
    expect(draft).toContain("I'll send an invite across shortly");
  });

  it('spells out the timezone, because he writes from Sydney to Auckland', () => {
    expect(draft).toContain('09:00 NZST');
  });

  it('offers to include anyone else they asked for', () => {
    expect(draft).toContain('our head of architecture');
  });

  it('leaves that sentence out when nobody else was mentioned', () => {
    expect(draftReply(request({ attendees: [] }))).not.toContain('Happy to include');
  });
});

describe('the .ics attachment', () => {
  const email = buildMeetingEmail(request());
  const ics = email.attachments[0]?.content ?? '';

  it('is attached for the top window', () => {
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]?.filename).toBe('kiwibank-priya.ics');
    expect(email.attachments[0]?.contentType).toContain('text/calendar');
  });

  it('uses CRLF everywhere, including the final line', () => {
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.split('\r\n').length).toBeGreaterThan(10);
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it('carries the window in UTC', () => {
    // 09:00 Auckland on 22 September is 21:00 UTC on the 21st.
    expect(ics).toContain('DTSTART:20260921T210000Z');
  });

  it('is a request from Vinay, not a confirmation', () => {
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('STATUS:TENTATIVE');
    expect(ics).toContain('ORGANIZER;CN=Vinay Kumar:mailto:vinay@example.com');
    expect(ics).toContain('RSVP=TRUE:mailto:priya.raman@kiwibank.co.nz');
  });

  it('is left off entirely when no window was captured', () => {
    expect(buildMeetingEmail(request({ windows: [] })).attachments).toEqual([]);
  });
});

describe('the .ics details that bite', () => {
  it('escapes a comma in a company name rather than truncating the field', () => {
    expect(escapeText('Bank of Queensland, Limited')).toBe('Bank of Queensland\\, Limited');
  });

  it('escapes semicolons, backslashes and newlines', () => {
    expect(escapeText('a;b')).toBe('a\;b');
    expect(escapeText('a\\b')).toBe('a\\\\b');
    expect(escapeText('a\nb')).toBe('a\\nb');
  });

  it('folds a long line at 75 octets with a leading space', () => {
    const folded = foldLine(`DESCRIPTION:${'x'.repeat(200)}`);
    const [first, second] = folded.split('\r\n');
    expect(Buffer.from(first as string, 'utf8').length).toBeLessThanOrEqual(75);
    expect(second?.startsWith(' ')).toBe(true);
  });

  it('never splits a multi-byte character across the fold', () => {
    const folded = foldLine(`SUMMARY:${'é'.repeat(80)}`);
    for (const line of folded.split('\r\n')) {
      expect(line).not.toContain('�');
    }
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'é'.repeat(80)}`);
  });

  it('leaves a short line alone', () => {
    expect(foldLine('VERSION:2.0')).toBe('VERSION:2.0');
  });

  it('builds a file with no stamp supplied, for real use', () => {
    const ics = buildIcs({
      uid: 'u',
      startsAt: '2026-09-22T09:00:00+12:00',
      endsAt: '2026-09-22T09:20:00+12:00',
      summary: 's',
      description: 'd',
      organiserName: 'V',
      organiserEmail: 'v@example.com',
      attendeeName: 'P',
      attendeeEmail: 'p@example.com'
    });
    expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
  });
});

describe('reading the reply', () => {
  it('takes a one-word confirmation', () => {
    expect(parseReply('CONFIRMED').decision).toBe('confirmed');
  });

  it('takes it in any case, with a signature after it', () => {
    expect(parseReply('confirmed\n\nVinay').decision).toBe('confirmed');
  });

  it('reads only what he typed, not the instructions quoted back', () => {
    // This is the one that matters. His own email lists all three words, so a
    // naive parser reads REJECT out of the quotation and suppresses someone
    // who had just agreed to a meeting.
    const reply = `CONFIRMED

Sent from my iPhone

-----Original Message-----
From: ANZ Voice SDR
REPLY TO ME WITH ONE WORD
  CONFIRMED   — I will stop the follow-up
  RESCHEDULE  — tell me when
  REJECT      — I will drop it and suppress them`;
    expect(parseReply(reply).decision).toBe('confirmed');
  });

  it('handles the Gmail attribution line', () => {
    const reply = 'REJECT\n\nOn Thu, 17 Sep 2026 at 14:00, ANZ Voice SDR wrote:\n> CONFIRMED RESCHEDULE REJECT';
    expect(parseReply(reply).decision).toBe('rejected');
  });

  it('keeps the note when he reschedules', () => {
    const parsed = parseReply('RESCHEDULE — try the following week, he is away');
    expect(parsed.decision).toBe('reschedule');
    expect(parsed.note).toBe('try the following week, he is away');
  });

  it('refuses to guess when he types two of them', () => {
    expect(parseReply('CONFIRMED or maybe RESCHEDULE, not sure').decision).toBe('unclear');
  });

  it('refuses to guess when he types none of them', () => {
    expect(parseReply('who is this about again?').decision).toBe('unclear');
  });

  it('shows what it actually read, for the audit trail', () => {
    expect(parseReply('CONFIRMED\n\n> quoted').consideredText).toBe('CONFIRMED');
  });

  it('strips an Outlook divider', () => {
    expect(stripQuoted('yes\n________________________________\nFrom: someone')).toBe('yes');
  });
});
