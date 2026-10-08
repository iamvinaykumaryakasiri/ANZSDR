import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ApolloClient } from '../../src/data/apollo-client.js';
import { phase3ConfigSchema, type Phase3Config } from '../../src/data/config.js';
import { InMemoryEnrichmentLedger, PrismaEnrichmentLedger } from '../../src/data/enrichment-ledger.js';
import { InMemoryEnrichmentQueue } from '../../src/data/enrichment-queue.js';
import { EnrichmentService, deliveryKey } from '../../src/data/enrichment.js';
import { FakeApollo, type FakeAccount, type FakePerson } from '../support/apollo-fake.js';
import { addContact, addDossier, world, type World } from '../support/phase3.js';

const WEBHOOK = 'https://sdr.example.org/webhooks/apollo?secret=s';

function person(i: number, over: Partial<FakePerson> = {}): FakePerson {
  return {
    id: `p${i}`,
    first: `First${i}`,
    last: `Lastname${i}`,
    title: 'Head of Data',
    seniority: 'head',
    email: `first${i}@bank.example`,
    emailStatus: 'verified',
    state: 'New South Wales',
    country: 'Australia',
    ...over
  };
}

const dbs: World[] = [];
afterAll(async () => {
  for (const w of dbs) await w.db.$disconnect();
});

async function setup(
  options: {
    people?: FakePerson[];
    phone?: Partial<Phase3Config['enrichment']['phone']>;
    saveContacts?: boolean;
    webhook?: string | undefined;
    withApollo?: boolean;
    queue?: boolean;
  } = {}
) {
  const w = await world();
  dbs.push(w);
  const fake = new FakeApollo([
    { domain: 'bank.example', name: 'Bank', orgId: 'org1', people: options.people ?? [0, 1, 2, 3, 4].map((i) => person(i)) } satisfies FakeAccount
  ]);
  const ledger = new PrismaEnrichmentLedger(w.db);
  const client = new ApolloClient({ apiKey: 'k', ledger, fetch: fake.fetch, sleep: async () => {}, costs: { usdPerCredit: 0.05 } });
  const config = phase3ConfigSchema.parse({
    enrichment: { saveContacts: options.saveContacts ?? true, phone: { enabled: true, minimumConfidence: 'medium', ...(options.phone ?? {}) } }
  }).enrichment;
  const queue = options.queue === false ? undefined : new InMemoryEnrichmentQueue({ sleep: async () => {}, backoffMs: 1 });
  const service = new EnrichmentService({
    db: w.db,
    ledger,
    apollo: options.withApollo === false ? undefined : client,
    config,
    webhookUrl: 'webhook' in options ? options.webhook : WEBHOOK,
    queue,
    now: () => new Date('2026-10-07T01:00:00Z')
  });
  return { w, fake, ledger, client, service, queue };
}

describe('stage one: the email', () => {
  it('plans without spending, separating what is already bought', async () => {
    const { fake, service, client } = await setup();
    await client.enrichEmails([{ apolloId: 'p0' }]);
    const before = fake.calls.length;

    const plan = await service.planEmailStage([{ apolloId: 'p0' }, { apolloId: 'p1' }, { apolloId: 'p2' }, { apolloId: 'p1' }]);
    expect(plan).toEqual({ requested: 3, fromLedger: 1, toBuy: 2, credits: 2, usd: 0.1 });
    expect(fake.calls.length).toBe(before);
  });

  it('buys best-first up to the ceiling and defers the rest, never touching the ledger hits\' budget', async () => {
    const { service, client, fake } = await setup();
    await client.enrichEmails([{ apolloId: 'p4' }]); // already ours: free, so it does not use up the ceiling

    // $0.10 at $0.05 a credit allows exactly two purchases.
    const result = await service.enrichEmailsWithinBudget(
      [0, 1, 2, 3, 4].map((i) => ({ apolloId: `p${i}` })),
      0.1
    );

    expect([...result.outcomes.keys()].sort()).toEqual(['p0', 'p1', 'p4']);
    expect(result.deferred.map((d) => d.apolloId)).toEqual(['p2', 'p3']);
    expect(result.credits).toBe(2);
    expect(result.usd).toBeCloseTo(0.1);
    expect(result.notes[0]).toContain('2 deferred');
    // The one already held is answered from the ledger and is not even sent.
    expect(fake.callsTo('/people/bulk_match').at(-1)?.body?.details).toHaveLength(2);
  });

  it('buys nothing when the ceiling is zero, but still returns what it already holds', async () => {
    const { service, client, fake } = await setup();
    await client.enrichEmails([{ apolloId: 'p0' }]);
    const before = fake.paidCalls.length;
    const result = await service.enrichEmailsWithinBudget([{ apolloId: 'p0' }, { apolloId: 'p1' }], 0);
    expect(result.outcomes.get('p0')?.status).toBe('enriched');
    expect(result.deferred.map((d) => d.apolloId)).toEqual(['p1']);
    expect(fake.paidCalls.length).toBe(before);
  });

  it('saves what it bought as Apollo contacts, so enriching them again is free, and nothing it merely looked up', async () => {
    const { service, client, fake } = await setup();
    await client.enrichEmails([{ apolloId: 'p3' }]);
    const result = await service.enrichEmailsWithinBudget([{ apolloId: 'p0' }, { apolloId: 'p1' }, { apolloId: 'p3' }], 10);
    expect(result.savedContacts).toBe(2);
    expect(fake.callsTo('/contacts')).toHaveLength(2);
  });

  it('can be told not to save contacts, and a failed save does not undo the purchase', async () => {
    const off = await setup({ saveContacts: false });
    await off.service.enrichEmailsWithinBudget([{ apolloId: 'p0' }], 10);
    expect(off.fake.callsTo('/contacts')).toHaveLength(0);

    const failing = await setup();
    failing.fake.failures.push({ status: 500, body: { error: 'no' }, path: '/contacts' });
    const result = await failing.service.enrichEmailsWithinBudget([{ apolloId: 'p1' }], 10);
    expect(result.outcomes.get('p1')?.status).toBe('enriched');
    expect(result.savedContacts).toBe(0);
    expect(result.notes.join(' ')).toContain('could not save');
    expect(await failing.ledger.getEmail('p1')).toMatchObject({ matched: true });
  });

  it('refuses to run without an Apollo client, saying why', async () => {
    const { service } = await setup({ withApollo: false });
    await expect(service.enrichEmailsWithinBudget([{ apolloId: 'p0' }], 1)).rejects.toThrow(/APOLLO_API_KEY/);
  });

  it('writes the name, a verified work email and the provenance onto the contact, from the ledger', async () => {
    const { w, service, client } = await setup();
    await client.enrichEmails([{ apolloId: 'p0' }]);
    const contactId = await addContact(w, 'bank.example', { firstName: 'First0', lastName: 'La***0', apolloId: 'p0', status: 'scored' });

    expect(await service.applyEmailFromLedger(contactId, 'p0')).toBe(true);
    const contact = await w.db.contact.findUniqueOrThrow({ where: { id: contactId }, include: { emails: true } });
    expect(contact).toMatchObject({ lastName: 'Lastname0', status: 'enriched', source: 'apollo', seniority: 'head' });
    expect(contact.lawfulBasis).toContain('legitimate business interest');
    expect(contact.emails).toMatchObject([{ kind: 'apollo_work', address: 'first0@bank.example', verified: true }]);

    const provenance = await w.db.memory.findUniqueOrThrow({ where: { id: `provenance:${contactId}:provenance-email` } });
    expect(JSON.parse(provenance.content)).toMatchObject({ source: 'Apollo.io', lawfulBasis: expect.stringContaining('B2B'), acquired: ['name', 'work email (verified)'] });
  });

  it('has nothing to write for someone never bought, or bought and not matched', async () => {
    const { w, service, client } = await setup();
    const contactId = await addContact(w, 'bank.example', { apolloId: 'ghost' });
    expect(await service.applyEmailFromLedger(contactId, 'ghost')).toBe(false);
    await client.enrichEmails([{ apolloId: 'ghost' }]);
    expect(await service.applyEmailFromLedger(contactId, 'ghost')).toBe(false);
  });

  it('never lowers a contact that has already moved on', async () => {
    const { w, service, client } = await setup();
    await client.enrichEmails([{ apolloId: 'p0' }]);
    const contactId = await addContact(w, 'bank.example', { apolloId: 'p0', status: 'researched' });
    await service.applyEmailFromLedger(contactId, 'p0');
    expect((await w.db.contact.findUniqueOrThrow({ where: { id: contactId } })).status).toBe('researched');
  });
});

describe('the research gate in front of stage two', () => {
  async function gateWorld(over: Parameters<typeof setup>[0] = {}) {
    const s = await setup(over);
    const contactId = await addContact(s.w, 'bank.example', { apolloId: 'p0' });
    return { ...s, contactId };
  }

  it('is closed while phone enrichment is off', async () => {
    const s = await gateWorld({ phone: { enabled: false } });
    await addDossier(s.w, s.contactId, 'high');
    expect(await s.service.phoneGate(s.contactId)).toMatchObject({ eligible: false, reason: expect.stringContaining('phone enrichment is off') });
  });

  it('is closed without a public https webhook, or without a client', async () => {
    const noHook = await gateWorld({ webhook: undefined });
    await addDossier(noHook.w, noHook.contactId, 'high');
    expect((await noHook.service.phoneGate(noHook.contactId)).reason).toContain('PUBLIC_BASE_URL');

    const noApollo = await gateWorld({ withApollo: false });
    expect((await noApollo.service.phoneGate(noApollo.contactId)).reason).toBe('no Apollo key');
  });

  it('is closed until there is a dossier, and for a low one', async () => {
    const s = await gateWorld();
    expect((await s.service.phoneGate(s.contactId)).reason).toContain('no dossier yet');
    await addDossier(s.w, s.contactId, 'low');
    const decision = await s.service.phoneGate(s.contactId);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toContain('dossier confidence is low');
  });

  it('opens at the configured confidence, and not before', async () => {
    const medium = await gateWorld();
    await addDossier(medium.w, medium.contactId, 'medium');
    expect((await medium.service.phoneGate(medium.contactId)).eligible).toBe(true);

    const strict = await gateWorld({ phone: { minimumConfidence: 'high' } });
    await addDossier(strict.w, strict.contactId, 'medium');
    expect((await strict.service.phoneGate(strict.contactId)).eligible).toBe(false);
    await addDossier(strict.w, strict.contactId, 'high');
    expect((await strict.service.phoneGate(strict.contactId)).eligible).toBe(true);
  });

  it('uses the latest dossier', async () => {
    const s = await gateWorld();
    await addDossier(s.w, s.contactId, 'high');
    await new Promise((r) => setTimeout(r, 5));
    await addDossier(s.w, s.contactId, 'low');
    expect((await s.service.phoneGate(s.contactId)).eligible).toBe(false);
  });

  it.each([
    ['a test contact, which already has the operator\'s own number', { kind: 'test' }],
    ['someone with no Apollo id', { apolloId: null }],
    ['someone who already has a number', { phoneE164: '+61290001234' }]
  ])('is closed for %s', async (_label, over) => {
    const s = await setup();
    const contactId = await addContact(s.w, 'bank.example', { apolloId: 'p0', ...over });
    await addDossier(s.w, contactId, 'high');
    expect((await s.service.phoneGate(contactId)).eligible).toBe(false);
  });

  it('is closed for a suppressed account or contact: no money is spent on someone we may not call', async () => {
    const byAccount = await gateWorld();
    await addDossier(byAccount.w, byAccount.contactId, 'high');
    await byAccount.w.db.suppression.create({
      data: { id: randomUUID(), scope: 'account', key: byAccount.w.accountIds.get('bank.example') as string, source: 'operator', reason: 'client' }
    });
    expect((await byAccount.service.phoneGate(byAccount.contactId)).reason).toContain('suppressed');

    const byContact = await gateWorld();
    await addDossier(byContact.w, byContact.contactId, 'high');
    await byContact.w.db.suppression.create({
      data: { id: randomUUID(), scope: 'contact', key: byContact.contactId, source: 'prospect-request', reason: 'asked' }
    });
    expect((await byContact.service.phoneGate(byContact.contactId)).reason).toContain('suppressed');
  });

  it('says so for a contact that does not exist', async () => {
    const s = await setup();
    expect((await s.service.phoneGate('nobody')).reason).toBe('no such contact');
  });
});

describe('stage two: asking for the phone', () => {
  it('queues one request when the gate passes, and places it with the webhook when the queue runs', async () => {
    const s = await setup();
    const contactId = await addContact(s.w, 'bank.example', { apolloId: 'p0' });
    await addDossier(s.w, contactId, 'medium');

    const first = await s.service.onResearched(contactId);
    expect(first).toMatchObject({ eligible: true, reason: expect.stringContaining('queued') });
    const second = await s.service.onResearched(contactId);
    expect(second.reason).toContain('already queued');
    expect(s.fake.paidCalls).toHaveLength(0); // queued, not yet placed

    await s.service.startWorker();
    expect(await s.queue!.drain()).toEqual({ processed: 1, failed: [] });
    const call = s.fake.paidCalls[0]!;
    expect(call.query).toMatchObject({ reveal_phone_number: 'true', webhook_url: WEBHOOK });
    expect(await s.ledger.getPhone('p0')).toMatchObject({ status: 'requested' });
    expect(s.client.credits.totalCredits).toBe(8);
  });

  it('asks the gate again when the job actually runs', async () => {
    const s = await setup();
    const contactId = await addContact(s.w, 'bank.example', { apolloId: 'p0' });
    await addDossier(s.w, contactId, 'medium');
    await s.service.onResearched(contactId);
    // Between queueing and running, the account is suppressed.
    await s.w.db.suppression.create({
      data: { id: randomUUID(), scope: 'account', key: s.w.accountIds.get('bank.example') as string, source: 'operator', reason: 'client' }
    });
    await s.service.startWorker();
    await s.queue!.drain();
    expect(s.fake.paidCalls).toHaveLength(0);
  });

  it('places the request straight away when there is no queue', async () => {
    const s = await setup({ queue: false });
    const contactId = await addContact(s.w, 'bank.example', { apolloId: 'p0' });
    await addDossier(s.w, contactId, 'high');
    const decision = await s.service.onResearched(contactId);
    expect(decision.reason).toContain('phone requested now');
    expect(s.fake.paidCalls).toHaveLength(1);
  });

  it('buys nothing when the gate is closed', async () => {
    const s = await setup();
    const contactId = await addContact(s.w, 'bank.example', { apolloId: 'p0' });
    await addDossier(s.w, contactId, 'low');
    expect((await s.service.onResearched(contactId)).eligible).toBe(false);
    expect(s.fake.calls).toHaveLength(0);
    expect((await s.queue!.stats()).waiting).toBe(0);
  });

  it('puts a held-without-email contact through stage one from the queue', async () => {
    const s = await setup();
    const contactId = await addContact(s.w, 'bank.example', { firstName: 'First1', lastName: 'Lastname1', apolloId: 'p1', status: 'scored' });
    expect(await s.service.enqueueEmailBackfill()).toBe(1);
    expect(await s.service.enqueueEmailBackfill()).toBe(0);
    await s.service.startWorker();
    await s.queue!.drain();
    expect(await s.w.db.contactEmail.count({ where: { contactId } })).toBe(1);
    expect((await s.w.db.contact.findUniqueOrThrow({ where: { id: contactId } })).status).toBe('enriched');
  });

  it('will not run a backfill without a queue', async () => {
    const s = await setup({ queue: false });
    await expect(s.service.enqueueEmailBackfill()).rejects.toThrow(/no queue/);
    await expect(s.service.startWorker()).rejects.toThrow(/no queue/);
  });
});

describe('what arrives by webhook', () => {
  async function requested(over: Parameters<typeof setup>[0] = {}) {
    const s = await setup(over);
    await s.client.enrichEmails([{ apolloId: 'p0' }]);
    const contactId = await addContact(s.w, 'bank.example', { apolloId: 'p0', firstName: 'First0', lastName: 'Lastname0' });
    await s.ledger.recordPhoneRequest({
      apolloId: 'p0',
      requestedAt: '2026-10-07T00:00:00.000Z',
      estimatedCredits: 8,
      status: 'requested',
      deliveries: [],
      numbers: []
    });
    return { ...s, contactId };
  }

  const direct = { number: '+61290001234', kind: 'work_direct' as const };
  const mobile = { number: '+61412345678', kind: 'mobile' as const };

  it('geo-tags the number and keeps the office direct dial over the mobile', async () => {
    const s = await requested();
    const result = await s.service.applyPhoneDelivery('p0', [mobile, direct]);
    expect(result).toMatchObject({ status: 'applied', chosen: '+61290001234' });
    const contact = await s.w.db.contact.findUniqueOrThrow({ where: { id: s.contactId } });
    // The profile said New South Wales and the 02 area code agrees.
    expect(contact).toMatchObject({ phoneE164: '+61290001234', phoneLine: 'fixed', jurisdiction: 'au-nsw', timezone: 'Australia/Sydney' });
    const provenance = await s.w.db.memory.findUniqueOrThrow({ where: { id: `provenance:${s.contactId}:provenance-phone` } });
    expect(JSON.parse(provenance.content).detail).toContain('direct, fixed, AU');
  });

  it('keeps a mobile, flagged as one, when it is all there is', async () => {
    const s = await requested();
    await s.service.applyPhoneDelivery('p0', [mobile]);
    expect(await s.w.db.contact.findUniqueOrThrow({ where: { id: s.contactId } })).toMatchObject({ phoneE164: '+61412345678', phoneLine: 'mobile' });
  });

  it('is idempotent: the same delivery twice changes nothing the second time', async () => {
    const s = await requested();
    expect((await s.service.applyPhoneDelivery('p0', [direct])).status).toBe('applied');
    const before = await s.w.db.contact.findUniqueOrThrow({ where: { id: s.contactId } });
    expect(await s.service.applyPhoneDelivery('p0', [direct])).toEqual({ status: 'duplicate' });
    const after = await s.w.db.contact.findUniqueOrThrow({ where: { id: s.contactId } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect((await s.ledger.getPhone('p0'))?.deliveries).toHaveLength(1);
  });

  it('recognises the same delivery whatever order the numbers arrive in', () => {
    expect(deliveryKey('p0', [direct, mobile])).toBe(deliveryKey('p0', [mobile, direct]));
    expect(deliveryKey('p0', [direct])).not.toBe(deliveryKey('p1', [direct]));
  });

  it('refuses numbers for someone we never asked about', async () => {
    const s = await requested();
    expect(await s.service.applyPhoneDelivery('stranger', [direct])).toEqual({ status: 'unrequested' });
  });

  it('does not replace a test contact\'s own number with a prospect\'s data', async () => {
    const s = await requested();
    await s.w.db.contact.update({ where: { id: s.contactId }, data: { kind: 'test', phoneE164: '+61448455510', phoneLine: 'mobile' } });
    await s.service.applyPhoneDelivery('p0', [direct]);
    expect((await s.w.db.contact.findUniqueOrThrow({ where: { id: s.contactId } })).phoneE164).toBe('+61448455510');
  });

  it('records a delivery for a person no longer on the blackboard without inventing a contact', async () => {
    const s = await requested();
    await s.w.db.contact.delete({ where: { id: s.contactId } });
    expect(await s.service.applyPhoneDelivery('p0', [direct])).toMatchObject({ status: 'applied', contactId: undefined });
    expect((await s.ledger.getPhone('p0'))?.status).toBe('delivered');
  });

  it('keeps nothing from a delivery of home numbers only, and says so in the provenance', async () => {
    const s = await requested();
    await s.service.applyPhoneDelivery('p0', [{ number: '+61290001234', kind: 'home' }]);
    expect((await s.w.db.contact.findUniqueOrThrow({ where: { id: s.contactId } })).phoneE164).toBeNull();
    const provenance = await s.w.db.memory.findUniqueOrThrow({ where: { id: `provenance:${s.contactId}:provenance-phone` } });
    expect(JSON.parse(provenance.content).detail).toContain('personal line');
  });

  it('works against the in-memory ledger too', async () => {
    const w = await world();
    dbs.push(w);
    const ledger = new InMemoryEnrichmentLedger();
    const service = new EnrichmentService({ db: w.db, ledger, config: phase3ConfigSchema.parse({}).enrichment });
    await ledger.recordPhoneRequest({ apolloId: 'x', requestedAt: '2026-10-07T00:00:00.000Z', estimatedCredits: 8, status: 'requested', deliveries: [], numbers: [] });
    expect(await service.applyPhoneDelivery('x', [direct])).toMatchObject({ status: 'applied', contactId: undefined });
  });
});
