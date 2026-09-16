# ANZ Voice SDR

An autonomous multi-agent cold-calling system for Hexaware ANZ. The full brief,
including the build phases and the rules that override everything else, is in
[`CLAUDE.md`](./CLAUDE.md).

**Phases 1 and 2 are complete. Nothing in this repository can place a call.**

## Getting started

```bash
npm install
npm run db:setup      # apply migrations and generate the Prisma client
npm test              # 236 tests, including the 10,000-request fuzz acceptance
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

Two properties are worth knowing about:

**The recipient's clock, not the server's.** A number resolves to every place its
holder might be. An `02` number could be in Sydney or Canberra; a mobile could be
anywhere in the country. The window has to be open in *all* of them, so an
unhinted mobile is gated on the intersection of every state's window and a
Sydney number is blocked on Canberra Day unless enrichment has pinned it to NSW.

**Policy can only narrow.** The statutory windows are frozen in
`src/compliance/policy.ts` and are checked independently of `config/policy.yaml`.
There is no configuration change that widens the legal calling window.

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
```

`npm run tick` is exactly what the scheduler will call in later phases, so the
decisions an operator sees by hand are the decisions the system makes on its own.

Phase 2 ships **stub** Prospector and Scout handlers behind their real contracts.
They read `config/fixtures.json` (copy `config/fixtures.example.json`) rather than
Apollo or the open web. Phase 3 replaces the handlers and the tools; the
contracts, the task graph and the budgets do not move.

## Three things ship deliberately blocked

1. **No caller ID numbers** in `config/policy.yaml`, so every dial is denied with
   `CALLER_ID_NOT_CONFIGURED`. The Industry Standard requires a real number that
   stays answerable for 30 days after the call.
2. **`allow_mobile_dialling: false`**, so only office direct dials are possible.
   Apollo returns personal mobiles and a personal mobile can be on the DNCR.
3. **`require_verified_calendar: true`**, so no dial happens on a date whose
   holiday year has not been signed off by a human. The official Australian
   dataset stops at 2025; 2026 and 2027 are derived from rules.

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
