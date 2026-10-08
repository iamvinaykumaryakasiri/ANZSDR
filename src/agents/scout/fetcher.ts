/**
 * A page fetcher that cannot be talked into doing anything it should not.
 *
 * Section 16: no scraping of sites that prohibit it, and (section 5.3) a public
 * LinkedIn profile only if it is lawfully fetchable. These are enforced here, in
 * code, before a request is made, rather than being a line in Scout's prompt:
 *
 *   - Hosts whose terms prohibit automated access are refused outright. The
 *     list is not configuration a run can widen.
 *   - robots.txt is read and obeyed (RFC 9309): the longest matching rule
 *     wins, an unreachable robots.txt is treated as a complete disallow, and a
 *     404 is treated as no restrictions.
 *   - https only. Redirects are followed by hand, up to three hops, and the
 *     policy is applied again at every hop, so a permitted page cannot bounce
 *     the fetcher onto a forbidden one.
 *   - Size and time are capped, and only text and HTML are read.
 *
 * LinkedIn is on the list and always will be: its User Agreement prohibits
 * automated access to profile pages and its robots.txt disallows them. Scout
 * does not read LinkedIn, and says in the dossier that it did not.
 */

import type { FetchFailure, FetchResult, PageFetcher } from './sources.js';

/** Subdomains are covered: "linkedin.com" also blocks "au.linkedin.com". */
export const DENIED_HOSTS: readonly string[] = [
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'glassdoor.com',
  'indeed.com',
  'seek.com.au',
  'seek.co.nz',
  'trademe.co.nz'
];

export function isDeniedHost(hostname: string, deny: readonly string[] = DENIED_HOSTS): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return deny.some((d) => host === d || host.endsWith(`.${d}`));
}

/* ------------------------------------------------------------------ */
/* robots.txt                                                          */
/* ------------------------------------------------------------------ */

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export type RobotsPolicy = { kind: 'rules'; rules: RobotsRule[] } | { kind: 'allow-all' } | { kind: 'disallow-all' };

function patternMatches(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(
    `^${body
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}${anchored ? '$' : ''}`
  );
  return regex.test(path);
}

/** Parse the group that applies to `agentToken`, falling back to `*`. */
export function parseRobots(text: string, agentToken: string): RobotsPolicy {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let current: { agents: string[]; rules: RobotsRule[] } | undefined;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (current === undefined || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((field === 'allow' || field === 'disallow') && current !== undefined) {
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }

  const token = agentToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  return rules.length === 0 ? { kind: 'allow-all' } : { kind: 'rules', rules };
}

/** The longest matching rule wins; on a tie, allow wins (RFC 9309). */
export function robotsAllows(policy: RobotsPolicy, pathAndQuery: string): boolean {
  if (policy.kind === 'allow-all') return true;
  if (policy.kind === 'disallow-all') return false;
  let best: RobotsRule | undefined;
  for (const rule of policy.rules) {
    if (!patternMatches(rule.pattern, pathAndQuery)) continue;
    if (best === undefined || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best === undefined ? true : best.allow;
}

/* ------------------------------------------------------------------ */
/* HTML to text                                                        */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: '...'
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch === null ? '' : decodeEntities(titleMatch[1] ?? '').replace(/\s+/g, ' ').trim();

  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

/* ------------------------------------------------------------------ */
/* The fetcher                                                         */
/* ------------------------------------------------------------------ */

export interface PolicyFetcherOptions {
  fetch?: typeof fetch;
  /** Sent as User-Agent and matched against robots.txt groups. */
  userAgent?: string;
  /** The token robots.txt groups are matched on, e.g. "anzsdr-scout". */
  agentToken?: string;
  denyHosts?: readonly string[];
  maxBytes?: number;
  maxChars?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  robotsTtlMs?: number;
  now?: () => Date;
}

export class PolicyFetcher implements PageFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly agentToken: string;
  private readonly deny: readonly string[];
  private readonly maxBytes: number;
  private readonly maxChars: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly robotsTtlMs: number;
  private readonly now: () => Date;
  private readonly robots = new Map<string, { policy: RobotsPolicy; at: number }>();

  constructor(options: PolicyFetcherOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.agentToken = options.agentToken ?? 'anzsdr-scout';
    this.userAgent = options.userAgent ?? `ANZSDR-Scout/1.0 (business research; honours robots.txt)`;
    // The deny list can be extended but never emptied below the defaults.
    this.deny = [...DENIED_HOSTS, ...(options.denyHosts ?? [])];
    this.maxBytes = options.maxBytes ?? 1_500_000;
    this.maxChars = options.maxChars ?? 40_000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.robotsTtlMs = options.robotsTtlMs ?? 3_600_000;
    this.now = options.now ?? (() => new Date());
  }

  private fail(url: string, reason: FetchFailure, detail?: string): FetchResult {
    return { ok: false, url, reason, ...(detail !== undefined ? { detail } : {}) };
  }

  private async robotsFor(origin: string): Promise<RobotsPolicy> {
    const cached = this.robots.get(origin);
    if (cached !== undefined && this.now().getTime() - cached.at < this.robotsTtlMs) return cached.policy;

    let policy: RobotsPolicy;
    try {
      const response = await this.get(`${origin}/robots.txt`, 'text/plain');
      if (response.status >= 500) policy = { kind: 'disallow-all' };
      else if (response.status >= 400) policy = { kind: 'allow-all' };
      else policy = parseRobots(await response.text(), this.agentToken);
    } catch {
      // RFC 9309: if it cannot be read, assume we may not read anything.
      policy = { kind: 'disallow-all' };
    }
    this.robots.set(origin, { policy, at: this.now().getTime() });
    return policy;
  }

  private async get(url: string, accept: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        redirect: 'manual',
        headers: { 'user-agent': this.userAgent, accept },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async fetch(url: string): Promise<FetchResult> {
    let current = url;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        return this.fail(url, 'invalid-url', current);
      }
      if (parsed.protocol !== 'https:') return this.fail(url, 'not-https', current);
      if (isDeniedHost(parsed.hostname, this.deny)) {
        return this.fail(url, 'blocked-host', `${parsed.hostname} prohibits automated access`);
      }

      const policy = await this.robotsFor(parsed.origin);
      // `disallow-all` only ever means robots.txt could not be read (RFC 9309).
      if (policy.kind === 'disallow-all') return this.fail(url, 'robots-unreachable', parsed.origin);
      if (!robotsAllows(policy, `${parsed.pathname}${parsed.search}`)) return this.fail(url, 'robots-disallow', current);

      let response: Response;
      try {
        response = await this.get(current, 'text/html,application/xhtml+xml,text/plain');
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        return this.fail(url, aborted ? 'timeout' : 'error', error instanceof Error ? error.message : String(error));
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) return this.fail(url, 'http-error', `${response.status} without a Location`);
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) return this.fail(url, 'http-error', String(response.status));

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const isHtml = contentType.includes('html');
      if (!isHtml && !contentType.startsWith('text/plain')) {
        return this.fail(url, 'unsupported-type', contentType || 'no content-type');
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.maxBytes) return this.fail(url, 'too-large', `${declared} bytes`);

      const body = await response.text();
      if (body.length > this.maxBytes) return this.fail(url, 'too-large', `${body.length} characters`);

      const { title, text } = isHtml ? htmlToText(body) : { title: '', text: body.trim() };
      return {
        ok: true,
        url,
        finalUrl: current,
        title,
        text: text.slice(0, this.maxChars),
        contentType,
        retrievedAt: this.now().toISOString()
      };
    }
    return this.fail(url, 'too-many-redirects');
  }
}
