/**
 * Find out what your Apollo key can actually do, before you pay for anything.
 *
 *   npm run apollo:check
 *   npm run apollo:check -- --spend-a-credit   also tests enrichment (costs ~1 credit)
 *
 * Apollo's own documentation says only that "access to Apollo API depends on your
 * Apollo plan", without saying which endpoints need which tier. Rather than guess,
 * this asks your account directly. Search costs nothing, so the free checks are
 * genuinely free; the enrichment check is opt-in because it spends a credit.
 */

const BASE = 'https://api.apollo.io/api/v1';
const KEY = process.env.APOLLO_API_KEY ?? '';
const SPEND = process.argv.includes('--spend-a-credit');

interface Check {
  name: string;
  endpoint: string;
  why: string;
  costsCredits: boolean;
  run: () => Promise<Response>;
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-api-key': KEY
    },
    body: JSON.stringify(body)
  });
}

const checks: Check[] = [
  {
    name: 'People Search',
    endpoint: 'POST /mixed_people/search',
    why: 'finds people at an account. Discovery only: it returns no emails and no phone numbers.',
    costsCredits: false,
    run: () =>
      post('/mixed_people/search', {
        q_organization_domains_list: ['apollo.io'],
        person_titles: ['head of data'],
        page: 1,
        per_page: 1
      })
  },
  {
    name: 'Organization Search',
    endpoint: 'POST /mixed_companies/search',
    why: 'checks an account exists and looks the way the ICP expects before we spend anything on its people.',
    costsCredits: false,
    run: () => post('/mixed_companies/search', { q_organization_domains_list: ['apollo.io'], page: 1, per_page: 1 })
  },
  {
    name: 'Bulk People Enrichment',
    endpoint: 'POST /people/bulk_match',
    why: 'the only way to get a work email. Up to ten people per call.',
    costsCredits: true,
    run: () =>
      post('/people/bulk_match', {
        reveal_personal_emails: false,
        details: [{ first_name: 'Tim', last_name: 'Zheng', domain: 'apollo.io' }]
      })
  }
];

function verdict(status: number): { ok: boolean; note: string } {
  if (status === 200) return { ok: true, note: 'available' };
  if (status === 401) return { ok: false, note: 'key rejected — check APOLLO_API_KEY' };
  if (status === 403) {
    return {
      ok: false,
      note: 'not authorised — either your plan does not include it, or your key is scoped without it'
    };
  }
  if (status === 429) return { ok: false, note: 'rate limited — wait an hour and try again' };
  return { ok: false, note: `unexpected status ${status}` };
}

async function main(): Promise<void> {
  if (KEY.trim() === '') {
    console.error('APOLLO_API_KEY is not set.');
    console.error('Create a key at Settings > Integrations > API in Apollo, then put it in .env.');
    console.error('See docs/APOLLO-SETUP.md for the whole sequence.');
    process.exit(1);
  }

  console.log('Asking Apollo what this key can reach.\n');
  let blocked = 0;

  for (const check of checks) {
    if (check.costsCredits && !SPEND) {
      console.log(`  SKIPPED  ${check.name}`);
      console.log(`           ${check.endpoint}`);
      console.log('           costs about one credit; re-run with --spend-a-credit to test it\n');
      continue;
    }

    let response: Response;
    try {
      response = await check.run();
    } catch (error) {
      console.log(`  ERROR    ${check.name}: ${error instanceof Error ? error.message : String(error)}\n`);
      blocked += 1;
      continue;
    }

    const { ok, note } = verdict(response.status);
    if (!ok) blocked += 1;
    console.log(`  ${ok ? 'OK      ' : 'BLOCKED '} ${check.name}`);
    console.log(`           ${check.endpoint} — ${note}`);
    console.log(`           ${check.why}`);
    if (!ok) {
      const body = await response.text();
      console.log(`           apollo said: ${body.slice(0, 200)}`);
    }
    console.log('');
  }

  const publicUrl = process.env.PUBLIC_BASE_URL;
  console.log('Webhook, for phone enrichment:');
  if (publicUrl === undefined || publicUrl.trim() === '') {
    console.log('  PUBLIC_BASE_URL is not set. Apollo delivers phone numbers asynchronously to a');
    console.log('  public HTTPS URL and refuses the request without one, so phone enrichment');
    console.log('  cannot work until this is set. Office direct dials do not need it.\n');
  } else if (!publicUrl.startsWith('https://')) {
    console.log(`  ${publicUrl} is not HTTPS. Apollo requires HTTPS.\n`);
  } else {
    console.log(`  ${publicUrl}/webhooks/apollo`);
    console.log('  Check it from your phone with wifi off before relying on it.\n');
  }

  if (blocked === 0) {
    console.log(SPEND ? 'Everything Phase 3 needs is available.' : 'The free checks passed. Re-run with --spend-a-credit to test enrichment.');
  } else {
    console.log(`${blocked} of the endpoints Phase 3 needs are not available on this key.`);
    console.log('If the key is scoped, recreate it with those endpoints selected, or as a master key.');
    console.log('If it is already a master key, the plan is the limit. See docs/APOLLO-SETUP.md.');
    process.exit(1);
  }
}

await main();

export {};
