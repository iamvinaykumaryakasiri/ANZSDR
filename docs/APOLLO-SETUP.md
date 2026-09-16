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

## The honest bit about plans

Apollo's own documentation says only this:

> Access to Apollo API depends on your Apollo plan. If you need access, upgrade
> your plan, or reach out to the Apollo sales team for guidance.

It does not say which endpoints need which tier, and the third-party articles that
claim to know disagree with each other. Published pricing at the time of writing is
Free, Basic around US$49/user/month, Professional around US$79, and Organization
around US$119, billed annually — but which of those unlocks the endpoints above is
not something to take on trust when it is a recurring bill.

So don't guess, and don't pay first. Ask your own account:

```bash
npm run apollo:check
```

It calls the endpoints Phase 3 actually needs and tells you, per endpoint,
whether your key can reach it. The free checks cost nothing. Enrichment is
skipped unless you ask for it:

```bash
npm run apollo:check -- --spend-a-credit
```

---

## The sequence

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

- **Everything OK** → stay on the free plan for now. Phase 3 can be built and
  tested against it.
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

1. Free plan, work email.
2. Scoped API key with the four endpoints.
3. `npm run apollo:check` — free.
4. Upgrade only if it tells you to, and only to the cheapest tier that passes.
5. Public HTTPS hostname when you want mobile numbers. Not before.

Sources: [Apollo people search reference](https://docs.apollo.io/reference/people-api-search),
[bulk people enrichment](https://docs.apollo.io/reference/bulk-people-enrichment),
[retrieving mobile numbers](https://docs.apollo.io/docs/retrieve-mobile-phone-numbers-for-contacts),
[creating an API key](https://docs.apollo.io/docs/create-api-key).
