/**
 * The Apollo client (brief section 5.2).
 *
 * Four properties are the point of this file, and each is structural rather than
 * a habit of whoever calls it:
 *
 *   1. It never re-buys. Every paid method asks the enrichment ledger first and
 *      answers from it when it can; the HTTP request is simply never made. A
 *      repeat purchase is not refused with an error that a caller might catch
 *      and retry around - it is impossible to express.
 *   2. Phone numbers are only ever requested with a public https webhook_url,
 *      because Apollo delivers them asynchronously and cannot deliver them
 *      anywhere else. Without one the call is refused before a credit moves.
 *   3. `reveal_personal_emails` is off, and a client has to be built with the
 *      permission before a call can turn it on.
 *   4. Credits are counted. Every paid call produces an entry the spend hook
 *      sees, taken from Apollo's own figure when it gives one.
 *
 * Search is free and returns discovery data only: no emails, no phone numbers.
 * Everything that costs a credit goes through enrichment.
 */

import { ApolloNotConfiguredError, ApolloApiError, ApolloAuthError, ApolloNetworkError, ApolloPlanError, ApolloRateLimitError, ApolloResponseError, MissingApolloIdError, PersonalEmailNotPermittedError, PhoneWebhookRequiredError } from './errors.js';
import {
  bulkMatchResponseSchema,
  contactCreateResponseSchema,
  jobPostingsResponseSchema,
  matchResponseSchema,
  normaliseEnrichedPerson,
  normaliseOrganization,
  normalisePerson,
  normalisePhones,
  organizationEnrichResponseSchema,
  peopleSearchResponseSchema,
  type EnrichedPerson,
  type JobPosting,
  type OrganizationRecord,
  type PersonRecord,
  type PhoneNumberRecord,
  type RawPerson
} from './apollo-types.js';
import type { EnrichmentLedger } from './enrichment-ledger.js';
import type { z } from 'zod';

export const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';

/** Apollo's documented ceiling for Bulk People Enrichment. */
export const BULK_MATCH_BATCH = 10;

export interface ApolloCosts {
  /** A work email costs roughly one credit. */
  emailCredits: number;
  /** A phone costs around eight. */
  phoneCredits: number;
  organizationCredits: number;
  /**
   * What one credit costs us in dollars. Deliberately a configuration value and
   * deliberately conservative: it is used to hold spend to a ceiling, and an
   * overestimate fails safe where an underestimate does not.
   */
  usdPerCredit: number;
}

export const DEFAULT_COSTS: ApolloCosts = {
  emailCredits: 1,
  phoneCredits: 8,
  organizationCredits: 1,
  usdPerCredit: 0.05
};

export interface CreditEntry {
  at: Date;
  endpoint: string;
  credits: number;
  usd: number;
  /** True when Apollo did not state the credits consumed and this is our own figure. */
  estimated: boolean;
  note: string;
}

export class CreditMeter {
  readonly entries: CreditEntry[] = [];

  record(entry: CreditEntry): void {
    this.entries.push(entry);
  }

  get totalCredits(): number {
    return this.entries.reduce((sum, e) => sum + e.credits, 0);
  }

  get totalUsd(): number {
    return Number(this.entries.reduce((sum, e) => sum + e.usd, 0).toFixed(6));
  }
}

export interface PeopleSearchQuery {
  domains: string[];
  titles: string[];
  seniorities: string[];
  page?: number;
  perPage?: number;
}

export interface PeopleSearchResult {
  people: PersonRecord[];
  page: number;
  totalPages?: number;
  totalEntries?: number;
}

/** Who to enrich. The Apollo id is mandatory: it is what the never-re-buy guard keys on. */
export interface EnrichRequest {
  apolloId: string;
  firstName?: string;
  lastName?: string;
  domain?: string;
  organizationName?: string;
  linkedinUrl?: string;
}

export type EnrichOutcome =
  | { status: 'enriched'; source: 'apollo' | 'ledger'; person: EnrichedPerson; credits: number }
  | { status: 'not-found'; source: 'apollo' | 'ledger' }
  /** Another call in this process is already buying this person. */
  | { status: 'in-flight' };

export type PhoneRequestOutcome =
  | { status: 'requested'; estimatedCredits: number; immediate: PhoneNumberRecord[] }
  | { status: 'not-found' }
  | { status: 'skipped'; reason: 'already-requested' | 'in-flight' };

export interface ApolloClientOptions {
  apiKey: string;
  /** The never-re-buy guard. Mandatory: a client with no memory of what it bought is the bug. */
  ledger: EnrichmentLedger;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source. Tests pass a constant. */
  random?: () => number;
  now?: () => Date;
  /** Retries after the first attempt. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A Retry-After longer than this is not waited out: the run stops and says so. */
  maxRetryAfterMs?: number;
  /** Minimum gap between request starts, to stay under Apollo's per-minute limits. */
  minIntervalMs?: number;
  timeoutMs?: number;
  /**
   * People Search path. The brief names `/mixed_people/search`; Apollo's newer
   * name for the same call is `/mixed_people/api_search`. Both answer with the
   * same shape, and the account's own error text uses the newer one.
   */
  searchPath?: string;
  costs?: Partial<ApolloCosts>;
  /** Allow a call to turn on reveal_personal_emails. Off unless a human decided otherwise. */
  permitPersonalEmails?: boolean;
  /** Told about every paid call as it happens, so the spend ledger is never behind the money. */
  onSpend?: (entry: CreditEntry) => Promise<void> | void;
}

type Json = Record<string, unknown>;

interface RequestSpec<T> {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: Json;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /**
   * Whether repeating the request after an ambiguous failure is harmless. A paid
   * call is not: a 502 can mean "not processed" or "processed, reply lost", and
   * guessing wrong spends twice. Paid calls retry only on an explicit 429 or 503.
   */
  safeToRepeat: boolean;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parseRetryAfter(header: string | null, now: Date): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

export class ApolloClient {
  readonly credits = new CreditMeter();
  readonly costs: ApolloCosts;

  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private readonly inflight = new Set<string>();
  private turn: Promise<void> = Promise.resolve();
  private lastStart = 0;

  constructor(private readonly options: ApolloClientOptions) {
    if (options.apiKey.trim() === '') throw new ApolloNotConfiguredError();
    this.costs = { ...DEFAULT_COSTS, ...(options.costs ?? {}) };
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.baseUrl = (options.baseUrl ?? APOLLO_BASE_URL).replace(/\/+$/, '');
  }

  /** Build a client from the environment. Throws ApolloNotConfiguredError when there is no key. */
  static fromEnv(
    env: NodeJS.ProcessEnv,
    options: Omit<ApolloClientOptions, 'apiKey'>
  ): ApolloClient {
    const apiKey = (env.APOLLO_API_KEY ?? '').trim();
    if (apiKey === '') throw new ApolloNotConfiguredError();
    const usd = Number(env.APOLLO_USD_PER_CREDIT);
    return new ApolloClient({
      ...options,
      apiKey,
      ...(env.APOLLO_SEARCH_PATH !== undefined && env.APOLLO_SEARCH_PATH.trim() !== ''
        ? { searchPath: env.APOLLO_SEARCH_PATH.trim() }
        : {}),
      costs: {
        ...(Number.isFinite(usd) && usd > 0 ? { usdPerCredit: usd } : {}),
        ...(options.costs ?? {})
      }
    });
  }

  usdFor(credits: number): number {
    return Number((credits * this.costs.usdPerCredit).toFixed(6));
  }

  /* ---------------------------------------------------------------- */
  /* Free                                                              */
  /* ---------------------------------------------------------------- */

  /** People Search. Costs nothing and returns no emails and no phone numbers. */
  async searchPeople(query: PeopleSearchQuery): Promise<PeopleSearchResult> {
    const page = query.page ?? 1;
    const perPage = Math.min(100, query.perPage ?? 50);
    const response = await this.request({
      method: 'POST',
      path: this.options.searchPath ?? '/mixed_people/search',
      body: {
        q_organization_domains_list: query.domains,
        person_titles: query.titles,
        person_seniorities: query.seniorities,
        include_similar_titles: true,
        page,
        per_page: perPage
      },
      schema: peopleSearchResponseSchema,
      safeToRepeat: true
    });

    const seen = new Set<string>();
    const people: PersonRecord[] = [];
    for (const raw of [...response.people, ...response.contacts]) {
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      people.push(normalisePerson(raw));
    }
    return {
      people,
      page,
      ...(typeof response.pagination?.total_pages === 'number' ? { totalPages: response.pagination.total_pages } : {}),
      ...(typeof (response.total_entries ?? response.pagination?.total_entries) === 'number'
        ? { totalEntries: (response.total_entries ?? response.pagination?.total_entries) as number }
        : {})
    };
  }

  /** Job postings for an organisation, a strong signal of tech direction (section 5.3). */
  async organizationJobPostings(organizationApolloId: string): Promise<JobPosting[]> {
    const response = await this.request({
      method: 'GET',
      path: `/organizations/${encodeURIComponent(organizationApolloId)}/job_postings`,
      query: { page: '1', per_page: '25' },
      schema: jobPostingsResponseSchema,
      safeToRepeat: true
    });
    const out: JobPosting[] = [];
    for (const p of response.organization_job_postings) {
      const title = (p.title ?? '').trim();
      const url = (p.url ?? '').trim();
      if (title === '' || url === '') continue;
      const location = [p.city, p.state, p.country].filter((x): x is string => typeof x === 'string' && x !== '').join(', ');
      const postedAt = p.posted_at ?? p.last_seen_at ?? undefined;
      out.push({
        title,
        url,
        ...(location !== '' ? { location } : {}),
        ...(typeof postedAt === 'string' && postedAt !== '' ? { postedAt } : {})
      });
    }
    return out;
  }

  /**
   * Save an enriched person as an Apollo contact, so enriching them again later
   * does not bill again (section 5.2). Free, and idempotent on Apollo's side
   * because duplicates are run through its own dedupe.
   */
  async createContact(person: EnrichedPerson): Promise<string | undefined> {
    const response = await this.request({
      method: 'POST',
      path: '/contacts',
      body: {
        first_name: person.firstName,
        last_name: person.lastName,
        title: person.title,
        ...(person.organizationName !== undefined ? { organization_name: person.organizationName } : {}),
        ...(person.email !== undefined ? { email: person.email } : {}),
        run_dedupe: true
      },
      schema: contactCreateResponseSchema,
      safeToRepeat: false
    });
    const id = response.contact?.id;
    if (id !== undefined) await this.options.ledger.setApolloContact(person.apolloId, id);
    return id;
  }

  /* ---------------------------------------------------------------- */
  /* Paid                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Stage one: a work email for each person, in batches of ten.
   *
   * Anyone the ledger already holds is answered from it. Only the rest cost
   * anything, and only they cause a request.
   */
  async enrichEmails(
    requests: EnrichRequest[],
    options: { revealPersonalEmails?: boolean } = {}
  ): Promise<Map<string, EnrichOutcome>> {
    if (options.revealPersonalEmails === true && this.options.permitPersonalEmails !== true) {
      throw new PersonalEmailNotPermittedError();
    }
    const outcomes = new Map<string, EnrichOutcome>();
    const toBuy: EnrichRequest[] = [];

    for (const r of dedupeById(requests)) {
      const cached = await this.options.ledger.getEmail(r.apolloId);
      if (cached !== null) {
        outcomes.set(
          r.apolloId,
          cached.matched && cached.person !== undefined
            ? { status: 'enriched', source: 'ledger', person: cached.person, credits: 0 }
            : { status: 'not-found', source: 'ledger' }
        );
        continue;
      }
      if (this.inflight.has(`email:${r.apolloId}`)) {
        outcomes.set(r.apolloId, { status: 'in-flight' });
        continue;
      }
      this.inflight.add(`email:${r.apolloId}`);
      toBuy.push(r);
    }

    try {
      for (const batch of chunk(toBuy, BULK_MATCH_BATCH)) {
        const response = await this.request({
          method: 'POST',
          path: '/people/bulk_match',
          query: {
            reveal_personal_emails: options.revealPersonalEmails === true ? 'true' : 'false',
            reveal_phone_number: 'false'
          },
          body: { details: batch.map(detailFor) },
          schema: bulkMatchResponseSchema,
          safeToRepeat: false
        });

        const byId = new Map<string, RawPerson>();
        for (const m of response.matches) if (m !== null) byId.set(m.id, m);

        const bought: Array<{ request: EnrichRequest; person: EnrichedPerson | undefined }> = [];
        for (const r of batch) {
          const raw = byId.get(r.apolloId);
          bought.push({ request: r, person: raw === undefined ? undefined : normaliseEnrichedPerson(raw) });
        }

        const withEmail = bought.filter((b) => b.person?.email !== undefined).length;
        const stated = typeof response.credits_consumed === 'number';
        const credits = stated ? (response.credits_consumed as number) : withEmail * this.costs.emailCredits;
        await this.spend({
          endpoint: '/people/bulk_match',
          credits,
          estimated: !stated,
          note: `email enrichment, ${batch.length} requested, ${withEmail} with an email`
        });

        for (const { request, person } of bought) {
          const perPerson = person?.email !== undefined ? this.costs.emailCredits : 0;
          await this.options.ledger.recordEmail({
            apolloId: request.apolloId,
            boughtAt: this.now().toISOString(),
            matched: person !== undefined,
            ...(person !== undefined ? { person } : {}),
            credits: perPerson,
            estimated: !stated
          });
          outcomes.set(
            request.apolloId,
            person === undefined
              ? { status: 'not-found', source: 'apollo' }
              : { status: 'enriched', source: 'apollo', person, credits: perPerson }
          );
        }
      }
    } finally {
      for (const r of toBuy) this.inflight.delete(`email:${r.apolloId}`);
    }
    return outcomes;
  }

  /**
   * One person via `/people/match`. The same guard as the bulk call, for the
   * occasions a single lookup is wanted.
   */
  async matchPerson(request: EnrichRequest, options: { revealPersonalEmails?: boolean } = {}): Promise<EnrichOutcome> {
    if (options.revealPersonalEmails === true && this.options.permitPersonalEmails !== true) {
      throw new PersonalEmailNotPermittedError();
    }
    requireId(request);
    const cached = await this.options.ledger.getEmail(request.apolloId);
    if (cached !== null) {
      return cached.matched && cached.person !== undefined
        ? { status: 'enriched', source: 'ledger', person: cached.person, credits: 0 }
        : { status: 'not-found', source: 'ledger' };
    }
    const key = `email:${request.apolloId}`;
    if (this.inflight.has(key)) return { status: 'in-flight' };
    this.inflight.add(key);

    try {
      const response = await this.request({
        method: 'POST',
        path: '/people/match',
        query: {
          reveal_personal_emails: options.revealPersonalEmails === true ? 'true' : 'false',
          reveal_phone_number: 'false'
        },
        body: detailFor(request),
        schema: matchResponseSchema,
        safeToRepeat: false
      });
      const person = response.person === null || response.person === undefined ? undefined : normaliseEnrichedPerson(response.person);
      const credits = person?.email !== undefined ? this.costs.emailCredits : 0;
      await this.spend({
        endpoint: '/people/match',
        credits,
        estimated: true,
        note: person === undefined ? 'single match, no result' : 'single match'
      });
      await this.options.ledger.recordEmail({
        apolloId: request.apolloId,
        boughtAt: this.now().toISOString(),
        matched: person !== undefined,
        ...(person !== undefined ? { person } : {}),
        credits,
        estimated: true
      });
      return person === undefined
        ? { status: 'not-found', source: 'apollo' }
        : { status: 'enriched', source: 'apollo', person, credits };
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Stage two: ask for phone numbers. Apollo answers later, to `webhookUrl`; the
   * synchronous reply will not contain the mobile.
   *
   * Refused outright without an https webhook, because the numbers could not be
   * delivered and the credits would be spent for nothing.
   */
  async requestPhones(
    requests: EnrichRequest[],
    options: { webhookUrl: string }
  ): Promise<Map<string, PhoneRequestOutcome>> {
    if (!/^https:\/\//i.test(options.webhookUrl.trim())) {
      throw new PhoneWebhookRequiredError(
        options.webhookUrl.trim() === '' ? 'none was supplied' : `"${options.webhookUrl}" is not https`
      );
    }
    const outcomes = new Map<string, PhoneRequestOutcome>();
    const toBuy: EnrichRequest[] = [];

    for (const r of dedupeById(requests)) {
      if ((await this.options.ledger.getPhone(r.apolloId)) !== null) {
        outcomes.set(r.apolloId, { status: 'skipped', reason: 'already-requested' });
        continue;
      }
      if (this.inflight.has(`phone:${r.apolloId}`)) {
        outcomes.set(r.apolloId, { status: 'skipped', reason: 'in-flight' });
        continue;
      }
      this.inflight.add(`phone:${r.apolloId}`);
      toBuy.push(r);
    }

    try {
      for (const batch of chunk(toBuy, BULK_MATCH_BATCH)) {
        const response = await this.request({
          method: 'POST',
          path: '/people/bulk_match',
          query: {
            reveal_personal_emails: 'false',
            reveal_phone_number: 'true',
            webhook_url: options.webhookUrl
          },
          body: { details: batch.map(detailFor) },
          schema: bulkMatchResponseSchema,
          safeToRepeat: false
        });

        const byId = new Map<string, RawPerson>();
        for (const m of response.matches) if (m !== null) byId.set(m.id, m);

        const matched = batch.filter((r) => byId.has(r.apolloId));
        // Reserved at the full rate: Apollo bills when a number is found, which we
        // cannot know yet, and a ceiling should hold against the worst case.
        const credits = matched.length * this.costs.phoneCredits;
        await this.spend({
          endpoint: '/people/bulk_match',
          credits,
          estimated: true,
          note: `phone reveal requested for ${matched.length} (delivered later by webhook)`
        });

        for (const r of batch) {
          const raw = byId.get(r.apolloId);
          const requestedAt = this.now().toISOString();
          if (raw === undefined) {
            await this.options.ledger.recordPhoneRequest({
              apolloId: r.apolloId,
              requestedAt,
              estimatedCredits: 0,
              status: 'none',
              deliveries: [],
              numbers: []
            });
            outcomes.set(r.apolloId, { status: 'not-found' });
            continue;
          }
          await this.options.ledger.recordPhoneRequest({
            apolloId: r.apolloId,
            requestedAt,
            estimatedCredits: this.costs.phoneCredits,
            status: 'requested',
            deliveries: [],
            numbers: []
          });
          outcomes.set(r.apolloId, {
            status: 'requested',
            estimatedCredits: this.costs.phoneCredits,
            immediate: normalisePhones(raw.phone_numbers)
          });
        }
      }
    } finally {
      for (const r of toBuy) this.inflight.delete(`phone:${r.apolloId}`);
    }
    return outcomes;
  }

  /** Organisation Enrichment, guarded like the others and keyed on the domain. */
  async enrichOrganization(domain: string): Promise<OrganizationRecord | undefined> {
    const key = domain.trim().toLowerCase();
    const cached = await this.options.ledger.getOrganization(key);
    if (cached !== null) return cached.organization;

    const response = await this.request({
      method: 'GET',
      path: '/organizations/enrich',
      query: { domain: key },
      schema: organizationEnrichResponseSchema,
      safeToRepeat: false
    });
    const organization = response.organization === null || response.organization === undefined
      ? undefined
      : normaliseOrganization(response.organization, key);
    const credits = organization !== undefined ? this.costs.organizationCredits : 0;
    await this.spend({
      endpoint: '/organizations/enrich',
      credits,
      estimated: true,
      note: `organization enrichment for ${key}`
    });
    await this.options.ledger.recordOrganization({
      domain: key,
      boughtAt: this.now().toISOString(),
      credits,
      ...(organization !== undefined ? { organization } : {})
    });
    return organization;
  }

  /* ---------------------------------------------------------------- */
  /* Plumbing                                                          */
  /* ---------------------------------------------------------------- */

  private async spend(input: { endpoint: string; credits: number; estimated: boolean; note: string }): Promise<void> {
    if (input.credits === 0) return;
    const entry: CreditEntry = {
      at: this.now(),
      endpoint: input.endpoint,
      credits: input.credits,
      usd: this.usdFor(input.credits),
      estimated: input.estimated,
      note: input.note
    };
    this.credits.record(entry);
    await this.options.onSpend?.(entry);
  }

  /** Pace request starts so a burst cannot trip Apollo's per-minute limit. */
  private async pace(): Promise<void> {
    const gap = this.options.minIntervalMs ?? 0;
    if (gap <= 0) return;
    const wait = this.lastStart + gap - this.now().getTime();
    if (wait > 0) await this.sleep(wait);
    this.lastStart = this.now().getTime();
  }

  private async request<T>(spec: RequestSpec<T>): Promise<T> {
    const turn = this.turn.then(() => this.pace());
    this.turn = turn.catch(() => undefined);
    await turn;

    const url = new URL(`${this.baseUrl}${spec.path}`);
    for (const [k, v] of Object.entries(spec.query ?? {})) url.searchParams.set(k, v);
    const endpoint = spec.path;
    const maxRetries = this.options.maxRetries ?? 4;
    const baseDelay = this.options.baseDelayMs ?? 1000;
    const maxDelay = this.options.maxDelayMs ?? 30_000;
    const maxRetryAfter = this.options.maxRetryAfterMs ?? 120_000;

    let lastBody = '';
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const backoff = (): number => {
        const cap = Math.min(maxDelay, baseDelay * 2 ** attempt);
        return Math.round(cap / 2 + (this.random() * cap) / 2);
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: spec.method,
          headers: {
            accept: 'application/json',
            'cache-control': 'no-cache',
            'x-api-key': this.options.apiKey,
            ...(spec.body !== undefined ? { 'content-type': 'application/json' } : {})
          },
          ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        if (spec.safeToRepeat && attempt < maxRetries) {
          await this.sleep(backoff());
          continue;
        }
        throw new ApolloNetworkError(endpoint, error);
      }
      clearTimeout(timer);

      lastBody = await response.text();
      if (response.ok) {
        let parsedJson: unknown;
        try {
          parsedJson = lastBody.trim() === '' ? {} : JSON.parse(lastBody);
        } catch {
          throw new ApolloResponseError(endpoint, 'the body was not JSON');
        }
        const parsed = spec.schema.safeParse(parsedJson);
        if (!parsed.success) {
          throw new ApolloResponseError(endpoint, parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
        }
        return parsed.data;
      }

      const status = response.status;
      if (status === 401) throw new ApolloAuthError(endpoint, lastBody);
      if (status === 403) throw new ApolloPlanError(endpoint, lastBody);

      const retryableStatus = status === 429 || status === 503 || (spec.safeToRepeat && status >= 500);
      if (retryableStatus) {
        const advised = parseRetryAfter(response.headers.get('retry-after'), this.now());
        if (advised !== undefined && advised > maxRetryAfter) {
          // "Try again in an hour" is not something to sleep through inside a run.
          throw new ApolloRateLimitError(endpoint, lastBody, attempt + 1);
        }
        if (attempt < maxRetries) {
          await this.sleep(advised ?? backoff());
          continue;
        }
        if (status === 429) throw new ApolloRateLimitError(endpoint, lastBody, attempt + 1);
      }
      throw new ApolloApiError(`Apollo answered ${status} on ${endpoint}: ${lastBody.slice(0, 200)}`, status, endpoint, lastBody);
    }

    // Unreachable: the loop returns or throws on its last pass.
    throw new ApolloApiError(`Apollo retries exhausted on ${endpoint}`, 0, endpoint, lastBody);
  }
}

function requireId(r: EnrichRequest): void {
  if (typeof r.apolloId !== 'string' || r.apolloId.trim() === '') {
    throw new MissingApolloIdError(`${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || 'no name either');
  }
}

function dedupeById(requests: EnrichRequest[]): EnrichRequest[] {
  const seen = new Set<string>();
  const out: EnrichRequest[] = [];
  for (const r of requests) {
    requireId(r);
    if (seen.has(r.apolloId)) continue;
    seen.add(r.apolloId);
    out.push(r);
  }
  return out;
}

function detailFor(r: EnrichRequest): Json {
  return {
    id: r.apolloId,
    ...(r.firstName !== undefined ? { first_name: r.firstName } : {}),
    ...(r.lastName !== undefined ? { last_name: r.lastName } : {}),
    ...(r.domain !== undefined ? { domain: r.domain } : {}),
    ...(r.organizationName !== undefined ? { organization_name: r.organizationName } : {}),
    ...(r.linkedinUrl !== undefined ? { linkedin_url: r.linkedinUrl } : {})
  };
}
