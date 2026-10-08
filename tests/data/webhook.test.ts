import { afterAll, afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { APOLLO_WEBHOOK_SECRET_HEADER, apolloWebhook, buildWebhookUrl } from '../../src/data/apollo-webhook.js';
import { ApolloClient } from '../../src/data/apollo-client.js';
import { PrismaEnrichmentLedger } from '../../src/data/enrichment-ledger.js';
import { FakeApollo, loadFixture, phoneWebhookBody } from '../support/apollo-fake.js';
import { addContact, world, type World } from '../support/phase3.js';

const SECRET = 's3cret-value';
// The id in the recorded webhook payload.
const APOLLO_ID = '64a7ff0cc4dfae00013df1a5';

const worlds: World[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});
afterAll(async () => {
  for (const w of worlds) await w.db.$disconnect();
});

async function setup(options: { secret?: string; asked?: boolean } = {}) {
  const w = await world();
  worlds.push(w);
  const ledger = new PrismaEnrichmentLedger(w.db);
  // The person was bought (so their location is known) and a phone reveal was requested.
  const fake = new FakeApollo([
    {
      domain: 'bank.example',
      name: 'Bank',
      orgId: 'org1',
      people: [{ id: APOLLO_ID, first: 'Priya', last: 'Raman', title: 'Chief Data Officer', email: 'priya@bank.example', state: 'New South Wales', country: 'Australia' }]
    }
  ]);
  const client = new ApolloClient({ apiKey: 'k', ledger, fetch: fake.fetch, sleep: async () => {} });
  await client.enrichEmails([{ apolloId: APOLLO_ID }]);
  const contactId = await addContact(w, 'bank.example', { apolloId: APOLLO_ID, firstName: 'Priya', lastName: 'Raman' });
  if (options.asked !== false) {
    await ledger.recordPhoneRequest({
      apolloId: APOLLO_ID,
      requestedAt: '2026-10-07T00:00:00.000Z',
      estimatedCredits: 8,
      status: 'requested',
      deliveries: [],
      numbers: []
    });
  }
  const app = Fastify();
  apps.push(app);
  await app.register(apolloWebhook, { db: w.db, ...(options.secret !== undefined ? { secret: options.secret } : { secret: SECRET }) });
  return { w, app, ledger, contactId };
}

const payload = (): unknown => loadFixture('phone-webhook.json');

describe('who may deliver', () => {
  it('turns away a request with no secret, before reading the body', async () => {
    const { app, ledger } = await setup();
    const res = await app.inject({ method: 'POST', url: '/webhooks/apollo', payload: payload() as object });
    expect(res.statusCode).toBe(401);
    expect((await ledger.getPhone(APOLLO_ID))?.status).toBe('requested');
  });

  it('turns away the wrong secret, including one of a different length', async () => {
    const { app } = await setup();
    for (const wrong of ['nope', `${SECRET}x`, SECRET.slice(0, -1), '']) {
      const res = await app.inject({ method: 'POST', url: `/webhooks/apollo?secret=${wrong}`, payload: payload() as object });
      expect(res.statusCode).toBe(401);
    }
  });

  it('accepts the secret in the query string, which is where Apollo can put it', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: `/webhooks/apollo?secret=${SECRET}`, payload: payload() as object });
    expect(res.statusCode).toBe(200);
  });

  it('accepts the secret in a header, for a sender that can set one', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/apollo',
      headers: { [APOLLO_WEBHOOK_SECRET_HEADER]: SECRET },
      payload: payload() as object
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses everything, rather than accepting everything, when no secret is configured', async () => {
    const { app, ledger } = await setup({ secret: '' });
    const res = await app.inject({ method: 'POST', url: '/webhooks/apollo?secret=', payload: payload() as object });
    expect(res.statusCode).toBe(503);
    expect((await ledger.getPhone(APOLLO_ID))?.status).toBe('requested');
  });
});

describe('what it does with a delivery', () => {
  const url = `/webhooks/apollo?secret=${SECRET}`;

  it('puts the best number on the contact, geo-tagged and line-typed', async () => {
    const { app, w, contactId } = await setup();
    const res = await app.inject({ method: 'POST', url, payload: payload() as object });
    expect(res.json()).toEqual({ status: 'ok', applied: 1, duplicate: 0, unrequested: 0 });

    const contact = await w.db.contact.findUniqueOrThrow({ where: { id: contactId } });
    // The recorded payload carries an office direct dial and a mobile; the direct dial is kept.
    expect(contact).toMatchObject({ phoneE164: '+61290001234', phoneLine: 'fixed', jurisdiction: 'au-nsw', timezone: 'Australia/Sydney' });
  });

  it('is idempotent: Apollo retrying the same delivery changes nothing', async () => {
    const { app, w, ledger, contactId } = await setup();
    await app.inject({ method: 'POST', url, payload: payload() as object });
    const first = await w.db.contact.findUniqueOrThrow({ where: { id: contactId } });

    for (let i = 0; i < 3; i++) {
      const retry = await app.inject({ method: 'POST', url, payload: payload() as object });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual({ status: 'ok', applied: 0, duplicate: 1, unrequested: 0 });
    }
    expect(await w.db.contact.findUniqueOrThrow({ where: { id: contactId } })).toEqual(first);
    expect((await ledger.getPhone(APOLLO_ID))?.deliveries).toHaveLength(1);
  });

  it('survives two copies of the same delivery arriving together', async () => {
    const { app, ledger } = await setup();
    const results = await Promise.all([
      app.inject({ method: 'POST', url, payload: payload() as object }),
      app.inject({ method: 'POST', url, payload: payload() as object })
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect((await ledger.getPhone(APOLLO_ID))?.deliveries).toHaveLength(1);
  });

  it('acknowledges and drops a delivery for someone we never asked about', async () => {
    const { app, w, contactId } = await setup({ asked: false });
    const res = await app.inject({ method: 'POST', url, payload: payload() as object });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', applied: 0, duplicate: 0, unrequested: 1 });
    expect((await w.db.contact.findUniqueOrThrow({ where: { id: contactId } })).phoneE164).toBeNull();
  });

  it('handles several people in one delivery', async () => {
    const { app } = await setup();
    const body = payload() as { people: unknown[] };
    body.people.push((phoneWebhookBody('someone-else', [{ sanitized: '+61290009999', type: 'work_direct' }]) as { people: unknown[] }).people[0]);
    const res = await app.inject({ method: 'POST', url, payload: body as object });
    expect(res.json()).toEqual({ status: 'ok', applied: 1, duplicate: 0, unrequested: 1 });
  });

  it('records "nothing found" when Apollo found no number', async () => {
    const { app, ledger, w, contactId } = await setup();
    const res = await app.inject({ method: 'POST', url, payload: phoneWebhookBody(APOLLO_ID, []) as object });
    expect(res.statusCode).toBe(200);
    expect((await ledger.getPhone(APOLLO_ID))?.status).toBe('none');
    expect((await w.db.contact.findUniqueOrThrow({ where: { id: contactId } })).phoneE164).toBeNull();
  });

  it('says 400 to a body it cannot read, since retrying it will not help', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url, payload: { people: 'none' } });
    expect(res.statusCode).toBe(400);
  });

  it('does not echo numbers back', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url, payload: payload() as object });
    expect(res.body).not.toContain('+61');
  });
});

describe('the URL handed to Apollo', () => {
  it('is https with the secret, or nothing at all', () => {
    expect(buildWebhookUrl('https://sdr.example.org/', 'a b&c')).toBe('https://sdr.example.org/webhooks/apollo?secret=a%20b%26c');
    expect(buildWebhookUrl('http://sdr.example.org', 's')).toBeUndefined();
    expect(buildWebhookUrl('', 's')).toBeUndefined();
    expect(buildWebhookUrl('https://sdr.example.org', '  ')).toBeUndefined();
  });
});
