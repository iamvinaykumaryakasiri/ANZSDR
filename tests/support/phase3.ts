/**
 * Shared setup for the Phase 3 tests: a blackboard with a campaign and accounts,
 * and a helper to put a contact on it the way the orchestrator would.
 */

import { randomUUID } from 'node:crypto';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { ANZ_ICP } from './harness.js';

export interface World {
  db: Blackboard;
  campaignId: string;
  accountIds: Map<string, string>;
}

export async function world(
  accounts: Array<{ domain: string; name: string; country?: 'AU' | 'NZ' }> = [{ domain: 'bank.example', name: 'Bank' }],
  options: { maxUsdPerWeek?: number } = {}
): Promise<World> {
  const db = await createTestBlackboard();
  const campaignId = randomUUID();
  await db.campaign.create({
    data: {
      id: campaignId,
      name: 'Phase 3 test',
      market: 'AU',
      status: 'active',
      icp: JSON.stringify(ANZ_ICP),
      goal: JSON.stringify({ meetingsPerWeek: 5, maxUsdPerWeek: options.maxUsdPerWeek ?? 50 })
    }
  });
  const accountIds = new Map<string, string>();
  for (const a of accounts) {
    const id = randomUUID();
    accountIds.set(a.domain, id);
    await db.account.create({
      data: {
        id,
        campaignId,
        name: a.name,
        domain: a.domain,
        country: a.country ?? 'AU',
        industry: 'financial services',
        priority: 1,
        status: 'new'
      }
    });
  }
  return { db, campaignId, accountIds };
}

export async function addContact(
  w: World,
  domain: string,
  over: Partial<{
    id: string;
    firstName: string;
    lastName: string;
    title: string;
    apolloId: string | null;
    status: string;
    kind: string;
    phoneE164: string | null;
  }> = {}
): Promise<string> {
  const id = over.id ?? randomUUID();
  await w.db.contact.create({
    data: {
      id,
      accountId: w.accountIds.get(domain) as string,
      campaignId: w.campaignId,
      firstName: over.firstName ?? 'Priya',
      lastName: over.lastName ?? 'Raman',
      title: over.title ?? 'Chief Data Officer',
      apolloId: over.apolloId === undefined ? `apollo-${id}` : over.apolloId,
      status: over.status ?? 'scored',
      kind: over.kind ?? 'prospect',
      phoneE164: over.phoneE164 ?? null
    }
  });
  return id;
}

export async function addDossier(w: World, contactId: string, confidence: 'high' | 'medium' | 'low'): Promise<void> {
  await w.db.dossier.create({
    data: {
      id: randomUUID(),
      contactId,
      hypothesis: 'h',
      confidence,
      person: '{"name":"x","title":"y","priorEmployers":[],"signals":[]}',
      account: '{"whatTheyDo":"z","techSignals":[],"announcements":[],"pressures":[]}',
      hooks: '[]',
      landmines: '[]',
      unverified: '[]',
      sources: '[]'
    }
  });
}
