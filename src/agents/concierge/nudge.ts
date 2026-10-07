/**
 * The nudge.
 *
 * Section 12.1: "If there is no reply in 24 hours, one nudge." One, not a
 * cadence: a request Vinay has ignored twice is a request he has decided about,
 * and a third email is the system nagging its own operator.
 *
 * The nudge carries the same reference as the original, so replying CONFIRMED,
 * RESCHEDULE or REJECT to it works exactly as it does to the first email.
 *
 * It is marked as sent only after it has gone. A failed send leaves the request
 * due, so the next tick tries again; the cost of the other order is a request
 * that is never nudged and a prospect who waits for an answer nobody knows to give.
 */

import type { Blackboard } from '../../blackboard/client.js';
import type { MeetingRequestRecord, MeetingRequestRepository } from '../../blackboard/meetings.js';
import { renderWindow, type PreferredWindow } from './meeting-email.js';
import type { Mailer, OutboundMail } from './ports.js';
import { refFor } from './ref.js';

export interface NudgeDeps {
  db: Blackboard;
  meetings: MeetingRequestRepository;
  /** Wrap in `operatorOnly` before passing it in. */
  mailer: Mailer;
  operatorEmail: string;
  now: () => Date;
}

export interface NudgeResult {
  requestId: string;
  status: 'sent' | 'failed' | 'skipped';
  detail: string;
}

function parseWindows(raw: string): PreferredWindow[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PreferredWindow[]) : [];
  } catch {
    return [];
  }
}

function hoursSince(then: Date, now: Date): number {
  return Math.floor((now.getTime() - then.getTime()) / 3_600_000);
}

export async function buildNudge(
  deps: NudgeDeps,
  request: MeetingRequestRecord
): Promise<OutboundMail> {
  const contact = await deps.db.contact.findUniqueOrThrow({
    where: { id: request.contactId },
    include: { account: true }
  });
  const record = await deps.db.callRecord.findUnique({ where: { callId: request.callId } });
  const windows = record === null ? [] : parseWindows(record.windows);
  const zone = record?.timezone ?? 'Pacific/Auckland';
  const name = `${contact.firstName} ${contact.lastName}`;
  const waiting = request.emailSentAt === null ? 24 : hoursSince(request.emailSentAt, deps.now());

  const lines: string[] = [];
  lines.push(`${name} (${contact.title}, ${contact.account.name}) asked for a call with you ${waiting} hours ago, and I have not had an answer from you.`);
  lines.push('');
  const first = windows[0];
  if (first !== undefined) {
    lines.push('THEY SAID THEY ARE FREE');
    lines.push(`  ${renderWindow(first, zone)}`);
    lines.push('');
  }
  lines.push('The original email, with the draft reply to them, is further down your inbox. Reply to this one instead if that is easier:');
  lines.push('');
  lines.push('  CONFIRMED   — I will mark it arranged and stop calling them');
  lines.push('  RESCHEDULE  — I will keep it open and stop the reminders; you arrange the new time');
  lines.push('  REJECT      — I will drop it and suppress them permanently');
  lines.push('');
  lines.push(`  Leave this line in your reply so I know which request it is:  ${refFor(request.id)}`);
  lines.push('');
  lines.push('This is the only reminder I will send for this request.');
  lines.push('');

  return {
    to: deps.operatorEmail,
    subject: `[REMINDER] [MEETING REQUEST] ${name} — ${contact.account.name} — no reply yet`,
    body: lines.join('\n'),
    attachments: []
  };
}

export async function runNudges(deps: NudgeDeps): Promise<NudgeResult[]> {
  const due = await deps.meetings.dueForNudge(deps.now());
  if (due.length === 0) return [];

  if (deps.operatorEmail.trim() === '') {
    return due.map((request) => ({
      requestId: request.id,
      status: 'skipped',
      detail: 'no operator email is configured, so there is nowhere to send a reminder'
    }));
  }

  const results: NudgeResult[] = [];
  for (const request of due) {
    try {
      const mail = await buildNudge(deps, request);
      await deps.mailer.send(mail);
      await deps.meetings.markNudged(request.id, deps.now());
      results.push({ requestId: request.id, status: 'sent', detail: `reminded ${deps.operatorEmail}` });
    } catch (error) {
      // One failure does not stop the others, and does not mark this one.
      results.push({ requestId: request.id, status: 'failed', detail: (error as Error).message });
    }
  }
  return results;
}
