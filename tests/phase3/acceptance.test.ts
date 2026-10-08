/**
 * Phase 3 acceptance (brief section 13):
 *
 *   20 real contacts across 5 ANZ accounts with verified emails,
 *   source-attributed dossiers, and zero duplicate Apollo spend.
 *
 * Fixture-driven: Apollo is a fake that speaks Apollo's wire shapes (the real
 * client runs against it unchanged), the web is a fake that serves pages and
 * robots.txt to the real policy fetcher, and the model is scripted. There is no
 * key and no network. The people and companies are invented.
 *
 * What this proves is the machinery: that the right people are bought, that
 * nothing is bought twice, that nothing unsourced reaches a dossier, and that a
 * low-confidence dossier reaches Caller with no hooks. Whether the first real
 * model call writes a good dossier is `npm run scout`.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { assembleBriefing } from '../../src/agents/caller/briefing.js';
import { loadIdentityFromObject } from '../../src/agents/caller/identity.js';
import { PolicyFetcher } from '../../src/agents/scout/fetcher.js';
import type { ScoutModel } from '../../src/agents/scout/model.js';
import type { ResearchTools } from '../../src/agents/scout/sources.js';
import { SpendLedger } from '../../src/blackboard/repositories.js';
import { apolloWebhook } from '../../src/data/apollo-webhook.js';
import { phase3ConfigSchema } from '../../src/data/config.js';
import { InMemoryEnrichmentQueue } from '../../src/data/enrichment-queue.js';
import { createPhase3Runtime } from '../../src/data/runtime.js';
import { ClaimIndex } from '../../src/knowledge/claims.js';
import { PROSPECT_ACCOUNT, RESEARCH_CONTACT } from '../../src/orchestrator/kinds.js';
import { FakeApollo, phoneWebhookBody, type FakeAccount } from '../support/apollo-fake.js';
import { ANZ_ICP, harness, type Harness } from '../support/harness.js';

// Each test runs 25 tasks against a real database, twice in one case; under a loaded machine that outlasts the 5s default.
vi.setConfig({ testTimeout: 90_000 });

const ICP = { ...ANZ_ICP, titles: [...ANZ_ICP.titles, 'head of technology'], seniorities: ['c_suite', 'vp', 'head', 'director'] };

const COMPANIES = [
  { domain: 'northgate-bank.example', name: 'Northgate Bank', country: 'AU' as const, state: 'New South Wales', where: 'Australia' },
  { domain: 'harbour-credit.example', name: 'Harbour Credit', country: 'AU' as const, state: 'Victoria', where: 'Australia' },
  { domain: 'swan-mutual.example', name: 'Swan Mutual', country: 'AU' as const, state: 'Western Australia', where: 'Australia' },
  { domain: 'kauri-building-society.example', name: 'Kauri Building Society', country: 'NZ' as const, state: 'Auckland', where: 'New Zealand' },
  { domain: 'tui-bank.example', name: 'Tui Bank', country: 'NZ' as const, state: 'Wellington', where: 'New Zealand' }
];

const TITLES: Array<[string, string]> = [
  ['Chief Data Officer', 'c_suite'],
  ['Head of Data Platforms', 'head'],
  ['Director of Engineering', 'director'],
  ['Head of Technology', 'head'],
  ['Technical Recruiter', 'manager'],
  ['Marketing Director', 'director']
];

/** The invented people. Alex<account><n>: four qualify, two never should. */
function apolloWorld(): FakeApollo {
  const accounts: FakeAccount[] = COMPANIES.map((c, i) => ({
    domain: c.domain,
    name: c.name,
    orgId: `org${i}`,
    people: TITLES.map(([title, seniority], j) => ({
      id: `a${i}p${j}`,
      first: `Alex${i}${j}`,
      last: `Surname${i}${j}`,
      title,
      seniority,
      email: `alex${i}${j}@${c.domain}`,
      emailStatus: 'verified',
      state: c.state,
      country: c.where,
      linkedin: `https://www.linkedin.com/in/alex-${i}${j}`
    }))
  }));
  return new FakeApollo(accounts);
}

const NEWS_SENTENCE = (name: string): string => `${name} today announced a three-year core banking modernisation programme.`;
const JOBS_SENTENCE = (name: string): string => `${name} is hiring six data platform engineers; Databricks is required.`;

/** A small web: each company has a home page, a news item and a careers page. */
function theWeb() {
  const pages = new Map<string, string>();
  for (const c of COMPANIES) {
    pages.set(`https://${c.domain}/`, `<title>${c.name}</title><p>${c.name} is a mid-tier ${c.where} financial institution.</p>`);
    pages.set(`https://${c.domain}/news/modernisation`, `<p>${NEWS_SENTENCE(c.name)}</p>`);
    pages.set(`https://${c.domain}/careers/data-platform`, `<p>${JOBS_SENTENCE(c.name)}</p>`);
  }
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain' } });
    const body = pages.get(url);
    return body === undefined ? new Response('nope', { status: 404 }) : new Response(body, { headers: { 'content-type': 'text/html' } });
  };
  const tools: ResearchTools = {
    search: {
      search: async (query) => {
        const company = COMPANIES.find((c) => query.includes(c.name));
        if (company === undefined) return [];
        return [
          `https://${company.domain}/news/modernisation`,
          `https://${company.domain}/careers/data-platform`,
          'https://www.linkedin.com/in/someone'
        ].map((url) => ({ url, title: url }));
      }
    },
    fetcher: new PolicyFetcher({ fetch: fetchImpl })
  };
  return { tools, requested };
}

const claim = (text: string, sourceUrl: string, quote: string) => ({ text, sourceUrl, quote });

/**
 * A scripted model that reads its prompt: it finds the documents it was shown and
 * quotes them. Two contacts are made to misbehave on purpose.
 */
function scriptedScout(): ScoutModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async synthesize(request) {
      prompts.push(request.user);
      const who = /Person: (Alex\d\d)/.exec(request.user)?.[1] ?? '';
      const docs = new Map<string, string>();
      for (const m of request.user.matchAll(/<document url="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/document>/g)) docs.set(m[1] as string, m[2] as string);
      const news = [...docs].find(([u]) => u.endsWith('/news/modernisation'));
      const jobs = [...docs].find(([u]) => u.endsWith('/careers/data-platform'));

      let draft: Record<string, unknown>;
      if (who === 'Alex30') {
        // The model that cannot find anything: its own honest answer is nothing.
        draft = { hypothesis: 'No trigger', confidence: 'low', hooks: [] };
      } else if (news === undefined || jobs === undefined) {
        draft = {};
      } else {
        const newsQuote = /announced a three-year core banking modernisation programme/.exec(news[1])?.[0] ?? '';
        const jobsQuote = /hiring six data platform engineers; Databricks is required/.exec(jobs[1])?.[0] ?? '';
        draft = {
          hypothesis: 'Likely focused on delivering the core modernisation',
          hypothesisSources: [news[0]],
          confidence: 'high',
          account: {
            announcements: [claim('Announced a three-year core banking modernisation', news[0], newsQuote)],
            techSignals: [claim('Is hiring six data platform engineers', jobs[0], jobsQuote)],
            pressures: [] as unknown[]
          },
          hooks: [
            claim('Announced a three-year core banking modernisation', news[0], newsQuote),
            claim('Is hiring six data platform engineers who know Databricks', jobs[0], jobsQuote)
          ]
        };
        if (who === 'Alex10') {
          // Adds a rumour with no source, and a "fact" whose quote is on no page.
          (draft.account as { pressures: unknown[] }).pressures = [
            { text: 'Heard they are cutting the technology budget' },
            claim('Plans to move its core to a hyperscaler next year', news[0], 'plans to move its core platform to a hyperscaler next year')
          ];
        }
      }
      return { text: JSON.stringify(draft), tokensIn: 9000, tokensOut: 700, usd: 0.07 };
    }
  };
}

const identity = loadIdentityFromObject({
  agent: { name: 'Lexi', gender: 'female', accent: 'au-neutral' },
  operator: { name: 'Vinay Kumar', title: 'Sales Director', company: 'Hexaware Technologies', team: 'the ANZ sales team' },
  callback: { number: '+61280000000' }
});

const open: Harness[] = [];
afterAll(async () => {
  for (const h of open) await h.close();
});

async function build(options: { phone?: boolean } = {}) {
  const h = await harness({ maxTasksPerTick: 80, weeklyUsdCeiling: 100 });
  open.push(h);
  const fake = apolloWorld();
  const web = theWeb();
  const model = scriptedScout();
  const queue = new InMemoryEnrichmentQueue({ sleep: async () => {}, backoffMs: 1 });
  const runtime = await createPhase3Runtime({
    db: h.db,
    spend: new SpendLedger(h.db),
    env: { APOLLO_API_KEY: 'test-key', PUBLIC_BASE_URL: 'https://sdr.example.org', APOLLO_WEBHOOK_SECRET: 'whsec' },
    config: phase3ConfigSchema.parse({ enrichment: { phone: { enabled: options.phone ?? false } } }),
    queue,
    apolloFetch: fake.fetch,
    apolloMinIntervalMs: 0,
    apolloSleep: async () => {},
    research: web.tools,
    scoutModel: model,
    scoutModelConfig: { scout: 'claude-opus-5', scout_search: 'claude-haiku-4-5', prices_usd_per_mtok: {} },
    now: () => new Date()
  });
  // The same task kinds, with the real handlers behind them.
  h.registry.register(runtime.prospectKind!);
  h.registry.register(runtime.researchKind!);

  const accountIds = new Map<string, string>();
  for (const c of COMPANIES) {
    const id = `acct-${c.domain}`;
    accountIds.set(c.domain, id);
    await h.db.account.create({
      data: { id, campaignId: h.campaignId, name: c.name, domain: c.domain, country: c.country, industry: 'financial services', priority: 1, status: 'new' }
    });
  }
  const queueProspecting = async (): Promise<void> => {
    for (const c of COMPANIES) {
      await h.tasks.create({
        kind: PROSPECT_ACCOUNT,
        priority: 1,
        campaignId: h.campaignId,
        accountId: accountIds.get(c.domain) as string,
        payload: { campaignId: h.campaignId, accountId: accountIds.get(c.domain), accountName: c.name, domain: c.domain, icp: ICP, limit: 10 }
      });
    }
  };
  const tickUntilIdle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) {
      const report = await h.director.tick();
      if (report.ranTasks === 0) return;
      expect(report.escalated).toBe(0);
    }
  };
  return { h, fake, web, model, runtime, queue, queueProspecting, tickUntilIdle };
}

describe('Phase 3 acceptance: 20 contacts across 5 accounts', () => {
  it('finds, enriches and researches them, with every dossier source-attributed', async () => {
    const t = await build();
    await t.queueProspecting();
    await t.tickUntilIdle();
    const { h } = t;

    // Twenty contacts, four per account, and not the recruiter or the marketing director.
    const contacts = await h.db.contact.findMany({ include: { emails: true, account: true } });
    expect(contacts).toHaveLength(20);
    expect(contacts.every((c) => !/Technical Recruiter|Marketing Director/.test(c.title))).toBe(true);
    expect(new Set(contacts.map((c) => c.account.domain)).size).toBe(5);

    // Each has a real name (not the masked one the search returned) and a verified work email.
    for (const c of contacts) {
      expect(c.lastName).not.toContain('*');
      expect(c.emails).toHaveLength(1);
      expect(c.emails[0]).toMatchObject({ kind: 'apollo_work', verified: true });
      expect(c.emails[0]?.address).toBe(`${c.firstName.toLowerCase()}@${c.account.domain}`);
      expect(c).toMatchObject({ status: 'researched', source: 'apollo' });
      expect(c.lawfulBasis).toContain('legitimate business interest');
      expect(await h.db.memory.findUnique({ where: { id: `provenance:${c.id}:provenance-email` } })).not.toBeNull();
    }

    // Twenty dossiers. Every fact and hook in them points at a page that was actually fetched.
    const dossiers = await h.db.dossier.findMany();
    expect(dossiers).toHaveLength(20);
    const fetched = new Set(t.web.requested.filter((u) => !u.endsWith('/robots.txt')));
    for (const d of dossiers) {
      const urls: string[] = [
        ...(JSON.parse(d.hooks) as Array<{ sourceUrl: string }>).map((x) => x.sourceUrl),
        ...(JSON.parse(d.landmines) as Array<{ sourceUrl: string }>).map((x) => x.sourceUrl),
        ...(JSON.parse(d.account) as { techSignals: Array<{ sourceUrl: string }>; announcements: Array<{ sourceUrl: string }>; pressures: Array<{ sourceUrl: string }> }).techSignals.map((x) => x.sourceUrl),
        ...(JSON.parse(d.sources) as string[])
      ];
      for (const u of urls) {
        expect(u).toMatch(/^https:\/\//);
        expect(fetched.has(u)).toBe(true);
      }
    }
    expect(dossiers.filter((d) => d.confidence !== 'low').length).toBe(19);

    // LinkedIn was offered in every search and on every contact, and never touched.
    expect(t.web.requested.some((u) => u.includes('linkedin'))).toBe(false);
  });

  it('spends one credit per person the first time and nothing at all the second', async () => {
    const t = await build();
    await t.queueProspecting();
    await t.tickUntilIdle();
    const { h, fake } = t;

    // Four people at each of five accounts, one request per account, ten at a time at most.
    expect(fake.paidCalls).toHaveLength(5);
    const bought = fake.callsTo('/people/bulk_match').flatMap((c) => (c.body?.details as Array<{ id: string }>).map((d) => d.id));
    expect(bought).toHaveLength(20);
    expect(new Set(bought).size).toBe(20);
    expect(bought.some((id) => /p[45]$/.test(id))).toBe(false); // never the recruiter or the marketing director

    const ledgerApollo = async (): Promise<number> =>
      (await h.db.spendRecord.aggregate({ _sum: { usd: true }, where: { category: 'apollo' } }))._sum.usd ?? 0;
    expect(await ledgerApollo()).toBeCloseTo(20 * 0.05, 6);
    expect(await fake.callsTo('/contacts').length).toBe(20); // saved as Apollo contacts, so re-enriching is free

    // Second run over the same five accounts.
    const paidBefore = fake.paidCalls.length;
    const tasksBefore = await h.db.task.count({ where: { kind: RESEARCH_CONTACT } });
    await t.queueProspecting();
    await t.tickUntilIdle();

    expect(fake.paidCalls.length).toBe(paidBefore);
    expect(await ledgerApollo()).toBeCloseTo(1.0, 6);
    expect(await h.db.contact.count()).toBe(20);
    expect(await h.db.task.count({ where: { kind: RESEARCH_CONTACT } })).toBe(tasksBefore);
    expect(await h.db.dossier.count()).toBe(20);
  });

  it('does not re-buy even when the blackboard has forgotten the people: the ledger remembers', async () => {
    const t = await build();
    await t.queueProspecting();
    await t.tickUntilIdle();
    const { h, fake } = t;
    const paid = fake.paidCalls.length;

    // Wipe everything the orchestrator wrote. The enrichment ledger is separate.
    await h.db.dossier.deleteMany();
    await h.db.contactEmail.deleteMany();
    await h.db.traceEvent.deleteMany();
    await h.db.agentRun.deleteMany();
    await h.db.task.deleteMany();
    await h.db.contact.deleteMany();
    await t.queueProspecting();
    await t.tickUntilIdle();

    expect(fake.paidCalls.length).toBe(paid);
    const contacts = await h.db.contact.findMany({ include: { emails: true } });
    expect(contacts).toHaveLength(20);
    // The emails came back from the ledger, verified, for nothing.
    expect(contacts.every((c) => c.emails.length === 1 && c.emails[0]?.verified === true)).toBe(true);
  });

  it('drops the unsourced and the unquotable, and says so in the dossier', async () => {
    const t = await build();
    await t.queueProspecting();
    await t.tickUntilIdle();
    const contact = await t.h.db.contact.findFirstOrThrow({ where: { firstName: 'Alex10' } });
    const dossier = await t.h.db.dossier.findFirstOrThrow({ where: { contactId: contact.id } });

    const account = JSON.parse(dossier.account) as { pressures: unknown[]; announcements: unknown[] };
    expect(account.pressures).toEqual([]);
    expect(account.announcements).toHaveLength(1);
    const unverified = JSON.parse(dossier.unverified) as string[];
    expect(unverified.join(' | ')).toContain('dropped pressure (no source URL): Heard they are cutting the technology budget');
    expect(unverified.join(' | ')).toContain('dropped pressure (the quote is not in the source)');
    // The good material around it survived, so the dossier is still useful.
    expect(JSON.parse(dossier.hooks)).toHaveLength(2);
    // More than half of the model's proposals were not dropped, so this is not capped.
    expect(['high', 'medium']).toContain(dossier.confidence);
  });

  it('gives Caller no hooks from a low-confidence dossier', async () => {
    const t = await build();
    await t.queueProspecting();
    await t.tickUntilIdle();
    const contact = await t.h.db.contact.findFirstOrThrow({ where: { firstName: 'Alex30' }, include: { account: true } });
    const row = await t.h.db.dossier.findFirstOrThrow({ where: { contactId: contact.id } });

    expect(row.confidence).toBe('low');
    expect(JSON.parse(row.hooks)).toEqual([]);

    const pack = assembleBriefing({
      identity,
      prospect: { contactId: contact.id, name: `${contact.firstName} ${contact.lastName}`, firstName: contact.firstName, title: contact.title, accountName: contact.account.name, market: contact.account.country as 'AU' | 'NZ' },
      dossier: {
        hypothesis: row.hypothesis,
        confidence: row.confidence as 'low',
        hooks: JSON.parse(row.hooks) as Array<{ text: string; sourceUrl: string }>,
        landmines: (JSON.parse(row.landmines) as Array<{ fact: string }>).map((l) => l.fact),
        unverified: JSON.parse(row.unverified) as string[]
      },
      claims: ClaimIndex.fromObject({ version: 1, claims: [] }),
      pack: { sections: [], missing: [] }
    });
    expect(pack.hooks).toEqual([]);
    expect(pack.notes.join(' ')).toContain('dossier confidence is low');
  });

  it('narrates the whole thing in the trace, in words', async () => {
    const t = await build();
    await t.queueProspecting();
    await t.tickUntilIdle();
    const lines = (await t.h.trace.recent(500)).map((x) => `${x.actor}: ${x.summary}`);
    expect(lines.some((l) => /prospector: stage one: 4 email\(s\) to buy \(about 4 credit\(s\), \$0\.20\)/.test(l))).toBe(true);
    expect(lines.some((l) => /prospector: 4 prospect\(s\) returned, 4 with an email: 4 bought/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith('scout: dropped 2 claim(s) the evidence did not support'))).toBe(true);
    expect(lines.some((l) => l.startsWith('enrichment: phone stage for') && l.includes('phone enrichment is off'))).toBe(true);
  });
});

describe('Phase 3: the second stage', () => {
  it('asks for phone numbers only for dossiers that pass the research gate, with the webhook, and files what arrives', async () => {
    const t = await build({ phone: true });
    await t.queueProspecting();
    await t.tickUntilIdle();
    await t.runtime.enrichment.startWorker();
    expect(await t.queue.drain()).toMatchObject({ processed: 19, failed: [] });

    const phoneCalls = t.fake.callsTo('/people/bulk_match').filter((c) => c.query.reveal_phone_number === 'true');
    const asked = phoneCalls.flatMap((c) => (c.body?.details as Array<{ id: string }>).map((d) => d.id));
    // Nineteen, not twenty: the low-confidence dossier did not earn a phone.
    expect(asked).toHaveLength(19);
    expect(asked).not.toContain('a3p0'); // Alex30
    for (const c of phoneCalls) expect(c.query.webhook_url).toBe('https://sdr.example.org/webhooks/apollo?secret=whsec');

    // Apollo calls back, twice (it retries), and the number lands geo-tagged.
    const app = Fastify();
    await app.register(apolloWebhook, { db: t.h.db, secret: 'whsec' });
    const body = phoneWebhookBody('a2p0', [
      { sanitized: '+61892001234', type: 'work_direct' },
      { sanitized: '+61412345678', type: 'mobile' }
    ]) as object;
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'POST', url: '/webhooks/apollo?secret=whsec', payload: body });
      expect(res.statusCode).toBe(200);
    }
    await app.close();

    const swan = await t.h.db.contact.findFirstOrThrow({ where: { apolloId: 'a2p0' } });
    // Swan Mutual is in Western Australia: the 08 area code and the profile agree.
    expect(swan).toMatchObject({ phoneE164: '+61892001234', phoneLine: 'fixed', jurisdiction: 'au-wa', timezone: 'Australia/Perth' });
    expect((await t.h.db.contact.count({ where: { phoneE164: { not: null } } }))).toBe(1);
  });

  it('never asks while phone enrichment is off', async () => {
    const t = await build({ phone: false });
    await t.queueProspecting();
    await t.tickUntilIdle();
    expect(t.fake.callsTo('/people/bulk_match').filter((c) => c.query.reveal_phone_number === 'true')).toHaveLength(0);
    expect((await t.queue.stats()).waiting).toBe(0);
  });
});
