# Session handoff

Written at the end of the Phase 1 session so the next one can pick up without
re-deriving anything. Read `CLAUDE.md` first — it is the brief and it governs.

**Branch:** `claude/anz-voice-sdr-build-8o6q1m`
**State:** Phases 1 and 2 complete and accepted. Phase 3 not started. Working tree
clean, everything pushed.

**Three operator rules were added after Phase 2 and are now part of the brief:**
no Saturday calling ever; the calling plan runs on Sydney time for Australia and
Auckland time for New Zealand; and every day's calling is approved by Vinay before
any of it is dialled. See CLAUDE.md sections 7.1 and 7.6.

---

## Resume in one minute

```bash
npm install           # postinstall runs `prisma generate`
npm run db:setup      # apply migrations
npm test              # 265 tests, ~10s, includes the 10,000-request fuzz acceptance
npm run test:coverage # fails below 100% branch coverage on src/compliance
npm run typecheck
```

If those are green, the ground you are standing on is the ground this handoff
describes. To watch the loop run:

```bash
cp config/fixtures.example.json config/fixtures.json
npm run seed:demo && npm run tick
npm run seed:demo -- phones      # example numbers, so the plan has something to plan
npm run plan -- draft            # today's calling, with what the gate says about each entry
npm run plan -- approve          # release it: these people, today only
```

---

## What Phase 2 delivered

The blackboard, the agent contract and its runner, the Campaign Director, and two
stub agents that prove the loop end to end.

```
prisma/schema.prisma     the blackboard: campaigns, accounts, contacts, emails,
                         dossiers, calls, compliance state, tasks, runs, traces,
                         escalations, spend, memory, playbooks
src/blackboard/
  schemas.ts             Zod schemas for every constrained column and JSON column
  client.ts              connection, migration application, repo-root-anchored URLs
  repositories.ts        tasks and the task graph, escalations, spend, journal, trace
  compliance-stores.ts   Prisma implementations of the Phase 1 compliance ports
src/agents/
  contract.ts            the section 3.1 contract: role, model, input, output,
                         tools, budget, escalatesTo
  budget.ts              continuous metering of turns, tokens, dollars, wall clock
  runner.ts              the only way to run a sub-agent
  journal.ts             where a run's story is written
  prospector/, scout/    real contracts, stub handlers, fixture-backed tools
src/orchestrator/
  registry.ts            task kind -> agent, and what follows from a result
  kinds.ts               prospect-account and research-contact, wired end to end
  director.ts            the Campaign Director tick
  cli.ts                 `npm run tick`
```

### Acceptance evidence

> *Phase 2 accept: a task runs end to end with full trace, a deliberately
> malformed sub-agent output fails closed, and a budget breach escalates rather
> than continuing.*

All three in `tests/orchestrator/director.test.ts`:

- **End to end with a full trace.** One `prospect-account` task produces two
  contacts (the recruiter is correctly rejected by the ICP), queues a
  `research-contact` task each, and both produce sourced dossiers. Sixteen trace
  lines tell the whole story in plain English, attached to their task.
- **Malformed output fails closed.** A Prospector returning off-contract data is
  tried exactly twice, escalated, and writes nothing: no contacts, no dossiers,
  no task result. The task that depended on it is marked blocked rather than left
  pending.
- **Budget breach escalates.** A handler taking one turn too many is stopped at
  the ceiling, the run is recorded as `budget-exceeded` with no output, and what
  it spent before being stopped is still on the ledger. The Director also refuses
  to *start* work whose worst-case cost exceeds the remaining weekly budget.

Also covered: the kill switch halting a tick, an automatic trip on the third
escalation of the day (the Phase 1 rule, fed by Phase 2 signals), a lost
blackboard tripping the switch, and an unknown task kind escalating to a human.

Coverage on the Phase 2 modules is 98% of statements and 93% of branches. The
100% branch threshold remains enforced on `src/compliance` only, as the brief
specifies.

### The three operator rules, and how they are enforced

1. **No Saturdays.** `AU_STATUTORY.sat` is `null` in `src/compliance/policy.ts`.
   Stricter than the Industry Standard, which permits Saturday 09:00-17:00.
   It lives in code, so no edit to `config/policy.yaml` can re-open it, and the
   fuzz test asserts no allowed dial ever lands on a Saturday in any candidate
   locality or on the operator's clock.

2. **One clock per market.** `calling-window.ts` evaluates two separate windows.
   `evaluatePolicy` runs once, on the operator's clock and calendar
   (`Australia/Sydney` / `au-nsw`, `Pacific/Auckland` / `nz-national`).
   `evaluateStatutory` runs per candidate recipient locality, unchanged. A dial
   needs both.

   This was the one instruction that needed care: a naive "everything is AEST"
   would call Perth at 06:30 local and breach the Standard. Keeping the statutory
   check means anchoring to Sydney can only delay a call, never permit one. A
   Perth prospect is reachable between noon and 16:30 Sydney, which is 09:00 to
   13:30 their time.

3. **Daily plan approval.** A new deny code, `DAY_PLAN_NOT_APPROVED`, enforced in
   the gate alongside calling hours - not in the orchestrator and not in a prompt.
   `src/blackboard/call-plans.ts` holds the record, `src/orchestrator/planner.ts`
   drafts it, `npm run plan` is the operator's side. Approval is of named people
   on a named day: it does not carry over and does not extend to anyone not on
   the list. The planner asks the gate about every candidate with the approval
   check switched off, so the plan can be honest about its own blocks before
   anyone approves it.

### Design decisions made in Phase 2 — do not re-litigate

1. **`runAgent` is the only way to run a sub-agent.** Guarantees live in the
   runner, not in the handler. Two output attempts, then escalate.
2. **The orchestrator decides what follows from a result**, never the agent that
   produced it. Sub-agents return results; they do not queue each other's work.
3. **SQLite has no enums and no JSON type**, so constrained columns are text
   validated by Zod on the way in and out. A corrupt row throws rather than
   reaching an agent.
4. **Sourcing is enforced by the schema.** `sourcedFactSchema` requires a URL, so
   an unsourced hook cannot be stored at all. The stub Scout drops unsourced
   findings and reports them as unverified.
5. **Relative `file:` database URLs are anchored to the repository root.** The
   Prisma CLI resolves them against the schema directory and the runtime against
   the working directory, which silently produces two databases.
6. **Stub handlers sit behind real contracts.** Phase 3 swaps handlers and tools;
   contracts, task graph and budgets do not move.

## What Phase 1 delivered

The deterministic compliance core. Nothing in the repository can place a call:
there is no telephony, no voice provider, no model call anywhere in this path.

```
src/compliance/
  types.ts           domain types: dial requests, decisions, deny codes, snapshots
  policy.ts          STATUTORY windows frozen in code + the YAML policy loader
  phone.ts           AU/NZ number parsing, line-type and locality resolution
  holidays.ts        runtime calendar: holiday / part-day / out-of-coverage / unverified
  calling-window.ts  window evaluation per locality, and the next-open search
  suppression.ts     permanent cross-campaign suppression matching
  dnc.ts             Do Not Call washing and the mobile-dialling switch
  attempts.ts        attempt caps, intervals, per-account weekly pacing
  kill-switch.ts     state machine + deterministic auto-trip evaluation
  audit.ts           append-only audit records, in-memory and JSONL
  ports.ts           storage ports + in-memory adapters (Prisma swaps in at Phase 2)
  gate.ts            evaluateDialRequest() — the pure decision function
  service.ts         ComplianceGate — loads the snapshot, evaluates, audits
src/ops/
  kill-switch-store.ts   file-backed state, so the stop button works if the DB is down
  kill-switch-cli.ts     npm run kill -- stop|resume|status
scripts/holidays/        the build-time rule engine and the sign-off tool
config/holidays/         generated AU + NZ calendars (committed, reviewable diffs)
data/sources/            vendored official data.gov.au dataset
```

## Acceptance evidence

> *Phase 1 accept: a fuzz test over 10,000 synthetic dial requests yields zero
> out-of-window or suppressed dials.*

`tests/compliance/fuzz.test.ts` runs 5,000 requests with the holiday sign-off
required and 5,000 without. Zero out-of-window dials, zero dials to suppressed
contacts. Each decision is cross-checked against an oracle written independently
of the gate — its own area-code table, its own window arithmetic, its own read of
the raw calendar JSON — and the two agree on every request **in both directions**.
That two-way agreement is what rules out the degenerate pass where a gate
satisfies the criterion by refusing everything: 271 and 84 dials were allowed in
the two runs, each independently verified open in every candidate locality.

100% branch coverage on `src/compliance`, enforced by the vitest threshold.

---

## Design decisions made — do not re-litigate

1. **The gate is a pure function.** `evaluateDialRequest(request, snapshot, policy,
   calendar)` has no I/O. `ComplianceGate` (service.ts) does the loading and
   auditing around it. This is what makes the fuzz test possible without a database.

2. **Statutory windows are frozen in code**, in `src/compliance/policy.ts`, and are
   checked independently of `config/policy.yaml`. Both must pass. There is no code
   path by which a config change widens the legal calling window; the YAML can only
   narrow it. Attempts to widen produce a warning on load, not a clamp.

3. **A number resolves to a SET of localities, and the window must be open in all
   of them.** An `02` number could be in Sydney or Canberra; a mobile could be
   anywhere in the country. This is how "unknown location defaults to the most
   restrictive window" is implemented, and it is load-bearing — a Sydney landline
   is correctly blocked on Canberra Day unless enrichment has pinned it to NSW.
   Enrichment hints (`localityHint`) collapse the set to one place.

4. **The gate returns every reason at once**, not the first one it hits, so the
   console can show why nothing is dialling. Each reason carries `permanent` and,
   where knowable, `retryableAt`. The request-level `retryableAt` is the latest of
   them, and is undefined if any reason is permanent or has no knowable clearing
   time (kill switch, concurrency).

5. **Holiday rules live at build time only.** `scripts/holidays/rules.ts` generates
   `config/holidays/*.json`; the runtime reads the JSON and never the rules. A
   calendar change is therefore always a reviewable diff, and a rule bug cannot
   silently alter a live decision.

6. **Conservative superset invariant on holidays.** The generated calendar must be
   a superset of the gazetted one. Blocking a day the government did not gazette
   costs one dial slot; missing one it did gazette is a breach.

7. **Storage is behind ports.** `SuppressionStore`, `DncStore`, `AttemptStore`,
   `CallStateStore`, `KillSwitchStore`, `AuditLog`. In-memory implementations exist
   and are tested. Phase 2 provides Prisma-backed ones; no decision logic changes.

8. **The kill switch is a file, not a database row.** If the database is what has
   gone wrong, the stop button still has to work.

---

## What ships deliberately blocked

Verified against the shipped config: an office direct dial today returns
`CALLER_ID_NOT_CONFIGURED` + `HOLIDAY_CALENDAR_UNVERIFIED`; a mobile also returns
`MOBILE_DIALLING_DISABLED`.

| Block | Where | Clears when |
|---|---|---|
| No caller ID numbers | `config/policy.yaml` → `caller_id.au_number` / `nz_number` | §15 item 3 answered |
| `allow_mobile_dialling: false` | `config/policy.yaml` → `dnc` | §15 item 4 answered |
| `require_verified_calendar: true` | `config/policy.yaml` → `holidays` | a human runs `npm run holidays:verify -- --sign-off all:2026 --by "<name>"` |

Each is a one-line change. None should be changed without the corresponding
answer.

## Known limitation, flagged not hidden

The official `data.gov.au` holiday dataset publishes **2021–2025 only**. 2026 and
2027 are derived by the rule engine, which the tests validate differentially
against all five published years across all eight states and territories. Eight
annually-proclaimed holidays have no published date yet and are reported as gaps
rather than treated as working days:

- NT show days (Alice Springs, Tennant Creek, Katherine, Darwin) — 2027
- Royal Queensland Show — 2027
- Victoria's Friday before the AFL Grand Final — 2026 and 2027
- WA King's Birthday — 2027

New Zealand publishes no machine-readable dataset at all, so its whole calendar is
derived from the Holidays Act 2003 and is unverified.

`npm run holidays:verify` lists everything outstanding.

---

## Next: Phase 2 — Blackboard and orchestrator

> *Accept: a task runs end to end with full trace, a deliberately malformed
> sub-agent output fails closed, and a budget breach escalates rather than
> continuing.*

Sketch, not a commitment — confirm with Vinay before building:

- Prisma schema for accounts, contacts, dossiers, calls, outcomes, playbooks,
  tasks, plus the four memories in brief §3.5.
- Prisma-backed implementations of the Phase 1 ports, replacing the in-memory ones
  in production wiring. The in-memory ones stay for tests.
- The agent contract type from brief §3.1 (`role`, `model`, `input`, `output`,
  `tools`, `budget`, `escalatesTo`) with Zod validation on both entry and exit, and
  fail-closed behaviour on the second validation failure.
- Campaign Director: scheduler tick, task graph, dispatch, budget accounting,
  escalation, and the one-line rationale per decision the brief requires.
- Tracing that the console's Agent Trace view can render in plain English later.
- Two stub agents to prove the loop end to end.

Phase 2 does not need any §15 answer to proceed. Budget ceilings (item 8) make the
budget enforcement more meaningful but sensible configurable defaults are fine.

---

## Open questions from brief §15, awaiting answers

Asked at the end of the Phase 1 session; none answered yet.

| # | Question | Gates |
|---|---|---|
| 1 | Agent name, voice, gender, accent (AU-neutral assumed) | Phase 4–5 |
| 2 | Hexaware brand/legal sign-off on an AI identifying itself for them | Phase 9 |
| 3 | Twilio numbers, and the callback number answerable for 30 days | Phase 5, and unblocks caller ID |
| 4 | DNCR washing arranged, or office direct dials only to start? | Phase 3 onward |
| 5 | First campaign ICP — which accounts, which titles, AU or NZ first | **Phase 3, blocking** |
| 6 | Which email address meeting requests go to; do `.ics` attachments survive his mail client | Phase 6 |
| 7 | Recording retention (currently 90 days) and whether recordings may leave Australia | Phase 5 |
| 8 | Budget ceilings — Apollo credits, voice minutes, LLM spend per month | Phase 3. Currently a $50/week default in the Campaign Director |

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
npm run tick                              # one Campaign Director tick, decisions printed
```
