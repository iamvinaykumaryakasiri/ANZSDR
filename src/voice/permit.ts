/**
 * The dial permit: the only thing that lets a provider adapter place a call.
 *
 * Section 0 rule 1 says anything that decides whether a call may legally happen
 * is deterministic code and no model gets a vote. The compliance gate is that
 * code. What this module adds is the other half of the guarantee: that no call
 * can reach a voice provider *around* the gate.
 *
 * The mechanism is small and deliberate.
 *
 *   - `requestDialPermit` asks the gate. If the gate allows the dial, it mints a
 *     permit. If it does not, it throws `DialDenied` carrying every reason.
 *   - A permit is frozen, short-lived, and single-use.
 *   - A permit is recognised by identity: it is registered in a module-private
 *     set when it is minted, and nothing else in the codebase can add to that
 *     set. A hand-built object with the same fields is not a permit.
 *   - A provider adapter's `placeCall` takes the permit and *nothing else that
 *     names a destination*. The number dialled and the caller ID presented are
 *     read off the permit, so the number the gate ruled on is by construction
 *     the number that rings.
 *
 * This does not make bypass impossible for code that is willing to edit this
 * file - nothing in a repository can. It makes bypass a visible change to the
 * one module that has to be reviewed, rather than a missing check in one of many
 * call sites. `tests/voice/no-bypass.test.ts` additionally fails if any file
 * other than the Vapi adapter talks to the provider's call-creation endpoint.
 */

import { randomUUID } from 'node:crypto';
import { ComplianceGate } from '../compliance/service.js';
import type { DialDecision, DialRequest, Market } from '../compliance/types.js';

declare const permitBrand: unique symbol;

export interface DialPermit {
  readonly [permitBrand]: true;
  readonly permitId: string;
  readonly requestId: string;
  readonly contactId: string;
  readonly accountId: string;
  readonly campaignId: string;
  /** The number the gate ruled on, in E.164. The only number an adapter may dial. */
  readonly e164: string;
  readonly market: Market;
  /** The caller line identification to present: real, configured, never withheld. */
  readonly callerId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly policyVersion: string;
}

const issued = new WeakSet<object>();
const spent = new WeakSet<object>();

/** The gate said no. Every reason is carried, because the operator needs all of them. */
export class DialDenied extends Error {
  constructor(readonly decision: DialDecision) {
    super(
      `the compliance gate refused this dial: ${decision.reasons.map((r) => `${r.code} (${r.detail})`).join('; ')}`
    );
    this.name = 'DialDenied';
  }
}

/** A permit that is not real, is out of date, or has already been used. */
export class PermitRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermitRejected';
  }
}

export interface PermitPolicy {
  caller_id: { au_number: string; nz_number: string };
}

export interface PermitOptions {
  /** A permit is for now. Default 60 seconds. */
  ttlMs?: number;
}

function callerIdFor(policy: PermitPolicy, market: Market): string {
  return (market === 'AU' ? policy.caller_id.au_number : policy.caller_id.nz_number).trim();
}

/**
 * Ask the compliance gate for permission to dial, and receive a permit only if
 * it says yes. Every request - allowed or denied - is audited by the gate.
 */
export async function requestDialPermit(
  gate: ComplianceGate,
  policy: PermitPolicy,
  request: DialRequest,
  options: PermitOptions = {}
): Promise<DialPermit> {
  // A look-alike gate that always says yes is the easiest bypass there is. The
  // real one is a class in src/compliance and only that class is accepted.
  if (!(gate instanceof ComplianceGate)) {
    throw new TypeError('a dial permit can only be issued by the compliance gate');
  }

  const decision = await gate.request(request);
  if (!decision.allowed) throw new DialDenied(decision);

  const number = decision.evidence.number;
  if (number === undefined) {
    // An allowed decision always carries the parsed number. If one does not, the
    // decision cannot be tied to a destination and nothing may be dialled on it.
    throw new PermitRejected('the gate allowed the dial but did not say which number it ruled on');
  }

  const callerId = callerIdFor(policy, request.market);
  if (callerId === '') {
    // The gate denies this with CALLER_ID_NOT_CONFIGURED. Checked again here
    // because the policy passed in is not necessarily the one the gate holds.
    throw new PermitRejected(`no ${request.market} caller ID is configured, so there is nothing to present`);
  }

  const issuedAt = decision.evaluatedAt;
  const permit = Object.freeze({
    permitId: randomUUID(),
    requestId: request.requestId,
    contactId: request.contactId,
    accountId: request.accountId,
    campaignId: request.campaignId,
    e164: number.e164,
    market: request.market,
    callerId,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + (options.ttlMs ?? 60_000)),
    policyVersion: decision.evidence.policyVersion
  }) as unknown as DialPermit;

  issued.add(permit);
  return permit;
}

/**
 * Check a permit and use it up. Called by a provider adapter before it makes any
 * network request. A second use of the same permit fails: a retry has to go back
 * to the gate, which counts the attempt and re-checks the clock.
 */
export function redeemPermit(permit: DialPermit, now: Date): void {
  if (typeof permit !== 'object' || permit === null || !issued.has(permit)) {
    throw new PermitRejected('this is not a dial permit issued by the compliance gate');
  }
  if (spent.has(permit)) {
    throw new PermitRejected('this dial permit has already been used; ask the compliance gate again');
  }
  if (now.getTime() >= permit.expiresAt.getTime()) {
    throw new PermitRejected('this dial permit has expired; ask the compliance gate again');
  }
  spent.add(permit);
}
