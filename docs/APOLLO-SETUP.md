# Setting up Apollo, starting as small as possible

Phase 3 needs three things from Apollo, and one thing from wherever you run this:

| Need | Endpoint | Cost |
|---|---|---|
| Find people at an account | `POST /api/v1/mixed_people/search` | **0 credits** |
| Get their work email | `POST /api/v1/people/bulk_match` | ~1 credit each |
| Get a mobile number | the same call with `reveal_phone_number=true` | ~8× an email, and **asynchronous** |
| Receive the mobile numbers | a public HTTPS URL Apollo can POST to | your hosting |

The important asymmetry: **search is free, enrichment is what costs.** That is why
the system scores everyone against your ICP first and only spends a credit on the
people who clear the bar you set on the account desk.

---

## The plan question, now answered

Apollo's documentation says only that "access to Apollo API depends on your
Apollo plan", and the third-party articles that claim to know which tier
disagree with each other — several insist the Organization plan (~US$119/user/mo)
is required for "advanced API access".

We now have a direct answer, because we asked the account rather than the blogs.
Calling the search endpoints on a **Free** plan returns:

```
The api/v1/mixed_people/api_search API is not included in your Free plan and is
not accessible. All paid plans include full API access.
```

Two things follow, both useful:

1. **Free will not work.** Both `mixed_people/search` and `mixed_companies/search`
   are blocked. Without search there is no discovery, and without discovery the
   Prospector has nothing to score. Enrichment alone does not substitute: the
   design is search, then score, then spend.
2. **The cheapest paid plan should be enough.** "All paid plans include full API
   access" is Apollo's own wording, from Apollo's own error. That points at
   **Basic**, around US$49/user/month billed annually — not the ~US$119
   Organization tier the articles claim.

So: upgrade to **Basic**, then immediately run `npm run apollo:check`. If Basic
really does include full API access, everything Phase 3 needs will come back OK
and there is no reason to go further up the tiers. If something is still blocked,
the check names it, and that is the moment to talk to Apollo rather than to guess
another upgrade.

```bash
npm run apollo:check                      # free: search endpoints only
npm run apollo:check -- --spend-a-credit  # also tests enrichment, costs ~1 credit
```

### 1. Start on the free plan

Sign up at [apollo.io](https://www.apollo.io) **with your Hexaware work email**.
Apollo's docs note that free accounts registered with a personal address are
restricted on the search endpoint; paid accounts are not affected.

### 2. Create an API key

Settings → Integrations → API → **Create new key**.

You are offered a *scoped* key or a *master* key. Scoped is the default and is the
better habit: select exactly these endpoints and nothing else.

- `mixed_people/search`
- `mixed_companies/search`
- `people/bulk_match`
- `people/match`

If those endpoints are not offered in the list, that is itself the answer about
your plan.

Put it in `.env`:

```
APOLLO_API_KEY=your-key-here
```

### 3. Ask what it can do

```bash
npm run apollo:check
```

- **Everything OK** → good, but on a Free plan expect the two search endpoints to
  come back blocked; see above.
- **403 on something** → the message tells you whether it reads as a scope problem
  or a plan problem. If the key is scoped, recreate it with those endpoints
  selected. If it is already a master key, the plan is the limit.
- **Only then** upgrade, to the *cheapest* tier that clears the check, and run the
  check again before the second month bills.

### 4. Credits, and what they buy

A run of the Phase 3 acceptance — 20 contacts across 5 accounts — costs roughly:

| | Credits | Note |
|---|---|---|
| Search | 0 | however many people we look at |
| 20 work emails | ~20 | one per person who clears the ICP score |
| Mobile numbers | 0 to start | mobile dialling is off until DNC washing is arranged |

Twenty-odd credits. Whatever the free plan gives you monthly is very likely
enough to get Phase 3 working. This is the whole reason to start small: you will
know what you need before you commit to it.

### 5. The public hostname

Apollo delivers mobile numbers **asynchronously**, minutes later, by POSTing to a
URL you supply. It requires a public **HTTPS** URL and refuses the request
without one. Office direct dials do not need any of this — only mobile numbers do,
and mobile dialling is off until DNC washing is sorted (§7.2 of the brief). So
this can wait, but it is worth doing early because the account desk needs hosting
anyway.

Cheapest stable option, if you own a domain:

```bash
# Cloudflare Tunnel — free, and the URL does not change between restarts
cloudflared tunnel login
cloudflared tunnel create anzsdr
cloudflared tunnel route dns anzsdr sdr.yourdomain.com
cloudflared tunnel run --url http://localhost:8080 anzsdr
```

Then:

```
PUBLIC_BASE_URL=https://sdr.yourdomain.com
```

`ngrok` works for testing but its free URL changes on every restart, which breaks
webhooks that arrive minutes later. A small VPS or Fly.io/Railway instance works
too and costs a few dollars a month.

Whatever you choose, check it from your phone with wifi off before relying on it:

```
https://sdr.yourdomain.com/healthz   →   {"ok":true,"service":"anz-voice-sdr"}
```

---

## What the system already does to protect your credit balance

None of this is on your discipline:

- **Search before spend.** People Search costs nothing and returns no contact
  details. Everyone is scored against your ICP first.
- **A score floor you set.** Below the minimum score on the account desk, nobody
  is enriched. A loose title list therefore costs nothing.
- **Two stages.** Email for everyone who clears the ICP; a phone number only for
  those who also clear the research gate, because a phone costs about eight times
  what an email does.
- **Deduplication.** `Contact.apolloId` is uniquely indexed. We do not re-acquire
  somebody we already hold, and Phase 3 converts enriched people to Apollo
  contacts so a later re-enrichment does not bill again.
- **A weekly ceiling.** The Campaign Director will not start work whose worst-case
  cost exceeds what is left of the week's budget. You set that number on the
  account desk.

---

## Summary

1. **Upgrade to Basic** (~US$49/user/month annual). Free does not include the
   search API, and search is where Phase 3 starts.
2. Scoped API key with the four endpoints, or a master key.
3. `npm run apollo:check` — free, and it names anything still blocked.
4. Go further up the tiers only if the check says so, not because an article did.
5. Public HTTPS hostname when you want mobile numbers. Not before.

Sources: [Apollo people search reference](https://docs.apollo.io/reference/people-api-search),
[bulk people enrichment](https://docs.apollo.io/reference/bulk-people-enrichment),
[retrieving mobile numbers](https://docs.apollo.io/docs/retrieve-mobile-phone-numbers-for-contacts),
[creating an API key](https://docs.apollo.io/docs/create-api-key).
