/**
 * A fake Apollo that speaks Apollo's wire shapes, so the real client runs against
 * it unchanged.
 *
 * It is a `fetch`, not a mock of the client: the client builds real requests
 * (URL, query string, headers, JSON body), this answers them with responses shaped
 * like the recorded ones in `tests/fixtures/apollo/`, and keeps a record of
 * every call. That record is what the "zero duplicate spend" assertions count.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './fixtures.js';

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, 'tests/fixtures/apollo', name), 'utf8')) as T;
}

export interface FakePerson {
  id: string;
  first: string;
  last: string;
  title: string;
  /** Apollo's seniority band. The newer People Search omits it; enrichment returns it. */
  seniority?: string;
  email?: string;
  emailStatus?: string;
  city?: string;
  state?: string;
  country?: string;
  linkedin?: string;
  phones?: Array<{ sanitized: string; type: string }>;
}

export interface FakeAccount {
  domain: string;
  name: string;
  orgId: string;
  industry?: string;
  jobs?: Array<{ title: string; url: string; city?: string }>;
  people: FakePerson[];
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

export interface ScriptedFailure {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Throw instead of answering, as a dropped connection would. */
  networkError?: boolean;
  /** Only fail a request to this path; others pass over it. */
  path?: string;
}

const PAID_PATHS = ['/people/bulk_match', '/people/match', '/organizations/enrich'];

export class FakeApollo {
  readonly calls: RecordedCall[] = [];
  /** Consumed, one per request, before any normal answer. */
  readonly failures: ScriptedFailure[] = [];
  /** Leave `credits_consumed` out of bulk answers, as Apollo sometimes does. */
  omitCreditsConsumed = false;
  private contactSeq = 0;

  constructor(readonly accounts: FakeAccount[]) {}

  get paidCalls(): RecordedCall[] {
    return this.calls.filter((c) => PAID_PATHS.includes(c.path));
  }

  callsTo(path: string): RecordedCall[] {
    return this.calls.filter((c) => c.path === path);
  }

  private person(id: string): { person: FakePerson; account: FakeAccount } | undefined {
    for (const account of this.accounts) {
      const person = account.people.find((p) => p.id === id);
      if (person !== undefined) return { person, account };
    }
    return undefined;
  }

  private matchBody(found: { person: FakePerson; account: FakeAccount }): Record<string, unknown> {
    const { person: p, account } = found;
    return {
      id: p.id,
      first_name: p.first,
      last_name: p.last,
      name: `${p.first} ${p.last}`,
      title: p.title,
      ...(p.seniority !== undefined ? { seniority: p.seniority } : {}),
      ...(p.linkedin !== undefined ? { linkedin_url: p.linkedin } : {}),
      ...(p.email !== undefined ? { email: p.email, email_status: p.emailStatus ?? 'verified' } : { email_status: 'unavailable' }),
      city: p.city,
      state: p.state,
      country: p.country,
      organization_id: account.orgId,
      organization: { id: account.orgId, name: account.name, primary_domain: account.domain },
      // The reveal is asynchronous: the synchronous reply carries no phones.
      phone_numbers: []
    };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      headers
    };
    this.calls.push(call);

    const at = this.failures.findIndex((f) => f.path === undefined || f.path === call.path);
    const failure = at === -1 ? undefined : this.failures.splice(at, 1)[0];
    if (failure !== undefined) {
      if (failure.networkError === true) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(failure.body ?? {}), {
        status: failure.status,
        headers: { 'content-type': 'application/json', ...(failure.headers ?? {}) }
      });
    }
    return this.answer(call);
  };

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  }

  private answer(call: RecordedCall): Response {
    if (call.path === '/mixed_people/search' || call.path === '/mixed_people/api_search') {
      const domains = (call.body?.q_organization_domains_list ?? []) as string[];
      const account = this.accounts.find((a) => domains.includes(a.domain));
      const people = (account?.people ?? []).map((p) => ({
        id: p.id,
        first_name: p.first,
        // The current People Search masks the surname and returns no seniority or email.
        last_name_obfuscated: `${p.last.slice(0, 2)}***${p.last.slice(-1)}`,
        title: p.title,
        has_email: p.email !== undefined,
        has_direct_phone: 'Yes',
        organization: { name: account?.name }
      }));
      return this.json({ total_entries: people.length, people, pagination: { page: 1, per_page: 50, total_entries: people.length, total_pages: 1 } });
    }

    if (call.path === '/people/bulk_match') {
      const details = (call.body?.details ?? []) as Array<{ id?: string }>;
      const revealPhone = call.query.reveal_phone_number === 'true';
      const matches = details.map((d) => {
        const found = d.id === undefined ? undefined : this.person(d.id);
        return found === undefined ? null : this.matchBody(found);
      });
      const withEmail = matches.filter((m) => m !== null && typeof m.email === 'string').length;
      return this.json({
        status: 'success',
        total_requested_enrichments: details.length,
        unique_enriched_records: matches.filter((m) => m !== null).length,
        missing_records: matches.filter((m) => m === null).length,
        ...(this.omitCreditsConsumed ? {} : { credits_consumed: revealPhone ? matches.length * 8 : withEmail }),
        matches
      });
    }

    if (call.path === '/people/match') {
      const id = call.body?.id as string | undefined;
      const found = id === undefined ? undefined : this.person(id);
      return this.json({ person: found === undefined ? null : this.matchBody(found) });
    }

    if (call.path === '/contacts') {
      this.contactSeq += 1;
      return this.json({ contact: { id: `apollo-contact-${this.contactSeq}` } });
    }

    if (call.path === '/organizations/enrich') {
      const account = this.accounts.find((a) => a.domain === call.query.domain);
      return this.json({
        organization:
          account === undefined
            ? null
            : { id: account.orgId, name: account.name, primary_domain: account.domain, industry: account.industry ?? 'financial services' }
      });
    }

    const jobs = /^\/organizations\/([^/]+)\/job_postings$/.exec(call.path);
    if (jobs !== null) {
      const account = this.accounts.find((a) => a.orgId === decodeURIComponent(jobs[1] as string));
      return this.json({
        organization_job_postings: (account?.jobs ?? []).map((j, i) => ({
          id: `job-${i}`,
          title: j.title,
          url: j.url,
          city: j.city,
          country: 'Australia',
          posted_at: '2026-09-01'
        }))
      });
    }

    return this.json({ error: `fake Apollo has no route for ${call.method} ${call.path}` }, 404);
  }
}

/** An Apollo phone-delivery body for one person, in the recorded shape. */
export function phoneWebhookBody(apolloId: string, numbers: Array<{ sanitized: string; type: string }>): unknown {
  return {
    status: 'success',
    people: [
      {
        id: apolloId,
        status: 'success',
        phone_numbers: numbers.map((n) => ({
          raw_number: n.sanitized,
          sanitized_number: n.sanitized,
          type_cd: n.type,
          confidence_cd: 'high',
          status_cd: 'valid_number',
          dnc_status_cd: null
        }))
      }
    ]
  };
}
