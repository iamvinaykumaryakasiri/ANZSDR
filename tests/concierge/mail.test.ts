/**
 * The mail layer.
 *
 * The encoder is checked by an independent reader written here, not by running
 * the encoder's own logic backwards: a symmetrical mistake would round-trip
 * perfectly and still be wrong on the wire.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEml, base64Wrapped, encodeHeaderValue } from '../../src/agents/concierge/mime.js';
import { FileMailer } from '../../src/agents/concierge/file-mailer.js';
import {
  MemoryMailer,
  MemorySmsSender,
  ProspectMailBlockedError,
  bareAddress,
  operatorOnly
} from '../../src/agents/concierge/ports.js';
import { buildMeetingEmail } from '../../src/agents/concierge/meeting-email.js';

const DATE = new Date('2026-10-07T02:20:00.000Z');

/* ---- an independent reader ------------------------------------------ */

function unfold(block: string): string[] {
  const lines: string[] = [];
  for (const line of block.split('\r\n')) {
    if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += line;
    else lines.push(line);
  }
  return lines;
}

function headerMap(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of unfold(block)) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

/** Decode RFC 2047: whitespace between adjacent encoded words is dropped. */
function decodeHeader(value: string): string {
  const joined = value.replace(/\?=\s+=\?UTF-8\?B\?/g, '?==?UTF-8?B?');
  return joined.replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

interface Part {
  headers: Record<string, string>;
  body: Buffer;
}

function parse(eml: string): { headers: Record<string, string>; parts: Part[]; raw: string } {
  const split = eml.indexOf('\r\n\r\n');
  const headers = headerMap(eml.slice(0, split));
  const rest = eml.slice(split + 4);
  const type = headers['content-type'] ?? '';
  const boundary = /boundary="([^"]+)"/.exec(type)?.[1];

  const decodePart = (raw: string): Part => {
    const at = raw.indexOf('\r\n\r\n');
    const h = headerMap(raw.slice(0, at));
    const encoded = raw.slice(at + 4).replace(/\r\n/g, '');
    return { headers: h, body: Buffer.from(encoded, 'base64') };
  };

  if (boundary === undefined) {
    return { headers, parts: [decodePart(`${eml.slice(0, 0)}${eml.slice(eml.indexOf('Content-Type:'))}`)], raw: eml };
  }
  const chunks = rest
    .split(`--${boundary}`)
    .map((c) => c.replace(/^\r\n/, '').replace(/\r\n$/, ''))
    .filter((c) => c !== '' && c !== '--' && !c.startsWith('--'));
  return { headers, parts: chunks.map(decodePart), raw: eml };
}

const base = {
  from: 'ANZ Voice SDR <sdr@example.com>',
  to: 'vinay@example.com',
  subject: 'Hello',
  text: 'Body.',
  attachments: [],
  date: DATE,
  messageId: 'abc123@anzsdr.local'
};

/* ---- subjects -------------------------------------------------------- */

describe('the subject line', () => {
  it('passes plain ASCII through untouched', () => {
    expect(encodeHeaderValue('[MEETING REQUEST] Priya Raman')).toBe('[MEETING REQUEST] Priya Raman');
  });

  it('round-trips the real section 12.1 subject, em dashes and all', () => {
    const subject = '[MEETING REQUEST] Priya Raman — Kiwibank — Tuesday 22 September, 09:00';
    const encoded = encodeHeaderValue(subject);
    expect(encoded).toContain('=?UTF-8?B?');
    expect(decodeHeader(encoded)).toBe(subject);
  });

  it('keeps every encoded word within the 75 characters the standard allows', () => {
    const encoded = encodeHeaderValue('[MEETING REQUEST] Priya Raman — Kiwibank — Tuesday 22 September, 09:00');
    for (const word of encoded.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? []) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it('folds onto lines that stay short', () => {
    const encoded = encodeHeaderValue('Bank of Queensland — a very long company name — '.repeat(5));
    for (const line of encoded.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
  });

  it('never splits a multi-byte character across two encoded words', () => {
    // Fifty em dashes are 150 bytes: the chunking has to land between them.
    const subject = '—'.repeat(50);
    const decoded = decodeHeader(encodeHeaderValue(subject));
    expect(decoded).toBe(subject);
    expect(decoded).not.toContain('�');
  });

  it('keeps a space that falls at a chunk edge', () => {
    const subject = `${'a'.repeat(44)} — ${'b'.repeat(60)} é`;
    expect(decodeHeader(encodeHeaderValue(subject))).toBe(subject);
  });

  it('flattens a newline in the subject rather than letting it write a header', () => {
    // The subject is built from a company name that came from a data provider.
    const encoded = encodeHeaderValue('Kiwibank\r\nBcc: someone@evil.example');
    expect(encoded).not.toMatch(/[\r\n]/);
    expect(encoded).toBe('Kiwibank Bcc: someone@evil.example');
  });
});

/* ---- structure ------------------------------------------------------- */

describe('the message', () => {
  it('is a single plain-text part when there is nothing to attach', () => {
    const eml = buildEml(base);
    expect(eml).not.toContain('multipart/mixed');
    const parsed = parse(eml);
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0]?.body.toString('utf8')).toBe('Body.');
  });

  it('carries the usual headers, with a standards-style date', () => {
    const { headers } = parse(buildEml(base));
    expect(headers.from).toBe(base.from);
    expect(headers.to).toBe('vinay@example.com');
    expect(headers['message-id']).toBe('<abc123@anzsdr.local>');
    expect(headers['mime-version']).toBe('1.0');
    expect(headers.date).toBe('Wed, 07 Oct 2026 02:20:00 GMT');
  });

  it('uses CRLF throughout, never a bare newline', () => {
    expect(buildEml(base)).not.toMatch(/[^\r]\n/);
  });

  it('carries non-ASCII body text intact', () => {
    const text = 'Tuesday 09:00 NZST · 07:00 Sydney — Hello → there';
    expect(parse(buildEml({ ...base, text })).parts[0]?.body.toString('utf8')).toBe(text);
  });

  it('wraps base64 at 76 characters', () => {
    for (const line of base64Wrapped('x'.repeat(500)).split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
  });

  it('attaches a calendar file byte for byte, line endings included', () => {
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
    const eml = buildEml({
      ...base,
      attachments: [{ filename: 'kiwibank-priya.ics', contentType: 'text/calendar; charset=utf-8; method=REQUEST', content: ics }]
    });
    const { parts, headers } = parse(eml);

    expect(headers['content-type']).toContain('multipart/mixed');
    expect(parts).toHaveLength(2);
    expect(parts[1]?.headers['content-type']).toContain('text/calendar');
    expect(parts[1]?.headers['content-disposition']).toContain('filename="kiwibank-priya.ics"');
    expect(parts[1]?.body.toString('utf8')).toBe(ics);
  });

  it('closes the multipart with the terminating boundary', () => {
    const eml = buildEml({ ...base, attachments: [{ filename: 'a.ics', contentType: 'text/calendar', content: 'x' }] });
    const boundary = /boundary="([^"]+)"/.exec(eml)?.[1] as string;
    expect(eml.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });

  it('uses the same boundary for the same message and a different one for another', () => {
    const a = buildEml({ ...base, attachments: [{ filename: 'a', contentType: 'text/plain', content: 'x' }] });
    const b = buildEml({ ...base, messageId: 'other@anzsdr.local', attachments: [{ filename: 'a', contentType: 'text/plain', content: 'x' }] });
    expect(/boundary="([^"]+)"/.exec(a)?.[1]).not.toBe(/boundary="([^"]+)"/.exec(b)?.[1]);
  });
});

describe('header injection', () => {
  it('refuses a recipient with a line break', () => {
    expect(() => buildEml({ ...base, to: 'vinay@example.com\r\nBcc: x@evil.example' })).toThrow(/line break/);
  });

  it('refuses a sender with a line break', () => {
    expect(() => buildEml({ ...base, from: 'a@b.com\nBcc: x@evil.example' })).toThrow(/line break/);
  });

  it('cannot be made to write a header through the filename', () => {
    const eml = buildEml({
      ...base,
      attachments: [{ filename: 'a"\r\nBcc: x@evil.example.ics', contentType: 'text/calendar', content: 'x' }]
    });
    expect(eml).not.toMatch(/\r\nBcc:/);
  });

  it('cannot be made to write a header through the content type', () => {
    const eml = buildEml({
      ...base,
      attachments: [{ filename: 'a.ics', contentType: 'text/calendar\r\nBcc: x@evil.example', content: 'x' }]
    });
    expect(eml).not.toMatch(/\r\nBcc:/);
  });

  it('cannot be made to close its own message id early and start another header', () => {
    // The text survives as inert characters inside the id, on one line. What
    // matters is that it did not become a header of its own.
    const eml = buildEml({ ...base, messageId: 'a>\r\nBcc: x@evil.example' });
    const { headers } = parse(eml);
    expect(headers.bcc).toBeUndefined();
    expect(eml).not.toMatch(/\r\nBcc:/);
    expect(headers['message-id']).toMatch(/^<[^>\r\n]*>$/);
  });
});

/* ---- the real email ---------------------------------------------------- */

describe('the real meeting email, as bytes', () => {
  const email = buildMeetingEmail({
    requestId: '8f21a3c4-1111-2222-3333-444455556666',
    prospect: {
      name: 'Priya Raman',
      firstName: 'Priya',
      title: 'Head of Data',
      company: 'Bank of Queensland, Limited',
      phone: '+6444960000',
      email: 'priya@kiwibank.co.nz',
      emailSource: 'confirmed_on_call'
    },
    windows: [{ saidAs: 'Tuesday morning', startsAt: '2026-10-13T09:00:00+13:00', endsAt: '2026-10-13T12:00:00+13:00' }],
    timezone: 'Pacific/Auckland',
    attendees: [],
    hypothesis: 'A rebuild is under way.',
    hookUsed: '',
    summary: ['Agreed to a call.'],
    objections: [],
    operator: { name: 'Vinay Kumar', firstName: 'Vinay', email: 'vinay@example.com' }
  });

  const eml = buildEml({
    from: 'ANZ Voice SDR <sdr@example.com>',
    to: email.to,
    subject: email.subject,
    text: email.body,
    attachments: email.attachments,
    date: DATE,
    messageId: 'real@anzsdr.local'
  });
  const parsed = parse(eml);

  it('arrives with the subject section 12.1 specifies', () => {
    expect(decodeHeader(parsed.headers.subject as string)).toBe(email.subject);
    expect(email.subject).toContain('—');
  });

  it('arrives with the whole body', () => {
    expect(parsed.parts[0]?.body.toString('utf8')).toBe(email.body);
  });

  it('arrives with a calendar file that still has a comma-bearing company name escaped', () => {
    const ics = parsed.parts[1]?.body.toString('utf8') ?? '';
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toMatch(/\r\n$/);
  });
});

/* ---- who it may be sent to --------------------------------------------- */

describe('operator-only mail', () => {
  const mail = (to: string) => ({ to, subject: 's', body: 'b', attachments: [] });

  it('sends to the operator', async () => {
    const inner = new MemoryMailer();
    await operatorOnly(inner, ['vinay@example.com']).send(mail('vinay@example.com'));
    expect(inner.sent).toHaveLength(1);
  });

  it('refuses a prospect, whatever asked, and sends nothing', async () => {
    const inner = new MemoryMailer();
    await expect(operatorOnly(inner, ['vinay@example.com']).send(mail('priya@kiwibank.co.nz'))).rejects.toThrow(
      ProspectMailBlockedError
    );
    expect(inner.sent).toEqual([]);
  });

  it('says why, and where prospect mail goes instead', async () => {
    await expect(operatorOnly(new MemoryMailer(), ['vinay@example.com']).send(mail('p@x.com'))).rejects.toThrow(
      /own mailbox/
    );
  });

  it('is not fooled by case or a display name', async () => {
    const inner = new MemoryMailer();
    const guarded = operatorOnly(inner, ['Vinay@Example.com']);
    await guarded.send(mail('VINAY@example.COM'));
    await guarded.send(mail('Vinay Kumar <vinay@example.com>'));
    expect(inner.sent).toHaveLength(2);
  });

  it('is not fooled by a display name that contains the operator’s address', async () => {
    // "vinay@example.com" <attacker@evil.example> - the address that gets the
    // mail is the one in the angle brackets.
    await expect(
      operatorOnly(new MemoryMailer(), ['vinay@example.com']).send(mail('"vinay@example.com" <attacker@evil.example>'))
    ).rejects.toThrow(ProspectMailBlockedError);
  });

  it('allows nothing at all when no operator address is configured', async () => {
    // A mailer built before section 15 item 6 is answered must fail closed.
    await expect(operatorOnly(new MemoryMailer(), []).send(mail('vinay@example.com'))).rejects.toThrow();
    await expect(operatorOnly(new MemoryMailer(), ['']).send(mail(''))).rejects.toThrow();
  });

  it('reads the bare address out of a display form', () => {
    expect(bareAddress('Vinay Kumar <Vinay@Example.com>')).toBe('vinay@example.com');
    expect(bareAddress('  a@b.com ')).toBe('a@b.com');
  });
});

describe('the in-memory senders', () => {
  it('records what was sent', async () => {
    const sms = new MemorySmsSender();
    const result = await sms.send('+61412345678', '+61280000000', 'hello');
    expect(sms.sent).toEqual([{ to: '+61412345678', from: '+61280000000', body: 'hello' }]);
    expect(result.id).toBe('sms-1');
  });
});

/* ---- the file mailer ---------------------------------------------------- */

describe('the file mailer', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function mailer() {
    const dir = join(mkdtempSync(join(tmpdir(), 'anzsdr-outbox-')), 'nested', 'outbox');
    dirs.push(join(dir, '..', '..'));
    return { dir, mailer: new FileMailer({ dir, from: 'sdr@example.com', now: () => DATE, newId: () => 'id1' }) };
  }

  it('writes an .eml file, creating the folder if it is not there', async () => {
    const { dir, mailer: m } = mailer();
    expect(existsSync(dir)).toBe(false);
    const sent = await m.send({ to: 'vinay@example.com', subject: 'Hello there', body: 'Body.', attachments: [] });
    expect(sent.where && existsSync(sent.where)).toBe(true);
    expect(sent.where).toMatch(/\.eml$/);
  });

  it('names the file so a folder of them is readable', async () => {
    const { mailer: m } = mailer();
    const sent = await m.send({
      to: 'vinay@example.com',
      subject: '[MEETING REQUEST] Priya Raman — Kiwibank — Tuesday',
      body: 'x',
      attachments: []
    });
    expect(sent.where).toContain('2026-10-07T02-20-00-000Z');
    expect(sent.where).toContain('meeting-request-priya-raman-kiwibank-tuesday');
  });

  it('writes something a mail client can open: parseable, with the attachment inside', async () => {
    const { mailer: m } = mailer();
    const email = { to: 'vinay@example.com', subject: 'Calendar — test', body: 'Hi', attachments: [{ filename: 'a.ics', contentType: 'text/calendar', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }] };
    const sent = await m.send(email);
    const parsed = parse(readFileSync(sent.where as string, 'utf8'));
    expect(decodeHeader(parsed.headers.subject as string)).toBe('Calendar — test');
    expect(parsed.parts[1]?.body.toString('utf8')).toContain('BEGIN:VCALENDAR');
  });

  it('falls back to a plain name when a subject has no usable characters', async () => {
    const { mailer: m } = mailer();
    const sent = await m.send({ to: 'vinay@example.com', subject: '———', body: 'x', attachments: [] });
    expect(sent.where).toContain('message.eml');
  });

  it('generates its own ids when none are supplied', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'anzsdr-outbox-')), 'o');
    dirs.push(join(dir, '..'));
    const sent = await new FileMailer({ dir, from: 's@example.com' }).send({
      to: 'v@example.com',
      subject: 'x',
      body: 'y',
      attachments: []
    });
    expect(sent.id.length).toBeGreaterThan(4);
  });
});
