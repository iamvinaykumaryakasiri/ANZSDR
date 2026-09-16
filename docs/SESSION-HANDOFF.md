# Session handoff

The resume point for this build. Read [`CLAUDE.md`](../CLAUDE.md) first — that is
the brief and it governs. This document is the state of play and the reasoning
behind it, so a fresh session does not re-derive or re-litigate any of it.

**Branch:** `claude/anz-voice-sdr-build-8o6q1m`
**State:** Phases 1 and 2 complete and accepted. Phase 3 not started.
**Last verified:** 333 tests green, 100% branch coverage on `src/compliance`,
working tree clean, everything pushed.

**First campaign is loaded.** `NZ banking pilot`, market NZ: Kiwibank and TSB at
priority 1, four tier 2 banks at 2, two tier 3 at 3. Twenty-nine technology
titles from CIO down to engineering manager. Three meetings a week, US$25 ceiling.

**Two test contacts are loaded**, both on `+61448455510` — a number Vinay
answers — against Kiwibank and TSB. Both are marked `kind: test`, so the gate
will consider them while the system is in test mode. Both are an *Australian*
mobile on a *New Zealand* account, which is deliberate and now handled: the
market of a dial follows the number, not the employer's country. See
"Dialling the operator's own mobile" below for the one flag that has to be
turned on before they can actually be rung, and note that sharing one number
means `max_dials_per_number_per_day: 1` permits only one of the two per day.

---

## Resume in one minute

```bash
npm install           # postinstall runs `prisma generate`
npm run db:setup      # apply migrations
npm test              # 333 tests, ~25s, includes the 15,000-request fuzz acceptance
npm run test:coverage # fails below 100% branch coverage on src/compliance
npm run typecheck
```

If those are green, the ground you are standing on is the ground this handoff
describes. To watch the whole loop run end to end:

```bash
cp config/fixtures.example.json config/fixtures.json
npm run seed:demo                # example campaign, account, first task
npm run tick                     # prospect + research, decisions printed
npm run seed:demo -- phones      # example numbers, so the plan has something to plan
npm run plan -- draft            # today's calling, with what the gate says about each entry
npm run plan -- approve          # release it: these people, today only

export ADMIN_TOKEN=$(openssl rand -hex 24)
npm run serve                    # the account desk on http://localhost:8080/
```

---

## Where things stand

| Phase | State |
|---|---|
| 1 — Compliance core | Complete and accepted |
| 2 — Blackboard and orchestrator | Complete and accepted, including the daily call plan and its approval gate |
| 3 — Prospector and Scout | **Next.** Needs an Apollo key; see below |
| 4–9 | Not started |

Nothing in the repository can place a call. There is no telephony, no voice
provider, and no model call anywhere on the dial path.

---

## What exists

```
src/compliance/            the dial gate. Deterministic, 100% branch coverage, no model
  types.ts                 dial requests, decisions, deny codes, snapshots
  policy.ts                STATUTORY windows frozen in code + the YAML policy loader
  phone.ts                 AU/NZ number parsing, line type, locality resolution
  holidays.ts              runtime calendar: holiday / part-day / out-of-coverage / unverified
  calling-window.ts        the operator window and the statutory window, evaluated separately
  suppression.ts           permanent cross-campaign suppression matching
  dnc.ts                   Do Not Call washing and the mobile-dialling switch
  attempts.ts              attempt caps, intervals, per-account weekly pacing
  kill-switch.ts           state machine + deterministic auto-trip evaluation
  audit.ts                 append-only audit records, in-memory and JSONL
  ports.ts                 storage ports + in-memory adapters
  gate.ts                  evaluateDialRequest() — the pure decision function
  service.ts               ComplianceGate — loads the snapshot, evaluates, audits

src/blackboard/            the shared store
  schemas.ts               Zod schemas for every constrained column and JSON column
  client.ts                connection, migration application, repo-root-anchored URLs
  repositories.ts          tasks and the task graph, escalations, spend, journal, trace
  compliance-stores.ts     Prisma implementations of the Phase 1 compliance ports
  call-plans.ts            the daily call plan record

src/agents/                the sub-agent contract and its runner
  contract.ts              section 3.1: role, model, input, output, tools, budget, escalatesTo
  budget.ts                continuous metering of turns, tokens, dollars, wall clock
  runner.ts                the only way to run a sub-agent
  journal.ts               where a run's story is written
  prospector/, scout/      real contracts, stub handlers, fixture-backed tools

src/orchestrator/          the Campaign Director
  registry.ts              task kind -> agent, and what follows from a result
  kinds.ts                 prospect-account and research-contact, wired end to end
  director.ts              the tick
  planner.ts               drafts the day's calling and asks the gate about each entry
  cli.ts, plan-cli.ts      npm run tick, npm run plan

src/web/                   the account desk (NOT the section 14 console)
  server.ts                Fastify, token-gated. Will also host the Apollo webhook
  accounts-api.ts          accounts, ICP, goal, spreadsheet paste and CSV export
  public/index.html        one page, no build step

src/ops/                   kill-switch state and CLI
prisma/                    schema and migrations for the SQLite blackboard
config/policy.yaml         operator policy — can only ever make calling more restrictive
config/campaign.yaml       the campaign, the ICP and the budget — committed source of truth
config/accounts.csv        the account list — committed, survives a fresh clone
config/contacts.csv        the people — `kind` decides whether each can be dialled
config/holidays/           generated AU and NZ calendars (committed, reviewable diffs)
scripts/                   holiday rule engine, calendar sign-off, Apollo check, demo seed
data/sources/              vendored official data.gov.au holiday dataset
docs/APOLLO-SETUP.md       how to set Apollo up without paying first
```

---

## Acceptance evidence

**Phase 1** — *a fuzz test over 10,000 synthetic dial requests yields zero
out-of-window or suppressed dials.*

`tests/compliance/fuzz.test.ts` runs two 5,000-request passes. Zero out-of-window
dials, zero suppressed dials, zero Saturday dials, zero dials without an approved
plan. Every decision is cross-checked against an oracle written independently of
the gate — its own area-code table, its own window arithmetic, its own read of
the raw calendar JSON — and the two agree on every request **in both directions**.
That two-way agreement is what rules out the degenerate pass where a gate
satisfies the criterion by refusing everything.

**Phase 2** — *a task runs end to end with full trace, a deliberately malformed
sub-agent output fails closed, and a budget breach escalates rather than
continuing.*

All three in `tests/orchestrator/director.test.ts`. One `prospect-account` task
produces two contacts (the recruiter correctly rejected by the ICP), queues a
`research-contact` task each, and both produce sourced dossiers, with sixteen
plain-English trace lines attached to their tasks. A Prospector returning
off-contract data is tried exactly twice, escalated, and writes nothing. A handler
taking one turn too many is stopped at the ceiling with no output and its spend
still on the ledger.

---

## The three operator rules, and how they are enforced

Added after Phase 2 and now part of the brief (CLAUDE.md §2, §7.1, §7.6).

1. **No Saturdays.** `AU_STATUTORY.sat` is `null` in `src/compliance/policy.ts` —
   stricter than the Industry Standard, which permits Saturday 09:00–17:00. It
   lives in code, so no edit to `config/policy.yaml` can re-open it, and the fuzz
   test asserts no allowed dial ever lands on a Saturday in any candidate
   locality or on the operator's clock.

2. **One clock per market.** `calling-window.ts` evaluates two separate windows.
   `evaluatePolicy` runs once on the operator's clock and calendar
   (`Australia/Sydney` / `au-nsw`, `Pacific/Auckland` / `nz-national`).
   `evaluateStatutory` runs per candidate recipient locality. A dial needs both.

   This was the instruction that needed care rather than literal obedience: a
   naive "everything is AEST" would call Perth at 06:30 local and Brisbane at
   08:30 during daylight saving, both breaches. Keeping the statutory check means
   anchoring to Sydney can only ever delay a call, never permit one. A Perth
   prospect is reachable between noon and 16:30 Sydney, which is 09:00 to 13:30
   their time.

3. **Daily plan approval.** A deny code, `DAY_PLAN_NOT_APPROVED`, enforced in the
   gate alongside calling hours — not in the orchestrator and not in a prompt.
   `src/blackboard/call-plans.ts` holds the record, `src/orchestrator/planner.ts`
   drafts it, `npm run plan` is the operator's side. Approval is of named people
   on a named day: it does not carry over and does not extend to anyone not on
   the list. The planner asks the gate about every candidate with the approval
   check switched off, so a draft can be honest about its own blocks before
   anyone approves it. Prospecting and research continue without approval;
   neither is a call.

---

## Design decisions — do not re-litigate

**Compliance**

1. **The gate is a pure function.** `evaluateDialRequest(request, snapshot,
   policy, calendar)` has no I/O. `ComplianceGate` does the loading and auditing
   around it. This is what makes the fuzz test possible without a database.
2. **Statutory windows are frozen in code** and checked independently of
   `config/policy.yaml`. Both must pass, so no config change widens the legal
   window. An attempt to widen produces a warning on load, not a clamp.
3. **A number resolves to a SET of localities** and the statutory window must be
   open in all of them. An `02` number could be in Sydney or Canberra; a mobile
   could be anywhere. This is load-bearing: a Sydney landline is correctly
   blocked on Canberra Day unless enrichment has pinned it to NSW.
4. **The gate returns every reason at once**, not the first one it hits, each
   carrying `permanent` and, where knowable, `retryableAt`.
5. **Holiday rules live at build time only.** `scripts/holidays/rules.ts`
   generates `config/holidays/*.json`; the runtime reads the JSON and never the
   rules, so a calendar change is always a reviewable diff.
6. **Conservative superset invariant on holidays.** The generated calendar must
   be a superset of the gazetted one. Blocking a day the government did not
   gazette costs one dial slot; missing one it did is a breach.
7. **The kill switch is a file, not a database row.** If the database is what has
   gone wrong, the stop button still has to work.

**Orchestration**

8. **`runAgent` is the only way to run a sub-agent.** The guarantees live in the
   runner, not the handler: two output attempts then escalate, continuous budget
   metering, and tools limited to what the contract declares. A handler that
   hangs is stopped by its own wall-clock budget.
9. **The orchestrator decides what follows from a result**, never the agent that
   produced it. Sub-agents return results; they do not queue each other's work.
10. **Storage is behind ports.** In-memory and Prisma implementations are held to
    one conformance suite, including the gate returning the same answer either
    way, so the Phase 1 acceptance still means something with a database under it.
11. **SQLite has no enums and no JSON type**, so constrained columns are text
    validated by Zod on the way in and out. A corrupt row throws rather than
    reaching an agent.
12. **Sourcing is enforced by the schema.** `sourcedFactSchema` requires a URL, so
    an unsourced hook cannot be stored at all. When Phase 4 assembles a briefing
    pack there is no path by which an unsourced claim reaches Caller.
13. **Relative `file:` database URLs are anchored to the repository root.** The
    Prisma CLI resolves them against the schema directory and the runtime against
    the working directory, which silently produces two databases.
14. **`import.meta.dirname` is not used for repository paths.** Some transforms
    rewrite it to the entry module's directory. Use
    `dirname(fileURLToPath(import.meta.url))`.
15. **Stub handlers sit behind real contracts.** Phase 3 swaps handlers and tools;
    contracts, task graph and budgets do not move.

**The account desk**

16. **It is not the section 14 console.** That is Phase 8 and starts with a design
    review. The desk is an admin surface and says so on its own masthead.
17. **It refuses to start without `ADMIN_TOKEN`.** It edits the list of people the
    system will call; it is never served unauthenticated, and the token
    comparison is timing-safe.
18. **Removing a worked account closes it** rather than deleting it, so the record
    of what was said to people there survives.
19. **The delimiter is chosen once per pasted block**, and quote handling applies
    to comma-separated input only. Excel pastes cells tab-separated and literal,
    so an account called "Bank, The" survives a paste and a `"` in a note is not
    eaten.
20. **The weekly ceiling comes from the campaign goal**, which the desk edits, not
    from a constructor default. The number on the page is the number the Director
    obeys.

---

## What ships deliberately blocked

An office direct dial today returns `CALLER_ID_NOT_CONFIGURED` +
`HOLIDAY_CALENDAR_UNVERIFIED`; a mobile also returns `MOBILE_DIALLING_DISABLED`;
and with no approved plan, `DAY_PLAN_NOT_APPROVED`.

| Block | Where | Clears when |
|---|---|---|
| No caller ID numbers | `config/policy.yaml` → `caller_id` | §15 item 3 answered |
| `allow_mobile_dialling: false` | `config/policy.yaml` → `dnc` | §15 item 4 answered |
| `exempt_test_contacts: false` | `config/policy.yaml` → `dnc` | Vinay decides — see below. Required before Phase 5 can dial anything |
| `require_verified_calendar: true` | `config/policy.yaml` → `holidays` | a human runs `npm run holidays:verify -- --sign-off all:2026 --by "<name>"` |
| `test_contacts_only: true` | `config/policy.yaml` → `dialling` | deliberately, once §15 items 2, 3 and 4 are answered |
| `require_daily_plan: true` | `config/policy.yaml` → `approval` | not waiting on anything — this is how the system is meant to run |

The first four are one-line changes and none should be made without the
corresponding answer.

### Dialling the operator's own mobile

§7.2 bans mobiles until DNCR washing is arranged, because Apollo hands back
personal mobiles and a personal mobile can be registered. But every number
Vinay controls is a mobile, so §13 Phase 5's *"calls only to numbers I control"*
and that ban cannot both hold. `dnc.exempt_test_contacts` is the way through.

It is narrow on purpose:

- The contact must be recorded `test` **on the blackboard**. `contactKind` is
  read from the record by the gate, never taken from the dial request, so
  nothing upstream can assert its way past it.
- `dialling.test_contacts_only` must still be true. Taking the system out of
  test mode takes the exemption with it, which is exactly when you want it gone.
- A wash result that positively says *registered* still refuses the dial.

The risk it carries is mis-marking: anyone typed into `config/contacts.csv`
with `kind` = `test` skips the DNC check entirely. Only numbers Vinay personally
answers belong in that column. The CSV default falls the safe way — anything not
literally `test` is treated as a real person — but the column is still typed by
hand.

---

## Known limitations, flagged not hidden

**The official `data.gov.au` holiday dataset publishes 2021–2025 only.** 2026 and
2027 are derived by the rule engine, which the tests validate differentially
against all five published years across all eight states and territories. Eight
annually-proclaimed holidays have no published date and are reported as gaps
rather than treated as working days:

- NT show days (Alice Springs, Tennant Creek, Katherine, Darwin) — 2027
- Royal Queensland Show — 2027
- Victoria's Friday before the AFL Grand Final — 2026 and 2027
- WA King's Birthday — 2027

New Zealand publishes no machine-readable dataset at all, so its whole calendar
is derived from the Holidays Act 2003 and is unverified. `npm run holidays:verify`
lists everything outstanding.

**Apollo's Free plan does not include the search API.** Verified directly against
the live account, which returned: *"The api/v1/mixed_people/api_search API is not
included in your Free plan and is not accessible. All paid plans include full API
access."* Both `mixed_people/search` and `mixed_companies/search` are blocked, so
Phase 3 cannot begin discovery on Free. Apollo's own wording points at **Basic**
(~US$49/user/month) rather than the ~US$119 Organization tier third-party articles
claim. `npm run apollo:check` re-tests this on any key.

---

## Next: Phase 3 — Prospector and Scout

> *Accept: 20 real contacts across 5 ANZ accounts with verified emails,
> source-attributed dossiers, and zero duplicate Apollo spend.*

**The account list is no longer a blocker.** Rather than a list in a message, the
operator maintains it on the account desk (`npm run serve`): accounts, ICP titles,
seniorities, never-call words, the minimum score to enrich, the meetings-per-week
goal and the weekly spend ceiling. Paste a block from Excel; export CSV back.

**What is still needed before starting:**

- **An Apollo Basic plan and an API key.** The connected account is on Free,
  which blocks both search endpoints — verified, not assumed. See
  `docs/APOLLO-SETUP.md`. The account holds 180 email credits and 160 direct-dial
  credits, which is ample for the twenty-contact acceptance run once search works.
- ~~Real accounts and titles~~ **Done.** `config/campaign.yaml` and
  `config/accounts.csv` now hold the first campaign: eight New Zealand tier 2/3
  banks and twenty-nine technology titles. See below.
- A **public HTTPS hostname**, but only for mobile numbers. Apollo delivers phone
  enrichment asynchronously to a webhook and refuses the request without one.
  Office direct dials need none of it, and mobile dialling is off anyway until
  §15 item 4 is answered.

**Sketch:**

- Apollo client: `POST /api/v1/mixed_people/search` for discovery, then
  `/people/bulk_match` for enrichment, ten at a time.
- Replace the `people-search` fixture tool with the real one. The Prospector
  contract, the ICP scoring and the task graph do not change.
- Two-stage enrichment: email for everyone who clears the ICP score, phone only
  for those who also clear the research gate — a phone costs roughly eight times
  what an email does.
- An enrichment queue built around the asynchronous phone webhook from day one,
  with an idempotent handler, because Apollo retries. Mount it on the existing
  Fastify server at `/webhooks/apollo`.
- Convert enriched people to Apollo contacts so a later re-enrichment does not
  bill again, and deduplicate against `Contact.apolloId`, which already has a
  unique index.
- Geo-tag each number to a jurisdiction and timezone at enrichment time and write
  it to `Contact.jurisdiction` / `Contact.timezone`. Without it every mobile is
  gated on the most restrictive window in the market.
- Replace the Scout `web-search` fixture tool with real retrieval. The sourcing
  discipline is already enforced by the schema.

---

## Open questions from brief §15

| # | Question | Gates |
|---|---|---|
| 1 | Agent name, voice, gender, accent (AU-neutral assumed) | Phase 4–5 |
| 2 | Hexaware brand/legal sign-off on an AI identifying itself for them | Phase 9 |
| 3 | Twilio numbers, and the callback number answerable for 30 days | Phase 5, and unblocks caller ID |
| 4 | DNCR washing arranged, or office direct dials only to start? | **Phase 3 onward.** Currently office direct dials only |
| 5 | First campaign ICP — which accounts, which titles, AU or NZ first | Answered by building the account desk; the operator enters them there |
| 6 | Which email address meeting requests go to; do `.ics` attachments survive his mail client | Phase 6 |
| 7 | Recording retention (currently 90 days) and whether recordings may leave Australia | Phase 5 |
| 8 | Budget ceilings | Set on the account desk per campaign. Seeded small: 3 meetings/week, US$25/week |

---

## Useful commands

```bash
npm run kill -- status                    # is dialling permitted?
npm run kill -- stop "reason"             # halt everything
npm run kill -- resume                    # a human, and only a human, restarts it

npm run holidays:build                    # regenerate calendars from source + rules
npm run holidays:verify                   # what is not signed off yet
npm run holidays:verify -- --sign-off all:2026 --by "Vinay Kumar"

npm run db:setup                          # apply migrations, generate the client
npm run seed:demo                         # example campaign, account and first task
npm run seed:demo -- phones               # example numbers on researched contacts
npm run tick                              # one Campaign Director tick, decisions printed

npm run plan -- draft | show | approve | reject
npm run serve                             # the account desk (needs ADMIN_TOKEN)

npm run accounts:import                   # config files -> blackboard
npm run accounts:export                   # blackboard -> config files, to commit

npm run apollo:check                      # what an Apollo key can actually reach, free
npm run apollo:check -- --spend-a-credit  # also tests enrichment
```
