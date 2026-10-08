/**
 * Placing a call to a number the operator controls.
 *
 * Phase 5 rings Vinay's own phone and nobody else's (section 13: "calls only to
 * numbers I control"). Three independent things make that true, and this module
 * is the first of them:
 *
 *   1. Here: the contact must be recorded `test` on the blackboard, read fresh
 *      from the database at the moment of dialling. Anything else is refused
 *      before the gate is even asked. There is no option to relax this; a pilot
 *      that rings real prospects (phase 9) is a deliberate change to this file.
 *   2. The compliance gate: `dialling.test_contacts_only` is true as shipped, so
 *      the gate refuses a prospect on its own account, and it also decides
 *      every other thing - calling hours, suppression, caps, the approved plan,
 *      the kill switch, the caller ID.
 *   3. The provider adapter takes a permit the gate issued and no number. See
 *      `permit.ts`.
 *
 * The order inside is the order of increasing commitment: read, check the
 * briefing can be built, ask the gate, create the call record, ask the provider.
 * An attempt is counted against the contact only once the provider has accepted
 * the call (or might have), so a mistyped API key does not use up the one dial a
 * number is allowed each day.
 */

import { randomUUID } from 'node:crypto';
import type { Blackboard } from '../blackboard/client.js';
import { marketForDial } from '../compliance/phone.js';
import type { CompliancePolicy } from '../compliance/policy.js';
import type { ComplianceGate } from '../compliance/service.js';
import type { DenyReason, DialRequest, Jurisdiction, Market } from '../compliance/types.js';
import { buildCallContext, type BriefingSourceDeps } from './briefing-source.js';
import { CallStore } from './call-store.js';
import { DialDenied, PermitRejected, requestDialPermit } from './permit.js';
import { ProviderUncertainError, type ProviderAdapter } from './provider.js';

export type Refusal =
  | 'CONTACT_NOT_FOUND'
  | 'NOT_A_TEST_CONTACT'
  | 'NO_PHONE_NUMBER'
  | 'BRIEFING_UNAVAILABLE'
  | 'GATE_DENIED'
  | 'PERMIT_REJECTED'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_UNCERTAIN';

export type DialResult =
  | { ok: true; callId: string; providerCallId: string; e164: string; callerId: string }
  | {
      ok: false;
      refused: Refusal;
      detail: string;
      /** Every reason the gate gave, when it was the gate. */
      reasons?: DenyReason[];
      /** Set when the call may have been placed anyway. */
      callId?: string;
    };

export interface DialDeps {
  db: Blackboard;
  gate: ComplianceGate;
  policy: CompliancePolicy;
  adapter: ProviderAdapter;
  briefing: BriefingSourceDeps;
  now?: () => Date;
}

export async function placeTestCall(deps: DialDeps, contactId: string): Promise<DialResult> {
  const now = deps.now ?? (() => new Date());
  const { db } = deps;

  // 1. Who is this, according to the blackboard - now, not according to the caller.
  const contact = await db.contact.findUnique({ where: { id: contactId }, include: { account: true } });
  if (contact === null) {
    return { ok: false, refused: 'CONTACT_NOT_FOUND', detail: `there is no contact ${contactId} on the blackboard` };
  }
  if (contact.kind !== 'test') {
    return {
      ok: false,
      refused: 'NOT_A_TEST_CONTACT',
      detail: `${contact.firstName} ${contact.lastName} is recorded as a real prospect. Phase 5 places calls only to contacts marked test, which are numbers you control`
    };
  }
  if (contact.phoneE164 === null || contact.phoneE164.trim() === '') {
    return { ok: false, refused: 'NO_PHONE_NUMBER', detail: `${contact.firstName} ${contact.lastName} has no phone number` };
  }

  // 2. Can the call be briefed? A call whose opening cannot be built would ring a
  // phone and then say nothing useful. Find that out before the phone rings.
  try {
    await buildCallContext(deps.briefing, 'preflight', contact.id);
  } catch (error) {
    return { ok: false, refused: 'BRIEFING_UNAVAILABLE', detail: (error as Error).message };
  }

  // 3. The compliance gate. The number's market, not the employer's, as in the planner.
  const accountMarket: Market = contact.account.country === 'NZ' ? 'NZ' : 'AU';
  const market = marketForDial(contact.phoneE164, accountMarket);
  const request: DialRequest = {
    requestId: `test-${randomUUID()}`,
    contactId: contact.id,
    accountId: contact.accountId,
    campaignId: contact.campaignId,
    phone: contact.phoneE164,
    market,
    emailDomain: contact.account.domain,
    source: 'operator',
    at: now(),
    ...(contact.jurisdiction !== null
      ? {
          localityHint: {
            jurisdiction: contact.jurisdiction as Jurisdiction,
            ...(contact.timezone !== null ? { timezone: contact.timezone } : {})
          }
        }
      : {})
  };

  let permit;
  try {
    permit = await requestDialPermit(deps.gate, deps.policy, request);
  } catch (error) {
    if (error instanceof DialDenied) {
      return { ok: false, refused: 'GATE_DENIED', detail: error.message, reasons: error.decision.reasons };
    }
    if (error instanceof PermitRejected) return { ok: false, refused: 'PERMIT_REJECTED', detail: error.message };
    throw error;
  }

  // 4. The call record, then the provider. From here a failure has to leave the
  // record in a state that does not hold the live-call slot.
  const calls = new CallStore(db, now);
  const call = await calls.create({ contactId: contact.id, accountId: contact.accountId, campaignId: contact.campaignId });

  const recordAttempt = async (): Promise<void> => {
    await db.dialAttempt.create({
      data: {
        id: randomUUID(),
        contactId: contact.id,
        accountId: contact.accountId,
        e164: permit.e164,
        at: now(),
        hadConversation: false,
        callId: call.id
      }
    });
  };

  let placed;
  try {
    placed = await deps.adapter.placeCall(permit, { callId: call.id });
  } catch (error) {
    if (error instanceof ProviderUncertainError) {
      // It may have rung. Count it, and close the record so the live-call slot is
      // released; if the provider did place it, its report will find the call.
      await recordAttempt();
      await calls.markEnded(call.id, { at: now(), endedReason: 'provider-uncertain' });
      return { ok: false, refused: 'PROVIDER_UNCERTAIN', detail: error.message, callId: call.id };
    }
    // Nothing was placed: no attempt, and the call record is closed.
    await calls.markEnded(call.id, { at: now(), endedReason: 'provider-rejected' });
    if (error instanceof PermitRejected) return { ok: false, refused: 'PERMIT_REJECTED', detail: error.message, callId: call.id };
    return { ok: false, refused: 'PROVIDER_REJECTED', detail: (error as Error).message, callId: call.id };
  }

  // The provider has the call. Count it first: whatever goes wrong with the
  // bookkeeping after this, the number has been rung.
  await recordAttempt();
  await calls.setProvider(call.id, placed.providerCallId, placed.controlUrl);
  await calls.append(call.id, { kind: 'status', data: { state: 'dialling', providerStatus: placed.providerStatus } });
  return { ok: true, callId: call.id, providerCallId: placed.providerCallId, e164: permit.e164, callerId: permit.callerId };
}
