/**
 * A text arriving from a prospect.
 *
 * Section 7.2: "Honour every opt-out regardless." Twilio blocks further sends
 * to a number that replies STOP, at the carrier level, and that is the floor.
 * This is the system's own record of it, so that the blackboard, the compliance
 * gate and Vinay all know what Twilio already knows, and so that a person who
 * writes "please stop texting me" - which Twilio does not treat as STOP - is
 * honoured too.
 *
 * An opt-out suppresses the contact and the number permanently, because the
 * person has told us to stop and section 7.2 does not ask which channel they
 * meant. A test contact is suppressed as a contact only, for the same reason
 * the executor does: rehearsing STOP from Vinay's own phone must not burn the
 * number the whole test programme runs on.
 *
 * Anything that is not an opt-out is forwarded to Vinay. A prospect who texts
 * back "Tuesday works" has said something a person needs to read, and silently
 * dropping it would waste the one warm signal the system can produce.
 *
 * Twilio retries webhooks, so everything here is idempotent: the same message
 * delivered twice leaves one opt-out, one suppression and one forwarded email.
 */

import type { Blackboard } from '../../blackboard/client.js';
import type { SuppressionStore } from '../../compliance/ports.js';
import type { Mailer } from './ports.js';
import { isOptOut } from './sms.js';

export interface InboundSmsDeps {
  db: Blackboard;
  suppressions: SuppressionStore;
  /** Wrap in `operatorOnly` before passing it in. */
  mailer: Mailer;
  operatorEmail: string;
  now: () => Date;
}

export interface InboundSms {
  /** The sender, E.164. Twilio supplies it in that form. */
  from: string;
  body: string;
  /** Twilio's message id. The idempotency key for a redelivered webhook. */
  messageSid: string;
}

export type InboundSmsResult =
  | { kind: 'rejected'; why: string }
  | { kind: 'opted-out'; contacts: number; suppressed: string[]; duplicate: boolean }
  | { kind: 'forwarded'; contacts: number; duplicate: boolean }
  | { kind: 'recorded'; contacts: number; duplicate: boolean; why: string };

const E164 = /^\+\d{8,15}$/;

/** A bounded copy of what they wrote: it is stored and emailed, so it is not unbounded. */
const MAX_BODY = 1000;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/** Write a memory row once. Returns false when this message was already recorded. */
async function recordOnce(
  db: Blackboard,
  row: { id: string; key: string; kind: string; summary: string; content: unknown },
  at: Date
): Promise<boolean> {
  try {
    await db.memory.create({
      data: { id: row.id, scope: 'contact', key: row.key, kind: row.kind, summary: row.summary, content: JSON.stringify(row.content), createdAt: at }
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export async function handleInboundSms(deps: InboundSmsDeps, message: InboundSms): Promise<InboundSmsResult> {
  const { db } = deps;
  const from = message.from.trim();
  if (!E164.test(from)) {
    return { kind: 'rejected', why: 'the sender is not an E.164 number, so there is nobody to attribute it to' };
  }
  if (message.messageSid.trim() === '') {
    return { kind: 'rejected', why: 'no message id, so a redelivery could not be told from a new message' };
  }

  const body = message.body.trim().slice(0, MAX_BODY);
  const at = deps.now();
  const contacts = await db.contact.findMany({ where: { phoneE164: from } });

  if (isOptOut(body)) {
    const suppressed: string[] = [];
    let duplicate = contacts.length > 0;

    for (const contact of contacts) {
      const fresh = await recordOnce(
        db,
        {
          id: `sms-opt-out:${message.messageSid}:${contact.id}`,
          key: contact.id,
          kind: 'sms-opt-out',
          summary: 'replied to a text asking us to stop',
          content: { messageSid: message.messageSid, said: body }
        },
        at
      );
      if (fresh) duplicate = false;

      // A test contact is suppressed as a contact only; see the module comment.
      const scopes: Array<{ scope: 'contact' | 'number'; key: string }> =
        contact.kind === 'test'
          ? [{ scope: 'contact', key: contact.id }]
          : [
              { scope: 'contact', key: contact.id },
              { scope: 'number', key: from }
            ];
      const existing = await deps.suppressions.find({ contactId: contact.id, e164: from, accountId: contact.accountId });
      for (const { scope, key } of scopes) {
        if (existing.some((e) => e.scope === scope && e.key === key)) continue;
        await deps.suppressions.add({
          scope,
          key,
          source: 'prospect-request',
          reason: `replied to a text: "${body}"`,
          createdAt: at,
          permanent: true
        });
        suppressed.push(scope);
      }
    }

    // A STOP from a number we hold no contact for is still honoured: the number
    // has told us to stop, whoever it belongs to.
    if (contacts.length === 0) {
      const existing = await deps.suppressions.find({ contactId: '', e164: from, accountId: '' });
      if (!existing.some((e) => e.scope === 'number' && e.key === from)) {
        await deps.suppressions.add({
          scope: 'number',
          key: from,
          source: 'prospect-request',
          reason: `replied to a text: "${body}"`,
          createdAt: at,
          permanent: true
        });
        suppressed.push('number');
      }
    }

    return { kind: 'opted-out', contacts: contacts.length, suppressed, duplicate: duplicate && suppressed.length === 0 };
  }

  // Not an opt-out: someone has to read it.
  if (contacts.length === 0) {
    return { kind: 'recorded', contacts: 0, duplicate: false, why: 'a text from a number we hold no contact for' };
  }

  const operator = deps.operatorEmail.trim();
  let duplicate = true;
  let forwarded = 0;
  for (const contact of contacts) {
    const id = `sms-reply:${message.messageSid}:${contact.id}`;
    if ((await db.memory.findUnique({ where: { id } })) !== null) continue;
    duplicate = false;

    // Mail first, record second. A failure in between means Twilio redelivers
    // and Vinay may see it twice; the other order would mean he never sees it.
    if (operator !== '') {
      const name = `${contact.firstName} ${contact.lastName}`;
      const account = await db.account.findUnique({ where: { id: contact.accountId } });
      await deps.mailer.send({
        to: operator,
        subject: `[SMS REPLY] ${name}${account !== null ? ` — ${account.name}` : ''}`,
        body: [
          `${name} replied to the confirmation text from ${from}:`,
          '',
          `  "${body}"`,
          '',
          'Nothing has been sent back. Reply to them yourself, from your own phone or mailbox.',
          ''
        ].join('\n'),
        attachments: []
      });
      forwarded += 1;
    }
    await recordOnce(
      db,
      {
        id,
        key: contact.id,
        kind: 'sms-reply',
        summary: 'replied to a text',
        content: { messageSid: message.messageSid, said: body }
      },
      at
    );
  }

  if (operator === '' && !duplicate) {
    return { kind: 'recorded', contacts: contacts.length, duplicate, why: 'no operator email is configured, so the reply was kept but not forwarded' };
  }
  return { kind: 'forwarded', contacts: forwarded, duplicate };
}
