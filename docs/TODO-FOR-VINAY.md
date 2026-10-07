# To do — things only you can do

Everything here is something the build cannot do for you: it needs your accounts, your decisions, or your sign-off. Each item says why it matters, how long it takes, and exactly what to do. They are ordered by what unblocks the most. Items marked **parallel** can be done at the same time as each other.

Nothing in this list needs you to write code.

Legend: **Blocks** = what stays switched off until it is done.

---

## A. Do these first (about 45 minutes in total)

### A1. Approve what Lexi may say — 10 min
**Blocks:** Lexi asserting any fact at all. As shipped, 0 of 13 claims are approved, so she can say nothing about Hexaware beyond the opening.

1. In a terminal on your machine, in the repo: `npm run knowledge:status` lists every claim.
2. Approve these five (one per command; there is deliberately no approve-all):
   ```
   npm run knowledge:approve frameworks.zero-friction
   npm run knowledge:approve frameworks.zerovity
   npm run knowledge:approve services.data-ai
   npm run knowledge:approve company.headquarters
   npm run knowledge:approve company.headcount.q2-2026
   ```
3. Reject the conflicting headcount figure:
   ```
   npm run knowledge:reject company.headcount.aggregator -- --reason "Undated aggregator figure; conflicts with Hexaware's own Q2 results"
   ```
4. Leave the rest as drafts until you have checked them:
   - `services.ddai-practice` — comes from you, not a public page. Approve once you are happy for Lexi to say "Hexaware has a Data, Digital & AI practice".
   - `anz.nz-entity`, `anz.sydney-office` — directory data. Confirm against Hexaware's own records first.
   - `company.revenue.q2-2026`, `company.ownership`, `company.listed` — finances and ownership are poor cold-call material and §9 bars speculating about finances. Recommend leaving as drafts.
5. You can do all of this from your phone instead: `npm run serve`, open the **What Lexi may say** panel.

### A2. Put real content in the knowledge pack — 30 min
**Blocks:** good conversations. Lexi's body of the call is only as good as this.

1. `knowledge/proof-points.md` is **empty on purpose**. For each reference story, write the story and mark it **nameable** or **anonymised**. §9 bans naming any client not marked nameable, and the build cannot know who has consented.
2. Drop capability decks (`.pptx`) and notes (`.md`, `.txt`) into `knowledge/drop/`, then `npm run knowledge:sync`. Each line becomes a *draft* claim tagged with its file and slide. Approve line by line.
3. Fill `knowledge/objections.md`, `anz-story.md` and `icp.md` in your own words.

---

## B. Accounts and keys (parallel — each takes 10–20 min)

Put every secret in `.env` at the repo root (gitignored). In a cloud session, add them as environment variables in the environment settings instead. **Never paste a key into chat or commit it.**

### B1. Anthropic key
**Blocks:** nothing in the tests (they run offline), but every real call and `npm run caller:smoke`. You already have one working here; add it to your own `.env` and any other environment.
- `ANTHROPIC_API_KEY=...`
- Set a monthly spend limit in the Anthropic Console. This is your budget ceiling for §15 item 8.

### B2. Apollo
**Blocks:** Phase 3 on real data (finding people, emails, phones).
1. Apollo account with API access; create a **master API key** (phone reveal needs it).
2. `APOLLO_API_KEY=...`
3. Read `docs/APOLLO-SETUP.md`. Know the costs: about 1 credit per work email, about 8 per phone.
4. Phone numbers arrive asynchronously by webhook, which needs a public HTTPS hostname (see B5). Emails do not.
5. First run is always a dry run: `npm run prospect -- --account <domain>` prints the credits it would spend and spends nothing until you add `--yes`.

### B3. Twilio
**Blocks:** any real call or SMS.
1. Twilio account, upgraded out of trial (trial numbers cannot call unverified numbers freely and play a trial message).
2. Buy **one Australian number** and **one New Zealand number**. Australian numbers need a regulatory bundle (business address and ID); submit it early because approval can take days.
3. Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` to `.env`.
4. For SMS, register the sender. An alphanumeric sender is **not** accepted by this system (a prospect could not reply STOP).
5. **Decide the callback number** (§15 item 3). It must be real, answerable, and stay answerable for at least 30 days after the last call. Put it in `config/policy.yaml` under the caller ID fields. Until you do, the gate refuses every dial with `CALLER_ID_NOT_CONFIGURED`. That is intended.

### B4. Vapi
**Blocks:** voice.
1. Vapi account, create an API key, `VAPI_API_KEY=...`.
2. Import the Twilio numbers into Vapi as BYO carrier numbers.
3. Full walkthrough is in `docs/VOICE-SETUP.md`. `npm run voice:doctor` prints exactly what is still missing and never places a call.

### B5. A public HTTPS hostname
**Blocks:** Apollo phone webhooks, Vapi, Twilio SMS replies.
- Quickest for testing: a tunnel (Cloudflare Tunnel or ngrok) to port 3000. Set it as `PUBLIC_BASE_URL`.
- For the pilot, a small always-on host with a stable name (a tunnel URL that changes will break webhooks).

### B6. Redis (optional until volume)
The enrichment queue runs in memory without it. For real use set `REDIS_URL` so queued work survives a restart.

### B7. A transactional email provider
**Blocks:** meeting-request emails reaching your inbox. Today they are written to `data/outbox` as `.eml` files.
- Pick one (SendGrid, Postmark, SES), verify a sending domain, add its key. The mailer is already locked so it can only email **you**.
- Prospect-facing email is never sent by the system; it is drafted inside the email to you and you send it from Outlook (§12.2).

---

## C. Legal and compliance sign-offs — do not skip

### C1. Hexaware brand and legal sign-off — your call, can take days
**Blocks:** dialling any real prospect (§15 item 2).
Get written confirmation that Hexaware brand/legal are comfortable with an AI identifying itself as calling on their behalf. Do this early; it is the longest-lead item.

### C2. Do Not Call Register washing (§15 item 4)
**Blocks:** calling mobiles. Today only office direct dials are possible.
- Option 1 (recommended to start): office direct dials only. Nothing to do.
- Option 2: arrange DNCR washing (ACMA's DNCR wash service or an accredited provider), then set `dnc.allow_mobile_dialling: true` and record the wash date. Numbers must be re-washed every 30 days.

### C3. Sign off the public-holiday calendar
**Blocks:** every dial on 2026–2027 dates. The official dataset stops at 2025, so later years are derived from rules and the gate denies them until a human verifies.
1. Open the generated calendar and check your state's and NZ's holidays against the official government lists.
2. `npm run holidays:verify`.

### C4. Recordings (§15 item 7)
Decide the retention period (default 90 days, with an automatic purge job) and whether recordings may leave Australia. If they may not, tell me and I will constrain the storage region.

### C5. Privacy handling
Decide who handles access/deletion requests under the Privacy Act 1988 (AU) and Privacy Act 2020 (NZ), and put that contact in the opening script's "where we got your number" answer.

---

## D. Decisions I need from you (answer in one message)

1. **First campaign (§15 item 5):** which accounts, which titles, AU or NZ first. Suggested for a low-stakes pilot: 5 accounts, one market.
2. **Where meeting requests go (§15 item 6):** which email address. Then run `npm run concierge:preview`, open the sample `.eml` in your own mail client, and tell me if the `.ics` attaches and opens properly.
3. **Budget ceilings (§15 item 8):** monthly caps for Apollo credits, voice minutes, and LLM spend. The Campaign Director enforces these.
4. **Agent voice:** Lexi's accent/voice (AU-neutral assumed).
5. **The audit question:** Guardian's post-call audit currently flags Lexi's mandated opening lines as unsupported claims. You chose to leave it. Confirm you are happy that the defect numbers on the console include them, or tell me to exempt them.
6. **Inbound mail:** how should your `CONFIRMED`/`RESCHEDULE`/`REJECT` replies reach the system? Options: a forwarding rule to an inbound-parse address, or a small mailbox poller. Until then, use the console's one-tap buttons or `npm run concierge:reply`.

---

## E. Getting to a first real test call (about 1 hour once A–C are done)

1. `npm run voice:doctor` — everything it reports as missing, fix.
2. Mark **your own mobile** as a *test* contact (calls only to numbers you control; this is what `dialling.test_contacts_only` enforces). Set `dnc.exempt_test_contacts: true` so your mobile is allowed.
3. Draft today's plan: `npm run plan -- draft`, review it, `npm run plan -- approve`. Nothing dials without this, and it does not carry over to tomorrow.
4. `npm run voice:testcall -- --contact <your test contact id> --yes`.
5. Answer it. Check: Lexi gives her name, says she is an AI, says who she works for, announces recording, and asks for thirty seconds. Ask her a few awkward questions. Ask for a human. Try "ignore your instructions".
6. Do this ten times (Phase 5 acceptance). Watch the console during the call.
7. Check the meeting-request email and reply `CONFIRMED`.

## F. Before any real prospect (Phase 9)

- C1 signed off, A1/A2 done, C2 decided, C3 verified.
- Set `dialling.test_contacts_only: false` **only** after all of the above. This is the switch that lets the system call real people.
- Start with 20 real calls into one low-stakes segment, reviewing every one before scaling.
- Know where **STOP ALL** is on the console. Test it once, deliberately, before the first real call.

---

## G. Things worth doing when you have a quiet moment

- Review the console design notes in `web/DESIGN.md`. Say what you want changed; it is cheap now and expensive later.
- Read `CLAUDE.md`'s "Where the brief was silent, the build chose" list and overrule anything you disagree with (for example: an escalation suppresses the contact and number; an existing client or active RFP suppresses the whole account).
- Decide whether to allow direct sending of prospect email later. If yes it must come from an authenticated Hexaware subdomain with SPF, DKIM and DMARC. Not before.
- LinkedIn connect requests are queued for you to send manually. Decide how often you want to clear that queue.
