import { describe, expect, it } from 'vitest';
import { applicableSuppressions, suppress } from '../../src/compliance/suppression.js';
import { evaluateDnc } from '../../src/compliance/dnc.js';
import { evaluateAttempts } from '../../src/compliance/attempts.js';
import { policy } from '../support/fixtures.js';
import type { AttemptRecord, DncWashRecord, ParsedNumber } from '../../src/compliance/types.js';

const DAY = 86_400_000;
const NOW = new Date('2026-03-11T00:00:00Z');

const subject = {
  contactId: 'contact-1',
  e164: '+61280001234',
  accountId: 'account-1',
  emailDomain: 'westpac.com.au'
};

describe('suppression', () => {
  it('matches on every scope it supports', () => {
    const entries = [
      suppress('contact', 'contact-1', 'not-interested', 'asked us not to call', NOW),
      suppress('number', '+61280001234', 'complaint', 'complained', NOW),
      suppress('account', 'account-1', 'existing-relationship', 'already a client', NOW),
      suppress('domain', 'westpac.com.au', 'operator', 'whole company off limits', NOW)
    ];
    expect(applicableSuppressions(entries, subject)).toHaveLength(4);
  });

  it('ignores entries that belong to someone else', () => {
    const entries = [
      suppress('contact', 'contact-2', 'not-interested', 'x', NOW),
      suppress('number', '+61399990000', 'complaint', 'x', NOW)
    ];
    expect(applicableSuppressions(entries, subject)).toEqual([]);
  });

  it('matches domains case-insensitively', () => {
    const entries = [suppress('domain', 'WESTPAC.COM.AU', 'operator', 'x', NOW)];
    expect(applicableSuppressions(entries, subject)).toHaveLength(1);
  });

  it('cannot match a domain scope when the contact has no email domain', () => {
    const entries = [suppress('domain', 'westpac.com.au', 'operator', 'x', NOW)];
    const { emailDomain: _omitted, ...withoutDomain } = subject;
    expect(applicableSuppressions(entries, withoutDomain)).toEqual([]);
  });

  it('is permanent by construction', () => {
    expect(suppress('contact', 'c', 'prospect-request', 'r', NOW).permanent).toBe(true);
  });
});

describe('DNC washing', () => {
  const p = policy();
  const mobile: ParsedNumber = { e164: '+61412345678', market: 'AU', lineType: 'mobile', nsn: '412345678', areaCode: '4' };
  const fixed: ParsedNumber = { e164: '+61280001234', market: 'AU', lineType: 'fixed', nsn: '280001234', areaCode: '2' };
  const wash = (over: Partial<DncWashRecord> = {}): DncWashRecord => ({
    e164: mobile.e164,
    result: 'clear',
    washedAt: new Date(NOW.getTime() - DAY),
    register: 'ACMA Do Not Call Register',
    ...over
  });

  it('refuses mobiles outright until washing is arranged', () => {
    expect(evaluateDnc(mobile, wash(), p, NOW)).toEqual({ kind: 'mobile-dialling-disabled' });
  });

  it('does not require a wash for an office direct dial', () => {
    expect(evaluateDnc(fixed, null, p, NOW)).toEqual({ kind: 'not-required' });
  });

  it('requires a wash once mobile dialling is switched on', () => {
    const open = policy({ allowMobileDialling: true });
    expect(evaluateDnc(mobile, null, open, NOW)).toEqual({ kind: 'missing' });
  });

  it('accepts a fresh clear wash', () => {
    const open = policy({ allowMobileDialling: true });
    const outcome = evaluateDnc(mobile, wash(), open, NOW);
    expect(outcome.kind).toBe('ok');
  });

  it('rejects a wash older than its validity period', () => {
    const open = policy({ allowMobileDialling: true });
    const outcome = evaluateDnc(mobile, wash({ washedAt: new Date(NOW.getTime() - 31 * DAY) }), open, NOW);
    expect(outcome.kind).toBe('stale');
  });

  it('treats the expiry instant itself as expired', () => {
    const open = policy({ allowMobileDialling: true });
    const outcome = evaluateDnc(mobile, wash({ washedAt: new Date(NOW.getTime() - 30 * DAY) }), open, NOW);
    expect(outcome.kind).toBe('stale');
  });

  it('refuses a registered number permanently', () => {
    const open = policy({ allowMobileDialling: true });
    expect(evaluateDnc(mobile, wash({ result: 'registered' }), open, NOW).kind).toBe('registered');
  });

  it('applies wash rules to fixed lines when policy says to', () => {
    const p2 = policy();
    p2.dnc.wash_required_for = ['mobile', 'fixed'];
    expect(evaluateDnc(fixed, null, p2, NOW).kind).toBe('missing');
  });
});

describe('attempt caps', () => {
  const p = policy();
  const attempt = (daysAgo: number, over: Partial<AttemptRecord> = {}): AttemptRecord => ({
    contactId: 'contact-1',
    accountId: 'account-1',
    e164: '+61280001234',
    at: new Date(NOW.getTime() - daysAgo * DAY),
    hadConversation: false,
    ...over
  });

  it('allows a first attempt', () => {
    const e = evaluateAttempts('contact-1', [], [], false, p, NOW);
    expect(e).toMatchObject({ used: 0, remaining: 3, capReached: false, minIntervalMet: true, accountWeeklyCapMet: true });
    expect(e.windowClosesAt).toBeUndefined();
  });

  it('stops permanently at three attempts', () => {
    const e = evaluateAttempts('contact-1', [attempt(20), attempt(14), attempt(8)], [], false, p, NOW);
    expect(e.capReached).toBe(true);
    expect(e.remaining).toBe(0);
  });

  it('stops permanently once the 21-day window has elapsed', () => {
    const e = evaluateAttempts('contact-1', [attempt(22)], [], false, p, NOW);
    expect(e.windowClosed).toBe(true);
    expect(e.capReached).toBe(false);
  });

  it('keeps the window open on its final day', () => {
    const e = evaluateAttempts('contact-1', [attempt(20)], [], false, p, NOW);
    expect(e.windowClosed).toBe(false);
  });

  it('enforces five clear days between attempts', () => {
    const tooSoon = evaluateAttempts('contact-1', [attempt(4)], [], false, p, NOW);
    expect(tooSoon.minIntervalMet).toBe(false);
    expect(tooSoon.nextAttemptAllowedAt?.toISOString()).toBe(new Date(NOW.getTime() + DAY).toISOString());
    expect(evaluateAttempts('contact-1', [attempt(5)], [], false, p, NOW).minIntervalMet).toBe(true);
  });

  it('allows one contact per account per week and no more', () => {
    const others = [attempt(2, { contactId: 'contact-9' })];
    const e = evaluateAttempts('contact-1', [], others, false, p, NOW);
    expect(e.accountWeeklyCapMet).toBe(false);
    expect(e.accountNextAllowedAt?.toISOString()).toBe(new Date(NOW.getTime() + 5 * DAY).toISOString());
  });

  it('does not charge the same contact twice against the account cap', () => {
    const own = [attempt(6)];
    expect(evaluateAttempts('contact-1', own, own, false, p, NOW).accountWeeklyCapMet).toBe(true);
  });

  it('lifts the account cap once somebody there has actually spoken to us', () => {
    const others = [attempt(2, { contactId: 'contact-9', hadConversation: true })];
    expect(evaluateAttempts('contact-1', [], others, true, p, NOW).accountWeeklyCapMet).toBe(true);
  });
});
