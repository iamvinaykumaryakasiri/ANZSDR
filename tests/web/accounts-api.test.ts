/**
 * The account desk. It edits the list of people the system will call, so the
 * things worth testing are that it is not reachable without the token, that a
 * pasted spreadsheet lands correctly, and that removing a worked account does
 * not take its call history with it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { buildServer } from '../../src/web/server.js';
import { parseAccountRows, toCsv } from '../../src/web/accounts-api.js';
import { randomUUID } from 'node:crypto';
import { ANZ_ICP } from '../support/harness.js';

const TOKEN = 'test-token-0123456789';

let live: Array<{ app: FastifyInstance; db: Blackboard }> = [];
afterEach(async () => {
  for (const { app, db } of live) {
    await app.close();
    await db.$disconnect();
  }
  live = [];
});

async function server(): Promise<{ app: FastifyInstance; db: Blackboard; campaignId: string }> {
  const db = await createTestBlackboard();
  const app = buildServer({ db, adminToken: TOKEN });
  live.push({ app, db });

  const campaignId = randomUUID();
  await db.campaign.create({
    data: {
      id: campaignId,
      name: 'ANZ BFSI pilot',
      market: 'AU',
      status: 'active',
      icp: JSON.stringify(ANZ_ICP),
      goal: JSON.stringify({ meetingsPerWeek: 3, maxUsdPerWeek: 25 })
    }
  });
  return { app, db, campaignId };
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe('the door', () => {
  it('refuses the API without the token', async () => {
    const { app } = await server();
    const response = await app.inject({ method: 'GET', url: '/api/campaigns' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a wrong token, including one that is merely a prefix', async () => {
    const { app } = await server();
    for (const value of ['nope', TOKEN.slice(0, -1), TOKEN + 'x', '']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/campaigns',
        headers: { authorization: `Bearer ${value}` }
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('will not start at all without a token configured', async () => {
    const db = await createTestBlackboard();
    expect(() => buildServer({ db, adminToken: '   ' })).toThrow(/ADMIN_TOKEN is required/);
    await db.$disconnect();
  });

  it('serves the page and a health check without one', async () => {
    const { app } = await server();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Account desk');
  });
});

describe('the ICP', () => {
  it('returns the campaign with its titles and goal', async () => {
    const { app } = await server();
    const body = (await app.inject({ method: 'GET', url: '/api/campaigns', headers: auth })).json();
    expect(body[0].icp.titles).toContain('head of data');
    expect(body[0].goal.maxUsdPerWeek).toBe(25);
  });

  it('saves a new title list', async () => {
    const { app, db, campaignId } = await server();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/campaigns/${campaignId}/icp`,
      headers: auth,
      payload: { titles: ['chief information officer'], seniorities: ['c_suite'], disqualifiers: [], minimumScore: 70 }
    });
    expect(response.statusCode).toBe(200);
    const saved = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(JSON.parse(saved.icp).titles).toEqual(['chief information officer']);
  });

  it('refuses an ICP that does not match the schema', async () => {
    const { app, campaignId } = await server();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/campaigns/${campaignId}/icp`,
      headers: auth,
      payload: { titles: 'not an array' }
    });
    expect(response.statusCode).toBe(400);
  });

  it('saves the weekly spend ceiling the Director obeys', async () => {
    const { app, db, campaignId } = await server();
    await app.inject({
      method: 'PUT',
      url: `/api/campaigns/${campaignId}/goal`,
      headers: auth,
      payload: { meetingsPerWeek: 5, maxUsdPerWeek: 40 }
    });
    const saved = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(JSON.parse(saved.goal).maxUsdPerWeek).toBe(40);
  });

  it('404s on a campaign that does not exist', async () => {
    const { app } = await server();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/campaigns/nope/icp',
      headers: auth,
      payload: { titles: [], seniorities: [] }
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('accounts', () => {
  const add = (app: FastifyInstance, campaignId: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/campaigns/${campaignId}/accounts`, headers: auth, payload });

  it('adds one, tidying the domain as it goes', async () => {
    const { app, db, campaignId } = await server();
    const response = await add(app, campaignId, {
      name: 'Example Bank',
      domain: ' HTTPS://Examplebank.com.au/careers ',
      country: 'AU'
    });
    expect(response.statusCode).toBe(201);
    const account = await db.account.findFirstOrThrow();
    expect(account.domain).toBe('examplebank.com.au');
    expect(account.priority).toBe(3);
    expect(account.status).toBe('new');
  });

  it('refuses the same domain twice on one campaign', async () => {
    const { app, campaignId } = await server();
    await add(app, campaignId, { name: 'Example Bank', domain: 'examplebank.com.au', country: 'AU' });
    const second = await add(app, campaignId, { name: 'Example Bank Ltd', domain: 'examplebank.com.au', country: 'AU' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain('already on this campaign');
  });

  it('changes priority and status', async () => {
    const { app, db, campaignId } = await server();
    await add(app, campaignId, { name: 'Example Bank', domain: 'examplebank.com.au', country: 'AU' });
    const account = await db.account.findFirstOrThrow();
    await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      headers: auth,
      payload: { priority: 1, status: 'calling' }
    });
    const updated = await db.account.findFirstOrThrow();
    expect(updated.priority).toBe(1);
    expect(updated.status).toBe('calling');
    // A patch of one field leaves the others alone.
    expect(updated.name).toBe('Example Bank');
  });

  it('deletes an account nobody has been contacted at', async () => {
    const { app, db, campaignId } = await server();
    await add(app, campaignId, { name: 'Example Bank', domain: 'examplebank.com.au', country: 'AU' });
    const account = await db.account.findFirstOrThrow();
    const response = await app.inject({ method: 'DELETE', url: `/api/accounts/${account.id}`, headers: auth });
    expect(response.json().closed).toBe(false);
    expect(await db.account.count()).toBe(0);
  });

  it('closes rather than deletes an account with contacts on the record', async () => {
    const { app, db, campaignId } = await server();
    await add(app, campaignId, { name: 'Example Bank', domain: 'examplebank.com.au', country: 'AU' });
    const account = await db.account.findFirstOrThrow();
    await db.contact.create({
      data: {
        id: randomUUID(),
        accountId: account.id,
        campaignId,
        firstName: 'Priya',
        lastName: 'Raman',
        title: 'CDO',
        status: 'researched'
      }
    });

    const response = await app.inject({ method: 'DELETE', url: `/api/accounts/${account.id}`, headers: auth });
    expect(response.json().closed).toBe(true);
    expect(response.json().message).toContain('closed rather than deleted');
    expect((await db.account.findFirstOrThrow()).status).toBe('closed');
    expect(await db.contact.count()).toBe(1);
  });
});

describe('pasting people', () => {
  async function withAccount() {
    const ctx = await server();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/campaigns/${ctx.campaignId}/accounts`,
      headers: auth,
      payload: { name: 'Kiwibank', domain: 'kiwibank.co.nz', country: 'NZ' }
    });
    return ctx;
  }

  const paste = (ctx: Awaited<ReturnType<typeof withAccount>>, text: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/campaigns/${ctx.campaignId}/contacts/import`,
      headers: auth,
      payload: { text }
    });

  it('imports a person and normalises the number for the compliance gate', async () => {
    const ctx = await withAccount();
    const response = await paste(ctx, 'Test\tOne\tHead of Data\tkiwibank.co.nz\t04 111 2222\tt1@example.com\thead\t\ttest');
    expect(response.json()).toMatchObject({ added: 1, updated: 0, prospects: 0 });

    const contact = await ctx.db.contact.findFirstOrThrow({ include: { emails: true } });
    expect(contact.firstName).toBe('Test');
    expect(contact.kind).toBe('test');
    // Stored as E.164 with its line type worked out, not as the spreadsheet had it.
    expect(contact.phoneE164).toBe('+6441112222');
    expect(contact.phoneLine).toBe('fixed');
    expect(contact.status).toBe('enriched');
    expect(contact.source).toBe('operator');
    expect(contact.emails[0]?.address).toBe('t1@example.com');
  });

  it('treats anything that does not say "test" as a real person', async () => {
    const ctx = await withAccount();
    const response = await paste(
      ctx,
      [
        'A\tOne\tCIO\tkiwibank.co.nz\t+6441112222\t\tc_suite\t\ttest',
        'B\tTwo\tCIO\tkiwibank.co.nz\t+6441112223\t\tc_suite\t\tprospect',
        'C\tThree\tCIO\tkiwibank.co.nz\t+6441112224\t\tc_suite\t\t',
        'D\tFour\tCIO\tkiwibank.co.nz\t+6441112225\t\tc_suite\t\ttypo'
      ].join('\n')
    );
    // Only the explicit "test" row is dialable in test mode. A blank or a typo
    // defaults to a real person, because the other default could ring a stranger.
    expect(response.json()).toMatchObject({ added: 4, prospects: 3 });
    const kinds = await ctx.db.contact.findMany({ orderBy: { firstName: 'asc' }, select: { kind: true } });
    expect(kinds.map((k) => k.kind)).toEqual(['test', 'prospect', 'prospect', 'prospect']);
  });

  it('refuses a person at an account that is not on the campaign', async () => {
    const ctx = await withAccount();
    const response = await paste(ctx, 'Test\tOne\tCIO\tnotonthelist.co.nz\t+6441112222\t\thead\t\ttest');
    expect(response.json()).toMatchObject({ added: 0, updated: 0 });
    expect(response.json().skipped[0].reason).toContain('notonthelist.co.nz');
  });

  it('corrects rather than duplicates when the same person is pasted again', async () => {
    const ctx = await withAccount();
    await paste(ctx, 'Test\tOne\tHead of Data\tkiwibank.co.nz\t+6441112222\t\thead\t\ttest');
    const second = await paste(ctx, 'Test\tOne\tChief Data Officer\tkiwibank.co.nz\t+6441119999\t\tc_suite\t\ttest');

    expect(second.json()).toMatchObject({ added: 0, updated: 1 });
    expect(await ctx.db.contact.count()).toBe(1);
    const contact = await ctx.db.contact.findFirstOrThrow();
    expect(contact.title).toBe('Chief Data Officer');
    expect(contact.phoneE164).toBe('+6441119999');
  });

  it('keeps a person with no usable number rather than dropping them', async () => {
    const ctx = await withAccount();
    await paste(ctx, 'Test\tOne\tCIO\tkiwibank.co.nz\tnot a number\t\thead\t\ttest');
    const contact = await ctx.db.contact.findFirstOrThrow();
    expect(contact.phoneE164).toBeNull();
    expect(contact.phoneLine).toBeNull();
  });

  it('skips a row missing a name or a title, saying which', async () => {
    const ctx = await withAccount();
    const response = await paste(ctx, '\t\t\tkiwibank.co.nz\t+6441112222\t\thead\t\ttest');
    expect(response.json().added).toBe(0);
    expect(response.json().skipped[0].reason).toContain('firstName');
  });

  it('lists people with whether each one is dialable', async () => {
    const ctx = await withAccount();
    await paste(
      ctx,
      ['A\tOne\tCIO\tkiwibank.co.nz\t+6441112222\t\tc_suite\t\ttest',
       'B\tTwo\tCIO\tkiwibank.co.nz\t+6441112223\t\tc_suite\t\tprospect'].join('\n')
    );
    const listed = (
      await ctx.app.inject({ method: 'GET', url: `/api/campaigns/${ctx.campaignId}/contacts`, headers: auth })
    ).json();
    expect(listed).toHaveLength(2);
    expect(listed.map((c: { kind: string }) => c.kind).sort()).toEqual(['prospect', 'test']);
    expect(listed[0].account).toBe('Kiwibank');
  });

  it('exports what it imported', async () => {
    const ctx = await withAccount();
    await paste(ctx, 'Test\tOne\tHead of Data\tkiwibank.co.nz\t+6441112222\tt1@example.com\thead\t\ttest');
    const csv = await ctx.app.inject({
      method: 'GET',
      url: `/api/campaigns/${ctx.campaignId}/contacts.csv`,
      headers: auth
    });
    expect(csv.body.split('\n')[0]).toBe(
      'first_name,last_name,title,account_domain,phone,email,seniority,linkedin_url,kind,notes'
    );
    expect(csv.body).toContain('Test,One,Head of Data,kiwibank.co.nz,+6441112222,t1@example.com,head,,test,');
  });
});

describe('pasting a spreadsheet', () => {
  it('reads tab-separated rows without a header', () => {
    const rows = parseAccountRows('Example Bank\texamplebank.com.au\tAU\tfinancial services\t1\tmet at a conference');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.values).toMatchObject({
      account_name: 'Example Bank',
      domain: 'examplebank.com.au',
      priority: '1'
    });
  });

  it('honours a header row whose columns are in a different order', () => {
    const rows = parseAccountRows('Domain,Account Name\nexamplebank.com.au,Example Bank');
    expect(rows[0]?.values).toMatchObject({ domain: 'examplebank.com.au', account_name: 'Example Bank' });
    expect(rows[0]?.row).toBe(2);
  });

  it('keeps a comma inside a cell when the paste is tab-separated', () => {
    // Exactly what a paste out of Excel looks like for an account called "Bank, The".
    const rows = parseAccountRows('Bank, The\tbank.com.au\tAU');
    expect(rows[0]?.values).toMatchObject({ account_name: 'Bank, The', domain: 'bank.com.au', country: 'AU' });
  });

  it('handles quoted cells containing commas', () => {
    const rows = parseAccountRows('account_name,domain,country,industry,priority,notes\n"Bank, The",bank.com.au,AU,banking,2,"said ""not now"""');
    expect(rows[0]?.values.account_name).toBe('Bank, The');
    expect(rows[0]?.values.notes).toBe('said "not now"');
  });

  it('imports, updates a domain already present, and says what it skipped', async () => {
    const { app, db, campaignId } = await server();
    const first = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campaignId}/accounts/import`,
      headers: auth,
      payload: {
        text: [
          'Example Bank\texamplebank.com.au\tAU\tfinancial services\t1',
          'Another Bank\tanotherbank.co.nz\tNZ\tfinancial services\t2',
          '\t\tAU'
        ].join('\n')
      }
    });
    expect(first.json()).toMatchObject({ added: 2, updated: 0 });
    expect(first.json().skipped).toHaveLength(1);
    expect(first.json().skipped[0].row).toBe(3);

    const second = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campaignId}/accounts/import`,
      headers: auth,
      payload: { text: 'Example Bank Limited\texamplebank.com.au\tAU\tfinancial services\t1' }
    });
    expect(second.json()).toMatchObject({ added: 0, updated: 1 });
    expect(await db.account.count()).toBe(2);
    expect((await db.account.findFirstOrThrow({ where: { domain: 'examplebank.com.au' } })).name).toBe(
      'Example Bank Limited'
    );
  });

  it('defaults a missing country to the campaign market', async () => {
    const { app, db, campaignId } = await server();
    await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campaignId}/accounts/import`,
      headers: auth,
      payload: { text: 'Example Bank\texamplebank.com.au' }
    });
    expect((await db.account.findFirstOrThrow()).country).toBe('AU');
  });

  it('exports what it imported, in the columns the brief names', async () => {
    const { app, campaignId } = await server();
    await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campaignId}/accounts/import`,
      headers: auth,
      payload: { text: 'Bank, The\tbank.com.au\tAU\tbanking\t2\tsaid "not now"' }
    });
    const csv = await app.inject({ method: 'GET', url: `/api/campaigns/${campaignId}/accounts.csv`, headers: auth });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('account_name,domain,country,industry,priority,notes');
    expect(csv.body).toContain('"Bank, The"');
    expect(csv.body).toContain('"said ""not now"""');
  });

  it('round-trips through the CSV writer', () => {
    expect(toCsv([{ account_name: 'Plain', domain: 'a.com', country: 'AU', industry: 'x', priority: 1, notes: '' }]))
      .toContain('Plain,a.com,AU,x,1,');
  });
});
