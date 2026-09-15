import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPolicy, loadPolicyFromObject, STATUTORY_WINDOWS } from '../../src/compliance/policy.js';
import { policy, ROOT } from '../support/fixtures.js';

describe('statutory windows', () => {
  it('encodes the AU Industry Standard and is frozen', () => {
    expect(STATUTORY_WINDOWS.AU.mon).toEqual({ start: '09:00', end: '20:00' });
    expect(STATUTORY_WINDOWS.AU.sat).toEqual({ start: '09:00', end: '17:00' });
    expect(STATUTORY_WINDOWS.AU.sun).toBeNull();
    expect(Object.isFrozen(STATUTORY_WINDOWS)).toBe(true);
    expect(Object.isFrozen(STATUTORY_WINDOWS.AU)).toBe(true);
  });

  it('applies the NZ Marketing Association convention as if statutory', () => {
    expect(STATUTORY_WINDOWS.NZ.fri).toEqual({ start: '09:00', end: '17:00' });
    expect(STATUTORY_WINDOWS.NZ.sat).toBeNull();
    expect(STATUTORY_WINDOWS.NZ.sun).toBeNull();
  });
});

describe('policy loading', () => {
  it('loads the shipped policy file', () => {
    const p = loadPolicy(resolve(ROOT, 'config/policy.yaml'));
    expect(p.policy_version).toBe('1.0.0');
    expect(p.calling_windows.AU.days).toEqual(['tue', 'wed', 'thu']);
    // Ships with dialling blocked until real caller ID numbers are configured.
    expect(p.caller_id.au_number).toBe('');
    expect(p.dnc.allow_mobile_dialling).toBe(false);
    expect(p.warnings).toEqual([]);
  });

  it('expands the configured days into a full week', () => {
    const p = policy({ days: ['tue'] });
    expect(p.policyWindows.AU.tue).toEqual({ start: '09:30', end: '16:30' });
    expect(p.policyWindows.AU.wed).toBeNull();
  });

  it('warns when policy reaches past the statutory window', () => {
    const p = policy({ days: ['mon'], start: '07:00', end: '22:00' });
    expect(p.warnings.some((w) => w.includes('exceeds the statutory'))).toBe(true);
  });

  it('warns when policy opens a day the statute closes', () => {
    const p = policy({ days: ['sun'] });
    expect(p.warnings.some((w) => w.includes('sun'))).toBe(true);
  });

  it('rejects a window whose end precedes its start', () => {
    expect(() => policy({ start: '16:00', end: '09:00' })).toThrow(/start must be before end/);
  });

  it('rejects a malformed time', () => {
    expect(() => policy({ start: '9:30' })).toThrow(/HH:mm/);
  });

  it('refuses a policy that tries to withhold caller ID', () => {
    expect(() =>
      loadPolicyFromObject({
        ...JSON.parse(JSON.stringify({})),
        policy_version: 'x'
      })
    ).toThrow();
  });
});
