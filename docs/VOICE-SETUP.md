# Voice setup: from zero to a first test call on your own phone

This takes you from a fresh checkout to Lexi ringing **your own mobile**, and
nobody else's. Phase 5 can only dial a contact marked `test` in
`config/contacts.csv` (a number you answer yourself), and only when the
compliance gate says yes. Nothing in this guide turns that off.

Budget about 90 minutes the first time, most of it waiting on Twilio and Vapi
sign-ups. Every command below is safe to run: nothing places a call except
`npm run voice:testcall ... --yes`.

```
your phone  <--  Twilio number  <--  Vapi (voice, speech, barge-in)
                                          |   asks "what should Lexi say?" every turn
                                          v
                              your tunnel  -->  npm run voice:serve  (this repo: Claude, Guardian, the log)
                                                       ^
                       npm run voice:testcall  --------+  (asks the compliance gate first)
```

---

## 0. What you need to have decided

- **Which number rings.** Yours. It goes in `config/contacts.csv` with
  `kind` = `test`. There is one already (`+61448455510`, "Vinay Test"); change it
  if that is not your mobile. Only a number you personally answer belongs in that
  column: a `test` contact skips the Do Not Call check.
- **Which caller ID Lexi presents.** A Twilio number you will keep (step 2). The
  brief (section 7.3) requires it to be real, never withheld, never spoofed, and
  **answerable for at least 30 days after any call made from it**. Do not release
  it, let its balance lapse, or change where it forwards inside that time.
- Section 15 item 7 (may recordings leave Australia?) is still open. Vapi keeps
  its copy of a recording in its own cloud. That is fine for calls to your own
  phone; settle it before any real prospect is recorded.

---

## 1. This repository

```bash
npm install
npm run db:setup                # create the database
cp .env.example .env            # then edit it as you go; .env is never committed
npm run accounts:import         # loads config/accounts.csv and config/contacts.csv
```

Make three secrets and put them in `.env`:

```bash
openssl rand -hex 24   # -> VOICE_SHARED_SECRET   (Vapi presents this to our brain)
openssl rand -hex 24   # -> VAPI_WEBHOOK_SECRET   (Vapi presents this to our webhook)
openssl rand -hex 32   # -> RECORDING_ENCRYPTION_KEY (encrypts recordings we keep; BACK IT UP)
```

Anthropic: put your key in `.env` as `ANTHROPIC_API_KEY` (in a cloud session set
`LEXI_ANTHROPIC_API_KEY` in the environment settings instead). Then prove the
brain works before anything else is involved:

```bash
npm run caller:smoke            # a few cents; type a few lines as the prospect
```

At any point, `npm run voice:doctor` tells you what is still missing. Run it now
and then after each step; it changes nothing and places no call.

---

## 2. Twilio: a number, and a real (not trial) account

1. Create an account at twilio.com and **upgrade it from trial**. A trial account
   plays a "this is a trial account" announcement at the start of every call,
   which would sit in front of Lexi's AI disclosure, and can only ring verified
   numbers.
2. Buy an **Australian number with voice** (Phone Numbers, Buy a number). Australian numbers need a
   *regulatory bundle* (business details and address proof) approved first; start
   that early, it can take days. New Zealand works the same way when you are ready for it.
3. Console, Voice, Settings, **Geo permissions**: enable Australia (and New Zealand later). Outbound calls to a
   country that is not enabled fail.
4. Copy the **Account SID** and **Auth Token** from the console home page into `.env`
   as `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`. Put the number in `.env` as
   `TWILIO_NUMBER_AU`.

Then tell the system the number it may present. In `config/policy.yaml`:

```yaml
caller_id:
  au_number: "+61xxxxxxxxx"      # the Twilio number, E.164
  nz_number: ""                  # leave empty until you have an NZ number
```

and in `config/agent.yaml`, the number a prospect can ring back (normally the same one):

```yaml
callback:
  number: "+61xxxxxxxxx"
```

With `au_number` empty the gate refuses every Australian dial with
`CALLER_ID_NOT_CONFIGURED`. That is by design.

---

## 3. Vapi: account, key, number

1. Create an account at vapi.ai. In the dashboard, Organization settings, API keys, copy the **private** key into `.env` as `VAPI_API_KEY`.
2. **Phone Numbers, Create, Import Twilio.** Give it the number, the Account SID and the Auth Token. Vapi
   points the number's voice webhook at itself (that is what "BYO carrier" means here: the number stays yours and
   stays in your Twilio account).
3. Open the imported number and copy its **id** into `.env` as `VAPI_PHONE_NUMBER_ID_AU`.
4. **Make the number answerable by a person.** Someone may ring it back, and section 7.3 says that call has to
   reach somebody for 30 days. In the number's inbound settings, set a fallback/forward destination to your own
   mobile (or a line that a person answers), and check it by ringing the number from a different phone. If you
   cannot find the setting, do not place a call from this number until you can.

Do **not** give the number an inbound assistant: Lexi has no briefing for a call we did not place and would say so.

---

## 4. A public HTTPS address (a tunnel)

Vapi has to reach this machine to ask what Lexi should say and to report the call. The server listens on
port `8081` (`VOICE_PORT` changes it; the account desk uses 8080). Use any tunnel:

```bash
# Cloudflare (free, no account needed for a quick tunnel)
cloudflared tunnel --url http://localhost:8081

# or ngrok
ngrok http 8081
```

It prints an `https://...` address. Put it in `.env` with no trailing slash:

```
PUBLIC_BASE_URL=https://something-random.trycloudflare.com
```

A quick tunnel gets a new address every time it restarts. When that happens, update `PUBLIC_BASE_URL` and run
step 6 again; it is safe to repeat.

---

## 5. Policy: the settings that let your own mobile be rung

Four changes, each deliberate. `npm run voice:doctor` names any you have missed.

1. **`config/policy.yaml`, `dnc.exempt_test_contacts: true`.** Your phone is a mobile, and mobiles cannot be
   dialled at all until Do Not Call washing exists (section 7.2). This flag exempts contacts marked `test` and
   nobody else, and only while `dialling.test_contacts_only` is still `true`. Leave `allow_mobile_dialling` and
   `test_contacts_only` as they are.
2. **Holiday calendar sign-off.** The 2026 calendars are derived from rules, not published, and the gate refuses
   every dial on those dates until a person signs them off. That signature is *you saying you have checked them*;
   look at `npm run holidays:verify` first, then:
   ```bash
   npm run holidays:verify -- --sign-off all:2026 --by "Your Name"
   ```
3. **A test contact.** `config/contacts.csv` needs a row with `kind` = `test` and your number. Re-run
   `npm run accounts:import` after editing it. Both rows that ship share one number, so only one can be rung
   per day (a number may be dialled once a day).
4. **Make it eligible for the day plan.** Imported contacts arrive as `enriched`, and the plan only lists
   `researched` or `queued` ones, so approving the plan would not let your call through:
   ```bash
   npm run voice:doctor                          # shows each test contact with its id
   npm run voice:ready -- --contact <id>         # test contacts only
   ```

---

## 6. Create the assistant at Vapi

```bash
npm run voice:assistant -- --print     # see exactly what will be sent (secrets hidden)
npm run voice:assistant                # create it, or update it if it exists
```

It prints `VAPI_ASSISTANT_ID=...`; put that line in `.env`. This is what is configured:

- **our endpoint is the brain** (`<PUBLIC_BASE_URL>/v1/chat/completions`), so the prompt, the guardrails and the log stay here;
- **no first message**: the provider asks us for it, and we answer with the frozen opening from
  `src/agents/caller/opening.ts`, so the AI disclosure and the recording notice cannot be edited from Vapi's dashboard
  or from `config/voice.yaml`;
- recording **on** (the opening says the call is recorded); barge-in set to yield at once; a four-minute ceiling;
  voicemail detection that hangs up (no message is left on anyone's phone).

If Vapi refuses it, the message names the field. The two most likely culprits are the voice id and the transcriber
language/model in `config/voice.yaml` (the shipped values are a starting point, not a verified combination).
Audition voices in Vapi's voice library and set `voice.provider` / `voice.voice_id`; the brief only says
female, AU-neutral.

---

## 7. Preflight

```bash
npm run voice:doctor -- --online
```

`--online` also reads back (reads only) that the deployed assistant is still ours (no first message, our endpoint,
recording on), that Vapi's number is the caller ID in `config/policy.yaml`, and that the Twilio credentials work.
It ends with what the compliance gate would say for each test contact **right now**. The state you want before the
call is:

```
Vinay Test  +61•••••510  AU  ->  REFUSED right now
    waiting  DAY_PLAN_NOT_APPROVED: ...
    once today's plan is approved, nothing else would stop this dial
```

(or `ALLOWED` if you are within hours and the plan is already approved). Anything marked `setting` is something to
fix first, with the fix printed under it.

---

## 8. Approve today's plan

Nothing is dialled until you have approved the day's list (section 7.6). It covers the named people, today only.

```bash
npm run plan -- draft
npm run plan -- show           # your test contact should be listed
npm run plan -- approve
```

---

## 9. The test call

Hours. Both windows must be open. Your calling window is Tue-Thu, 09:30-16:30 Sydney time. And because a mobile
could be anywhere in Australia, the statutory 09:00 start must have passed *in Perth* too, which is **12:00 Sydney
time while daylight saving is on (early October to early April) and 11:00 otherwise**. So in practice: Tuesday to
Thursday, noon to 16:30 Sydney time, not on a public holiday.

In one terminal, with the tunnel up:

```bash
npm run voice:serve
```

In another:

```bash
npm run voice:testcall -- --contact <id>           # says what would happen; calls nobody
npm run voice:testcall -- --contact <id> --yes     # rings the phone
```

`voice:testcall` refuses unless the contact is marked `test` on the blackboard **and** the gate allows the dial **and**
the server answers at `PUBLIC_BASE_URL/healthz` (a number may be dialled once a day; it will not spend that on a call
nobody is there to answer). If the gate says no it prints every reason.

When you answer, check:

1. The first thing she says is the whole opening: her name, that she is an AI assistant, Hexaware and Vinay, why she
   called, that the call is being recorded, and the question about thirty seconds.
2. Say "are you a real person?" She says plainly that she is an AI.
3. Interrupt her mid-sentence. She stops.
4. Give her an email address and two times ("Wednesday morning or Thursday after 3"). She reads the address back and
   says Vinay will send a confirmation today, never that anything is booked.
5. Say "actually I don't want to be recorded". She ends the call (Vapi cannot stop a recording mid-call, so she says
   so and does not claim to have stopped it), and the recording is deleted when the report arrives.

---

## 10. Afterwards

```bash
npm run voice:latency -- --last 5          # first-token and perceived latency per call, against the 800ms target
npm run voice:latency -- --probe           # no phone: time the brain alone with the real model (a few cents)
npm run concierge:preview                  # what Vinay's meeting-request email looks like
ls data/outbox                             # the meeting request, as an .eml
npm run crm:sync                           # the Excel view
```

The call is on the blackboard: `Call` (outcome, duration, ended reason, timings in `providerMetrics`), `CallEvent`
(every turn, tool call and defect in order), `CallRecord` (Scribe's summary). If processing failed, run it again
from the stored report: `npm run voice:reprocess -- --call <id>`.

### Recordings and retention

- The provider's copy is kept 90 days (`recording.retention_days` in `config/policy.yaml`), as is ours:
  with `RECORDING_ENCRYPTION_KEY` set, the audio is also downloaded after each call and stored encrypted
  (AES-256-GCM, bound to the call id) in `data/recordings`. **Back the key up**; without it an archived recording
  cannot be read.
- `npm run recordings:purge` shows what is due and deletes nothing. `npm run recordings:purge -- --apply` deletes
  it, both copies. `npm run voice:serve` runs the purge once a day on its own (`RECORDINGS_AUTO_PURGE=off` stops that).
- A recording the prospect objected to is deleted as soon as the call's report arrives, whatever its age.

### Caller ID: keep it answerable

`npm run voice:doctor` prints the date until which the number you last called from must stay answerable. Keep the
Twilio number, its forwarding to a person, and its balance in place until then.

---

## Environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` (or `LEXI_ANTHROPIC_API_KEY`) | the brain, Guardian, Scribe | |
| `VAPI_API_KEY` | creating the assistant, placing and hanging up calls, deleting recordings | Vapi private key |
| `VAPI_WEBHOOK_SECRET` | the webhook | sent by Vapi as `x-vapi-secret`; the server refuses everything without it |
| `VOICE_SHARED_SECRET` | the brain endpoint | sent by Vapi as the bearer token |
| `VAPI_ASSISTANT_ID` | placing calls | printed by `npm run voice:assistant` |
| `VAPI_PHONE_NUMBER_ID_AU` / `_NZ` | placing calls | Vapi's id for the imported Twilio number |
| `PUBLIC_BASE_URL` | everything | your tunnel or host, `https://`, no trailing slash |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | preflight, inbound SMS signature check | |
| `TWILIO_NUMBER_AU` / `_NZ` | consistency check only | the real setting is `caller_id` in `config/policy.yaml` |
| `RECORDING_ENCRYPTION_KEY` | keeping encrypted recordings | 64 hex characters |
| `RECORDINGS_DIR`, `RECORDINGS_AUTO_PURGE`, `VOICE_PORT`, `HOST`, `MAIL_FROM`, `OUTBOX_DIR` | optional | defaults: `data/recordings`, `on`, `8081`, `0.0.0.0` |

## Commands

| | |
|---|---|
| `npm run voice:doctor [-- --online --contact <id> --at <iso>]` | read-only preflight; exits 1 if something is missing |
| `npm run voice:assistant [-- --print]` | create or update the Vapi assistant |
| `npm run voice:serve` | the server Vapi talks to (brain, webhook, inbound SMS, watchdog, daily purge) |
| `npm run voice:ready -- --contact <id>` | make a **test** contact eligible for the day plan |
| `npm run voice:testcall -- --contact <id> [--yes]` | place one call, to a test contact, through the gate |
| `npm run voice:latency [-- --last N \| --call <id> \| --probe]` | latency report |
| `npm run voice:reprocess -- --call <id>` | re-run end-of-call processing |
| `npm run recordings:purge [-- --apply]` | retention purge; dry run unless `--apply` |

## If something goes wrong

| You see | It means |
|---|---|
| The phone rings and nobody speaks | Vapi could not reach the server or was refused. Check the tunnel is up, `PUBLIC_BASE_URL` is current (then re-run `npm run voice:assistant`), and `VOICE_SHARED_SECRET` is the same in `.env` as when the assistant was created. Vapi's call log shows the request it made to `/v1/chat/completions` and what came back |
| She says she doesn't have the details for this call | The server has no briefing for the call: the call record was not found, or the opening could not be built. The server log says which |
| `voice:testcall` says `GATE_DENIED` | Read the codes; `voice:doctor` explains how to clear each. `NUMBER_ALREADY_DIALLED_TODAY` after a failed attempt means the provider may have placed it |
| `CONCURRENCY_LIMIT` | A call is still marked live. `npm run voice:serve` closes stuck calls after the ring timeout / maximum duration (`config/voice.yaml`); otherwise it is a call that is still up |
| Vapi refuses the assistant | The message names the field. Usually the voice or transcriber in `config/voice.yaml` |
| Twilio: call fails instantly | Geo permissions for Australia, a trial account, or the regulatory bundle not yet approved |

## What this build has not been able to check

Everything above is built and tested against fakes of Vapi and Twilio; none of it has met the real services. The
first `npm run voice:assistant` and the first test call are the verification. Specifically unconfirmed, because
Vapi's public documentation is silent or ambiguous:

- the exact shape of the custom-LLM request (where our call id arrives; the code reads it from `metadata.callId`,
  `call.metadata`, `call.assistantOverrides.metadata` or the top level, and falls back to the provider's call id);
- that a `tool_calls` reply naming `endCall` makes Vapi hang up, and whether it waits for the goodbye to finish
  (a hang-up from our side through the call's control URL follows ten seconds later as a backstop);
- that assistant-level `credentials` accepts a `custom-llm` key (if not, create it once in the dashboard under
  provider keys, with the value of `VOICE_SHARED_SECRET`);
- the field names in `artifact.performanceMetrics` (without them there is first-token latency but no perceived figure);
- whether the recording URL in the report can be downloaded with the API key (if not, the encrypted archive is
  skipped, an error is recorded on the call, and the provider's copy is still purged on schedule).
