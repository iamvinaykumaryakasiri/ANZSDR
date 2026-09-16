/**
 * Do Not Call washing.
 *
 * Australia's DNCR covers numbers used primarily for domestic purposes, and a
 * genuine B2B call to someone in their professional capacity generally sits
 * outside the prohibition. That carve-out is not a licence to dial an unwashed
 * list: Apollo returns personal mobiles, and a personal mobile can be registered.
 *
 * So: until washing is arranged, mobiles are not dialled at all. Once it is
 * arranged, every number in scope needs a wash result that is both clear and
 * inside its validity period.
 *
 * The one exception is a number the operator owns and is testing against, which
 * is not a stranger's number and is not what the register protects. That
 * exemption ships off and is fenced in three ways - see below.
 */

import type { CompliancePolicy } from './policy.js';
import type { ContactKind, DncWashRecord, ParsedNumber } from './types.js';

export type DncOutcome =
  | { kind: 'not-required' }
  | { kind: 'ok'; washedAt: Date; expiresAt: Date }
  | { kind: 'operator-test-number' }
  | { kind: 'mobile-dialling-disabled' }
  | { kind: 'missing' }
  | { kind: 'stale'; washedAt: Date; expiresAt: Date }
  | { kind: 'registered'; washedAt: Date };

export function evaluateDnc(
  number: ParsedNumber,
  wash: DncWashRecord | null,
  policy: CompliancePolicy,
  at: Date,
  contactKind: ContactKind | null
): DncOutcome {
  // A positive result is honoured before anything else, whatever the line type
  // and whatever `wash_required_for` says. Leaving office direct dials out of
  // the wash is a judgement about which numbers are *likely* to be registered;
  // it was never a reason to ring one we hold evidence demonstrably is.
  if (wash !== null && wash.result === 'registered') {
    return { kind: 'registered', washedAt: wash.washedAt };
  }

  // The operator's own handset. Washing a number you own against a register of
  // people who do not want to be rung by strangers is meaningless, and every
  // number the operator controls is a mobile, so without this the voice path
  // could never be tested at all. It removes the obligation to go and wash such
  // a number; the check above means it can never bury a result already in hand.
  //
  // Three things have to hold at once, and none of them comes from the caller:
  // the flag is on, the whole system is still in test mode, and the blackboard
  // itself records this contact as `test`. A dial request cannot assert its way
  // in here - `contactKind` is read from the record, never from the request.
  const operatorTestNumber =
    contactKind === 'test' &&
    policy.dnc.exempt_test_contacts &&
    policy.dialling.test_contacts_only;
  if (operatorTestNumber) {
    return { kind: 'operator-test-number' };
  }

  if (number.lineType === 'mobile' && !policy.dnc.allow_mobile_dialling) {
    return { kind: 'mobile-dialling-disabled' };
  }
  if (!policy.dnc.wash_required_for.includes(number.lineType)) {
    return { kind: 'not-required' };
  }
  if (wash === null) {
    return { kind: 'missing' };
  }
  const expiresAt = new Date(wash.washedAt.getTime() + policy.dnc.wash_validity_days * 86_400_000);
  if (at.getTime() >= expiresAt.getTime()) {
    return { kind: 'stale', washedAt: wash.washedAt, expiresAt };
  }
  return { kind: 'ok', washedAt: wash.washedAt, expiresAt };
}
