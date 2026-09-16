/**
 * Seed a campaign, an account and one prospecting task, so `npm run tick` has
 * something to do.
 *
 *   npm run seed:demo
 *
 * A development aid. It writes example data, never real prospects.
 */

import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlackboard } from '../src/blackboard/client.js';
import { TaskRepository } from '../src/blackboard/repositories.js';
import { PROSPECT_ACCOUNT } from '../src/orchestrator/kinds.js';
import type { Icp } from '../src/blackboard/schemas.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const ICP: Icp = {
  titles: ['chief data officer', 'head of data', 'director of engineering'],
  seniorities: ['c_suite', 'vp', 'director'],
  industries: ['financial services'],
  disqualifiers: ['intern', 'recruiter'],
  minimumScore: 60
};

const db = createBlackboard();

/**
 * `npm run seed:demo -- phones` puts example office numbers on the contacts a
 * tick has researched, so the call plan has something to plan. Phase 3 gets real
 * numbers from Apollo enrichment; these are example data and are not dialled by
 * anything in this repository.
 */
if (process.argv[2] === 'phones') {
  const contacts = await db.contact.findMany({ where: { status: 'researched' } });
  for (const [index, contact] of contacts.entries()) {
    await db.contact.update({
      where: { id: contact.id },
      data: {
        phoneE164: `+61280005${String(100 + index).padStart(3, '0')}`,
        phoneLine: 'fixed',
        jurisdiction: 'au-nsw',
        timezone: 'Australia/Sydney'
      }
    });
  }
  console.log(`put example office numbers on ${contacts.length} researched contact(s)`);
  await db.$disconnect();
  process.exit(0);
}

const campaignId = randomUUID();
const accountId = randomUUID();

await db.campaign.create({
  data: {
    id: campaignId,
    name: 'ANZ BFSI pilot',
    market: 'AU',
    status: 'active',
    icp: JSON.stringify(ICP),
    // Deliberately small to start: three meetings a week, and a ceiling that
    // covers roughly one Phase 3 acceptance run of twenty contacts. Both are
    // editable on the account desk, and the Director reads them from there.
    goal: JSON.stringify({ meetingsPerWeek: 3, maxUsdPerWeek: 25 })
  }
});

await db.account.create({
  data: {
    id: accountId,
    campaignId,
    name: 'Example Bank',
    domain: 'examplebank.com.au',
    country: 'AU',
    industry: 'financial services',
    priority: 1,
    status: 'new',
    notes: 'Example data, not a real prospect.'
  }
});

await new TaskRepository(db).create({
  kind: PROSPECT_ACCOUNT,
  priority: 1,
  campaignId,
  accountId,
  payload: {
    campaignId,
    accountId,
    accountName: 'Example Bank',
    domain: 'examplebank.com.au',
    icp: ICP,
    limit: 10
  }
});

console.log(`seeded campaign ${campaignId} with one ${PROSPECT_ACCOUNT} task`);
console.log(`fixtures: ${resolve(ROOT, 'config/fixtures.json')} (copy from config/fixtures.example.json)`);
await db.$disconnect();
