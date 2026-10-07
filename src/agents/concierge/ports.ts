/**
 * What the concierge sends through, and the one rule about who it may send to.
 *
 * Section 12.2: prospect-facing email goes from Vinay's own mailbox, never from
 * a system sending domain. Internal mail - to Vinay only - goes through a
 * transactional provider. So this system has no business ever emailing a
 * prospect, and that is enforced here at the point of sending rather than
 * trusted to every caller: a mailer wrapped in `operatorOnly` throws on any
 * other recipient, whatever code asked.
 *
 * SMS is the one channel that does reach a prospect directly, and it is guarded
 * by `smsEligibility` before it gets anywhere near this port.
 */

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: string;
}

export interface OutboundMail {
  to: string;
  subject: string;
  body: string;
  attachments: MailAttachment[];
}

export interface SentMail {
  id: string;
  /** Where it went, when that is a place a person can look (a file path). */
  where?: string;
}

export interface Mailer {
  send(mail: OutboundMail): Promise<SentMail>;
}

export class ProspectMailBlockedError extends Error {}

/** The bare address of `Name <a@b.com>` or `a@b.com`, lower-cased. */
export function bareAddress(value: string): string {
  const angle = /<([^>]+)>/.exec(value);
  return (angle !== null ? (angle[1] as string) : value).trim().toLowerCase();
}

/**
 * A mailer that will only ever write to the operator.
 *
 * An empty allow-list allows nothing, rather than everything: a mailer built
 * before the operator's address is configured must fail closed.
 */
export function operatorOnly(inner: Mailer, allowed: string[]): Mailer {
  const permitted = new Set(allowed.map(bareAddress).filter((a) => a !== ''));
  return {
    async send(mail: OutboundMail): Promise<SentMail> {
      if (!permitted.has(bareAddress(mail.to))) {
        throw new ProspectMailBlockedError(
          `refusing to send to ${mail.to}: this system only emails the operator, and prospect email is drafted for Vinay to send from his own mailbox (brief section 12.2)`
        );
      }
      return inner.send(mail);
    }
  };
}

export class MemoryMailer implements Mailer {
  readonly sent: OutboundMail[] = [];
  private counter = 0;

  async send(mail: OutboundMail): Promise<SentMail> {
    this.sent.push(mail);
    this.counter += 1;
    return { id: `memory-${this.counter}` };
  }
}

export interface SmsSender {
  /** `from` is a number a reply can reach. See `senderCanReceiveReplies`. */
  send(to: string, from: string, body: string): Promise<{ id: string }>;
}

export class MemorySmsSender implements SmsSender {
  readonly sent: Array<{ to: string; from: string; body: string }> = [];

  async send(to: string, from: string, body: string): Promise<{ id: string }> {
    this.sent.push({ to, from, body });
    return { id: `sms-${this.sent.length}` };
  }
}
