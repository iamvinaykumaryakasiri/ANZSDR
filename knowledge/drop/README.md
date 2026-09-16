# The live folder

Put things in here. Run `npm run knowledge:sync`. They become draft claims.

Or do the whole thing from a browser: `npm run serve`, then the **What Lexi may
say** panel on the account desk. Drag a deck in, press *Read the folder*, and
approve line by line. Same folder, same claims, same rule — an upload produces
drafts and nothing else.

## What it reads

| Extension | What happens |
|---|---|
| `.pptx` | Slide text extracted, one proposed claim per substantive line, tagged with the slide number it came from |
| `.md`, `.txt` | Read as text, split on headings and bullets |
| anything else | Listed as skipped, with the reason. Nothing fails silently |

Sub-folders are walked, so organise however suits you.

## What comes out

Every line that looks like an assertion becomes a **draft** claim in
`../approved-claims.json`, carrying the file it came from and the slide or
heading it sat under. Draft means the agent cannot say it. Nothing you put in
this folder reaches a prospect until you have read the claim and approved it:

```bash
npm run knowledge:status              # everything drafted, grouped by source
npm run knowledge:approve <claim-id>
npm run knowledge:reject  <claim-id> -- --reason "out of date"
```

Sync is idempotent. Re-running it on an unchanged file changes nothing, and
re-running it after you have approved something does not walk that approval
back — an approved claim whose source line still exists stays approved. A claim
whose source line has **disappeared** from the file is marked `orphaned` rather
than deleted, so an approval is never quietly lost.

## What not to put here

- Anything under client NDA. A drafted claim is stored in the repository.
- Pricing, rate cards, commercial terms. §9 bans the agent from saying any of it,
  so indexing it creates risk with no upside.
- Anything with a real prospect's personal details in it.

## Files here are not committed

`.gitignore` excludes the contents of this folder — decks are large, often
internal, and change constantly. What *is* committed is
`../approved-claims.json`, so the claims survive and are reviewable as a diff
even though the deck they came from is not in the repository.
