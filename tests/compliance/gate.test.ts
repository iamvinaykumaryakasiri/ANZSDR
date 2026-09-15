import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { evaluateDialRequest } from '../../src/compliance/gate.js';
import { suppress } from '../../src/compliance/suppression.js';
import { calendar, cleanSnapshot, policy, request } from '../support/fixtures.js';
import type { AttemptRecord, DenyCode } from '../../src/compliance/types.js';

const cal = calendar();
const DAY = 86_400_000;
/** Wednesday 12 March 2025, 11:00 Sydney: inside every window, on a signed-off year. */
const GOOD = DateTime.fromISO('2025-03-12T11:00', { zone: 'Australia/Sydney' }).toJSDate();

function codes(reasons: { code: DenyCode }[]): DenyCode[] {
  return reasons.map((r) => r.code).sort();
}

const attempt = (daysAgo: number, over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  contactId: 'contact-1',
  accountId: 'account-1',
  e164: '+61280001234',
  at: new Date(GOOD.getTime() - daysAgo * DAY),
  hadConversation: false,
  ...over
});

describe('the gate says yes', () => {
  it('allows a clean office direct dial inside the window', () => {
    const d = evaluateDialRequest(request({ at: GOOD }), cleanSnapshot(), policy(), cal);
    expect(d.allowed).toBe(true);
    expect(d.reasons).toEqual([]);
    expect(d.evidence.number?.e164).toBe('+61280001234');
    expect(d.evidence.attemptsRemaining).toBe(3);
    expect(d.retryableAt).toBeUndefined();
  });

  it('records the recipient local time in every candidate locality', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD, phone: '+61880001234' }),
      cleanSnapshot(),
      policy({ start: '09:00', end: '17:00' }),
      cal
    );
    expect(d.evidence.localTimes.map((l) => l.jurisdiction).sort()).toEqual(['au-nt', 'au-sa', 'au-wa']);
  });
});

describe('the gate says no', () => {
  it('stops everything while the kill switch is tripped', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD }),
      cleanSnapshot({ killSwitch: { active: true, reason: 'three escalations today' } }),
      policy(),
      cal
    );
    expect(codes(d.reasons)).toEqual(['KILL_SWITCH_ACTIVE']);
    expect(d.reasons[0]?.detail).toContain('three escalations today');
  });

  it('still denies when the kill switch was tripped without a reason', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD }),
      cleanSnapshot({ killSwitch: { active: true } }),
      policy(),
      cal
    );
    expect(d.reasons[0]?.detail).toContain('no reason recorded');
  });

  it('refuses an unparseable number permanently and stops evaluating', () => {
    const d = evaluateDialRequest(request({ at: GOOD, phone: 'not a number' }), cleanSnapshot(), policy(), cal);
    expect(codes(d.reasons)).toEqual(['INVALID_NUMBER']);
    expect(d.reasons[0]?.permanent).toBe(true);
    expect(d.evidence.number).toBeUndefined();
  });

  it('refuses a number that belongs to the other market', () => {
    const d = evaluateDialRequest(request({ at: GOOD, phone: '+6494567890' }), cleanSnapshot(), policy(), cal);
    expect(codes(d.reasons)).toEqual(['MARKET_MISMATCH']);
    expect(d.evidence.number?.market).toBe('NZ');
  });

  it('refuses to dial without a contactable caller ID number', () => {
    const d = evaluateDialRequest(request({ at: GOOD }), cleanSnapshot(), policy({ callerIdAu: '  ' }), cal);
    expect(codes(d.reasons)).toContain('CALLER_ID_NOT_CONFIGURED');
    expect(d.reasons[0]?.detail).toContain('30 days');
  });

  it('refuses a suppressed contact permanently', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD }),
      cleanSnapshot({ suppressions: [suppress('contact', 'contact-1', 'complaint', 'told us to stop', GOOD)] }),
      policy(),
      cal
    );
    expect(codes(d.reasons)).toEqual(['SUPPRESSED']);
    expect(d.reasons[0]?.permanent).toBe(true);
    expect(d.retryableAt).toBeUndefined();
  });

  it('refuses a suppressed domain even when the contact is new', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD, emailDomain: 'westpac.com.au' }),
      cleanSnapshot({ suppressions: [suppress('domain', 'westpac.com.au', 'operator', 'off limits', GOOD)] }),
      policy(),
      cal
    );
    expect(codes(d.reasons)).toEqual(['SUPPRESSED']);
  });

  it('refuses a mobile while mobile dialling is off', () => {
    const d = evaluateDialRequest(request({ at: GOOD, phone: '+61412345678' }), cleanSnapshot(), policy(), cal);
    expect(codes(d.reasons)).toContain('MOBILE_DIALLING_DISABLED');
  });

  it('refuses an unwashed mobile once mobile dialling is on', () => {
    const open = policy({ allowMobileDialling: true, start: '09:00', end: '17:00' });
    const d = evaluateDialRequest(request({ at: GOOD, phone: '+61412345678' }), cleanSnapshot(), open, cal);
    expect(codes(d.reasons)).toContain('DNC_WASH_MISSING');
  });

  it('refuses a stale wash and a registered number', () => {
    const open = policy({ allowMobileDialling: true, start: '09:00', end: '17:00' });
    const stale = evaluateDialRequest(
      request({ at: GOOD, phone: '+61412345678' }),
      cleanSnapshot({
        dncWash: { e164: '+61412345678', result: 'clear', washedAt: new Date(GOOD.getTime() - 40 * DAY), register: 'r' }
      }),
      open,
      cal
    );
    expect(codes(stale.reasons)).toContain('DNC_WASH_STALE');

    const registered = evaluateDialRequest(
      request({ at: GOOD, phone: '+61412345678' }),
      cleanSnapshot({
        dncWash: { e164: '+61412345678', result: 'registered', washedAt: new Date(GOOD.getTime() - DAY), register: 'r' }
      }),
      open,
      cal
    );
    expect(codes(registered.reasons)).toContain('DNC_REGISTERED');
    expect(registered.reasons.find((r) => r.code === 'DNC_REGISTERED')?.permanent).toBe(true);
  });

  it('stops after three attempts and after the 21-day window', () => {
    const capped = evaluateDialRequest(
      request({ at: GOOD }),
      cleanSnapshot({ contactAttempts: [attempt(25), attempt(20), attempt(14)] }),
      policy(),
      cal
    );
    expect(codes(capped.reasons)).toEqual(['ATTEMPT_CAP_REACHED', 'ATTEMPT_WINDOW_CLOSED']);
    expect(capped.retryableAt).toBeUndefined();
  });

  it('holds off until five days have passed, and says when', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD }),
      cleanSnapshot({ contactAttempts: [attempt(2)] }),
      policy(),
      cal
    );
    expect(codes(d.reasons)).toEqual(['MIN_INTERVAL_NOT_ELAPSED']);
    expect(d.retryableAt?.toISOString()).toBe(new Date(GOOD.getTime() + 3 * DAY).toISOString());
  });

  it('holds off on a second person at the same account in one week', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD }),
      cleanSnapshot({ accountAttemptsThisWeek: [attempt(1, { contactId: 'contact-9' })] }),
      policy(),
      cal
    );
    expect(codes(d.reasons)).toEqual(['ACCOUNT_WEEKLY_CAP']);
  });

  it('enforces the daily cap, the per-number-per-day rule and the concurrency limit', () => {
    const d = evaluateDialRequest(
      request({ at: GOOD }),
      cleanSnapshot({ dialsToday: 60, numberDialsToday: 1, liveCalls: 1 }),
      policy(),
      cal
    );
    expect(codes(d.reasons)).toEqual(['CONCURRENCY_LIMIT', 'DAILY_DIAL_CAP', 'NUMBER_ALREADY_DIALLED_TODAY']);
    // A live call has no knowable clearing time, so the request has none either.
    expect(d.retryableAt).toBeUndefined();
  });

  it('points the daily cap at the next operational day', () => {
    const d = evaluateDialRequest(request({ at: GOOD }), cleanSnapshot({ dialsToday: 60 }), policy(), cal);
    const retry = DateTime.fromJSDate(d.retryableAt as Date, { zone: 'Australia/Sydney' });
    expect(retry.toFormat('yyyy-MM-dd HH:mm')).toBe('2025-03-13 00:00');
  });

  it('refuses a call outside the policy window and offers the next opening', () => {
    // A Brisbane direct dial: Queensland is the one mainland jurisdiction with no
    // public holiday on the second Monday in March.
    const monday = DateTime.fromISO('2025-03-10T11:00', { zone: 'Australia/Brisbane' }).toJSDate();
    const d = evaluateDialRequest(request({ at: monday, phone: '+61730001234' }), cleanSnapshot(), policy(), cal);
    expect(codes(d.reasons)).toEqual(['OUTSIDE_POLICY_WINDOW']);
    expect(DateTime.fromJSDate(d.retryableAt as Date, { zone: 'Australia/Brisbane' }).toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2025-03-11 09:30'
    );
  });

  it('blocks a Sydney number on a Canberra Day it cannot rule out', () => {
    // 02 covers both NSW and the ACT, and the ACT observes Canberra Day on the
    // second Monday in March. Without an enrichment hint the gate has to assume
    // the recipient might be in Canberra.
    const canberraDay = DateTime.fromISO('2025-03-10T11:00', { zone: 'Australia/Sydney' }).toJSDate();
    const weekdays = policy({ days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
    const unhinted = evaluateDialRequest(request({ at: canberraDay }), cleanSnapshot(), weekdays, cal);
    expect(codes(unhinted.reasons)).toEqual(['PUBLIC_HOLIDAY']);
    expect(unhinted.reasons[0]?.detail).toContain('Canberra Day');

    // With enrichment saying New South Wales, the same call goes through.
    const hinted = evaluateDialRequest(
      request({ at: canberraDay, localityHint: { jurisdiction: 'au-nsw' } }),
      cleanSnapshot(),
      weekdays,
      cal
    );
    expect(hinted.allowed).toBe(true);
  });

  it('refuses a call outside the statutory window', () => {
    const sunday = DateTime.fromISO('2025-03-09T11:00', { zone: 'Australia/Sydney' }).toJSDate();
    const wide = policy({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '09:00', end: '17:00' });
    const d = evaluateDialRequest(request({ at: sunday }), cleanSnapshot(), wide, cal);
    expect(codes(d.reasons)).toEqual(['OUTSIDE_STATUTORY_WINDOW']);
  });

  it('refuses a public holiday and names it', () => {
    const anzac = DateTime.fromISO('2025-04-25T11:00', { zone: 'Australia/Sydney' }).toJSDate();
    const wide = policy({ days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
    const d = evaluateDialRequest(request({ at: anzac }), cleanSnapshot(), wide, cal);
    expect(codes(d.reasons)).toEqual(['PUBLIC_HOLIDAY']);
    expect(d.reasons[0]?.detail).toContain('Anzac');
  });

  it('groups a mobile spread across states into one reason per cause', () => {
    // Christmas Day 2025 is a Thursday: a holiday everywhere, so all eight
    // candidate states report the same cause and it is reported once.
    const xmas = DateTime.fromISO('2025-12-25T11:00', { zone: 'Australia/Sydney' }).toJSDate();
    const open = policy({ allowMobileDialling: true, start: '09:00', end: '17:00' });
    const d = evaluateDialRequest(
      request({ at: xmas, phone: '+61412345678' }),
      cleanSnapshot({
        dncWash: { e164: '+61412345678', result: 'clear', washedAt: new Date(xmas.getTime() - DAY), register: 'r' }
      }),
      open,
      cal
    );
    expect(codes(d.reasons)).toEqual(['PUBLIC_HOLIDAY']);
    expect(d.reasons[0]?.detail.split(';')).toHaveLength(8);
  });

  it('refuses a date the calendar does not cover, with no invented retry time', () => {
    const far = DateTime.fromISO('2031-03-12T11:00', { zone: 'Australia/Sydney' }).toJSDate();
    const d = evaluateDialRequest(request({ at: far }), cleanSnapshot(), policy(), cal);
    expect(codes(d.reasons)).toEqual(['HOLIDAY_CALENDAR_COVERAGE_GAP']);
    expect(d.reasons[0]?.retryableAt).toBeUndefined();
    expect(d.retryableAt).toBeUndefined();
  });

  it('refuses a year nobody has signed off', () => {
    const d = evaluateDialRequest(
      request({ at: DateTime.fromISO('2026-03-11T11:00', { zone: 'Australia/Sydney' }).toJSDate() }),
      cleanSnapshot(),
      policy({ requireVerifiedCalendar: true }),
      cal
    );
    expect(codes(d.reasons)).toEqual(['HOLIDAY_CALENDAR_UNVERIFIED']);
    expect(d.reasons[0]?.detail).toContain('2026');
  });

  it('reports every independent reason at once rather than the first one it hits', () => {
    const monday = DateTime.fromISO('2025-03-10T22:00', { zone: 'Australia/Sydney' }).toJSDate();
    const d = evaluateDialRequest(
      request({ at: monday, phone: '+61412345678' }),
      cleanSnapshot({
        suppressions: [suppress('account', 'account-1', 'existing-relationship', 'client', monday)],
        dialsToday: 99
      }),
      policy({ callerIdAu: '' }),
      cal
    );
    expect(codes(d.reasons)).toEqual([
      'CALLER_ID_NOT_CONFIGURED',
      'DAILY_DIAL_CAP',
      'MOBILE_DIALLING_DISABLED',
      'OUTSIDE_POLICY_WINDOW',
      'OUTSIDE_STATUTORY_WINDOW',
      'PUBLIC_HOLIDAY',
      'SUPPRESSED'
    ]);
  });
});

describe('New Zealand', () => {
  it('allows an Auckland office dial inside the NZ window', () => {
    const at = DateTime.fromISO('2025-03-12T11:00', { zone: 'Pacific/Auckland' }).toJSDate();
    const d = evaluateDialRequest(
      request({ at, phone: '+6494567890', market: 'NZ' }),
      cleanSnapshot(),
      policy(),
      cal
    );
    expect(d.allowed).toBe(true);
  });

  it('refuses a South Island number on any province anniversary because it cannot tell which province', () => {
    // Otago Anniversary Day, Monday 24 March 2025, with the window widened to weekdays.
    const at = DateTime.fromISO('2025-03-24T11:00', { zone: 'Pacific/Auckland' }).toJSDate();
    const wide = policy({ days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
    const d = evaluateDialRequest(
      request({ at, phone: '+6433771234', market: 'NZ' }),
      cleanSnapshot(),
      wide,
      cal
    );
    expect(codes(d.reasons)).toContain('PUBLIC_HOLIDAY');
  });

  it('blocks a national NZ holiday for every region', () => {
    const waitangi = DateTime.fromISO('2025-02-06T11:00', { zone: 'Pacific/Auckland' }).toJSDate();
    const wide = policy({ days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
    const d = evaluateDialRequest(
      request({ at: waitangi, phone: '+6494567890', market: 'NZ' }),
      cleanSnapshot(),
      wide,
      cal
    );
    expect(codes(d.reasons)).toEqual(['PUBLIC_HOLIDAY']);
  });
});
