import { describe, expect, it } from 'vitest';
import { DENIED_HOSTS, PolicyFetcher, htmlToText, isDeniedHost, parseRobots, robotsAllows } from '../../src/agents/scout/fetcher.js';

type Page = { status?: number; body?: string; type?: string; headers?: Record<string, string> };

/** A tiny web: url -> response. Everything fetched is recorded. */
function web(pages: Record<string, Page | 'network-error' | 'hang'>) {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(url);
    const page = pages[url];
    if (page === undefined) return new Response('not found', { status: 404 });
    if (page === 'network-error') throw new TypeError('fetch failed');
    if (page === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return new Response(page.body ?? '', {
      status: page.status ?? 200,
      headers: { 'content-type': page.type ?? 'text/html; charset=utf-8', ...(page.headers ?? {}) }
    });
  };
  return { fetchImpl, requested };
}

const ROBOTS_OPEN = { 'https://bank.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' } } as const;

describe('hosts that prohibit automated access', () => {
  it('covers LinkedIn and its subdomains, and not a look-alike', () => {
    expect(isDeniedHost('linkedin.com')).toBe(true);
    expect(isDeniedHost('au.linkedin.com')).toBe(true);
    expect(isDeniedHost('WWW.LinkedIn.com.')).toBe(true);
    expect(isDeniedHost('notlinkedin.com')).toBe(false);
    expect(isDeniedHost('linkedin.com.evil.example')).toBe(false);
    expect(DENIED_HOSTS).toContain('seek.com.au');
  });

  it('is refused before a single request is made', async () => {
    const { fetchImpl, requested } = web({});
    const fetcher = new PolicyFetcher({ fetch: fetchImpl });
    const result = await fetcher.fetch('https://www.linkedin.com/in/priya-raman');
    expect(result).toMatchObject({ ok: false, reason: 'blocked-host' });
    expect(requested).toEqual([]);
  });

  it('can be extended and never emptied', async () => {
    const { fetchImpl } = web({ ...ROBOTS_OPEN, 'https://bank.example/': { body: '<p>hi there, welcome</p>' } });
    const extended = new PolicyFetcher({ fetch: fetchImpl, denyHosts: ['bank.example'] });
    expect(await extended.fetch('https://bank.example/')).toMatchObject({ ok: false, reason: 'blocked-host' });
    expect(await extended.fetch('https://linkedin.com/in/x')).toMatchObject({ ok: false, reason: 'blocked-host' });
  });
});

describe('robots.txt', () => {
  it('stops a disallowed path without fetching it', async () => {
    const { fetchImpl, requested } = web({
      'https://bank.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private/\n' },
      'https://bank.example/private/plan': { body: '<p>secret</p>' },
      'https://bank.example/news': { body: '<p>public news item</p>' }
    });
    const fetcher = new PolicyFetcher({ fetch: fetchImpl });
    expect(await fetcher.fetch('https://bank.example/private/plan')).toMatchObject({ ok: false, reason: 'robots-disallow' });
    expect(requested).not.toContain('https://bank.example/private/plan');
    expect(await fetcher.fetch('https://bank.example/news')).toMatchObject({ ok: true });
  });

  it('reads robots.txt once per site, not once per page', async () => {
    const { fetchImpl, requested } = web({ ...ROBOTS_OPEN, 'https://bank.example/a': { body: '<p>aaaaaaa</p>' }, 'https://bank.example/b': { body: '<p>bbbbbbb</p>' } });
    const fetcher = new PolicyFetcher({ fetch: fetchImpl });
    await fetcher.fetch('https://bank.example/a');
    await fetcher.fetch('https://bank.example/b');
    expect(requested.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('treats a missing robots.txt as no restriction, and an unreachable one as a complete restriction', async () => {
    const missing = web({ 'https://bank.example/a': { body: '<p>aaaaaaa</p>' } });
    expect(await new PolicyFetcher({ fetch: missing.fetchImpl }).fetch('https://bank.example/a')).toMatchObject({ ok: true });

    const broken = web({ 'https://bank.example/robots.txt': { status: 503 }, 'https://bank.example/a': { body: '<p>aaaaaaa</p>' } });
    expect(await new PolicyFetcher({ fetch: broken.fetchImpl }).fetch('https://bank.example/a')).toMatchObject({ ok: false, reason: 'robots-unreachable' });
    expect(broken.requested).not.toContain('https://bank.example/a');

    const down = web({ 'https://bank.example/robots.txt': 'network-error', 'https://bank.example/a': { body: '<p>aaaaaaa</p>' } });
    expect(await new PolicyFetcher({ fetch: down.fetchImpl }).fetch('https://bank.example/a')).toMatchObject({ ok: false, reason: 'robots-unreachable' });
  });

  it('applies the group for our own name over the wildcard group', () => {
    const text = 'User-agent: *\nDisallow: /\n\nUser-agent: anzsdr-scout\nAllow: /news\nDisallow: /news/draft\n';
    const policy = parseRobots(text, 'anzsdr-scout');
    expect(robotsAllows(policy, '/news/today')).toBe(true);
    expect(robotsAllows(policy, '/news/draft/1')).toBe(false);
    // Anything not mentioned by our group is allowed: the wildcard group does not apply.
    expect(robotsAllows(policy, '/about')).toBe(true);
    expect(robotsAllows(parseRobots(text, 'someone-else'), '/about')).toBe(false);
  });

  it('lets the longest matching rule win, and allow win a tie', () => {
    const policy = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /c\nAllow: /c\n', 'x');
    expect(robotsAllows(policy, '/a/x')).toBe(false);
    expect(robotsAllows(policy, '/a/b/c')).toBe(true);
    expect(robotsAllows(policy, '/c/1')).toBe(true);
  });

  it('understands * and $ in a pattern, ignores comments and an empty Disallow', () => {
    const policy = parseRobots('# hi\nUser-agent: *\nDisallow: /*.pdf$ # no pdfs\nDisallow: /tmp/*/draft\nDisallow:\n', 'x');
    expect(robotsAllows(policy, '/files/report.pdf')).toBe(false);
    expect(robotsAllows(policy, '/files/report.pdf.html')).toBe(true);
    expect(robotsAllows(policy, '/tmp/1/draft')).toBe(false);
    expect(robotsAllows(policy, '/tmp/1/final')).toBe(true);
  });

  it('allows everything when there are no rules, and nothing under disallow-all', () => {
    expect(robotsAllows(parseRobots('', 'x'), '/anything')).toBe(true);
    expect(robotsAllows({ kind: 'disallow-all' }, '/anything')).toBe(false);
  });

  it('merges consecutive user-agent lines into one group', () => {
    const policy = parseRobots('User-agent: a\nUser-agent: anzsdr-scout\nDisallow: /x\n', 'anzsdr-scout');
    expect(robotsAllows(policy, '/x')).toBe(false);
  });
});

describe('redirects', () => {
  it('follows a redirect and reports the final URL', async () => {
    const { fetchImpl } = web({
      ...ROBOTS_OPEN,
      'https://bank.example/old': { status: 301, headers: { location: '/new' } },
      'https://bank.example/new': { body: '<title>New</title><p>The new page text</p>' }
    });
    const result = await new PolicyFetcher({ fetch: fetchImpl }).fetch('https://bank.example/old');
    expect(result).toMatchObject({ ok: true, finalUrl: 'https://bank.example/new', title: 'New' });
  });

  it('applies the policy at every hop: a permitted page cannot bounce the fetcher somewhere forbidden', async () => {
    const { fetchImpl, requested } = web({
      ...ROBOTS_OPEN,
      'https://bank.example/team': { status: 302, headers: { location: 'https://www.linkedin.com/company/bank' } }
    });
    const result = await new PolicyFetcher({ fetch: fetchImpl }).fetch('https://bank.example/team');
    expect(result).toMatchObject({ ok: false, reason: 'blocked-host' });
    expect(requested.some((u) => u.includes('linkedin'))).toBe(false);
  });

  it('applies robots.txt at the destination too', async () => {
    const { fetchImpl } = web({
      ...ROBOTS_OPEN,
      'https://bank.example/go': { status: 302, headers: { location: 'https://other.example/page' } },
      'https://other.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /\n' }
    });
    expect(await new PolicyFetcher({ fetch: fetchImpl }).fetch('https://bank.example/go')).toMatchObject({ ok: false, reason: 'robots-disallow' });
  });

  it('stops after three hops, and on a redirect with nowhere to go', async () => {
    const loop = web({
      ...ROBOTS_OPEN,
      'https://bank.example/a': { status: 302, headers: { location: '/a' } }
    });
    expect(await new PolicyFetcher({ fetch: loop.fetchImpl }).fetch('https://bank.example/a')).toMatchObject({ ok: false, reason: 'too-many-redirects' });

    const nowhere = web({ ...ROBOTS_OPEN, 'https://bank.example/b': { status: 302 } });
    expect(await new PolicyFetcher({ fetch: nowhere.fetchImpl }).fetch('https://bank.example/b')).toMatchObject({ ok: false, reason: 'http-error' });
  });
});

describe('what it will read', () => {
  it('refuses plain http and nonsense', async () => {
    const f = new PolicyFetcher({ fetch: web({}).fetchImpl });
    expect(await f.fetch('http://bank.example/')).toMatchObject({ ok: false, reason: 'not-https' });
    expect(await f.fetch('not a url')).toMatchObject({ ok: false, reason: 'invalid-url' });
  });

  it('reads HTML as text and plain text as it is, and nothing else', async () => {
    const { fetchImpl } = web({
      ...ROBOTS_OPEN,
      'https://bank.example/page': { body: '<html><title>T</title><body><p>Hello</p></body></html>' },
      'https://bank.example/note.txt': { type: 'text/plain', body: '  just text  ' },
      'https://bank.example/report.pdf': { type: 'application/pdf', body: '%PDF-1.7' },
      'https://bank.example/missing': { status: 404 }
    });
    const f = new PolicyFetcher({ fetch: fetchImpl, now: () => new Date('2026-10-07T00:00:00Z') });
    expect(await f.fetch('https://bank.example/page')).toMatchObject({ ok: true, text: 'Hello', title: 'T', retrievedAt: '2026-10-07T00:00:00.000Z' });
    expect(await f.fetch('https://bank.example/note.txt')).toMatchObject({ ok: true, text: 'just text' });
    expect(await f.fetch('https://bank.example/report.pdf')).toMatchObject({ ok: false, reason: 'unsupported-type' });
    expect(await f.fetch('https://bank.example/missing')).toMatchObject({ ok: false, reason: 'http-error', detail: '404' });
  });

  it('caps size and text length', async () => {
    const { fetchImpl } = web({
      ...ROBOTS_OPEN,
      'https://bank.example/huge': { body: 'x', headers: { 'content-length': '99999999' } },
      'https://bank.example/long': { body: `<p>${'word '.repeat(5000)}</p>` },
      'https://bank.example/big': { body: 'y'.repeat(200) }
    });
    const f = new PolicyFetcher({ fetch: fetchImpl, maxBytes: 100_000, maxChars: 1000 });
    expect(await f.fetch('https://bank.example/huge')).toMatchObject({ ok: false, reason: 'too-large' });
    const long = await f.fetch('https://bank.example/long');
    expect(long.ok && long.text.length).toBe(1000);
    expect(await new PolicyFetcher({ fetch: fetchImpl, maxBytes: 100 }).fetch('https://bank.example/big')).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('gives up on a server that never answers', async () => {
    const { fetchImpl } = web({ ...ROBOTS_OPEN, 'https://bank.example/slow': 'hang' });
    const result = await new PolicyFetcher({ fetch: fetchImpl, timeoutMs: 30 }).fetch('https://bank.example/slow');
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('reports a network failure as one', async () => {
    const { fetchImpl } = web({ ...ROBOTS_OPEN, 'https://bank.example/down': 'network-error' });
    expect(await new PolicyFetcher({ fetch: fetchImpl }).fetch('https://bank.example/down')).toMatchObject({ ok: false, reason: 'error' });
  });

  it('identifies itself', async () => {
    let agent = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      agent = new Headers(init?.headers).get('user-agent') ?? '';
      return String(input).endsWith('robots.txt') ? new Response('', { status: 404 }) : new Response('<p>hello there</p>', { headers: { 'content-type': 'text/html' } });
    };
    await new PolicyFetcher({ fetch: fetchImpl, userAgent: 'ANZSDR-Scout/9 (contact: ops@example.org)' }).fetch('https://bank.example/');
    expect(agent).toBe('ANZSDR-Scout/9 (contact: ops@example.org)');
  });
});

describe('HTML to text', () => {
  it('drops scripts, styles and comments, keeps paragraph breaks, and decodes entities', () => {
    const { title, text } = htmlToText(
      '<html><head><title>A &amp; B</title><style>p{color:red}</style></head><body><!-- hidden --><script>var x = "ignore me";</script><h1>Heading</h1><p>First&nbsp;para &quot;quoted&quot; &#8211; &#x2014;.</p><p>Second</p></body></html>'
    );
    expect(title).toBe('A & B');
    expect(text).not.toContain('ignore me');
    expect(text).not.toContain('color');
    expect(text).not.toContain('hidden');
    expect(text).toBe('Heading\nFirst para "quoted" – —.\nSecond');
  });

  it('survives broken markup and unknown entities', () => {
    expect(htmlToText('<p>5 &lt; 6 &foo; &#99999999;<b>bold').text).toContain('5 < 6 &foo;');
    expect(htmlToText('').text).toBe('');
  });
});
