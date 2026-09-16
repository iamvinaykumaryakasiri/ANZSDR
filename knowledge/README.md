# The Hexaware knowledge pack

This folder is the only place Caller's factual content comes from. Brief §6.

Two kinds of thing live here:

**The pack** — seven markdown files. Prose, context, framing. This is what the
agent is *briefed* on: how to talk about Hexaware, what the ANZ story is, how an
objection is normally handled. Read by the briefing-pack builder.

**The boundary** — `approved-claims.json`. Every factual assertion the agent is
permitted to make on a call. Caller may state an approved claim. It may not
state anything else, however true, however obvious, however hard the prospect
pushes. Anything outside the index gets the same answer:

> *"I don't want to give you a half answer on that — Vinay will come back to you
> with specifics."*

Guardian re-reads the transcript afterwards and logs any unsupported assertion
as a defect in the daily digest.

## Draft is not approved

A claim has a status: `draft`, `approved` or `rejected`. **Only `approved` is
assertable.** Everything in here was drafted from public sources by the build
and is `draft` until a human reads it and says otherwise. That is deliberate and
it fails the safe way: an unreviewed claim is silently unavailable to the agent
rather than silently said to a prospect.

```bash
npm run knowledge:status              # what is drafted, approved, conflicting
npm run knowledge:approve <claim-id>  # one claim, after you have read it
npm run knowledge:reject  <claim-id> -- --reason "..."
```

## The live folder

`knowledge/drop/` is yours. Put capability decks, one-pagers and notes in it and
run:

```bash
npm run knowledge:sync
```

Text is extracted, proposed claims are written into `approved-claims.json` as
**drafts**, each carrying the file and slide it came from. Nothing a drop
contains can be said on a call until you approve it. See `drop/README.md`.

## Where the figures disagree

Public sources contradict each other on Hexaware's headcount and revenue — see
`company.md`. The index records each figure with its own source and does not
attempt to reconcile them. Approve the one you can stand behind and reject the
rest; a claim that would be embarrassing to defend on a call is a claim to
reject, not to soften.
