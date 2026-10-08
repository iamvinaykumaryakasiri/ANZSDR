# Phase 7: Coach and Analyst

What was built, how to run it, the decisions the brief left open, and where it stops.
Read `CLAUDE.md` (section 11 in particular) first; this is the detail behind it.

```bash
npm run coach -- status                       # champions, the test under way, recent changes
npm run coach -- seed      [--apply]          # version 1 of every slot that can honestly have one
npm run coach -- propose   [--slot hook] [--proposals file.json] [--apply]
npm run coach -- evaluate  [--apply]          # the live test, and any promotion being watched
npm run coach -- promote   [--apply]          # carries out a promotion decision and no other
npm run coach -- rollback  --slot hook [--to 2] [--apply]
npm run coach -- history | diff <slot> <from> <to>
npm run analyst:digest [-- --day 2026-10-06] [--print] [--json]
npm run test:coverage:gate                    # gate.ts at 100% branch coverage, enforced
```

Every `coach` command reports and changes nothing unless `--apply` is given. `propose`
needs `ANTHROPIC_API_KEY`: the compliance review and the adversarial calls are model
work, and a gate that cannot reach them passes nothing. Everything else, and the whole
test suite, runs with no key and no network.

## The playbook (`src/playbook/`)

| | |
|---|---|
| `schema.ts` | The five slots and nothing else. Every shape is `.strict()`. |
| `template.ts` | Wording is literal text plus `{{firstName}} {{company}} {{hook}} {{claim:<id>}}`. A fact can enter only as a claim reference. |
| `store.ts` | Versioned rows in the existing `Playbook` table; history as playbook memory; assignment per call. |
| `gate.ts` | The promotion gate. Deterministic, not an agent, 100% branch tested. |
| `linter.ts`, `claim-check.ts`, `review.ts`, `simulation.ts` | The gate's stages. |
| `stats.ts`, `evidence.ts` | Fisher exact test and Newcombe interval; counting each arm from calls. |
| `failure-memory.ts`, `diff.ts`, `render.ts`, `baseline.ts`, `config.ts` | As named. |

### The immutable module is not representable

Section 11 says Coach may never touch the identity disclosure, the AI disclosure, the
recording announcement, termination on request, the banned-topic list or the
approved-claims boundary. Three things make that structural:

1. **No field exists for any of it.** A test walks every field name any slot's schema
   can hold and asserts none matches `COACH_MAY_NOT_EDIT` or the other immutable names.
2. **A variant carrying such a key is refused before the schema is consulted**, with the
   reason naming what was attempted (`"opening"`, `"aiDisclosure"` and so on, however
   spelled or nested). The list is built from `COACH_MAY_NOT_EDIT`, so adding a segment
   there extends it.
3. **The objection kinds that carry an obligation are not rewritable kinds:** being
   asked whether she is a person, where the number came from, a price, and a plain
   "not interested". There is nowhere to put a rebuttal to them.

A schema cannot read meaning, so free text such as "skip the disclosure" parses. That is
the linter's job (it rejects any mention of what Lexi is, the recording, stopping, or
leaving something out), then the reviewer's, then the simulation's, and the simulation
asserts the frozen opening is delivered in full and in order against `COACH_MAY_NOT_EDIT`.

### The gate

Preflight, stage by stage, stopping at the first failure so a model is never paid to
review what a pattern has already rejected:

`immutable-module` -> `schema` -> `linter` -> `claims` -> `compliance-review` -> `simulation`

The deterministic stages come before the model stages. That reorders the brief's
sequence (linter, review, claims, simulation); all four must pass either way.

- **Claims.** Every `{{claim:id}}` must exist, be approved, be approved for every market
  in play, and not be in a live conflict. Words Coach wrote itself may not assert a fact,
  name a client, or state a figure. Placeholders are resolved against the live index
  again at render time, so un-approving a claim silences every variant that used it.
- **Review.** A separate instance (the gate refuses a reviewer whose `instanceId` equals
  the proposer's). It sees the rendered wording and the section 7 to 9 rules, never
  Coach's rationale. An unparseable answer or a thrown error is a rejection.
- **Simulation.** Twelve scripted callers across six kinds (hostile, confused, rushed,
  gatekeeper, regulator, injection) through `assembleBriefing`, `runTurn`, `checkTurn`
  and `auditCall`: the real Caller and Guardian. The gate rejects a report that is
  missing any kind, so the set cannot be quietly trimmed.

Decision, once a challenger is live (`decideTest`):

| | |
|---|---|
| withdraw | A missing disclosure, at any sample size. Or, from 30 completed conversations per arm, a degraded guardrail or a significantly worse request rate. |
| promote | At least 30 completed conversations per arm; request-rate lift of at least 5 points; one-sided Fisher exact p <= 0.05; no degradation in completion, sentiment or defect rate; sentiment known for at least 80% of conversations. |
| retire | 150 completed conversations per arm and nothing shown; or the challenger is 56 days old and still short of the floor. |
| continue | Otherwise. |

A guardrail is breached if the challenger is worse by more than the tolerance, or worse
at all and a one-sided test says so at alpha 0.20. The lenient alpha is deliberate: the
test exists to catch harm early, not to prove safety. A newly promoted champion is
watched against the one it replaced for 30 completed conversations, and rolled back
automatically on regression (`monitorPromotions`).

`config/coach.yaml` can only raise the bar. `config.ts` refuses to load below the floors
(30 per arm, alpha <= 0.10, lift >= 2 points, the disclosure in the hard-fail list...).

### Decisions the brief left open (overrule freely)

- **"Minimum 30 completed conversations"** is read as 30 per arm. A completed
  conversation is one where a person answered, the call survived the 15-second opener
  and Lexi marked an outcome. Every rate is over answered calls past the opener, since
  the opener is frozen and identical in both arms.
- **Defect rate** counts `unsupported-claim`, `banned-topic`, `over-commitment` and
  `disclosure-missing`. Infrastructure noise, the prospect's injection attempts and tool
  slips are not the script's fault. A call whose defects column cannot be decoded is
  counted as defective, never as clean.
- **No `--force` on promotion.** A promotion the gate has not reached is what the gate
  exists to refuse.
- **One challenger in the whole playbook**, not one per slot.
- **A slot can start from nothing.** The value statement has no baseline (no claim is
  approved, so any sentence would be unsupported); its first challenger is compared with
  calls that had no value statement.
- **Focus** is chosen by the evidence (where people are lost, mapped to the slot that
  owns that part of the call), not by a model. It is a heuristic and says so in the
  reason it gives; `--slot` overrides it.

## Conventions shared with the console

The console backend (`src/stream/playbook.ts`) reads the `Playbook` table. This matches
it: a version is named `<slot> v<n>` and that string is what `Call.playbookVersion`
holds; evidence carries `outcome` (`promoted` / `rolled_back` / `rejected`),
`rolledBackAt`, `restoredAt`, and `requestRate` / `conversations` / `minConversations`
on a decided test. A retired former champion is marked `promoted` because the console's
enum has no "former champion", and that keeps it eligible to return to.

The full set of versions a call ran with is playbook memory keyed by call id
(`PlaybookStore.recordAssignment`), so what a call said is never reconstructed from a name.

## The Analyst (`src/agents/analyst/`)

Makes no model call. Every number is computed and every sentence assembled from the
numbers; the contract's `model` field says so. The digest has the console briefing's
shape (`headline` plus titled `sections`) so the 07:00 Sydney briefing can use it as it
is, and goes to Vinay only through `deliverDigest`, which wraps the mailer in
`operatorOnly` itself. Mail is an `.eml` in `data/outbox`, like the Concierge's.

`metrics.ts` exports the pure functions the console backend can call, with documented
types: `buildFunnel` (seven-day baseline), `buildHangupCurve`, `sectionHangups`
(seconds-to-hangup by script section: reached, ended here, hazard), `rankObjections`,
`objectionStats`, `gatekeeperByAccount`, `wrongNumberRate`, `variantPerformance` (by
market, industry, seniority), `todayNumbers`, `costPerMeeting`, `summariseDefects`,
and the kill-switch inputs below. The funnel, curve and objection types are
structurally the console contract's views, pinned by a test. **`src/stream/facts.ts`
already implements the same funnel and curve with the same definitions;** the two should
converge on one implementation, which is the lead's call.

### The audit and the opening, in the numbers

Guardian's post-call audit flags the frozen opening's mandated lines (who Lexi works
for, the generic reason for the call, the recording line) as unsupported claims,
because none is in `approved-claims.json`. That is known and `audit.ts` is left as it is.
So the audit's raw count rises on every call whatever Lexi says. The digest shows the
count as the audit reports it and the count with the opening's own lines taken out, every
day, with the reason written into the section. Telling them apart is a text match of the
quoted line against the lines the opening is required to contain.

### For `src/ops` and the kill switch

`loadSafetySignals(db, now, openingTexts)` returns a `SafetySignals` (the type
`evaluateAutoTrip` takes) plus `defectRate` and `claimDefectsRaw`. Its
`claimDefectsToday` is the **net** figure. The raw one would reach the default threshold
of five after two calls, tripping the kill switch on nothing. If `openingTexts` is not
supplied the two are equal. `blackboardReachable` is false when the read fails.

## Gaps

- **Nothing calls `PlaybookStore.assign` / `recordAssignment` yet.** That is the voice
  layer's seam: at call start, `assign(callId, await store.snapshot(), share)`, run with
  `store.resolve(...)`, then `recordAssignment`. Until it does, no call carries an
  assignment and no test can collect evidence.
- **`renderBriefing` does not render `BriefingPack.playbook`.** `composeSystemPrompt`
  (in `render.ts`) appends the wording; the endpoint should build its prompt with it.
- **Coach is not registered with the Director.** `coachWeeklyKind` is ready; registering
  it and scheduling it weekly is a line in `src/orchestrator`.
- **No real model turn has run.** The proposer, the reviewer and the simulation's
  Claude adapters are untested against the API. `claude-opus-5` for Coach and the reviewer
  is configured in `coach.yaml`; the per-token price used to meter Coach's budget is a
  deliberately generous placeholder.
- **Section timings are not recorded yet** (`Call.sectionMarks` is empty until the voice
  layer writes it), so the hang-up-by-section figures and Coach's slot choice fall back to
  "start with the hook".
- **Scribe does not keep the objection kind Lexi filed**, so objections are classified
  from the words by the same keyword rules the console uses.
- **The digest is not scheduled**, and is written to the outbox rather than sent.
