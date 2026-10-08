import { describe, expect, it } from 'vitest';
import { ApolloClient, BULK_MATCH_BATCH, type CreditEntry } from '../../src/data/apollo-client.js';
import {
  ApolloApiError,
  ApolloAuthError,
  ApolloNetworkError,
  ApolloNotConfiguredError,
  ApolloPlanError,
  ApolloRateLimitError,
  ApolloResponseError,
  MissingApolloIdError,
  PersonalEmailNotPermittedError,
  PhoneWebhookRequiredError
} from '../../src/data/errors.js';
import { InMemoryEnrichmentLedger } from '../../src/data/enrichment-ledger.js';
import { FakeApollo, loadFixture, type FakeAccount, type FakePerson } from '../support/apollo-fake.js';

function people(n: number): FakePerson[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    first: `First${i}`,
    last: `Lastname${i}`,
    title: 'Head of Data',
    seniority: 'head',
    email: `first${i}@bank.example`,
    emailStatus: 'verified',
    state: 'New South Wales',
    country: 'Australia'
  }));
}

function world(n = 3): FakeApollo {
  const account: FakeAccount = { domain: 'bank.example', name: 'Bank', orgId: 'org1', people: people(n) };
  return new FakeApollo([account]);
}

function makeClient(
  fake: FakeApollo,
  options: Partial<ConstructorParameters<typeof ApolloClient>[0]> = {}
): { client: ApolloClient; ledger: InMemoryEnrichmentLedger; slept: number[]; spent: CreditEntry[] } {
  const ledger = new InMemoryEnrichmentLedger();
  const slept: number[] = [];
  const spent: CreditEntry[] = [];
  const client = new ApolloClient({
    apiKey: 'test-key',
    ledger,
    fetch: fake.fetch,
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => 1,
    onSpend: (e) => {
      spent.push(e);
    },
    ...options
  });
  return { client, ledger, slept, spent };
}

const jsonFetch =
  (body: unknown, status = 200, headers: Record<string, string> = {}): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('configuration', () => {
  it('refuses to exist without a key, with an error that says what to do', () => {
    const ledger = new InMemoryEnrichmentLedger();
    expect(() => new ApolloClient({ apiKey: '  ', ledger })).toThrow(ApolloNotConfiguredError);
    expect(() => ApolloClient.fromEnv({}, { ledger })).toThrow(/APOLLO_API_KEY/);
    expect(() => ApolloClient.fromEnv({}, { ledger })).toThrow(/APOLLO-SETUP/);
  });

  it('reads the price per credit and the search path from the environment', () => {
    const client = ApolloClient.fromEnv(
      { APOLLO_API_KEY: 'k', APOLLO_USD_PER_CREDIT: '0.2', APOLLO_SEARCH_PATH: '/mixed_people/api_search' },
      { ledger: new InMemoryEnrichmentLedger() }
    );
    expect(client.costs.usdPerCredit).toBe(0.2);
    expect(client.usdFor(5)).toBe(1);
  });
});

describe('People Search (free)', () => {
  it('posts the ICP filters with the key header and returns discovery data only', async () => {
    const fake = world(2);
    const { client } = makeClient(fake);
    const result = await client.searchPeople({
      domains: ['bank.example'],
      titles: ['head of data'],
      seniorities: ['head', 'director'],
      perPage: 500
    });

    const call = fake.calls[0];
    expect(call?.path).toBe('/mixed_people/search');
    expect(call?.headers['x-api-key']).toBe('test-key');
    expect(call?.body).toMatchObject({
      q_organization_domains_list: ['bank.example'],
      person_titles: ['head of data'],
      person_seniorities: ['head', 'director'],
      per_page: 100
    });
    expect(result.people).toHaveLength(2);
    // Discovery only: a masked surname, no email, no phone.
    expect(result.people[0]).toMatchObject({ lastNameObfuscated: true, hasEmail: true });
    expect(JSON.stringify(result.people)).not.toContain('@');
    expect(client.credits.totalCredits).toBe(0);
  });

  it('can be pointed at the newer endpoint name', async () => {
    const fake = world(1);
    const { client } = makeClient(fake, { searchPath: '/mixed_people/api_search' });
    await client.searchPeople({ domains: ['bank.example'], titles: [], seniorities: [] });
    expect(fake.calls[0]?.path).toBe('/mixed_people/api_search');
  });

  it('reads the recorded current shape: masked surnames, no seniority, has_email flags', async () => {
    const { client } = makeClient(new FakeApollo([]), { fetch: jsonFetch(loadFixture('people-search.api_search.json')) });
    const result = await client.searchPeople({ domains: ['examplebank.com.au'], titles: [], seniorities: [] });
    expect(result.people.map((p) => [p.firstName, p.lastName, p.lastNameObfuscated, p.seniority])).toEqual([
      ['Priya', 'Ra***n', true, undefined],
      ['Tom', 'Wh***be', true, undefined],
      ['Sam', 'Ke***r', true, undefined]
    ]);
    expect(result.people[0]?.hasDirectPhone).toBe(true);
    expect(result.people[1]?.hasDirectPhone).toBe(false);
    expect(result.totalEntries).toBe(3);
  });

  it('reads the recorded legacy shape and ignores its placeholder email', async () => {
    const { client } = makeClient(new FakeApollo([]), { fetch: jsonFetch(loadFixture('people-search.legacy.json')) });
    const result = await client.searchPeople({ domains: ['examplebank.com.au'], titles: [], seniorities: [] });
    // The contact that is also a person appears once.
    expect(result.people.map((p) => p.apolloId)).toEqual(['5f1a00000000000000000001', '5f1a00000000000000000002']);
    expect(result.people[0]).toMatchObject({ lastName: 'Raman', lastNameObfuscated: false, seniority: 'c_suite', state: 'New South Wales' });
    expect(result.people[0]?.organizationDomain).toBe('examplebank.com.au');
  });
});

describe('Bulk People Enrichment', () => {
  it('sends ten per call, and counts the credits Apollo says it consumed', async () => {
    const fake = world(23);
    const { client, ledger, spent } = makeClient(fake);
    const outcomes = await client.enrichEmails(Array.from({ length: 23 }, (_, i) => ({ apolloId: `p${i}`, domain: 'bank.example' })));

    expect(BULK_MATCH_BATCH).toBe(10);
    expect(fake.callsTo('/people/bulk_match').map((c) => (c.body?.details as unknown[]).length)).toEqual([10, 10, 3]);
    expect(outcomes.size).toBe(23);
    expect([...outcomes.values()].every((o) => o.status === 'enriched')).toBe(true);
    expect(client.credits.totalCredits).toBe(23);
    expect(spent).toHaveLength(3);
    expect(spent.every((e) => !e.estimated)).toBe(true);
    expect(await ledger.getEmail('p7')).toMatchObject({ matched: true, credits: 1 });
  });

  it('turns off personal emails and phone reveal unless told otherwise', async () => {
    const fake = world(1);
    await makeClient(fake).client.enrichEmails([{ apolloId: 'p0' }]);
    expect(fake.calls[0]?.query).toMatchObject({ reveal_personal_emails: 'false', reveal_phone_number: 'false' });
    expect(fake.calls[0]?.query.webhook_url).toBeUndefined();
  });

  it('never re-buys: a person already in the ledger costs no request at all', async () => {
    const fake = world(3);
    const { client } = makeClient(fake);
    const ids = [{ apolloId: 'p0' }, { apolloId: 'p1' }, { apolloId: 'p2' }];

    const first = await client.enrichEmails(ids);
    const callsAfterFirst = fake.calls.length;
    const again = await client.enrichEmails(ids);

    expect(fake.calls.length).toBe(callsAfterFirst);
    expect(client.credits.totalCredits).toBe(3);
    expect(again.get('p1')).toMatchObject({ status: 'enriched', source: 'ledger', credits: 0 });
    // The data comes back from the ledger, identical.
    expect((again.get('p1') as { person: unknown }).person).toEqual((first.get('p1') as { person: unknown }).person);
  });

  it('buys only the people it does not already hold', async () => {
    const fake = world(4);
    const { client } = makeClient(fake);
    await client.enrichEmails([{ apolloId: 'p0' }, { apolloId: 'p1' }]);
    await client.enrichEmails([{ apolloId: 'p1' }, { apolloId: 'p2' }, { apolloId: 'p3' }]);
    const second = fake.callsTo('/people/bulk_match')[1];
    expect((second?.body?.details as Array<{ id: string }>).map((d) => d.id)).toEqual(['p2', 'p3']);
  });

  it('remembers a miss too, so it does not pay to be told no twice', async () => {
    const fake = world(1);
    const { client } = makeClient(fake);
    const first = await client.enrichEmails([{ apolloId: 'ghost' }]);
    expect(first.get('ghost')).toEqual({ status: 'not-found', source: 'apollo' });
    const callsBefore = fake.calls.length;
    const second = await client.enrichEmails([{ apolloId: 'ghost' }]);
    expect(second.get('ghost')).toEqual({ status: 'not-found', source: 'ledger' });
    expect(fake.calls.length).toBe(callsBefore);
    expect(client.credits.totalCredits).toBe(0);
  });

  it('does not buy the same person twice from two calls at once', async () => {
    const fake = world(1);
    const { client } = makeClient(fake);
    const [a, b] = await Promise.all([client.enrichEmails([{ apolloId: 'p0' }]), client.enrichEmails([{ apolloId: 'p0' }])]);
    expect(fake.paidCalls).toHaveLength(1);
    const statuses = [a.get('p0')?.status, b.get('p0')?.status].sort();
    expect(statuses).toEqual(['enriched', 'in-flight']);
  });

  it('estimates the credits itself, and says so, when Apollo does not state them', async () => {
    const fake = world(2);
    fake.omitCreditsConsumed = true;
    const { client, spent } = makeClient(fake);
    await client.enrichEmails([{ apolloId: 'p0' }, { apolloId: 'p1' }]);
    expect(spent).toHaveLength(1);
    expect(spent[0]).toMatchObject({ credits: 2, estimated: true });
    expect(spent[0]?.usd).toBeCloseTo(0.1);
  });

  it('reads the recorded bulk response, including the null for a missing record', async () => {
    const ledger = new InMemoryEnrichmentLedger();
    const { client } = makeClient(new FakeApollo([]), { ledger, fetch: jsonFetch(loadFixture('bulk-match.json')) });
    const outcomes = await client.enrichEmails([
      { apolloId: '64a7ff0cc4dfae00013df1a5' },
      { apolloId: 'missing-one' },
      { apolloId: '64a7ff0cc4dfae00013df1a6' }
    ]);
    const priya = outcomes.get('64a7ff0cc4dfae00013df1a5');
    expect(priya).toMatchObject({ status: 'enriched', person: { email: 'priya.raman@examplebank.com.au', emailStatus: 'verified' } });
    expect(outcomes.get('missing-one')?.status).toBe('not-found');
    expect(outcomes.get('64a7ff0cc4dfae00013df1a6')).toMatchObject({ person: { emailStatus: 'likely to engage' } });
    expect(client.credits.totalCredits).toBe(2);
  });

  it('refuses to reveal personal emails unless the client was built to allow it', async () => {
    const fake = world(1);
    await expect(makeClient(fake).client.enrichEmails([{ apolloId: 'p0' }], { revealPersonalEmails: true })).rejects.toThrow(
      PersonalEmailNotPermittedError
    );
    expect(fake.calls).toHaveLength(0);

    const permitted = makeClient(fake, { permitPersonalEmails: true });
    await permitted.client.enrichEmails([{ apolloId: 'p0' }], { revealPersonalEmails: true });
    expect(fake.calls[0]?.query.reveal_personal_emails).toBe('true');
  });

  it('needs an Apollo id, because that is what the guard keys on', async () => {
    const fake = world(1);
    await expect(makeClient(fake).client.enrichEmails([{ apolloId: '', firstName: 'No', lastName: 'Id' }])).rejects.toThrow(
      MissingApolloIdError
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('answers one person through /people/match, with the same guard', async () => {
    const fake = world(1);
    const { client } = makeClient(fake);
    const first = await client.matchPerson({ apolloId: 'p0', domain: 'bank.example' });
    expect(first).toMatchObject({ status: 'enriched', source: 'apollo', credits: 1 });
    expect(fake.calls[0]?.path).toBe('/people/match');
    const second = await client.matchPerson({ apolloId: 'p0' });
    expect(second).toMatchObject({ source: 'ledger' });
    expect(fake.paidCalls).toHaveLength(1);
  });
});

describe('phone reveal', () => {
  it('is refused without an https webhook, before anything is sent', async () => {
    const fake = world(1);
    const { client } = makeClient(fake);
    await expect(client.requestPhones([{ apolloId: 'p0' }], { webhookUrl: '' })).rejects.toThrow(PhoneWebhookRequiredError);
    await expect(client.requestPhones([{ apolloId: 'p0' }], { webhookUrl: 'http://example.com/hook' })).rejects.toThrow(/not https/);
    expect(fake.calls).toHaveLength(0);
  });

  it('asks with reveal_phone_number and the webhook, reserves the credits, and asks only once', async () => {
    const fake = world(2);
    const { client, ledger } = makeClient(fake);
    const url = 'https://sdr.example.org/webhooks/apollo?secret=s';
    const first = await client.requestPhones([{ apolloId: 'p0' }, { apolloId: 'nobody' }], { webhookUrl: url });

    expect(fake.calls[0]?.query).toMatchObject({ reveal_phone_number: 'true', webhook_url: url, reveal_personal_emails: 'false' });
    expect(first.get('p0')).toMatchObject({ status: 'requested', estimatedCredits: 8 });
    expect(first.get('nobody')).toEqual({ status: 'not-found' });
    expect(client.credits.totalCredits).toBe(8);
    expect(await ledger.getPhone('p0')).toMatchObject({ status: 'requested', estimatedCredits: 8 });

    const again = await client.requestPhones([{ apolloId: 'p0' }, { apolloId: 'nobody' }], { webhookUrl: url });
    expect(again.get('p0')).toEqual({ status: 'skipped', reason: 'already-requested' });
    expect(again.get('nobody')).toEqual({ status: 'skipped', reason: 'already-requested' });
    expect(fake.paidCalls).toHaveLength(1);
  });
});

describe('organisations and contacts', () => {
  it('enriches an organisation once, keyed on its domain', async () => {
    const fake = world(1);
    const { client } = makeClient(fake);
    const org = await client.enrichOrganization('Bank.Example');
    expect(org).toMatchObject({ apolloId: 'org1', domain: 'bank.example' });
    await client.enrichOrganization('bank.example');
    expect(fake.callsTo('/organizations/enrich')).toHaveLength(1);
    expect(client.credits.totalCredits).toBe(1);
  });

  it('lists job postings', async () => {
    const account: FakeAccount = {
      domain: 'bank.example',
      name: 'Bank',
      orgId: 'org1',
      people: [],
      jobs: [{ title: 'Data Platform Engineer', url: 'https://bank.example/careers/1', city: 'Sydney' }]
    };
    const { client } = makeClient(new FakeApollo([account]));
    const jobs = await client.organizationJobPostings('org1');
    expect(jobs).toEqual([
      { title: 'Data Platform Engineer', url: 'https://bank.example/careers/1', location: 'Sydney, Australia', postedAt: '2026-09-01' }
    ]);
  });

  it('saves an enriched person as an Apollo contact and remembers the id', async () => {
    const fake = world(1);
    const { client, ledger } = makeClient(fake);
    const outcome = await client.matchPerson({ apolloId: 'p0' });
    if (outcome.status !== 'enriched') throw new Error('expected a match');
    const id = await client.createContact(outcome.person);
    expect(id).toBe('apollo-contact-1');
    expect(fake.callsTo('/contacts')[0]?.body).toMatchObject({ first_name: 'First0', run_dedupe: true });
    expect((await ledger.getEmail('p0'))?.apolloContactId).toBe('apollo-contact-1');
  });
});

describe('rate limits and failures', () => {
  it('waits out a Retry-After and then succeeds', async () => {
    const fake = world(1);
    fake.failures.push({ status: 429, headers: { 'retry-after': '7' }, body: loadFixture('rate-limit-429.json') });
    const { client, slept } = makeClient(fake);
    const result = await client.searchPeople({ domains: ['bank.example'], titles: [], seniorities: [] });
    expect(result.people).toHaveLength(1);
    expect(slept).toEqual([7000]);
    expect(fake.calls).toHaveLength(2);
  });

  it('backs off exponentially without a Retry-After, up to the cap', async () => {
    const fake = world(1);
    for (let i = 0; i < 3; i++) fake.failures.push({ status: 429 });
    const { client, slept } = makeClient(fake, { baseDelayMs: 1000, maxDelayMs: 3000 });
    await client.searchPeople({ domains: ['bank.example'], titles: [], seniorities: [] });
    // random() is 1, so each wait is the full cap for that attempt: 1000, 2000, then 3000 (capped from 4000).
    expect(slept).toEqual([1000, 2000, 3000]);
  });

  it('gives up with a typed error after the last retry', async () => {
    const fake = world(1);
    for (let i = 0; i < 10; i++) fake.failures.push({ status: 429 });
    const { client } = makeClient(fake, { maxRetries: 2 });
    await expect(client.searchPeople({ domains: ['bank.example'], titles: [], seniorities: [] })).rejects.toThrow(ApolloRateLimitError);
    expect(fake.calls).toHaveLength(3);
  });

  it('does not sleep through a Retry-After that says to come back later', async () => {
    const fake = world(1);
    fake.failures.push({ status: 429, headers: { 'retry-after': '3600' } });
    const { client, slept } = makeClient(fake);
    await expect(client.searchPeople({ domains: ['bank.example'], titles: [], seniorities: [] })).rejects.toThrow(ApolloRateLimitError);
    expect(slept).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });

  it('retries a free call on a server error, but never repeats a paid one it cannot be sure about', async () => {
    const free = world(1);
    free.failures.push({ status: 502 });
    await makeClient(free).client.searchPeople({ domains: ['bank.example'], titles: [], seniorities: [] });
    expect(free.calls).toHaveLength(2);

    const paid = world(1);
    paid.failures.push({ status: 502, body: { error: 'bad gateway' } });
    await expect(makeClient(paid).client.enrichEmails([{ apolloId: 'p0' }])).rejects.toThrow(ApolloApiError);
    // One request: a 502 might mean "processed, reply lost", and guessing wrong would spend twice.
    expect(paid.calls).toHaveLength(1);
  });

  it('does retry a paid call that was explicitly rate-limited, since nothing was processed', async () => {
    const fake = world(1);
    fake.failures.push({ status: 429 });
    const { client } = makeClient(fake);
    const outcomes = await client.enrichEmails([{ apolloId: 'p0' }]);
    expect(outcomes.get('p0')?.status).toBe('enriched');
    expect(fake.calls).toHaveLength(2);
    expect(client.credits.totalCredits).toBe(1);
  });

  it('retries the network for a free call and not for a paid one', async () => {
    const free = world(1);
    free.failures.push({ status: 0, networkError: true });
    await makeClient(free).client.searchPeople({ domains: ['bank.example'], titles: [], seniorities: [] });
    expect(free.calls).toHaveLength(2);

    const paid = world(1);
    paid.failures.push({ status: 0, networkError: true });
    await expect(makeClient(paid).client.enrichEmails([{ apolloId: 'p0' }])).rejects.toThrow(ApolloNetworkError);
    expect(paid.calls).toHaveLength(1);
  });

  it('explains a plan error in the account\'s own words', async () => {
    const fake = world(1);
    fake.failures.push({ status: 403, body: loadFixture('plan-403.json') });
    const error = await makeClient(fake)
      .client.searchPeople({ domains: ['bank.example'], titles: [], seniorities: [] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApolloPlanError);
    expect((error as Error).message).toContain('not included in your Free plan');
    expect((error as Error).message).toContain('apollo:check');
  });

  it('names a rejected key', async () => {
    const fake = world(1);
    fake.failures.push({ status: 401, body: { error: 'Invalid access credentials.' } });
    await expect(makeClient(fake).client.searchPeople({ domains: [], titles: [], seniorities: [] })).rejects.toThrow(ApolloAuthError);
  });

  it('treats a 200 that is not the documented shape as an error, not as data', async () => {
    const bad = makeClient(new FakeApollo([]), { fetch: jsonFetch({ people: 'none' }) });
    await expect(bad.client.searchPeople({ domains: [], titles: [], seniorities: [] })).rejects.toThrow(ApolloResponseError);
    const notJson = makeClient(new FakeApollo([]), { fetch: async () => new Response('<html>', { status: 200 }) });
    await expect(notJson.client.searchPeople({ domains: [], titles: [], seniorities: [] })).rejects.toThrow(/not JSON/);
  });

  it('paces requests so a burst cannot trip the per-minute limit', async () => {
    const fake = world(1);
    let clock = 1_000_000;
    const { client, slept } = makeClient(fake, {
      minIntervalMs: 500,
      now: () => new Date(clock),
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      }
    });
    await client.searchPeople({ domains: [], titles: [], seniorities: [] });
    await client.searchPeople({ domains: [], titles: [], seniorities: [] });
    // The first request waits for nothing it needs; the second waits out the gap.
    expect(slept.filter((ms) => ms > 0).length).toBeGreaterThanOrEqual(1);
  });
});
