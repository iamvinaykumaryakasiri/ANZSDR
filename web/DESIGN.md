# Console design plan

Written before any component (CLAUDE.md section 13, Phase 8). Everything in `src/` follows it; where the build
had to depart from it, the departure is noted at the bottom.

## What this is for

One person, Vinay, first thing in the morning with coffee, sometimes on a phone in an Auckland hotel. The console
answers three questions without a click: what is happening right now, where are we losing people, what needs me.
It holds no business logic. It draws what `src/stream/contract.ts` sends and posts the few decisions he makes.

The most characteristic thing in this world is a live phone call to a stranger. So the console is a **control room
with one light in it**: either a call is on air, or the room is standing by.

## Concept: the gallery at six in the morning

A broadcast production gallery. Dark, cool, quiet. Instruments you read at a glance. One tally light.
The script is a **rundown** (disclosure, reason, hook, value, ask, close) and the live call moves down it.
What the prospect says is in a different voice from what the machine reports, the way captions differ from a
vision mixer's readouts.

## Colour

A deep cool ink field. Steel and slate for structure. Pale sand for outcomes that are settled. One red.

| Token | Hex | Role | Contrast on ink-900 |
|---|---|---|---|
| `ink-900` | `#0C1622` | page field | |
| `ink-800` | `#121E2D` | raised field (hero, sheets) | |
| `ink-700` | `#192A3E` | selected row, inset well | |
| `slate-500` | `#384F68` | rules, bar tracks (never text) | 2.2 |
| `slate-400` | `#5A7390` | control outlines, chart strokes (never text) | 3.7 |
| `slate-300` | `#6F89A6` | tertiary text, timestamps | 5.0 |
| `steel-300` | `#8EA6BF` | secondary text | 7.2 |
| `steel-200` | `#BCCBDA` | body text | 11.0 |
| `steel-100` | `#E6EDF4` | headings, primary text, focus ring | 15.4 |
| `sand-400` | `#BFAE87` | sand bars on ink | 8.3 |
| `sand-300` | `#DCCBA5` | settled outcomes: text and fills | 11.4 |
| `sand-200` | `#EDE2C8` | the confirm button, sand on sand | 14.1 |
| `tally` | `#FF2B3D` | **a call is live right now. Nothing else, ever.** | 4.9 |

Tailwind's default palette is wiped (`--color-*: initial`) so nothing outside this table can be reached for.

**The red rule.** Red appears in exactly three places, all meaning the same thing: the tally lamp in the hero,
the one-line "on air" indicator in the top bar (so it follows him to every screen), and the sweep line across the
top of the hero while a call is live. It is never an error, a warning, a delete or a stop. This also means the
**Stop all control is not red**, which is deliberate and uncomfortable: the control gets its urgency from size,
weight, a heavy light outline and a fixed position in the top bar on every screen. When it is engaged it inverts
to a solid light block.

**Errors and defects get weight and position, not colour.** A defect in a transcript is a heavy-ruled block set
into the line it happened on. A failed request is bold text next to the thing that failed, plus a retry. A held
queue item states the reason in plain words, in a heavier weight, first. A provider that is down sorts to the top
of Health and carries a solid square, where one that is fine carries a hollow one.

**Sand is for settled things.** Outcomes that have landed (meeting requested, confirmed, a call outcome in the
log), the last two funnel stages, the confirm button. If it is sand, it is done or it is the act of finishing.

No gradients, no shadows, no blurred glow except the tally lamp's own light.

## Type

Two families with a functional split.

- **Schibsted Grotesk** (variable) carries everything the system says: labels, numbers, names, buttons, tables.
  Figures are always `tabular-nums lining-nums` (checked in Chromium: `1111` and `0000` measure identically), so
  a counting clock or a live tally never jitters. The face's `tnum` also widens punctuation, so tabular figures
  are applied to runs of digits only (the `Fig` component), never to a whole line of text.
- **Newsreader** (variable, optical size) carries everything a *person* said: the transcript, the prospect's own
  words about when they are free, quotations in objections, and the draft reply he will paste into Outlook. Set
  larger and looser than the data around it, so speech never looks like telemetry.

Sentence case everywhere. No all-caps labels, no monospace decoration, no arrows or chevrons on buttons.

Scale (rem, so 200% zoom reflows rather than clips): 0.8125 labels and captions (the floor), 0.9375 body,
1.0625 emphasis, 1.25 speech, 1.75 section statements, 2.75 the state word (On air / Standing by), 4.5 the
elapsed clock. Line length is held under 70ch for prose and speech.

## Layout

Desktop is left aligned with a sticky header. The page is a flexible left region (12 columns inside it: the
funnel takes 5 and the curve 7) beside a fixed-width right column of 21 to 23rem. Left is what is happening and
what it means; right is what needs a person, and it stays in view while the left scrolls. The header is one row at
1536px and wider and two rows below that (brand and tools above, the screens beneath), so Stop all never moves.

```
 top bar  ANZ Voice SDR   Home  Calls  Meetings 3  Trace  Playbook  Accounts  Health      on air 0:41  Ask Jarvis  Stop all
 demo strip (only when snapshot.mode is demo) / halted strip (only when kill switch engaged) / reconnecting strip
 +--------------------------------------------------------------+---------------------+
 | On air | Standing by                         (cols 1 to 8)   | Needs you (cols 9-12)|
 | elapsed clock, prospect, hypothesis, rundown |  escalations first,  |
 | rail, transcript in the warm face            |  then meeting        |
 |                                              |  requests, each with |
 +----------------------------------------------+  confirm / resched / |
 | Where they drop                              |  reject              |
 |  funnel (9 stages, vs 7-day tick)  |  seconds-to-hangup curve with   +---------------------+
 |                                    |  script sections overlaid       | Up next              |
 +----------------------------------------------+  the queue, gate     |
 | Today: dialled connected conversations       |  reasons, countdown  |
 |        requests spend cost per meeting       |                      |
 +----------------------------------------------+                      |
 | Objections | Gatekeepers | Wrong numbers | Champion v challenger     |
 +----------------------------------------------+---------------------+
```

- Sections are separated by field steps and single rules, not by a box around everything. Only the hero is a
  lifted surface.
- Radius is hierarchical: nothing structural is rounded; controls are 3px; the tally lamp is a circle.
- The funnel and the curve sit side by side at 1280 and wider, stacked below that.
- Below 1100 the right column drops under the left; the nav wraps under the brand. No horizontal page scroll at
  any width.

### Mobile is a second layout

Below 640px a different component tree renders, not a squeezed one. It shows exactly four things, in this order:

1. **On air / standing by** (compact: prospect, clock, rundown stage, the last three lines of speech; or the next
   person and the countdown)
2. **Needs you**, where a meeting request is one tap to confirm, with reschedule beside it and reject behind a
   second press
3. **Today's numbers**
4. **Stop all**, pinned to the bottom edge, full width, thumb height

Plus a thin top strip that carries the demo marker, a connection note, and two plain text links: the morning
briefing and "Full console" (which switches to the desktop layout and is how someone at 200% zoom on a laptop,
whose viewport is under 640px, still reaches the other screens).

## The live-call hero

This is where the boldness is spent; the rest stays quiet.

- **Standing by**: a hollow ring where the lamp will be, the words Standing by, then the next number in the
  queue (name, title, company, market, the hypothesis behind the call) and a countdown to the next dial. If
  nothing can dial, the same space says why in plain words ("Today's plan isn't approved yet"). The room is never
  dead.
- **On air**: the lamp lit, the word On air, the elapsed clock at 4.5rem, who and why, then the **rundown rail**:
  six cells, past ones filled steel, the current one inverted to a solid light block, future ones dim. Then the
  transcript. Lexi's lines are quieter; the prospect's are brighter and carry a rule, because they are what the
  call turns on. Confidence is a three-notch meter with its word beside it; the script variant is named.
- The transcript keeps itself scrolled to the newest line until he scrolls up, then offers "Jump to latest".

## Where they drop

- **Funnel**: nine rows, each a button. Count, rate and absolute loss are text; each bar is drawn against the
  stage above it (filled is who arrived, the rest is the loss). A thin
  tick on every bar marks **where it would have ended at the seven-day baseline rate**. A bar that stops short of
  its tick is a worse-than-usual day, and the row's figures go heavy. No colour is spent on this. Selecting a
  stage filters the curve, the call list under it and the queue, and a bar above says exactly what is filtered.
- **Seconds-to-hangup curve**: a density area of call length, with the six script sections as bands behind it,
  so the eye can see which sentence loses people. Every bin is reachable by pointer, keyboard and touch. Hover,
  focus or tap lists those calls underneath, each with a play button that starts the recording three seconds
  before the hangup. Segment by market and script variant (and industry and seniority where the feed carries
  them).
- Beside them: objections ranked, gatekeeper blocks by account, wrong-number rate (labelled as a data-quality
  signal), champion against challenger with progress to the 30-conversation minimum.

## Motion

Exactly one orchestrated moment: **the transition into live-call state**. When a call starts while he is
watching, over about 900ms: the hero field lifts a step, the lamp strikes and blooms, a line sweeps across the
top edge and settles as a static rule, and the clock and rundown rise into place. Nothing else animates:
no hover effects, no section reveals, no number tweening, no skeleton shimmer. Opening a call that is already
live on page load does not replay it. `prefers-reduced-motion` removes it entirely and the state simply changes.

## Stop all

Fixed in the top bar on every screen (and pinned to the bottom edge on the phone). Two steps, in place:
press it and the control becomes "Halt all dialling?" with Halt now and Cancel, focus on Halt now, Escape
cancels, and it lapses on its own after eight seconds. Resume is the same shape, because lifting the halt
deserves the same deliberateness. The request is never optimistic: the control says "Halting" until the server
answers, and if the request fails it says so in bold beside the control with the command-line fallback
(`npm run kill`). Engaged state: the control inverts to a solid light block reading "Dialling halted", and a
full-width strip under the top bar carries the time and the reason.

## Jarvis

Command bar on Cmd or Ctrl plus K. Questions answer with the text and a "Read from" list that is always
present, because an answer without its sources is a guess. A command never runs on the first press: it comes
back as a confirmation panel that states exactly what will happen and offers Confirm and Cancel. A refusal is
shown plainly as a refusal. If a command asks for confirmation without saying what it would do, the panel
fails closed and nothing is offered.

## Quality floor

Keyboard navigable end to end, visible 2px light focus ring with an ink offset, semantic buttons, real
headings, `aria-live` on the transcript and the status line, `aria-pressed` on filters, charts with text
equivalents. Rem units throughout, wrapping grids, no fixed heights on text, no horizontal page scroll; readable
at 200% zoom. Contrast per the table above.

## Review against the brief

Checked the plan against the generic defaults and changed:

- First sketch put the elapsed clock and four KPI tiles across the top. Dropped: the brief asks for the call to
  be the hero, and a row of tiles is the default. Today is a flat strip beneath the analysis.
- First sketch gave every panel a bordered rounded card. Replaced with field steps and rules; only the hero is
  lifted.
- First sketch used small-caps labels over each section. Removed; headings are plain sentence-case text.
- First sketch coloured the funnel by good and bad. That would have spent the red or invented a green or amber.
  Replaced with the baseline tick, which carries the same information with position.
- Sand started as the general accent. Narrowed to settled outcomes only so it keeps meaning.

## Departures noted during the build

- "DEMO DATA" is set in sentence case ("Demo data") because the brief bans all-caps labels. It is a full-width
  hatched strip, present on every screen.
- Reject on a meeting request is press-then-confirm, not one tap, because it permanently suppresses the person.
  Confirm and reschedule are one tap.
- Funnel-stage and segment filtering is derived on the client from the call log, because the contract carries no
  per-stage call lists. It lives in one file (`src/lib/callFilter.ts`) so it can be replaced by server-supplied
  ids without touching a component.
