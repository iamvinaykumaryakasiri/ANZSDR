/**
 * Test mode.
 *
 * While `dialling.test_contacts_only` is true — which is how the system ships —
 * only a contact marked `test` may be dialled. That is a number the operator
 * controls. A real prospect is refused outright, so nobody can be called by
 * accident during build-out, and section 13's "calls only to numbers I control"
 * is a property of the gate rather than a matter of care.
 */

import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { evaluateDialRequest } from '../../src/compliance/gate.js';
import { calendar, cleanSnapshot, policy, request } from '../support/fixtures.js';
import type { DenyCode } from '../../src/compliance/types.js';

const cal = calendar();
const GOOD = DateTime.fromISO('2025-03-12T11:00', { zone: 'Australia/Sydney' }).toJSDate();

const codes = (reasons: { code: DenyCode }[]): DenyCode[] => reasons.map((r) => r.code).sort();

describe('while the system is in test mode', () => {
  const testMode = policy({ testContactsOnly: true });

  it('allows a number the operator controls', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD }),
      cleanSnapshot({ contactKind: 'test' }),
      testMode,
      cal
    );
    expect(d.allowed).toBe(true);
  });

  it('refuses a real prospect, however clean everything else is', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD }),
      cleanSnapshot({ contactKind: 'prospect' }),
      testMode,
      cal
    );
    expect(codes(d.reasons)).toEqual(['NOT_A_TEST_CONTACT']);
    expect(d.reasons[0]?.detail).toContain('only numbers the operator controls');
    // Not permanent: it clears the day the operator takes the system out of test
    // mode, which is a decision rather than a timestamp.
    expect(d.reasons[0]?.permanent).toBe(false);
    expect(d.retryableAt).toBeUndefined();
  });

  it('refuses a contact that is not on the blackboard at all', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD }),
      cleanSnapshot({ contactKind: null }),
      testMode,
      cal
    );
    expect(codes(d.reasons)).toEqual(['CONTACT_NOT_ON_BLACKBOARD']);
    expect(d.reasons[0]?.permanent).toBe(true);
  });
});

describe('once test mode is switched off', () => {
  const live = policy({ testContactsOnly: false });

  it('allows a real prospect', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD }),
      cleanSnapshot({ contactKind: 'prospect' }),
      live,
      cal
    );
    expect(d.allowed).toBe(true);
  });

  it('still refuses a contact with no record, because that is a different problem', () => {
    const d = evaluateDialRequest(request({ at: GOOD }), cleanSnapshot({ contactKind: null }), live, cal);
    expect(codes(d.reasons)).toEqual(['CONTACT_NOT_ON_BLACKBOARD']);
  });
});

describe('the shipped configuration', () => {
  it('has test mode on, so a real prospect cannot be dialled out of the box', async () => {
    const { loadPolicy } = await import('../../src/compliance/policy.js');
    const { resolve } = await import('node:path');
    const { ROOT } = await import('../support/fixtures.js');
    const shipped = loadPolicy(resolve(ROOT, 'config/policy.yaml'));
    expect(shipped.dialling.test_contacts_only).toBe(true);
  });
});
