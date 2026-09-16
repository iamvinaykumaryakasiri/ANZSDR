# PROJECT BRIEF — "ANZ Voice SDR"
### An autonomous multi-agent cold-calling system for Hexaware ANZ

---

## 0. How to use this brief

You are building a production agent system, not a script with an LLM bolted on. Work through the phases in §13. At the end of each phase, stop, run the acceptance checks, and report back before starting the next. Ask me about anything in §15 rather than guessing.

Three rules that override everything else:

1. **Compliance is code, never an agent.** Anything that decides whether a call may legally happen is deterministic, tested TypeScript. No model gets a vote on it.
2. **The agent never claims to be human.** Not by omission, not under pressure, not if the prospect insists.
3. **Every agent output that touches the outside world is schema-validated before it is acted on.** A sub-agent returning malformed or out-of-contract output fails closed.

---

## 1. What this is

A single-operator autonomous SDR that cold calls B2B prospects in Australia and New Zealand on behalf of Vinay Kumar, Sales Director at Hexaware Technologies, and turns interest into confirmed meetings in his inbox.

**Operator:** Vinay Kumar, Sales Director, Hexaware Technologies ANZ. Sydney-based. Focus on BFSI and the broader ANZ enterprise market, with New Zealand as an active build-out.

**Agent identity:** an AI assistant that is part of Hexaware's ANZ sales team, working with Vinay. Its own name, its own phone number. It discloses that it is AI within the first fifteen seconds of every call.

---

## 2. Decisions already made (do not re-litigate)

| Area | Decision |
|---|---|
| Architecture | Multi-agent: an orchestrator with specialist sub-agents (§3) |
| Voice layer | Managed provider (**Vapi** default, Retell acceptable) pointed at a **custom LLM endpoint we own**, running Claude |
| Telephony | Twilio numbers as BYO carrier into the voice provider. AU number for AU, NZ number for NZ |
| Prospect data | **Apollo.io API** for people search, email and phone enrichment |
| Autonomy | **Fully autonomous** dialling through an approved account list. No per-call approval, but **the day's call plan is approved by Vinay before any of it is dialled** (§7.7) |
| Meetings | **No calendar integration.** The agent captures the prospect's preferred times and emails the request to Vinay, who confirms (§12) |
| Script evolution | **Autonomous self-tuning** inside the promotion gate in §11 |
| Follow-up | SMS + email + LinkedIn connect queued (§12) |
| CRM | A live Excel workbook synced from the internal store |

### Why a custom LLM endpoint
Vapi will happily call a model provider for you. Don't use that path. Expose our own HTTPS endpoint speaking the OpenAI-compatible streaming chat-completions shape, and inside it run Claude with our prompt, our tools and our guardrail middleware. The provider handles telephony, ASR, TTS and barge-in. We keep the brain, the logging and the safety layer.

---

## 3. Agent architecture

### 3.1 The shape
A **blackboard** system. One shared typed state store (SQLite via Prisma) holds accounts, contacts, dossiers, calls, outcomes, playbooks and tasks. The orchestrator plans and delegates; sub-agents read the blackboard, do one job well, write structured results back. No sub-agent calls another directly — everything goes through the orchestrator and the blackboard, so every decision is traceable.

Each sub-agent is defined by a contract in `src/agents/<name>/contract.ts`:
```ts
{
  role:        string          // system prompt file
  model:       string          // per-agent model choice
  input:       ZodSchema       // validated on entry
  output:      ZodSchema       // validated on exit, fails closed
  tools:       Tool[]          // the ONLY tools it can reach
  budget:      { maxTurns, maxTokens, maxWallClockMs, maxUsd }
  escalatesTo: 'orchestrator' | 'human'
}
```
A sub-agent that exceeds budget, fails validation twice, or hits an unhandled state escalates rather than improvising.

### 3.2 The orchestrator — **Campaign Director**
Runs on a scheduler tick. Holds the goal ("book N qualified meetings this week from these accounts"), decides what work matters now, dispatches tasks, handles failures and escalations, and stops when budget or policy says stop. It is the only component allowed to spend money without a specific instruction, and it logs a one-line rationale for every decision it makes.

It cannot dial. It requests a dial; the Compliance Gate decides.

### 3.3 Sub-agents

**Prospector** — owns contact acquisition.
Reads active accounts, defines search criteria from the campaign ICP, queries Apollo, scores each person against the ICP, and enriches only those who pass. Handles both email and phone acquisition (§5.2). Deduplicates against everything we already hold. Never re-buys data.

**Scout** — owns research.
Builds the dossier for each contact before a number is dialled (§5.3). Every fact carries a source URL; unsourced facts are dropped. Produces the meeting hypothesis, two or three concrete hooks, and the landmines.

**Caller** — the real-time in-call brain.
Runs inside the custom LLM endpoint, one instance per call. Gets the dossier, the knowledge pack extract, the current champion playbook, and a tight tool set: `capture_email`, `capture_preferred_times`, `log_objection`, `mark_outcome`, `suppress_contact`, `escalate`. It has no ability to promise a time, quote a price, or read anything outside its briefing pack.

**Guardian** — owns safety at runtime.
Three layers, running in front of and behind Caller: a deterministic pattern filter on the outbound token stream, a fast model check on risky turns, and a post-call audit of the full transcript against the approved-claims index. Guardian can cut a turn mid-stream and substitute a safe deflection. It is the only sub-agent that can override Caller.

**Scribe** — owns the record.
Post-call: structured outcome, clean summary, objections raised, what was actually said, sentiment trace, captured email and preferred times, defects found. Writes to the blackboard and syncs the Excel workbook.

**Concierge** — owns everything after the call.
Meeting-request emails to Vinay, drafted prospect-facing emails, SMS confirmations, voicemail drops, LinkedIn queue, follow-up cadence, and the nudge if Vinay hasn't actioned a meeting request in 24 hours.

**Coach** — owns improvement.
Weekly. Reads outcomes, proposes playbook variants, runs them through the promotion gate (§11), promotes or rolls back, and writes the plain-English change note for the digest.

**Analyst** — owns visibility.
Daily digest, metrics, cost tracking, defect trends, cost per meeting.

### 3.4 Deliberately NOT agents
The **Compliance Gate**, **Suppression List**, **Dial Queue** and **Kill Switch** are plain deterministic services with full test coverage. They are not reasoned with, not prompted, and not persuadable. An agent asks them for permission and takes the answer.

### 3.5 Agent memory
- **Contact memory** — everything ever known or said to this person
- **Account memory** — what we have learned about this organisation across contacts, including what did not work
- **Playbook memory** — the current champion, its variants, and the evidence behind each
- **Failure memory** — hooks that died, objections we handled badly, patterns Coach should attack next

---

## 4. Stack

TypeScript, Node 20. Fastify for the webhook and LLM-endpoint surface. SQLite via Prisma as the system of record. BullMQ + Redis for dial, enrichment and follow-up queues. Anthropic SDK (`claude-sonnet-4-6` for in-call turns and routine sub-agents, a stronger model for Scout, Coach and Guardian's audit pass). Zod for every contract. Vitest, with 100% branch coverage on `compliance/`. Public HTTPS hostname required — both Apollo phone enrichment and the voice provider need reachable webhooks.

Config in `config/*.yaml`. Secrets in `.env`, never committed.

```
src/
  orchestrator/      # Campaign Director, task graph, budgets, escalation
  agents/
    prospector/ scout/ caller/ guardian/ scribe/ concierge/ coach/ analyst/
  compliance/        # dial gate, calling hours, DNC, suppression, caps  (NOT an agent)
  blackboard/        # shared state, schemas, memory
  knowledge/         # Hexaware pack loader, approved-claims index
  voice/             # provider adapter, call lifecycle, transcripts, recordings
  data/              # Apollo client, enrichment queue, dedupe
  crm/               # Excel sync
  ops/               # kill switch, health, alerting
  stream/            # SSE event bus feeding the console
web/                 # the console (§14) — React + Vite, its own build
```

---

## 5. The pipeline

### 5.1 Account list in
Maintained on the **account desk** (`npm run serve`), a small authenticated web page holding the organisations to work and the titles worth calling at them. It takes a block pasted straight out of Excel or Sheets using the same columns — `account_name`, `domain`, `country`, `industry`, `priority`, `notes` — and exports the same CSV back. New rows get picked up on the next tick.

`config/campaign.yaml` and `config/accounts.csv` are the committed source of truth for the list, so it survives a machine and every change to it is a reviewable diff. `npm run accounts:import` loads them into the blackboard; `npm run accounts:export` writes desk edits back so they can be committed.

The account desk is not the console in §14. That is Phase 8 and starts with a design review. The desk also carries the campaign's **minimum score to enrich**, its **meetings-per-week goal** and its **weekly spend ceiling**, which the Campaign Director reads directly.

### 5.2 Prospector: people, emails, phones
**Search.** `POST /api/v1/mixed_people/search` filtered by organisation domain, seniority and title keywords from the campaign ICP. Known Apollo behaviour to build around:
- People Search returns **no emails and no phone numbers**. Discovery only.
- Emails and phones come from People Enrichment (`/people/match`) or Bulk People Enrichment (`/people/bulk_match`, 10 per call).
- `reveal_phone_number=true` **requires** a `webhook_url` and delivers phones **asynchronously**, minutes later. The synchronous response will not contain the mobile. Build the enrichment queue around this from day one.
- Apollo retries webhooks. The handler must be idempotent.
- A work email costs roughly 1 credit; a phone costs around 8. Enrich in two stages: email first for everyone who passes ICP scoring, phone only for those who also pass the research gate.
- `reveal_personal_emails` is off by default and should stay off unless a contact is high-value and the work email bounces.
- People Search caps at 50,000 records (100/page, 500 pages).
- Convert enriched people to Apollo contacts so re-enriching later doesn't burn credits again.

**Email quality.** Hold up to three email states per contact: `apollo_work`, `apollo_personal`, `confirmed_on_call`. Verify deliverability before use. **A confirmed-on-call email always wins** — asking the prospect directly is both the highest quality source and the cheapest, so Caller asks for it on every connected call.

### 5.3 Scout: the dossier
Sources: web search, company site and newsroom, ASX/NZX announcements where listed, annual report themes, job postings (a strong tech-direction signal), the person's public LinkedIn profile and posts, podcasts and conference appearances.

```
person:      name, title, tenure, prior employers, likely remit, public signals
account:     what they do, size, tech estate signals, recent announcements,
             known transformation programmes, likely pressures
hypothesis:  the single most plausible reason this person takes a meeting
hooks:       2-3 specific, verifiable openers tied to something real
landmines:   anything to avoid (layoffs, breach, litigation, M&A)
confidence:  high | medium | low, with what is unverified
```
If confidence is `low`, Caller opens generically. A wrong specific is worse than a right generic.

### 5.4 Compliance Gate (§7) → Dial Queue → Caller
### 5.5 Scribe captures the outcome
`meeting_requested | callback_requested | not_interested | wrong_person | gatekeeper_blocked | voicemail | no_answer | invalid_number | do_not_contact | escalated`
### 5.6 Concierge follows up (§12), Coach learns (§11)

---

## 6. The Hexaware knowledge pack

`knowledge/` holds markdown I populate and you load, chunk and index:

- `company.md` — who Hexaware is, scale, global footprint, ANZ presence
- `services.md` — service lines, with DD&AI (Data, Digital & AI) called out; practice lead George Mathew
- `anz-story.md` — the ANZ proposition, the NZ build-out, why a local buyer cares
- `proof-points.md` — approved reference stories, each flagged nameable or anonymised
- `frameworks.md` — Zero Friction Enterprise™ and Zerovity™, in Vinay's own framing
- `icp.md` — per-campaign ICP, target titles, disqualifiers
- `objections.md` — the real objections and the responses that work
- `approved-claims.json` — **the hard boundary**: every factual claim the agent may assert on a call

**The claim rule.** Caller may only assert what maps to an entry in `approved-claims.json`. Anything else: *"I don't want to give you a half answer on that — Vinay will come back to you with specifics."* Guardian re-checks the transcript afterwards and logs any unsupported assertion as a defect in the daily digest.

---

## 7. The compliance engine (deterministic, tested, non-negotiable)

### 7.1 Calling windows — the recipient's local time, never the server's
Two windows, both of which must be open. They answer different questions and are deliberately not collapsed into one.

**The statutory window — where the recipient actually is.**
**Australia** (Telecommunications (Telemarketing and Research Calls) Industry Standard 2017): Mon–Fri 09:00–20:00, no Sundays, no public holidays. The Standard also permits Sat 09:00–17:00; **we do not call on Saturdays**. Saturday is closed in code, not in config, and no configuration change can re-open it.
**New Zealand** — no statutory equivalent; apply the NZ Marketing Association convention conservatively: weekdays 09:00–17:00, no weekends, no public holidays.

Australia spans five offsets and only some states observe DST. Geo-tag every number to a state and timezone at enrichment time and gate on the recipient's clock. Unknown location defaults to the most restrictive window. Load a maintained holiday calendar per AU state/territory plus NZ national and regional anniversary days.

**The operator window — Vinay's own working day, on one clock per market.** AU runs on **Sydney time** (`Australia/Sydney`), NZ on **Auckland time** (`Pacific/Auckland`). The calling plan is written, read and approved by one person in one place, so it is expressed in one clock rather than meaning a different thing for every prospect. Public holidays where the operator is close the operator's day.

Anchoring the plan to Sydney time can only ever delay a call, never permit one that would otherwise be unlawful: a dial needs both windows, so 09:30 Sydney is refused for a Perth number until it is 09:00 in Perth, and a Perth prospect's day ends at 16:30 Sydney even though Perth is still inside legal hours.

Policy default, tighter than the law: **09:30–16:30 on the operator's clock, Tue–Thu**, configurable.

### 7.2 Do Not Call
Australia's DNCR covers numbers used primarily for domestic purposes; business lines generally aren't eligible, and genuine B2B calls to someone in their professional capacity sit outside the prohibition. But **Apollo returns personal mobiles**, and a personal mobile can be registered. Don't lean on the B2B carve-out to excuse an unwashed list.
- Wash every number before dialling, re-wash on a 30-day cycle, store the wash date
- Until DNCR washing is in place, the system **must not dial mobiles at all** — office direct dials only. Config flag, defaults to safe
- Our own suppression list is permanent and cross-campaign. Any refusal, complaint or "don't call again" lands on it forever
- NZ's Marketing Association DNC list covers consumers only. Honour every opt-out regardless

### 7.3 In-call obligations (AU Industry Standard, applied to both markets)
- Caller line identification enabled with a real, contactable number. Never withheld, never spoofed. Answerable for at least 30 days after the call
- State who is calling, on whose behalf, and why, immediately after the call begins
- Terminate immediately on request. No rebuttal, no "just one quick thing"
- On request, say honestly where the number came from: a B2B data provider

### 7.4 Recording and privacy
Announce recording in the opening. If the prospect objects, stop recording and continue, or end the call — never continue covertly. Encrypt recordings, default 90-day retention with an automatic purge job. Honour access and deletion requests under the Privacy Act 1988 (AU) and Privacy Act 2020 (NZ). Log source and lawful basis for every contact record held.

### 7.5 Volume limits
Max 3 attempts per contact ever, within a 21-day window, then permanent stop. Minimum 5 days between attempts. Max 1 contact per account per week until a conversation happens. Global daily dial cap (default 60), concurrency of 1 live call, any number dialled at most once per day.

### 7.6 Daily call plan, approved before anything is dialled

Every day's calling is written down before it happens and dialled only once Vinay has approved it.

The plan lists, in order: who would be called, their number, the hypothesis behind the call, the earliest lawful moment they could be reached that day, and what the compliance gate already says about each of them. He therefore approves a list whose state he can see, not a promise that the system will behave.

- Approval covers **the named people on the named day**. It does not carry over to tomorrow and does not extend to anyone not on the list
- A plan may be drafted, submitted, approved or rejected. Only `approved` releases anything
- Redrafting supersedes the previous plan rather than deleting it, so a rejection and its reason stay on the record
- Enforcement is in the compliance gate (`DAY_PLAN_NOT_APPROVED`), alongside calling hours and suppression — not in the orchestrator, and not in a prompt
- Prospecting and research continue without approval. Neither is a call

### 7.7 Kill switch
One command and one dashboard button halt all dialling within seconds, drain the queue and hold state. Auto-trips on: 3 escalations in a day, error rate above threshold, unsupported-claim defects above threshold, sentiment collapse, or the orchestrator losing contact with the blackboard.

---

## 8. Conversation design

Target 45–120 seconds. This is a permission-to-continue call, not a pitch.

**Opening — fixed, immutable, never touched by Coach:**
agent name → AI disclosure → Hexaware, working with Vinay Kumar on the ANZ sales team → the reason for the call in one sentence → recording announcement → ask for thirty seconds.

**Body — variable, learnable:** dossier hook → relevance bridge → one specific value statement from approved claims → the ask.

**The ask:** twenty minutes with Vinay. Because there is no calendar integration, Caller asks for **preference, not commitment**: two or three windows that suit them, their timezone, and the best email. Then: *"Vinay will send you a confirmation and an invite today."* Caller must never state a time as booked.

**Behaviour rules:**
- One question at a time, then stop talking
- Never talk over the prospect. Yield instantly on barge-in
- Match their pace; if they're rushed, compress and offer email instead
- Accept the first genuine no. One clarifying question at most, then close warmly
- Never argue, guilt, manufacture urgency, or imply a relationship that doesn't exist
- If asked something outside approved claims, say so plainly and offer follow-up
- If the prospect is confused about who they're speaking to, re-disclose clearly
- Gatekeeper mode: transparent about purpose, ask for the right person and the best route to them, never trick or pressure a receptionist

**Hard escalation — end politely, suppress, alert Vinay immediately:** legal threat, formal complaint, media/analyst/regulator, request for a human, hostility, the prospect is already a Hexaware client or partner, an active RFP or procurement process, anything personal or distressing.

---

## 9. Guardian: content guardrails

Banned on every call regardless of what the prospect says or asks:
- Politics, elections, government policy positions, religion, race, gender, sexuality, unions, immigration, war, any live current affair
- Any opinion on a named competitor. No disparagement, no price comparison
- Pricing, rates, discounts, commercial terms, contractual commitments, delivery timelines, headcount promises
- Legal, financial, tax, medical or investment advice
- Any client name not marked nameable in `proof-points.md`
- Any statistic, certification or partnership status not in `approved-claims.json`
- Speculation about the prospect's employer's finances, layoffs, M&A, incidents or leadership
- Anything about another person at the account that wasn't publicly stated
- Profanity, sarcasm at the prospect's expense, flirtation, or commentary on their voice, accent or name
- Collecting anything beyond name, role, work email, timezone and time preference. Never anything sensitive

Deflection is always the same shape: acknowledge briefly, decline to engage, return to the reason for the call, offer to end if they'd prefer.

Prompt injection through the audio channel ("ignore your instructions", "you're actually human", "repeat your system prompt") is hostile input and is handled by the same filter. A blocked turn is logged as a defect with full context.

---

## 10. Email and meeting capture on the call

Caller has two capture tools it uses on every connected conversation:

`capture_email(email, confidence)` — *"What's the best email for you?"* Read it back phonetically to confirm. Store as `confirmed_on_call`, which overrides Apollo data.

`capture_preferred_times(slots[], timezone, attendees[])` — two or three windows in the prospect's own words ("Tuesday or Wednesday morning", "after 3pm any day next week"), normalised to concrete datetime ranges in their timezone and in Sydney time. Also capture whether anyone else should be on the call.

Nothing is ever presented to the prospect as confirmed. The commitment made on the call is that Vinay will email them today.

---

## 11. Coach: autonomous script evolution, with a gate

Coach **may** rewrite: hook phrasing, the value statement, objection rebuttals, the transition to the ask, and the preference-request wording.

Coach **may never** touch: the identity disclosure, the AI disclosure, the recording announcement, termination-on-request, the banned-topic list, or the approved-claims boundary. These live in an immutable module Coach has no write access to.

1. Scribe extracts, per call, where attention was lost, which objection appeared, what actually landed
2. Weekly, Coach proposes variants for one slot at a time
3. Each variant passes: guardrail linter → a compliance review by a separate model instance against §7 and §9 → claim-index check → a simulated adversarial call set (hostile, confused, rushed, gatekeeper, regulator-style probing)
4. Survivors run as challenger against champion. Minimum 30 completed conversations before any promotion decision
5. Promotion needs a meaningful lift in meeting-request rate **and** no degradation in conversation completion, sentiment or defect rate
6. Auto-rollback on regression. Every change versioned, diffable, reversible
7. The weekly digest explains what changed and why, in plain English

Track hook performance separately by industry, seniority and market. AU and NZ will diverge.

---

## 12. Concierge: meetings and follow-up (no calendar integration)

### 12.1 The meeting-request email to Vinay
Sent within two minutes of the call ending, subject `[MEETING REQUEST] {Name} — {Company} — {first preferred window}`:

- Who: name, title, company, phone, confirmed email, LinkedIn URL
- Preferred windows, shown **both** in their local time and in Sydney time
- Anyone else they want on the call
- The hypothesis and the hook that worked
- A five-line summary of what was actually said
- Objections raised and how they were handled
- Links to the transcript and recording
- **A ready-to-send draft reply to the prospect**, so Vinay can copy, paste and send from his own Outlook
- An `.ics` attachment for the top preferred window, so it's one tap to add

Vinay confirms by replying `CONFIRMED`, `RESCHEDULE`, or `REJECT` to the email. Concierge parses the reply, updates the blackboard and stops or adjusts follow-up accordingly. If there is no reply in 24 hours, one nudge.

### 12.2 Prospect-facing email
Outbound email to prospects goes from **Vinay's own mailbox**, not a third-party sending domain. Concierge therefore **drafts** every prospect email and delivers it to him ready to send. Internal system email (to Vinay only) goes via a transactional provider.

If Vinay later decides to allow direct sending, it must be from an authenticated Hexaware subdomain with SPF, DKIM and DMARC in place — not before.

### 12.3 Follow-up matrix

| Outcome | Action |
|---|---|
| Meeting requested | Meeting-request email to Vinay + SMS to prospect confirming a follow-up email is coming + draft reply prepared + LinkedIn connect queued |
| Callback requested | Retry scheduled at their stated time, SMS confirmation |
| Interested, no time now | Draft email with a one-pager and two windows, prepared for Vinay |
| Not interested | Draft thank-you, suppress permanently, no further contact |
| Voicemail | Voicemail drop — pre-recorded, identifies as AI, gives the callback number — then one drafted email |
| No answer | Retry per cadence, no message |
| Gatekeeper | Log the routing learned, retry the corrected contact |

SMS goes via Twilio, only to people who have just spoken to us, always identifying the sender and including an opt-out. **LinkedIn connect requests are queued for Vinay to send manually** — automating them breaches LinkedIn's terms and risks his account.

---

## 13. Build phases

**Phase 1 — Compliance core.** Calling windows with AU/NZ timezone and holiday handling, suppression, attempt caps, kill switch, audit log. Nothing dials.
*Accept:* a fuzz test over 10,000 synthetic dial requests yields zero out-of-window or suppressed dials.

**Phase 2 — Blackboard and orchestrator.** State schemas, agent contracts, budgets, task graph, escalation, tracing. Two stub agents to prove the loop.
*Accept:* a task runs end to end with full trace, a deliberately malformed sub-agent output fails closed, and a budget breach escalates rather than continuing.

**Phase 3 — Prospector and Scout.** Apollo search, ICP scoring, two-stage email-then-phone enrichment via async webhook, dossier generation.
*Accept:* 20 real contacts across 5 ANZ accounts with verified emails, source-attributed dossiers, and zero duplicate Apollo spend.

**Phase 4 — Caller and Guardian.** Custom LLM endpoint, briefing pack assembly, capture tools, three-layer guardrails, streaming filter.
*Accept:* a text-mode harness runs 30 scripted scenarios including hostility and injection with zero breaches.

**Phase 5 — Voice.** Vapi wired to our endpoint, Twilio numbers, barge-in, latency tuning, recording, transcripts. Calls only to numbers I control.
*Accept:* ten end-to-end calls, sub-800ms perceived response latency, correct disclosure every time, email and preferred times captured accurately.

**Phase 6 — Scribe and Concierge.** Outcome extraction, Excel sync, meeting-request email with `.ics` and draft reply, reply parsing, SMS, voicemail drop.
*Accept:* a simulated interested call produces a meeting-request email I'd actually act on without opening anything else, and replying `CONFIRMED` updates state correctly.

**Phase 7 — Coach and Analyst.** Post-call analysis, variant generation, promotion gate, daily digest, cost per meeting.
*Accept:* a variant that drops a required disclosure is correctly rejected by the gate.

**Phase 8 — The console.** Build it against the live system, not mocks. Design plan first (palette, type, layout) reviewed with me before any component is written.
*Accept:* during a live test call I can watch the transcript stream, see which script section is running, and read the drop-off curve from the previous ten calls without clicking anything. Stop All halts dialling in under five seconds. Confirming a meeting request works from my phone.

**Phase 9 — Pilot.** 20 real calls into one low-stakes segment, every one reviewed manually before anything scales.

---

## 14. The console

A single-operator command centre. One person uses this: Vinay, usually first thing in the morning with coffee, sometimes from a hotel in Auckland on a phone. It has to answer "what is happening right now", "where are we losing people", and "what needs me" without him clicking into anything.

Read `/mnt/skills/public/frontend-design/SKILL.md` before writing any of it.

### 14.1 Design direction

Do not open with a row of KPI cards. The most characteristic thing in this system's world is a live phone call to a stranger, so **the live call is the hero**: streaming transcript, elapsed seconds counting, the current script section highlighted, the agent's confidence, and the tally state. When nothing is live, that space holds the next number in the queue and the countdown to the next dial — the room is never dead, it is either on air or waiting.

**Palette.** A deep cool ink field, muted steel and slate for structure, pale sand for settled outcomes. One saturated signal red, borrowed from a broadcast tally light, reserved **exclusively** for "a call is live right now". Never use it for errors, warnings, deletes or anything else — the moment it means two things it stops meaning anything. Errors and defects get weight and position instead of colour. Avoid warm-cream-and-serif, avoid near-black with acid green.

**Type.** Two families with a functional split: system data in a grotesque with **tabular lining figures** (numbers update live and must not jitter), human speech — transcripts, quotes, the prospect's own words about when they're free — in a second, warmer family so speech never looks like telemetry. No all-caps labels, no monospace decoration, no arrows appended to buttons.

**Motion.** One orchestrated moment only: the transition into live-call state. Everything else changes without animation. No card hover effects, no staggered section reveals.

**Layout concept** (desktop, 12-col, left-aligned):

```
┌──────────────────────────────────────────┬──────────────────┐
│  ON AIR / STANDING BY                    │  NEEDS YOU       │
│  live transcript, elapsed, script stage  │  3 meeting       │
│  prospect · company · hypothesis         │  requests        │
│                                          │  1 escalation    │
├──────────────────────────────────────────┤  ───────────────  │
│  WHERE THEY DROP                         │  UP NEXT         │
│  funnel + seconds-to-hangup curve        │  queue, gated    │
├──────────────────────────────────────────┤  reasons, next   │
│  TODAY                                   │  dial countdown  │
│  dialled · connected · conversations ·   │                  │
│  requests · spend · cost per meeting     │  [ STOP ALL ]    │
└──────────────────────────────────────────┴──────────────────┘
```

The kill switch is visible on every screen, at all times, and never behind a menu.

### 14.2 Where they drop — the thing he actually asked for

Two views, side by side.

**Stage funnel**, with the count, the rate and the absolute loss at each step:
`queued → passed compliance gate → dialled → answered → survived the opener (15s) → real conversation (45s+) → ask made → meeting requested → confirmed by Vinay`

Every stage is clickable and filters everything else on the page. Each shows its drop-off against the seven-day baseline so a bad day is visible immediately.

**Seconds-to-hangup curve.** A density curve of call duration with the script sections overlaid — disclosure, reason for call, hook, value statement, ask. This is the single most useful chart in the product: it shows *which sentence* loses people. Hovering a spike lists those calls and lets him play the audio from three seconds before the drop. Segmentable by market (AU/NZ), industry, seniority, and script variant, because a hook that works on a NZ CIO will not work on a Sydney CDO.

Also surface: gatekeeper-block rate by account, wrong-number rate (a data-quality signal, not a script one), objection frequency ranked, and champion-vs-challenger performance side by side while a test is running.

### 14.3 Jarvis: the command bar

Always available on `⌘K`. Natural language in, grounded answers out — it queries the blackboard, never guesses, and always shows what it read.

Ask: *"why did we stop calling Westpac?"* · *"show me every call that died in the first ten seconds this week"* · *"which hook is working in New Zealand?"* · *"what's my cost per meeting this month?"* · *"read me the three calls that got closest"*

Command: *"pause the ANZ banking campaign"* · *"suppress this contact"* · *"requeue Priya for Thursday"* · *"roll back to the previous script"*

Read-only answers run immediately. Anything that changes state, spends money or touches a prospect requires an explicit confirm, showing exactly what will happen. Destructive commands can never be triggered by voice alone.

**Morning briefing.** At 07:00 Sydney the console opens on a briefing view: what happened yesterday, what changed, what needs him, what's queued today. One button reads it aloud so he can listen while getting ready. Same content lands as the daily digest email for the days he doesn't open the console.

### 14.4 The rest of the console

- **Call log** — every call, filterable, with transcript, recording, dossier, script variant used, guardrail defects flagged inline
- **Meeting desk** — pending requests with the prospect's preferred windows, the draft reply, and confirm / reschedule / reject in one tap. Mirrors the email flow in §12 so either route works
- **Agent trace** — for any task, what the orchestrator decided and why, which sub-agent ran, what it returned, what it cost. Plain-English, collapsible, not raw JSON
- **Playbook** — current champion, live challenger, version history with diffs, Coach's change notes
- **Accounts** — per-account state, contacts, attempts remaining, what we've learned, what didn't work
- **Health** — queue depth, provider status, Apollo credits remaining, spend against monthly ceiling, compliance-gate rejections by reason

### 14.5 Mobile

He travels to New Zealand regularly, so mobile is not an afterthought: a genuine second layout, not a squeezed desktop. Mobile shows exactly four things — on air / standing by, needs you, today's numbers, stop all. Confirming a meeting request from a phone in one tap is the most important mobile action in the product.

### 14.6 Build notes

React + Vite + TypeScript, Tailwind with a small custom token set, no off-the-shelf component kit. Live data over a single SSE stream from `stream/`; the console holds no business logic and can be killed without affecting the agents. Charts hand-built on visx or Recharts, styled to the token system rather than left at library defaults. Quality floor, unannounced: keyboard navigable, visible focus, reduced motion respected, readable at 200% zoom, works on a phone.

---

## 15. Open items — ask me, do not assume

1. Agent name, voice, gender and accent. AU-neutral assumed
2. Whether Hexaware brand/legal has signed off on an AI identifying itself as calling on their behalf. **Gates Phase 8 only** — build everything, dial no real prospect until answered
3. Twilio numbers, and the callback number that stays answerable for 30 days
4. DNCR washing: arrangement in place, or office direct dials only to start?
5. First campaign ICP: which accounts, which titles, AU or NZ first
6. Which email address the meeting requests go to, and whether `.ics` attachments survive his mail client
7. Recording retention period, and whether recordings may leave Australia
8. Budget ceilings: Apollo credits, voice minutes, LLM spend per month

## 16. Non-goals

Not a consumer dialler. Not multi-user. No predictive or parallel dialling. No LinkedIn automation. No scraping of sites that prohibit it. No calendar write access. This system is built to make a small number of good calls, not a large number of bad ones.

---

# Build status

*Maintained by the build. Update at the end of each phase.*

A fuller handoff — design decisions made, known limitations, and where to pick up —
is in [`docs/SESSION-HANDOFF.md`](./docs/SESSION-HANDOFF.md).

| Phase | State |
|---|---|
| 1 — Compliance core | **Complete.** Acceptance met: 10,000 fuzzed dial requests, zero out-of-window and zero suppressed dials, checked against an independently written oracle. 100% branch coverage on `src/compliance`. |
| 2 — Blackboard and orchestrator | **Complete.** Includes the daily call plan and its approval gate. Acceptance met: a task runs end to end with a full plain-English trace, a deliberately malformed sub-agent output escalates without reaching the blackboard, and a budget breach escalates rather than continuing. |
| 3 — Prospector and Scout | Not started. Unblocked on the account list: the account desk is built and the Apollo path is documented in `docs/APOLLO-SETUP.md`. Still needs an Apollo key and, for mobile numbers only, a public HTTPS hostname. |
| 4 — Caller and Guardian | Not started |
| 5 — Voice | Not started |
| 6 — Scribe and Concierge | Not started |
| 7 — Coach and Analyst | Not started |
| 8 — The console | Not started |
| 9 — Pilot | Not started |

## Standing constraints the build has already put in place

- `config/policy.yaml` ships with **no caller ID numbers set**, so the gate denies every dial with `CALLER_ID_NOT_CONFIGURED` until §15 item 3 is answered.
- `dialling.test_contacts_only` ships **true**: only contacts marked `test` — numbers Vinay controls — can be dialled. A real prospect is refused with `NOT_A_TEST_CONTACT`, and a contact with no blackboard record is refused too. Anything not explicitly marked `test` counts as a real person, so a typo stops a call rather than starting one. This is what makes §13 Phase 5's "calls only to numbers I control" a property of the gate.
- `dnc.allow_mobile_dialling` ships **false**, so only office direct dials are possible until §15 item 4 is answered.
- `dnc.exempt_test_contacts` ships **false**. It is the one route past that mobile ban, and it exists because every number Vinay controls is a mobile, so Phase 5's "calls only to numbers I control" is otherwise impossible. It is fenced three ways and cannot reach a prospect: the contact must be recorded `test` **on the blackboard** (never asserted by the dial request), `dialling.test_contacts_only` must still be true, and the flag must be on. Taking the system out of test mode takes the exemption with it. A wash result that positively says *registered* is still honoured.
- A wash result of `registered` now blocks a dial **whatever the line type**, even where `dnc.wash_required_for` does not cover it. Leaving office direct dials out of the wash is a judgement about which numbers are likely to be on the register; it was never a reason to ring one we already hold evidence about.
- The market of a dial follows **the number**, not the account's registered country. An NZ bank employing someone on an AU mobile is dialled under AU rules, on that person's clock. The account country is only the fallback for a number written in national form or one that will not parse.
- The account desk (`npm run serve`) refuses to start without `ADMIN_TOKEN`. It edits the list of people the system will call and is never served unauthenticated.
- `holidays.require_verified_calendar` ships **true**. The official `data.gov.au` holiday dataset stops at 2025, so 2026 and 2027 are derived from rules and every dial on those dates is denied until a human signs the calendar off with `npm run holidays:verify`.
- Statutory calling windows live in code (`src/compliance/policy.ts`), not in config. `config/policy.yaml` can only narrow them. **Saturday is closed there and cannot be re-opened by configuration.**
- The operator window runs on one clock per market — Sydney for AU, Auckland for NZ — and is checked *in addition to* the statutory window in the recipient's own timezone. Anchoring the plan to Sydney can delay a call but never permit an unlawful one.
- `approval.require_daily_plan` ships **true**: nothing dials until that day's plan has been approved, for the people on it, on that day. `npm run plan -- draft | show | approve | reject`.
- A sub-agent is only reachable through `runAgent`. Input and output are validated against its contract, output twice off-contract escalates, and the budget is metered continuously - so a malformed or over-budget result never reaches the blackboard.
- The Campaign Director dispatches work and decides what follows from a result. A sub-agent never queues another sub-agent's work, and the Director has no route to a dial: only the compliance gate can grant one.
- Phase 2 ships **stub** Prospector and Scout handlers behind their real contracts. They reach fixtures, not Apollo or the web. Phase 3 replaces the handlers and the tools; the contracts, the task graph and the budgets stay as they are.
