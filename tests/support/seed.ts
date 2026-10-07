/**
 * A call on the blackboard, with everything it hangs off.
 *
 * Meeting requests are tied to calls, contacts, accounts and campaigns by
 * foreign keys, so a test that wants one needs all of them. Kept here so each
 * test says what is different about its contact rather than how to make one.
 */

import { randomUUID } from 'node:crypto';
import type { Blackboard } from '../../src/blackboard/client.js';

export interface SeedOptions {
  kind?: 'test' | 'prospect';
  phone?: string;
  line?: 'mobile' | 'fixed';
  outcome?: string | null;
  accountId?: string;
  campaignId?: string;
  firstName?: string;
  startedAt?: Date;
  endedAt?: Date;
}

export interface Seeded {
  campaignId: string;
  accountId: string;
  contactId: string;
  callId: string;
}

export async function seedCall(db: Blackboard, options: SeedOptions = {}): Promise<Seeded> {
  const campaignId = options.campaignId ?? randomUUID();
  if ((await db.campaign.findUnique({ where: { id: campaignId } })) === null) {
    await db.campaign.create({
      data: {
        id: campaignId,
        name: 'NZ banking pilot',
        market: 'NZ',
        status: 'active',
        icp: JSON.stringify({ titles: [], seniorities: [], industries: [], disqualifiers: [] }),
        goal: JSON.stringify({ meetingsPerWeek: 3, maxUsdPerWeek: 25 })
      }
    });
  }

  const accountId = options.accountId ?? randomUUID();
  if ((await db.account.findUnique({ where: { id: accountId } })) === null) {
    await db.account.create({
      data: {
        id: accountId,
        campaignId,
        name: 'Kiwibank',
        domain: `${accountId.slice(0, 8)}.example.co.nz`,
        country: 'NZ',
        industry: 'financial services',
        priority: 1,
        status: 'calling'
      }
    });
  }

  const contactId = randomUUID();
  await db.contact.create({
    data: {
      id: contactId,
      accountId,
      campaignId,
      firstName: options.firstName ?? 'Priya',
      lastName: 'Raman',
      title: 'Head of Data',
      status: 'contacted',
      kind: options.kind ?? 'prospect',
      phoneE164: options.phone ?? '+6444960000',
      phoneLine: options.line ?? 'fixed'
    }
  });

  const callId = randomUUID();
  const startedAt = options.startedAt ?? new Date('2026-10-07T02:00:00.000Z');
  await db.call.create({
    data: {
      id: callId,
      contactId,
      accountId,
      campaignId,
      startedAt,
      endedAt: options.endedAt ?? new Date(startedAt.getTime() + 90_000),
      durationSec: 90,
      outcome: options.outcome === undefined ? 'meeting_requested' : options.outcome
    }
  });

  return { campaignId, accountId, contactId, callId };
}
