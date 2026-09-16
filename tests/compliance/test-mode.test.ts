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
import { resolve } from 'node:path';
import { evaluateDialRequest } from '../../src/compliance/gate.js';
import { loadPolicy } from '../../src/compliance/policy.js';
import { ROOT, calendar, cleanSnapshot, policy, request } from '../support/fixtures.js';
import type { DenyCode } from '../../src/compliance/types.js';

const cal = calendar();
const GOOD = DateTime.fromISO('2025-03-12T11:00', { zone: 'Australia/Sydney' }).toJSDate();
const SHIPPED = loadPolicy(resolve(ROOT, 'config/policy.yaml'));

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

/**
 * Ringing the operator's own mobile.
 *
 * Section 7.2 bans mobiles until Do Not Call washing is arranged, because Apollo
 * hands back personal mobiles and a personal mobile can be registered. Every
 * number the operator controls is also a mobile, so the ban and phase 5's "calls
 * only to numbers I control" cannot both hold without a way through. The way
 * through is narrow, off by default, and cannot reach a prospect.
 */
describe('the operator\'s own mobile', () => {
  const MOBILE = '+61400000000';
  // A mobile carries no geography, so it is gated on the most restrictive window
  // in the market - which in March means Perth, three hours behind Sydney. 13:00
  // Sydney is 10:00 there; 11:00 Sydney would be refused on the clock and tell
  // us nothing about the exemption.
  const OPEN_EVERYWHERE = DateTime.fromISO('2025-03-12T13:00', { zone: 'Australia/Sydney' }).toJSDate();

  it('is refused by default, exactly like any other mobile', () => {
    const d = evaluateDialRequest(
      request({ at: OPEN_EVERYWHERE, phone: MOBILE }),
      cleanSnapshot({ contactKind: 'test' }),
      policy({ testContactsOnly: true }),
      cal
    );
    expect(codes(d.reasons)).toEqual(['MOBILE_DIALLING_DISABLED']);
  });

  it('goes through once the exemption is switched on', () => {
    const d = evaluateDialRequest(
      request({ at: OPEN_EVERYWHERE, phone: MOBILE }),
      cleanSnapshot({ contactKind: 'test' }),
      policy({ testContactsOnly: true, exemptTestContacts: true }),
      cal
    );
    expect(d.allowed).toBe(true);
  });

  it('does not carry a prospect through with it', () => {
    const d = evaluateDialRequest(
      request({ at: OPEN_EVERYWHERE, phone: MOBILE }),
      cleanSnapshot({ contactKind: 'prospect' }),
      policy({ testContactsOnly: true, exemptTestContacts: true }),
      cal
    );
    // Both refusals stand: a stranger's mobile is still a stranger's mobile.
    expect(codes(d.reasons)).toEqual(['MOBILE_DIALLING_DISABLED', 'NOT_A_TEST_CONTACT']);
  });

  it('lapses when test mode is turned off, even with the flag left on', () => {
    const d = evaluateDialRequest(
      request({ at: OPEN_EVERYWHERE, phone: MOBILE }),
      cleanSnapshot({ contactKind: 'test' }),
      policy({ testContactsOnly: false, exemptTestContacts: true }),
      cal
    );
    expect(codes(d.reasons)).toEqual(['MOBILE_DIALLING_DISABLED']);
  });
});

describe('the shipped configuration', () => {
  it('has test mode on, so a real prospect cannot be dialled out of the box', () => {
    expect(SHIPPED.dialling.test_contacts_only).toBe(true);
  });

  it('ships with the mobile exemption off, so switching it on is a deliberate act', () => {
    expect(SHIPPED.dnc.exempt_test_contacts).toBe(false);
    expect(SHIPPED.dnc.allow_mobile_dialling).toBe(false);
  });
});
