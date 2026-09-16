# ANZ Voice SDR

An autonomous multi-agent cold-calling system for Hexaware ANZ. The full brief,
including the build phases and the rules that override everything else, is in
[`CLAUDE.md`](./CLAUDE.md).

**Phases 1 and 2 are complete. Nothing in this repository can place a call.**

## Getting started

```bash
npm install
npm run db:setup      # apply migrations and generate the Prisma client
npm test              # 298 tests, including the 10,000-request fuzz acceptance
npm run test:coverage # enforces 100% branch coverage on src/compliance
npm run typecheck
```

## What is here

```
src/compliance/     the dial gate, calling windows, DNC, suppression, caps, kill switch
src/blackboard/     the shared store: Prisma schema access, typed repositories, memory
src/agents/         the sub-agent contract, its runner, and the agents themselves
src/orchestrator/   the Campaign Director, the task graph, budgets, escalation
src/ops/            kill-switch state and CLI
prisma/             schema and migrations for the SQLite blackboard
config/policy.yaml  operator policy - can only ever make calling more restrictive
config/holidays/    generated AU and NZ holiday calendars
scripts/            the holiday rule engine, the sign-off tool, the demo seed
data/sources/       the vendored official data.gov.au holiday dataset
```

## The agent contract

A sub-agent is a contract plus a handler. The contract declares what it may
receive, what it must return, the only tools it can reach, and what it may spend.
Handlers are never called directly - `runAgent` is the only way in, because the
guarantees live in the runner rather than in the goodwill of the handler:

- **Input is validated before the handler sees it, output before anyone else
  does.** An off-contract answer gets exactly one more attempt and is then
  escalated. Malformed output is never returned and never written to the
  blackboard.
- **Budget is metered continuously** - turns, tokens, dollars and wall clock. A
  breach throws, and a throw becomes an escalation rather than a truncated
  answer. A handler that hangs is stopped by its own wall-clock budget.
- **Tools are the only way out.** A tool the contract does not declare, or
  arguments that do not match its schema, is a contract breach.

The Campaign Director decides what follows from a result. A sub-agent returns a
result; it does not get to decide what the system does next, which is what keeps
the task graph inspectable and stops one agent quietly driving another.

## The trace

Every decision is one plain-English line against the task it concerns, so the
console's agent trace never has to render raw JSON:

```
[campaign-director] running prospect-account for 8ea550ba at priority 1; its
                    dependencies are satisfied and it is the oldest work of that priority
[prospector]        searched examplebank.com.au and found 3 people
[prospector]        2 passed the ICP threshold of 60, 1 did not
[campaign-director] prospect-account finished; queued 2 research-contact task(s)
[scout]             dropped 1 unsourced fact(s): a rumour about cost pressure in technology
[scout]             built a high-confidence dossier from 3 sourced fact(s)
[campaign-director] nothing runnable; standing by
```

## The compliance gate

`ComplianceGate.request()` is the only thing in the system that can say yes to a
dial. It is a pure function of the request, a state snapshot, the policy and the
holiday calendar, and it fails closed: an unparseable number, a calendar that
does not cover the date, a wash result it has never seen, are all denials.

It returns every reason at once rather than the first one it hits, so the console
can show exactly why nothing is dialling, and each reason carries whether it is
permanent and when it could clear.

Four properties are worth knowing about:

**Two windows, both of which must be open.** The *statutory* window is where the
recipient actually is; the *operator* window is Vinay's own working day, on one
clock per market — Sydney for Australia, Auckland for New Zealand. One plan, one
clock, whoever is being called. Anchoring the plan to Sydney can only ever delay
a call, never permit an unlawful one: 09:30 Sydney is refused for a Perth number
until it is 09:00 in Perth, and a Perth prospect's day ends at 16:30 Sydney even
though Perth is still well inside legal hours.

**The recipient's clock, not the server's.** A number resolves to every place its
holder might be. An `02` number could be in Sydney or Canberra; a mobile could be
anywhere in the country. The statutory window has to be open in *all* of them, so
an unhinted mobile is gated on the intersection of every state's window and a
Sydney number is blocked on Canberra Day unless enrichment has pinned it to NSW.

**Policy can only narrow.** The statutory windows are frozen in
`src/compliance/policy.ts` and are checked independently of `config/policy.yaml`.
There is no configuration change that widens the legal calling window, and
Saturday is closed there outright — stricter than the Industry Standard, which
permits it.

**Nothing dials until the day's plan is approved.** Approval covers the named
people on the named day; it does not carry over to tomorrow and does not extend
to anyone not on the list. It is enforced in the gate, alongside calling hours.

## The account desk

A small web page for the two lists the system runs on: the organisations to work,
and the titles worth calling at them. It is **not** the console in section 14 of
the brief — that is Phase 8 and starts with a design review. It shares a process
with the Apollo webhook, because that needs a public HTTPS hostname anyway.

```bash
export ADMIN_TOKEN=$(openssl rand -hex 24)
npm run serve        # http://localhost:8080/
```

The server refuses to start without `ADMIN_TOKEN`: this page edits the list of
people the system will call, and is never served unauthenticated.

What it does:

- **Titles, seniorities and a never-call list.** A title containing a never-call
  word is dropped whatever the seniority.
- **A minimum score to enrich.** Below it nobody is enriched, so a loose title
  list costs nothing — search is free, enrichment is what bills.
- **Meetings per week and a weekly spend ceiling.** The Campaign Director reads
  the ceiling from here and will not start work it cannot afford to finish.
- **Paste straight from Excel.** Copy the cells and paste; tab-separated rows are
  read literally, a header row is optional, and a domain already on the campaign
  is updated rather than duplicated.
- **Removing a worked account closes it** rather than deleting it, so the record
  of what was said to people there survives.

### Where the list actually lives

`config/campaign.yaml` and `config/accounts.csv` are the committed source of
truth: the campaign, the ICP titles, the never-call words, the budget, and the
accounts. A database lives on one machine; these files survive a fresh clone, and
every change to them is a reviewable diff.

```bash
npm run accounts:import   # files -> blackboard
npm run accounts:export   # blackboard -> files, so desk edits can be committed
```

Edit the files and import, or edit on the desk and export. Either way, commit.
Import is idempotent: the campaign is matched by name and an account already on
it is updated rather than duplicated. An account's `status` is left alone on
import, because that is worked state, not list state.

## Apollo

See [`docs/APOLLO-SETUP.md`](./docs/APOLLO-SETUP.md). The short version: start on
the free plan, create a scoped API key, and run

```bash
npm run apollo:check                     # free: search endpoints only
npm run apollo:check -- --spend-a-credit # also tests enrichment
```

before paying for anything. Apollo's own documentation does not say which plan
unlocks which endpoint, so the script asks your account directly.

## Operating it

```bash
npm run kill -- status            # is dialling permitted?
npm run kill -- stop "reason"     # halt everything
npm run kill -- resume            # a human, and only a human, restarts it

npm run holidays:build            # regenerate the calendars from source + rules
npm run holidays:verify           # what is not signed off yet
npm run holidays:verify -- --sign-off all:2026 --by "Vinay Kumar"

npm run db:setup                  # apply migrations, generate the client
npm run seed:demo                 # an example campaign, account and first task
npm run tick                      # run one Campaign Director tick and print its decisions

npm run plan -- draft             # draw up today's calling and submit it for approval
npm run plan -- show              # what is planned, and what the gate says about each entry
npm run plan -- approve "note"    # release today's list. Today only, these people only
npm run plan -- reject "why"      # send it back; the reason stays on the record
```

A drafted plan reads like this, and is honest about its own blocks before asking
to be approved:

```
Call plan for 2026-09-16 — pending approval
2 contact(s) planned, 0 clear the compliance gate right now

 1. Priya Raman — Chief Data Officer, Example Bank
    +61280005100 · no lawful window today
    why: likely under pressure on a three-year core banking modernisation
    blocked: CALLER_ID_NOT_CONFIGURED — no AU caller line identification number is configured
    blocked: HOLIDAY_CALENDAR_UNVERIFIED — the 2026 calendar is derived-rule and has not been signed off
```

`npm run tick` is exactly what the scheduler will call in later phases, so the
decisions an operator sees by hand are the decisions the system makes on its own.

Phase 2 ships **stub** Prospector and Scout handlers behind their real contracts.
They read `config/fixtures.json` (copy `config/fixtures.example.json`) rather than
Apollo or the open web. Phase 3 replaces the handlers and the tools; the
contracts, the task graph and the budgets do not move.

## Four things ship deliberately blocked

1. **No caller ID numbers** in `config/policy.yaml`, so every dial is denied with
   `CALLER_ID_NOT_CONFIGURED`. The Industry Standard requires a real number that
   stays answerable for 30 days after the call.
2. **`allow_mobile_dialling: false`**, so only office direct dials are possible.
   Apollo returns personal mobiles and a personal mobile can be on the DNCR.
3. **`require_verified_calendar: true`**, so no dial happens on a date whose
   holiday year has not been signed off by a human. The official Australian
   dataset stops at 2025; 2026 and 2027 are derived from rules.
4. **`require_daily_plan: true`**, so no dial happens until the day's plan has
   been approved. Unlike the other three this one is not waiting on an answer —
   it is how the system is meant to run.

Each is a one-line change once the corresponding question in §15 of the brief has
an answer.

## Holiday data

The Australian calendar is built from the official `data.gov.au` machine-readable
dataset, vendored in `data/sources/`. The published resource covers 2021-2025
only, so later years come from the rule engine in `scripts/holidays/rules.ts`.

Those rules are validated differentially: the test suite asserts they reproduce
every gazetted holiday, in all eight states and territories, for all five
published years. Holidays that are proclaimed annually rather than defined by
rule - Western Australia's King's Birthday, the Northern Territory show days, the
Royal Queensland Show, Victoria's AFL Grand Final Friday - are listed explicitly,
and any year where one is unknown is reported as a gap rather than silently
treated as a working day.

New Zealand has no equivalent published dataset, so its calendar is derived from
the Holidays Act 2003 and is entirely unverified until signed off.
