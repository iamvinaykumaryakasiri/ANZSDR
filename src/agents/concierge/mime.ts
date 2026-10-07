/**
 * A mail message as bytes, written to the standards rather than approximately.
 *
 * Hand-rolled MIME is where things quietly go wrong, and the one that matters
 * here is the subject. Section 12.1 fixes it as
 * `[MEETING REQUEST] {Name} — {Company} — {window}`, which has an em dash in it,
 * which is not ASCII, which means RFC 2047 encoding - and an encoded word is
 * limited to 75 characters, so a realistic subject has to be split across
 * several. Get that wrong and the subject arrives as mojibake or truncated in
 * the one email the operator opens every morning.
 *
 * Also guarded: header injection. A subject is built from a prospect's company
 * name, which came from a data provider, and a newline in it would let that
 * data write its own headers.
 */

import { createHash } from 'node:crypto';
import type { MailAttachment } from './ports.js';

export interface MimeMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: MailAttachment[];
  date: Date;
  messageId: string;
}

const CRLF = '\r\n';

/** Wrap base64 at 76 characters, as RFC 2045 requires. */
export function base64Wrapped(data: Buffer | string): string {
  const encoded = (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64');
  return (encoded.match(/.{1,76}/g) ?? []).join(CRLF);
}

/** 45 bytes encodes to 60 base64 characters; with the 12 of wrapper, 72 < 75. */
const ENCODED_WORD_BYTES = 45;

/**
 * An RFC 2047 header value.
 *
 * ASCII passes through. Anything else becomes encoded words, split on
 * character boundaries - never inside a multi-byte character, which would
 * decode as a replacement glyph in the middle of a name. Folding whitespace
 * between adjacent encoded words is discarded on decode, so a space at a
 * chunk edge survives only because it is inside the encoded text.
 */
export function encodeHeaderValue(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;

  const chunks: string[] = [];
  let current = '';
  for (const char of Array.from(flat)) {
    if (Buffer.byteLength(current + char, 'utf8') > ENCODED_WORD_BYTES) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current !== '') chunks.push(current);

  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

function assertNoNewline(label: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} contains a line break, which would let the value write its own mail headers`);
  }
}

function quotedFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '_');
}

export function buildEml(message: MimeMessage): string {
  // Addresses are never encoded and never allowed a newline. A subject is
  // flattened instead of rejected: it is built from third-party data and the
  // useful response to a newline in a company name is a space, not a failure.
  assertNoNewline('the From address', message.from);
  assertNoNewline('the To address', message.to);

  const headers = [
    `Date: ${message.date.toUTCString()}`,
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Message-ID: <${message.messageId.replace(/[<>\r\n]/g, '')}>`,
    'MIME-Version: 1.0'
  ];

  const textPart = [
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Wrapped(message.text)
  ].join(CRLF);

  if (message.attachments.length === 0) {
    return `${[...headers, textPart].join(CRLF)}${CRLF}`;
  }

  const boundary = `=_anzsdr_${createHash('sha256').update(message.messageId).digest('hex').slice(0, 24)}`;
  const parts = [textPart];

  for (const attachment of message.attachments) {
    const name = quotedFilename(attachment.filename);
    parts.push(
      [
        `Content-Type: ${attachment.contentType.replace(/[\r\n]/g, ' ')}; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Wrapped(attachment.content)
      ].join(CRLF)
    );
  }

  const body = parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF);
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    body,
    `--${boundary}--`,
    ''
  ].join(CRLF);
}
