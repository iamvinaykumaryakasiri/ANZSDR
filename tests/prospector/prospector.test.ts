import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryJournal } from '../../src/agents/journal.js';
import { runAgent } from '../../src/agents/runner.js';
import { prospectorOutputSchema, type ProspectorInput } from '../../src/agents/prospector/contract.js';
import { createProspector } from '../../src/agents/prospector/prospector.js';
import { ApolloClient } from '../../src/data/apollo-client.js';
import { phase3ConfigSchema } from '../../src/data/config.js';
import { PrismaEnrichmentLedger } from '../../src/data/enrichment-ledger.js';
import { EnrichmentService } from '../../src/data/enrichment.js';
import { FakeApollo, loadFixture, type FakePerson } from '../support/apollo-fake.js';
import { ANZ_ICP } from '../support/harness.js';
import { addContact, world, type World } from '../support/phase3.js';

const worlds: World[] = [];
afterAll(async () => {
  for (const w of worlds) await w.db.$disconnect();
});

const person = (i: number, title: string, over: Partial<FakePerson> = {}): FakePerson => ({
  id: `p${i}`,
  first: `First${i}`,
  last: `Lastname${i}`,
  title,
  seniority: 'director',
  email: `first${i}@bank.example`,
  emailStatus: 'verified',
  state: 'New South Wales',
  country: 'Australia',
  ...over
});

const PEOPLE: FakePerson[] = [
  person(0, 'Chief Data Officer', { seniority: 'c_suite', linkedin: 'https://www.linkedin.com/in/p0' }),
  person(1, 'Head of Data Platforms', { seniority: 'head' }),
  person(2, 'Director of Engineering'),
  person(3, 'Technical Recruiter', { seniority: 'manager' }),
  person(4, 'Marketing Director'),
  person(5, 'Facilities Coordinator', { seniority: 'entry' })
];

async function setup(options: { usdPerCredit?: number; people?: FakePerson[] } = {}) {
  const w = await world();
  worlds.push(w);
  const fake = new FakeApollo([{ domain: 'bank.example', name: 'Bank', orgId: 'org1', people: options.people ?? PEOPLE }]);
  const ledger = new PrismaEnrichmentLedger(w.db);
  const config = phase3ConfigSchema.parse({ enrichment: { usdPerCredit: options.usdPerCredit ?? 0.05 } });
  const client = new ApolloClient({ apiKey: 'k', ledger, fetch: fake.fetch, sleep: async () => {}, costs: { usdPerCredit: config.enrichment.usdPerCredit } });
  const enrichment = new EnrichmentService({ db: w.db, ledger, apollo: client, config: config.enrichment });
  const agent = createProspector({ db: w.db, directory: client, enrichment, config });
  const input: ProspectorInput = {
    campaignId: w.campaignId,
    accountId: w.accountIds.get('bank.example') as string,
    accountName: 'Bank',
    domain: 'bank.example',
    icp: { ...ANZ_ICP, seniorities: ['c_suite', 'vp', 'head', 'director'] },
    limit: 10
  };
  const run = async (over: Partial<ProspectorInput> = {}) => {
    const journal = new InMemoryJournal();
    const outcome = await runAgent(agent, { ...input, ...over }, { taskId: 't', journal });
    return { outcome, journal };
  };
  return { w, fake, client, ledger, run };
}

describe('Prospector', () => {
  it('searches free, scores against the ICP, and buys emails only for the people who clear it', async () => {
    const { run, fake, client } = await setup();
    const { outcome, journal } = await run();
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;

    // Best first: the CDO with a profile, then the head, then the director.
    expect(outcome.output.prospects.map((p) => p.externalId)).toEqual(['p0', 'p1', 'p2']);
    expect(outcome.output.prospects[0]).toMatchObject({
      firstName: 'First0',
      lastName: 'Lastname0', // the real surname, not the masked one the search returned
      email: 'first0@bank.example',
      emailStatus: 'verified',
      enrichmentSource: 'apollo',
      seniority: 'c_suite'
    });
    expect(outcome.output.prospects[0]?.icpScore).toBeGreaterThanOrEqual(90);

    const reasons = Object.fromEntries(outcome.output.rejected.map((r) => [r.externalId, r.reason]));
    expect(reasons.p3).toContain('disqualified');
    expect(reasons.p4).toContain('scored 35'); // seniority alone is not enough
    expect(reasons.p5).toContain('nothing in the ICP matched');

    // Nobody who failed the ICP was bought.
    const bought = fake.callsTo('/people/bulk_match').flatMap((c) => (c.body?.details as Array<{ id: string }>).map((d) => d.id));
    expect(bought.sort()).toEqual(['p0', 'p1', 'p2']);
    expect(client.credits.totalCredits).toBe(3);
    expect(outcome.output.enrichment).toMatchObject({ requested: 3, bought: 3, fromLedger: 0, deferred: 0, credits: 3 });

    // The trace says what happened in words.
    const notes = journal.traces.filter((t) => t.actor === 'prospector').map((t) => t.summary);
    expect(notes.some((n) => n.includes('searched bank.example (free)'))).toBe(true);
    expect(notes.some((n) => n.includes('3 email(s) to buy (about 3 credit(s), $0.15)'))).toBe(true);
  });

  it('does not send a masked surname to Apollo, only the id', async () => {
    const { run, fake } = await setup();
    await run();
    const details = fake.callsTo('/people/bulk_match')[0]?.body?.details as Array<Record<string, unknown>>;
    expect(details[0]).toMatchObject({ id: 'p0', first_name: 'First0', domain: 'bank.example' });
    expect(details[0]).not.toHaveProperty('last_name');
  });

  it('respects the limit', async () => {
    const { run, fake } = await setup();
    const { outcome } = await run({ limit: 2 });
    if (outcome.status !== 'succeeded') throw new Error('expected success');
    expect(outcome.output.prospects.map((p) => p.externalId)).toEqual(['p0', 'p1']);
    expect(outcome.output.rejected.find((r) => r.externalId === 'p2')?.reason).toContain("beyond this run's limit of 2");
    expect(fake.paidCalls).toHaveLength(1);
  });

  it('holds spend to the run\'s ceiling and defers the rest to a later run', async () => {
    // At $0.20 a credit the $0.50 ceiling buys two emails.
    const { run, ledger } = await setup({ usdPerCredit: 0.2 });
    const { outcome } = await run();
    if (outcome.status !== 'succeeded') throw new Error('expected success');
    expect(outcome.output.prospects.map((p) => p.externalId)).toEqual(['p0', 'p1']);
    expect(outcome.output.rejected.find((r) => r.externalId === 'p2')?.reason).toContain('deferred');
    expect(outcome.output.enrichment).toMatchObject({ bought: 2, deferred: 1, credits: 2 });
    expect(outcome.output.enrichment?.usd).toBeCloseTo(0.4);
    expect(await ledger.getEmail('p2')).toBeNull();
  });

  it('spends nothing the second time: what it already bought comes from the ledger', async () => {
    const { run, fake, w } = await setup();
    const first = await run();
    if (first.outcome.status !== 'succeeded') throw new Error('expected success');
    const paid = fake.paidCalls.length;

    // The contacts were never written (this is the agent alone), so the second run
    // finds the same people. They cost nothing.
    const second = await run();
    if (second.outcome.status !== 'succeeded') throw new Error('expected success');
    expect(fake.paidCalls.length).toBe(paid);
    expect(second.outcome.output.prospects.map((p) => p.enrichmentSource)).toEqual(['ledger', 'ledger', 'ledger']);
    expect(second.outcome.output.enrichment).toMatchObject({ bought: 0, fromLedger: 3, credits: 0, usd: 0 });
    expect(w).toBeTruthy();
  });

  it('leaves out people already held, by Apollo id and by name, and buys nothing for them', async () => {
    const { run, fake, w } = await setup();
    await addContact(w, 'bank.example', { id: randomUUID(), firstName: 'First0', lastName: 'Lastname0', apolloId: 'p0', status: 'researched' });
    await addContact(w, 'bank.example', { firstName: 'First1', lastName: 'Lastname1', apolloId: null, status: 'enriched' });
    const { outcome } = await run();
    if (outcome.status !== 'succeeded') throw new Error('expected success');
    expect(outcome.output.prospects.map((p) => p.externalId)).toEqual(['p2']);
    expect(outcome.output.rejected.find((r) => r.externalId === 'p0')?.reason).toContain('matched by apollo-id');
    expect(outcome.output.rejected.find((r) => r.externalId === 'p1')?.reason).toContain('matched by name');
    expect((fake.callsTo('/people/bulk_match')[0]?.body?.details as unknown[]).length).toBe(1);
  });

  it('buys nothing at an account that is suppressed', async () => {
    const { run, fake, w } = await setup();
    await w.db.suppression.create({
      data: { id: randomUUID(), scope: 'account', key: w.accountIds.get('bank.example') as string, source: 'operator', reason: 'existing client' }
    });
    const { outcome } = await run();
    if (outcome.status !== 'succeeded') throw new Error('expected success');
    expect(outcome.output.prospects).toEqual([]);
    expect(outcome.output.rejected.filter((r) => r.reason.includes('account is suppressed: existing client'))).toHaveLength(3);
    expect(fake.paidCalls).toHaveLength(0);
  });

  it('returns nobody, without error, when nobody clears the bar', async () => {
    const { run, fake } = await setup({ people: [person(0, 'Facilities Coordinator', { seniority: 'entry' })] });
    const { outcome, journal } = await run();
    if (outcome.status !== 'succeeded') throw new Error('expected success');
    expect(outcome.output.prospects).toEqual([]);
    expect(fake.paidCalls).toHaveLength(0);
    expect(journal.traces.map((t) => t.summary)).toContain('nobody new to enrich');
  });

  it('records a person Apollo cannot match, charges nothing for them, and does not ask again', async () => {
    const { run, fake, ledger, client } = await setup();
    fake.unmatchable.add('p1');
    const first = await run();
    if (first.outcome.status !== 'succeeded') throw new Error('expected success');
    expect(first.outcome.output.prospects.map((p) => p.externalId)).toEqual(['p0', 'p2']);
    expect(first.outcome.output.rejected.find((r) => r.externalId === 'p1')?.reason).toContain('no credits were charged');
    expect(client.credits.totalCredits).toBe(2);
    expect(await ledger.getEmail('p1')).toMatchObject({ matched: false });

    const paid = fake.paidCalls.length;
    await run();
    expect(fake.paidCalls.length).toBe(paid);
  });

  it('escalates, in the account\'s own words, when the plan does not include search', async () => {
    const { run, fake } = await setup();
    fake.failures.push({ status: 403, body: loadFixture('plan-403.json') });
    const { outcome } = await run();
    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.failure.message).toContain('not included in your Free plan');
    expect(fake.paidCalls).toHaveLength(0);
  });

  it('keeps the Phase 2 output shape valid, so the stub and its tests still stand', () => {
    expect(
      prospectorOutputSchema.parse({
        accountId: 'a',
        prospects: [{ externalId: 'x', firstName: 'A', lastName: 'B', title: 'T', seniority: 'head', icpScore: 80, scoreRationale: 'r' }],
        searchedAt: '2026-10-07T00:00:00.000Z'
      }).prospects[0]
    ).not.toHaveProperty('email');
  });
});
