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
 */

import type { CompliancePolicy } from './policy.js';
import type { DncWashRecord, ParsedNumber } from './types.js';

export type DncOutcome =
  | { kind: 'not-required' }
  | { kind: 'ok'; washedAt: Date; expiresAt: Date }
  | { kind: 'mobile-dialling-disabled' }
  | { kind: 'missing' }
  | { kind: 'stale'; washedAt: Date; expiresAt: Date }
  | { kind: 'registered'; washedAt: Date };

export function evaluateDnc(
  number: ParsedNumber,
  wash: DncWashRecord | null,
  policy: CompliancePolicy,
  at: Date
): DncOutcome {
  if (number.lineType === 'mobile' && !policy.dnc.allow_mobile_dialling) {
    return { kind: 'mobile-dialling-disabled' };
  }
  if (!policy.dnc.wash_required_for.includes(number.lineType)) {
    return { kind: 'not-required' };
  }
  if (wash === null) {
    return { kind: 'missing' };
  }
  if (wash.result === 'registered') {
    return { kind: 'registered', washedAt: wash.washedAt };
  }
  const expiresAt = new Date(wash.washedAt.getTime() + policy.dnc.wash_validity_days * 86_400_000);
  if (at.getTime() >= expiresAt.getTime()) {
    return { kind: 'stale', washedAt: wash.washedAt, expiresAt };
  }
  return { kind: 'ok', washedAt: wash.washedAt, expiresAt };
}
