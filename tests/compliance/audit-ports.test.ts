import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dialDecisionRecord,
  InMemoryAuditLog,
  JsonlAuditLog,
  killSwitchRecord,
  suppressionRecord
} from '../../src/compliance/audit.js';
import {
  InMemoryAttemptStore,
  InMemoryContactStore,
  InMemoryCallStateStore,
  InMemoryDayPlanStore,
  InMemoryDncStore,
  InMemorySuppressionStore
} from '../../src/compliance/ports.js';
import { suppress } from '../../src/compliance/suppression.js';
import { cleanSnapshot, policy, request } from '../support/fixtures.js';
import { evaluateDialRequest } from '../../src/compliance/gate.js';
import { calendar } from '../support/fixtures.js';

const NOW = new Date('2026-03-11T02:30:00Z');

describe('audit records', () => {
  it('summarises an allowed dial and a denied one in one readable line', () => {
    const p = policy();
    const cal = calendar();
    const req = request({ at: new Date('2025-03-12T00:00:00Z') });
    const allowed = evaluateDialRequest(req, cleanSnapshot(), p, cal);
    const denied = evaluateDialRequest(
      req,
      cleanSnapshot({ killSwitch: { active: true, reason: 'operator stop' } }),
      p,
      cal
    );
    expect(dialDecisionRecord(req, allowed).summary).toContain('allowed');
    expect(dialDecisionRecord(req, denied).summary).toContain('KILL_SWITCH_ACTIVE');
  });

  it('records a kill-switch trip with no reason without crashing', () => {
    const record = killSwitchRecord({ active: true }, 'operator', NOW);
    expect(record.summary).toContain('no reason given');
  });

  it('records a suppression', () => {
    const entry = suppress('contact', 'contact-1', 'complaint', 'complained on the call', NOW);
    expect(suppressionRecord(entry, 'scribe').summary).toContain('permanently');
  });

  it('keeps records in order in memory', async () => {
    const log = new InMemoryAuditLog();
    await log.append(killSwitchRecord({ active: true, reason: 'a' }, 'operator', NOW));
    await log.append(killSwitchRecord({ active: false }, 'vinay', NOW));
    expect(await log.read()).toHaveLength(2);
  });

  it('appends to disk as JSON lines and reads them back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anzsdr-audit-'));
    const path = join(dir, 'nested', 'audit.jsonl');
    const log = new JsonlAuditLog(path);
    expect(await log.read()).toEqual([]);
    await log.append(killSwitchRecord({ active: true, reason: 'a' }, 'operator', NOW));
    await log.append(killSwitchRecord({ active: false }, 'vinay', NOW));
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(await log.read()).toHaveLength(2);
  });
});

describe('in-memory stores', () => {
  it('filters suppressions down to the ones that apply', async () => {
    const store = new InMemorySuppressionStore();
    await store.add(suppress('contact', 'contact-1', 'not-interested', 'x', NOW));
    await store.add(suppress('contact', 'contact-2', 'not-interested', 'x', NOW));
    expect(await store.find({ contactId: 'contact-1', e164: '+61280001234', accountId: 'a' })).toHaveLength(1);
    expect(await store.list()).toHaveLength(2);
  });

  it('keeps the newest wash for a number', async () => {
    const store = new InMemoryDncStore();
    expect(await store.latestWash('+61412345678')).toBeNull();
    const older = { e164: '+61412345678', result: 'clear' as const, washedAt: new Date('2026-01-01'), register: 'r' };
    const newer = { e164: '+61412345678', result: 'registered' as const, washedAt: new Date('2026-02-01'), register: 'r' };
    await store.record(newer);
    await store.record(older);
    expect((await store.latestWash('+61412345678'))?.result).toBe('registered');
    await store.record({ ...older, washedAt: new Date('2026-03-01'), result: 'clear' });
    expect((await store.latestWash('+61412345678'))?.result).toBe('clear');
  });

  it('counts attempts by contact, account, number and day', async () => {
    const store = new InMemoryAttemptStore();
    const base = { accountId: 'a1', e164: '+61280001234', hadConversation: false };
    await store.record({ ...base, contactId: 'c1', at: new Date('2026-03-01T00:00:00Z') });
    await store.record({ ...base, contactId: 'c2', at: new Date('2026-03-09T00:00:00Z'), hadConversation: true });
    expect(await store.forContact('c1')).toHaveLength(1);
    expect(await store.forAccountSince('a1', new Date('2026-03-05T00:00:00Z'))).toHaveLength(1);
    expect(await store.accountHasConversed('a1')).toBe(true);
    expect(await store.accountHasConversed('a2')).toBe(false);
    expect(await store.countSince(new Date('2026-03-05T00:00:00Z'))).toBe(1);
    expect(await store.countForNumberSince('+61280001234', new Date('2026-02-01T00:00:00Z'))).toBe(2);
    expect(await store.countForNumberSince('+61399990000', new Date('2026-02-01T00:00:00Z'))).toBe(0);
  });

  it('reports whether a contact is a test number, and null when it has never heard of them', async () => {
    const store = new InMemoryContactStore();
    expect(await store.kind('contact-1')).toBeNull();
    store.set('contact-1', 'test');
    store.set('contact-2', 'prospect');
    expect(await store.kind('contact-1')).toBe('test');
    expect(await store.kind('contact-2')).toBe('prospect');
    expect(await store.kind('contact-9')).toBeNull();
  });

  it('reports the day plan, and whether a contact is on it', async () => {
    const store = new InMemoryDayPlanStore();
    expect(await store.current('campaign-1', '2026-03-11', 'contact-1')).toBeNull();

    store.set({
      campaignId: 'campaign-1',
      planId: 'plan-1',
      planDate: '2026-03-11',
      status: 'approved',
      entryCount: 2,
      contactIds: ['contact-1', 'contact-2']
    });

    const onIt = await store.current('campaign-1', '2026-03-11', 'contact-1');
    expect(onIt?.status).toBe('approved');
    expect(onIt?.includesContact).toBe(true);
    expect((await store.current('campaign-1', '2026-03-11', 'contact-9'))?.includesContact).toBe(false);

    // Asking about another day still reports the plan that exists, so the gate can
    // say "the only plan is for another day" rather than "there is no plan".
    const otherDay = await store.current('campaign-1', '2026-03-12', 'contact-1');
    expect(otherDay?.planDate).toBe('2026-03-11');
  });

  it('reports live calls', async () => {
    const store = new InMemoryCallStateStore();
    expect(await store.liveCalls()).toBe(0);
    store.set(1);
    expect(await store.liveCalls()).toBe(1);
  });
});
