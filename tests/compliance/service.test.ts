import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { InMemoryAuditLog } from '../../src/compliance/audit.js';
import { InMemoryKillSwitchStore, KillSwitch } from '../../src/compliance/kill-switch.js';
import {
  InMemoryAttemptStore,
  InMemoryCallStateStore,
  InMemoryDncStore,
  InMemorySuppressionStore
} from '../../src/compliance/ports.js';
import { ComplianceGate } from '../../src/compliance/service.js';
import { suppress } from '../../src/compliance/suppression.js';
import { calendar, policy, request, type PolicyOverrides } from '../support/fixtures.js';

const GOOD = DateTime.fromISO('2025-03-12T11:00', { zone: 'Australia/Sydney' }).toJSDate();

function harness(overrides: PolicyOverrides = {}) {
  const audit = new InMemoryAuditLog();
  const suppression = new InMemorySuppressionStore();
  const dnc = new InMemoryDncStore();
  const attempts = new InMemoryAttemptStore();
  const calls = new InMemoryCallStateStore();
  const killSwitch = new KillSwitch(new InMemoryKillSwitchStore(), audit);
  const gate = new ComplianceGate({
    policy: policy(overrides),
    calendar: calendar(),
    killSwitch,
    suppression,
    dnc,
    attempts,
    calls,
    audit
  });
  return { gate, audit, suppression, dnc, attempts, calls, killSwitch };
}

describe('ComplianceGate', () => {
  it('allows a clean request and audits it', async () => {
    const { gate, audit } = harness();
    const decision = await gate.request(request({ at: GOOD }));
    expect(decision.allowed).toBe(true);
    const records = await audit.read();
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe('dial-decision');
    expect(records[0]?.summary).toContain('allowed');
  });

  it('audits denials too, so the console can show why nothing dialled', async () => {
    const { gate, audit, suppression } = harness();
    await suppression.add(suppress('contact', 'contact-1', 'complaint', 'told us to stop', GOOD));
    const decision = await gate.request(request({ at: GOOD }));
    expect(decision.allowed).toBe(false);
    expect((await audit.read())[0]?.summary).toContain('SUPPRESSED');
  });

  it('halts the moment the kill switch is tripped', async () => {
    const { gate, killSwitch } = harness();
    expect((await gate.request(request({ at: GOOD }))).allowed).toBe(true);
    await killSwitch.trip('operator', 'Vinay pressed Stop All', GOOD);
    const after = await gate.request(request({ at: GOOD }));
    expect(after.allowed).toBe(false);
    expect(after.reasons[0]?.code).toBe('KILL_SWITCH_ACTIVE');
  });

  it('counts the day against the operator timezone, not UTC', async () => {
    const { gate, attempts } = harness();
    // 21:00 Sydney on the 11th is still the 11th locally but already the 12th in UTC.
    const lateOn11th = DateTime.fromISO('2025-03-11T21:00', { zone: 'Australia/Sydney' }).toJSDate();
    for (let i = 0; i < 60; i++) {
      await attempts.record({
        contactId: `c${i}`,
        accountId: `a${i}`,
        e164: `+6128000${String(1000 + i)}`,
        at: DateTime.fromISO('2025-03-11T10:00', { zone: 'Australia/Sydney' }).toJSDate(),
        hadConversation: false
      });
    }
    const sameDay = await gate.snapshot(request({ at: lateOn11th }));
    expect(sameDay.dialsToday).toBe(60);
    const nextDay = await gate.snapshot(request({ at: GOOD }));
    expect(nextDay.dialsToday).toBe(0);
  });

  it('measures "already dialled today" over the recipient\'s longest plausible day', async () => {
    const { gate, attempts } = harness();
    // A Perth office dial: 07:00 Sydney on the 12th is 04:00 Perth, still the 12th
    // in both, but a dial placed at 22:00 Sydney on the 11th was 19:00 Perth on
    // the 11th and must not count against the 12th.
    await attempts.record({
      contactId: 'contact-1',
      accountId: 'account-1',
      e164: '+61880001234',
      at: DateTime.fromISO('2025-03-11T19:00', { zone: 'Australia/Perth' }).toJSDate(),
      hadConversation: false
    });
    const snap = await gate.snapshot(
      request({ at: DateTime.fromISO('2025-03-12T10:00', { zone: 'Australia/Perth' }).toJSDate(), phone: '+61880001234' })
    );
    expect(snap.numberDialsToday).toBe(0);
  });

  it('carries the email domain into the suppression lookup', async () => {
    const { gate, suppression } = harness();
    await suppression.add(suppress('domain', 'westpac.com.au', 'operator', 'whole company off limits', GOOD));
    const withDomain = await gate.snapshot(request({ at: GOOD, emailDomain: 'westpac.com.au' }));
    expect(withDomain.suppressions).toHaveLength(1);
    const without = await gate.snapshot(request({ at: GOOD }));
    expect(without.suppressions).toHaveLength(0);
  });

  it('falls back to the operational day when the number will not parse', async () => {
    const { gate } = harness();
    const snap = await gate.snapshot(request({ at: GOOD, phone: 'garbage' }));
    expect(snap.numberDialsToday).toBe(0);
  });

  it('assembles suppression, wash, attempt and concurrency state in one snapshot', async () => {
    const { gate, suppression, dnc, attempts, calls } = harness();
    await suppression.add(suppress('account', 'account-1', 'existing-relationship', 'client', GOOD));
    await dnc.record({ e164: '+61280001234', result: 'clear', washedAt: GOOD, register: 'r' });
    await attempts.record({
      contactId: 'contact-1',
      accountId: 'account-1',
      e164: '+61280001234',
      at: new Date(GOOD.getTime() - 86_400_000),
      hadConversation: true
    });
    calls.set(1);

    const snap = await gate.snapshot(request({ at: GOOD }));
    expect(snap.suppressions).toHaveLength(1);
    expect(snap.dncWash?.result).toBe('clear');
    expect(snap.contactAttempts).toHaveLength(1);
    expect(snap.accountAttemptsThisWeek).toHaveLength(1);
    expect(snap.accountHasConversed).toBe(true);
    expect(snap.liveCalls).toBe(1);
  });
});
