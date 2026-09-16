/**
 * The compliance engine was fuzzed against the in-memory stores. Production runs
 * against Prisma. These two implementations are therefore held to one set of
 * expectations, so the 10,000-request acceptance from Phase 1 still means
 * something once the database is underneath it.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createTestBlackboard } from '../../src/blackboard/client.js';
import {
  PrismaAttemptStore,
  PrismaAuditLog,
  PrismaCallStateStore,
  PrismaDncStore,
  PrismaSuppressionStore
} from '../../src/blackboard/compliance-stores.js';
import {
  InMemoryAttemptStore,
  InMemoryCallStateStore,
  InMemoryDncStore,
  InMemorySuppressionStore,
  type AttemptStore,
  type DncStore,
  type SuppressionStore
} from '../../src/compliance/ports.js';
import { InMemoryAuditLog, killSwitchRecord, type AuditLog } from '../../src/compliance/audit.js';
import { suppress } from '../../src/compliance/suppression.js';
import { ComplianceGate } from '../../src/compliance/service.js';
import { InMemoryKillSwitchStore, KillSwitch } from '../../src/compliance/kill-switch.js';
import { InMemoryDayPlanStore } from '../../src/compliance/ports.js';
import { calendar, policy, request } from '../support/fixtures.js';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';

const NOW = new Date('2026-03-11T00:00:00Z');
const DAY = 86_400_000;

interface Suite {
  name: string;
  make(): Promise<{
    suppression: SuppressionStore;
    dnc: DncStore;
    attempts: AttemptStore;
    calls: { liveCalls(): Promise<number> };
    audit: AuditLog;
    seedLiveCall?: () => Promise<void>;
    cleanup?: () => Promise<void>;
  }>;
}

const disconnects: Array<() => Promise<void>> = [];

const suites: Suite[] = [
  {
    name: 'in-memory',
    make: async () => {
      const calls = new InMemoryCallStateStore();
      return {
        suppression: new InMemorySuppressionStore(),
        dnc: new InMemoryDncStore(),
        attempts: new InMemoryAttemptStore(),
        calls,
        audit: new InMemoryAuditLog(),
        seedLiveCall: async () => {
          calls.set(1);
        }
      };
    }
  },
  {
    name: 'prisma',
    make: async () => {
      const db = await createTestBlackboard();
      disconnects.push(() => db.$disconnect());
      // Real foreign keys, so the fixture uses the same ids the expectations do.
      const campaignId = randomUUID();
      const accountId = 'account-1';
      const contactId = 'contact-1';
      await db.campaign.create({
        data: { id: campaignId, name: 'c', market: 'AU', status: 'active', icp: '{}', goal: '{}' }
      });
      await db.account.create({
        data: {
          id: accountId,
          campaignId,
          name: 'a',
          domain: 'a.example',
          country: 'AU',
          industry: 'financial services',
          status: 'new'
        }
      });
      for (const id of [contactId, 'contact-2']) {
        await db.contact.create({
          data: { id, accountId, campaignId, firstName: 'P', lastName: 'R', title: 'CDO', status: 'scored' }
        });
      }
      return {
        suppression: new PrismaSuppressionStore(db),
        dnc: new PrismaDncStore(db),
        attempts: new PrismaAttemptStore(db),
        calls: new PrismaCallStateStore(db),
        audit: new PrismaAuditLog(db),
        seedLiveCall: async () => {
          await db.call.create({
            data: {
              id: randomUUID(),
              contactId,
              accountId,
              campaignId,
              startedAt: NOW,
              endedAt: null
            }
          });
        }
      };
    }
  }
];

afterAll(async () => {
  for (const d of disconnects) await d();
});

describe.each(suites)('$name compliance stores', ({ make }) => {
  const subject = { contactId: 'contact-1', e164: '+61280001234', accountId: 'account-1' };

  it('returns only the suppressions that apply to the subject', async () => {
    const { suppression } = await make();
    await suppression.add(suppress('contact', 'contact-1', 'complaint', 'told us to stop', NOW));
    await suppression.add(suppress('contact', 'contact-2', 'complaint', 'someone else', NOW));
    await suppression.add(suppress('number', '+61399990000', 'complaint', 'a different number', NOW));
    const found = await suppression.find(subject);
    expect(found).toHaveLength(1);
    expect(found[0]?.key).toBe('contact-1');
    expect(found[0]?.permanent).toBe(true);
    expect(await suppression.list()).toHaveLength(3);
  });

  it('matches a domain suppression only when the subject carries a domain', async () => {
    const { suppression } = await make();
    await suppression.add(suppress('domain', 'westpac.com.au', 'operator', 'off limits', NOW));
    expect(await suppression.find(subject)).toHaveLength(0);
    expect(await suppression.find({ ...subject, emailDomain: 'westpac.com.au' })).toHaveLength(1);
  });

  it('keeps the newest wash for a number', async () => {
    const { dnc } = await make();
    expect(await dnc.latestWash('+61412345678')).toBeNull();
    await dnc.record({ e164: '+61412345678', result: 'registered', washedAt: new Date(NOW.getTime() - 5 * DAY), register: 'r' });
    await dnc.record({ e164: '+61412345678', result: 'clear', washedAt: new Date(NOW.getTime() - DAY), register: 'r' });
    expect((await dnc.latestWash('+61412345678'))?.result).toBe('clear');
  });

  it('counts attempts by contact, account, number and day', async () => {
    const { attempts } = await make();
    const base = { accountId: 'account-1', e164: '+61280001234', hadConversation: false };
    await attempts.record({ ...base, contactId: 'contact-1', at: new Date(NOW.getTime() - 10 * DAY) });
    await attempts.record({ ...base, contactId: 'contact-2', at: new Date(NOW.getTime() - DAY), hadConversation: true });

    expect(await attempts.forContact('contact-1')).toHaveLength(1);
    expect(await attempts.forAccountSince('account-1', new Date(NOW.getTime() - 7 * DAY))).toHaveLength(1);
    expect(await attempts.accountHasConversed('account-1')).toBe(true);
    expect(await attempts.accountHasConversed('account-9')).toBe(false);
    expect(await attempts.countSince(new Date(NOW.getTime() - 7 * DAY))).toBe(1);
    expect(await attempts.countForNumberSince('+61280001234', new Date(NOW.getTime() - 30 * DAY))).toBe(2);
    expect(await attempts.countForNumberSince('+61399990000', new Date(NOW.getTime() - 30 * DAY))).toBe(0);
  });

  it('reports calls in progress', async () => {
    const stores = await make();
    expect(await stores.calls.liveCalls()).toBe(0);
    await stores.seedLiveCall?.();
    expect(await stores.calls.liveCalls()).toBe(1);
  });

  it('round-trips audit records', async () => {
    const { audit } = await make();
    await audit.append(killSwitchRecord({ active: true, reason: 'operator stop' }, 'operator', NOW));
    const records = await audit.read();
    expect(records).toHaveLength(1);
    expect(records[0]?.summary).toContain('TRIPPED');
  });

  it('gives the compliance gate the same answer either way', async () => {
    const stores = await make();
    const gate = new ComplianceGate({
      policy: policy(),
      calendar: calendar(),
      killSwitch: new KillSwitch(new InMemoryKillSwitchStore(), stores.audit),
      suppression: stores.suppression,
      dnc: stores.dnc,
      attempts: stores.attempts,
      calls: stores.calls,
      dayPlans: new InMemoryDayPlanStore(),
      audit: stores.audit
    });

    const at = DateTime.fromISO('2025-03-12T11:00', { zone: 'Australia/Sydney' }).toJSDate();
    const clean = await gate.request(request({ at }));
    expect(clean.allowed).toBe(true);

    await stores.suppression.add(suppress('contact', 'contact-1', 'not-interested', 'declined', at));
    const suppressed = await gate.request(request({ at, requestId: 'req-2' }));
    expect(suppressed.allowed).toBe(false);
    expect(suppressed.reasons.map((r) => r.code)).toContain('SUPPRESSED');
  });
});
