/**
 * A mailer that writes `.eml` files instead of sending anything.
 *
 * Two uses, both real. It is how the whole system runs before a transactional
 * provider is configured - a request lands in a folder rather than vanishing.
 * And it answers brief section 15 item 6 without anyone having to ask: the
 * operator double-clicks the file in his own mail client and sees for himself
 * whether the `.ics` survives, which is the half of that question no test of
 * mine can answer.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEml } from './mime.js';
import type { Mailer, OutboundMail, SentMail } from './ports.js';

export interface FileMailerOptions {
  dir: string;
  from: string;
  now?: () => Date;
  newId?: () => string;
}

function slug(subject: string): string {
  return (
    subject
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'message'
  );
}

export class FileMailer implements Mailer {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: FileMailerOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  }

  async send(mail: OutboundMail): Promise<SentMail> {
    mkdirSync(this.options.dir, { recursive: true });
    const id = this.newId();
    const date = this.now();

    const eml = buildEml({
      from: this.options.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.body,
      attachments: mail.attachments,
      date,
      messageId: `${id}@anzsdr.local`
    });

    const stamp = date.toISOString().replace(/[:.]/g, '-');
    const where = join(this.options.dir, `${stamp}-${slug(mail.subject)}.eml`);
    writeFileSync(where, eml, 'utf8');
    return { id, where };
  }
}
