/**
 * Applying Vinay's reply.
 *
 * The parser reads a word; this changes the world because of it. That is the
 * step with consequences - a REJECT suppresses a person for good - so it is
 * written as a chain of refusals with one narrow path through them:
 *
 *   no decision found         -> nothing happens
 *   no reference found        -> nothing happens (see ref.ts: never guess)
 *   reference matches nothing -> nothing happens
 *   reference is ambiguous    -> nothing happens
 *   request already closed    -> nothing happens
 *
 * Only a clear word, tied to exactly one open request, gets as far as acting.
 */

import type { Blackboard } from '../../blackboard/client.js';
import type { MeetingRequestRepository, Decision } from '../../blackboard/meetings.js';
import type { SuppressionStore } from '../../compliance/ports.js';
import { narrowForTestContact, type SuppressionTarget } from './followup.js';
import { findRef } from './ref.js';
import { parseReply } from './reply.js';

export interface ApplyDeps {
  db: Blackboard;
  meetings: MeetingRequestRepository;
  suppressions: SuppressionStore;
  now: () => Date;
}

export type ApplyResult =
  | { kind: 'applied'; requestId: string; decision: Decision; effects: string[] }
  | { kind: 'unclear'; considered: string }
  | { kind: 'no-reference' }
  | { kind: 'unknown-reference'; ref: string }
  | { kind: 'ambiguous-reference'; ref: string; count: number }
  | { kind: 'not-applied'; requestId: string; reason: string; noop: boolean };

const DECISION: Record<'confirmed' | 'reschedule' | 'rejected', Decision> = {
  confirmed: 'confirmed',
  reschedule: 'reschedule',
  rejected: 'rejected'
};

/** Add a suppression for each target, skipping any that is already on the list. */
async function suppress(
  deps: ApplyDeps,
  contact: { id: string; kind: string; phoneE164: string | null; accountId: string },
  reason: string
): Promise<string[]> {
  const wanted: SuppressionTarget[] = ['contact', 'number'];
  const targets = narrowForTestContact(contact.kind === 'test' ? 'test' : 'prospect', wanted);
  const done: string[] = [];

  for (const target of targets) {
    const key = target === 'contact' ? contact.id : target === 'number' ? contact.phoneE164 : contact.accountId;
    if (key === null) continue;

    const existing = await deps.suppressions.find({
      contactId: contact.id,
      e164: contact.phoneE164 ?? '',
      accountId: contact.accountId
    });
    if (existing.some((e) => e.scope === target && e.key === key)) continue;

    await deps.suppressions.add({
      scope: target,
      key,
      source: 'operator',
      reason,
      createdAt: deps.now(),
      permanent: true
    });
    done.push(`suppressed ${target} permanently`);
  }
  return done;
}

export async function applyOperatorReply(deps: ApplyDeps, body: string): Promise<ApplyResult> {
  const parsed = parseReply(body);
  if (parsed.decision === 'unclear') return { kind: 'unclear', considered: parsed.consideredText };

  // The reference is searched for in the whole message, the decision only in
  // what he typed. See ref.ts for why those differ.
  const ref = findRef(body);
  if (ref === null) return { kind: 'no-reference' };

  const found = await deps.meetings.findByRef(ref);
  if (found.kind === 'none') return { kind: 'unknown-reference', ref };
  if (found.kind === 'ambiguous') return { kind: 'ambiguous-reference', ref, count: found.count };

  const request = found.record;
  const decision = DECISION[parsed.decision];
  const effects: string[] = [];

  // Checked before anything is done, so a closed request is never suppressed
  // on the strength of a reply that cannot change it anyway.
  if (request.status === decision) {
    return { kind: 'not-applied', requestId: request.id, reason: `already ${decision}`, noop: true };
  }
  if (request.status === 'confirmed' || request.status === 'rejected') {
    return {
      kind: 'not-applied',
      requestId: request.id,
      reason: `it is already ${request.status}, and a reply cannot change that`,
      noop: false
    };
  }

  const contact = await deps.db.contact.findUniqueOrThrow({ where: { id: request.contactId } });

  if (decision === 'rejected') {
    // Suppression first, then the status. If the process dies between them the
    // failure is "suppressed but still open", which is harmless and finishes on
    // the next attempt. The other order fails as "marked rejected but still
    // callable", which is the one outcome this must never produce.
    effects.push(...(await suppress(deps, contact, `operator rejected meeting request for call ${request.callId}`)));
  }

  const result = await deps.meetings.decide(request.id, decision, parsed.note, 'email-reply', deps.now());
  if (!result.applied) {
    return { kind: 'not-applied', requestId: request.id, reason: result.reason, noop: result.noop };
  }
  effects.push(`meeting request ${result.from} -> ${result.to}`);

  switch (decision) {
    case 'confirmed':
      // A meeting is arranged; nobody should cold-call them again meanwhile.
      await deps.db.contact.update({ where: { id: contact.id }, data: { status: 'done', updatedAt: deps.now() } });
      effects.push('contact closed: no further calls');
      break;
    case 'rejected':
      await deps.db.contact.update({ where: { id: contact.id }, data: { status: 'done', updatedAt: deps.now() } });
      effects.push('contact closed: no further calls');
      break;
    case 'reschedule':
      // Kept open and kept out of the call plan. The system never writes to a
      // prospect itself, so the new time is Vinay's to arrange from Outlook.
      effects.push('kept open; the 24-hour nudge stops, and the new time is yours to arrange');
      break;
  }

  return { kind: 'applied', requestId: request.id, decision, effects };
}
