/**
 * The real Prospector (section 3.3, section 5.2): it owns contact acquisition.
 *
 * Search is free and returns discovery data only. Everyone found is scored
 * against the ICP, deduplicated against everything already held, and only then
 * - and only up to the run's spend ceiling - enriched for an email.
 *
 * There is no model in this agent, and that is deliberate. Every step either
 * costs money or decides whether money is spent, and each of them has an exact
 * answer: the ICP score is a pure function (`src/data/icp.ts`), the
 * deduplication is a database query, the budget is arithmetic. A model here
 * could only make a decision that must be reproducible less reproducible. The
 * contract still names a model for the day Prospector needs one; none is called.
 *
 * Phone numbers are not bought here. They wait for Scout's dossier (the
 * research gate) and arrive later by webhook; see `src/data/enrichment.ts`.
 */

import { z } from 'zod';
import { defineAgent, type Agent, type AgentTool } from '../contract.js';
import type { Blackboard } from '../../blackboard/client.js';
import type { PeopleSearchQuery, PeopleSearchResult } from '../../data/apollo-client.js';
import type { PersonRecord } from '../../data/apollo-types.js';
import type { Phase3Config } from '../../data/config.js';
import { accountSuppression, findHeldContacts, isFullyHeld, type AccountHold, type HeldContact } from '../../data/dedupe.js';
import type { EnrichmentService } from '../../data/enrichment.js';
import { rankCandidates, scorePerson, type ScoreResult } from '../../data/icp.js';
import {
  PROSPECTOR_BUDGET,
  prospectorContract,
  type Prospect,
  type ProspectorInput,
  type ProspectorOutput
} from './contract.js';

/** What the Prospector needs from a people directory. The Apollo client satisfies it. */
export interface PeopleDirectory {
  searchPeople(query: PeopleSearchQuery): Promise<PeopleSearchResult>;
}

export interface ProspectorDeps {
  db: Blackboard;
  directory: PeopleDirectory;
  enrichment: EnrichmentService;
  config: Phase3Config;
}

const searchArgs = z.object({
  domain: z.string().min(1),
  titles: z.array(z.string()),
  seniorities: z.array(z.string()),
  pages: z.number().int().min(1).max(5),
  perPage: z.number().int().min(1).max(100)
});

const lookupArgs = z.object({
  accountId: z.string().min(1),
  domain: z.string().min(1),
  candidates: z.array(
    z.object({
      apolloId: z.string().min(1),
      firstName: z.string(),
      lastName: z.string(),
      lastNameObfuscated: z.boolean()
    })
  )
});

const enrichArgs = z.object({
  requests: z.array(
    z.object({
      apolloId: z.string().min(1),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      domain: z.string().optional()
    })
  ),
  maxUsd: z.number().nonnegative()
});

interface LookupResult {
  hold: AccountHold | null;
  held: Array<[string, HeldContact]>;
}

type EnrichToolResult = Awaited<ReturnType<EnrichmentService['enrichEmailsWithinBudget']>>;

function peopleSearchTool(directory: PeopleDirectory): AgentTool {
  return {
    name: 'people-search',
    description: 'Find people at an organisation by title and seniority. Discovery only: no emails, no phone numbers. Free.',
    input: searchArgs,
    usdPerCall: 0,
    handler: async (args) => {
      const a = searchArgs.parse(args);
      const seen = new Set<string>();
      const out: PersonRecord[] = [];
      for (let page = 1; page <= a.pages; page++) {
        const result = await directory.searchPeople({
          domains: [a.domain],
          titles: a.titles,
          seniorities: a.seniorities,
          page,
          perPage: a.perPage
        });
        for (const p of result.people) {
          if (seen.has(p.apolloId)) continue;
          seen.add(p.apolloId);
          out.push(p);
        }
        const last = result.totalPages !== undefined ? page >= result.totalPages : result.people.length < a.perPage;
        if (last) break;
      }
      return out;
    }
  };
}

function heldContactsTool(db: Blackboard): AgentTool {
  return {
    name: 'held-contacts',
    description: 'Who we already hold at this account, and whether the account is suppressed. Reads the blackboard.',
    input: lookupArgs,
    usdPerCall: 0,
    handler: async (args): Promise<LookupResult> => {
      const a = lookupArgs.parse(args);
      const hold = await accountSuppression(db, { accountId: a.accountId, domain: a.domain });
      const held = await findHeldContacts(db, a.accountId, a.candidates);
      return { hold, held: [...held.entries()] };
    }
  };
}

function enrichEmailsTool(enrichment: EnrichmentService): AgentTool {
  return {
    name: 'enrich-emails',
    description:
      'Buy work emails for the people given, best first, up to the dollar ceiling. Anyone already bought is free. This is the only tool that spends.',
    input: enrichArgs,
    // The cost is dynamic and enforced inside, against `maxUsd`; a flat figure here would be wrong either way.
    handler: async (args): Promise<EnrichToolResult> => {
      const a = enrichArgs.parse(args);
      return enrichment.enrichEmailsWithinBudget(
        a.requests.map((r) => ({
          apolloId: r.apolloId,
          ...(r.firstName !== undefined ? { firstName: r.firstName } : {}),
          ...(r.lastName !== undefined ? { lastName: r.lastName } : {}),
          ...(r.domain !== undefined ? { domain: r.domain } : {})
        })),
        a.maxUsd
      );
    }
  };
}

export function prospectorTools(deps: ProspectorDeps): AgentTool[] {
  return [peopleSearchTool(deps.directory), heldContactsTool(deps.db), enrichEmailsTool(deps.enrichment)];
}

interface Candidate {
  person: PersonRecord;
  score: ScoreResult;
  sortName: string;
}

export function createProspector(deps: ProspectorDeps): Agent<ProspectorInput, ProspectorOutput> {
  return defineAgent(prospectorContract(prospectorTools(deps)), async (ctx) => {
    const { icp, domain, limit, accountId, accountName } = ctx.input;
    const { weights } = deps.config.scoring;

    const found = await ctx.call<PersonRecord[]>('people-search', {
      domain,
      titles: icp.titles,
      seniorities: icp.seniorities,
      pages: deps.config.scoring.searchPages,
      perPage: deps.config.scoring.searchPerPage
    });
    ctx.note(`searched ${domain} (free) and found ${found.length} people`);

    const rejected: ProspectorOutput['rejected'] = [];
    const qualified: Candidate[] = [];
    for (const person of found) {
      if (person.title === '') {
        rejected.push({ externalId: person.apolloId, reason: 'no job title, so nothing to score' });
        continue;
      }
      const score = scorePerson(
        { title: person.title, seniority: person.seniority, linkedinUrl: person.linkedinUrl },
        icp,
        weights
      );
      if (score.score < icp.minimumScore) {
        rejected.push({ externalId: person.apolloId, reason: `scored ${score.score}: ${score.rationale}` });
        continue;
      }
      qualified.push({ person, score, sortName: `${person.lastName} ${person.firstName}` });
    }
    ctx.note(`${qualified.length} cleared the ICP minimum of ${icp.minimumScore}; ${found.length - qualified.length} did not`);

    const lookup = await ctx.call<LookupResult>('held-contacts', {
      accountId,
      domain,
      candidates: qualified.map((q) => ({
        apolloId: q.person.apolloId,
        firstName: q.person.firstName,
        lastName: q.person.lastName,
        lastNameObfuscated: q.person.lastNameObfuscated
      }))
    });

    if (lookup.hold !== null) {
      ctx.note(`${accountName} is suppressed (${lookup.hold.scope}: ${lookup.hold.reason}); nothing will be bought`);
      for (const q of qualified) {
        rejected.push({ externalId: q.person.apolloId, reason: `account is suppressed: ${lookup.hold.reason}` });
      }
      return { accountId, prospects: [], rejected, searchedAt: new Date().toISOString() };
    }

    const held = new Map(lookup.held);
    const fresh: Candidate[] = [];
    for (const q of qualified) {
      const h = held.get(q.person.apolloId);
      if (h !== undefined && isFullyHeld(h)) {
        rejected.push({ externalId: q.person.apolloId, reason: `already held as contact ${h.contactId} (matched by ${h.how}); not bought again` });
      } else {
        fresh.push(q);
      }
    }
    if (fresh.length < qualified.length) {
      ctx.note(`${qualified.length - fresh.length} already held; they are neither re-bought nor re-researched`);
    }

    const ranked = rankCandidates(
      fresh.map((c) => ({ person: c.person, score: c.score.score, seniority: c.score.seniority, sortName: c.sortName }))
    );
    const chosen = ranked.slice(0, limit);
    for (const c of ranked.slice(limit)) {
      rejected.push({ externalId: c.person.apolloId, reason: `qualified, but beyond this run's limit of ${limit}` });
    }

    if (chosen.length === 0) {
      ctx.note('nobody new to enrich');
      return { accountId, prospects: [], rejected, searchedAt: new Date().toISOString() };
    }

    const plan = await deps.enrichment.planEmailStage(chosen.map((c) => ({ apolloId: c.person.apolloId })));
    ctx.note(
      `stage one: ${plan.toBuy} email(s) to buy (about ${plan.credits} credit(s), $${plan.usd.toFixed(2)}) and ${plan.fromLedger} already bought; ` +
        `ceiling for this run is $${PROSPECTOR_BUDGET.maxUsd.toFixed(2)}`
    );

    const result = await ctx.call<EnrichToolResult>('enrich-emails', {
      requests: chosen.map((c) => ({
        apolloId: c.person.apolloId,
        firstName: c.person.firstName,
        // A masked surname would only confuse the match; the Apollo id identifies the person.
        ...(c.person.lastNameObfuscated ? {} : { lastName: c.person.lastName }),
        domain
      })),
      maxUsd: PROSPECTOR_BUDGET.maxUsd
    });
    // Over the tool boundary the Map arrives as the same Map: tools are in-process.
    for (const n of result.notes) ctx.note(n);

    const deferredIds = new Set(result.deferred.map((d) => d.apolloId));
    const prospects: Prospect[] = [];
    let bought = 0;
    let fromLedger = 0;

    for (const c of chosen) {
      const id = c.person.apolloId;
      if (deferredIds.has(id)) {
        rejected.push({ externalId: id, reason: "deferred: this run's Apollo spend ceiling was reached; next run" });
        continue;
      }
      const outcome = result.outcomes.get(id);
      if (outcome === undefined || outcome.status === 'in-flight') {
        rejected.push({ externalId: id, reason: 'another enrichment of this person is already in progress' });
        continue;
      }
      if (outcome.status === 'not-found') {
        rejected.push({ externalId: id, reason: 'Apollo could not match this person; no credits were charged' });
        continue;
      }

      const p = outcome.person;
      // Enrichment reveals the real surname, the real title and often a profile
      // link, so the person is scored again on what is now known.
      const rescored = scorePerson(
        { title: p.title === '' ? c.person.title : p.title, seniority: p.seniority ?? c.person.seniority, linkedinUrl: p.linkedinUrl ?? c.person.linkedinUrl },
        icp,
        weights
      );
      if (rescored.disqualified) {
        rejected.push({ externalId: id, reason: `after enrichment: ${rescored.rationale}` });
        continue;
      }

      if (outcome.source === 'apollo') bought += 1;
      else fromLedger += 1;
      const linkedinUrl = p.linkedinUrl ?? c.person.linkedinUrl;
      prospects.push({
        externalId: id,
        firstName: p.firstName === '' ? c.person.firstName : p.firstName,
        lastName: p.lastName === '' ? c.person.lastName : p.lastName,
        title: p.title === '' ? c.person.title : p.title,
        seniority: rescored.seniority,
        ...(linkedinUrl !== undefined && /^https?:\/\//i.test(linkedinUrl) ? { linkedinUrl } : {}),
        icpScore: Math.max(c.score, rescored.score),
        scoreRationale: rescored.rationale,
        ...(p.email !== undefined ? { email: p.email } : {}),
        ...(p.emailStatus !== undefined ? { emailStatus: p.emailStatus } : {}),
        enrichmentSource: outcome.source
      });
    }

    const withEmail = prospects.filter((p) => p.email !== undefined).length;
    ctx.note(
      `${prospects.length} prospect(s) returned, ${withEmail} with an email: ${bought} bought (${result.credits} credit(s), $${result.usd.toFixed(2)}), ${fromLedger} from the ledger for nothing, ${result.deferred.length} deferred`
    );

    return {
      accountId,
      prospects,
      rejected,
      searchedAt: new Date().toISOString(),
      enrichment: {
        requested: chosen.length,
        bought,
        fromLedger,
        deferred: result.deferred.length,
        credits: result.credits,
        usd: result.usd
      }
    };
  });
}
