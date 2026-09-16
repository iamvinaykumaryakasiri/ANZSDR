# ICP — who is worth calling

**The machine-readable ICP lives in `config/campaign.yaml`, not here.** That file
is what Prospector scores against and what the account desk edits; duplicating
the title list into this folder would guarantee the two drift apart. This file
holds the judgement behind it — the part a list of strings cannot carry.

Current campaign: **NZ banking pilot**. Market NZ. Three meetings a week,
US$25/week ceiling, minimum ICP score 60 to enrich.

## The accounts

Eight New Zealand banks, in `config/accounts.csv`:

| Priority | Accounts |
|---|---|
| 1 | Kiwibank, TSB Bank |
| 2 | The Co-operative Bank, Heartland Bank, SBS Bank, Rabobank NZ |
| 3 | NBS, Unity Credit Union |

Tier 2 and 3 deliberately. §16: *"built to make a small number of good calls, not
a large number of bad ones"*. A tier 2 New Zealand bank is a size where a Head of
Data both owns the problem and answers their own phone; at a big four Australian
bank neither is true.

## The titles

Twenty-nine, in `config/campaign.yaml`, matched as case-insensitive substrings of
the job title. Short stems do the most work — `head of data` already catches
"Head of Data & Analytics", "Head of Data Platforms" and "Group Head of Data".

Four bands: C-level, General Manager (the senior technology title in most NZ
banks), Head of, and Director/Manager for mid-senior.

## Disqualifiers

`intern`, `graduate`, `trainee`, `apprentice`, `recruiter`, `talent acquisition`,
`student`. Anyone matching is never called regardless of score.

## The judgement a score cannot hold

- **GM beats CIO in this market.** In a New Zealand bank of this size the GM
  Technology is frequently the real decision-maker and the CIO title may not
  exist at all. Do not rank C-level above GM here out of habit.
- **One person per account per week**, until someone at that account has actually
  spoken to us (§7.5). Eight accounts therefore means a naturally slow campaign,
  which is the intent.
- **A wrong specific is worse than a right generic** (§5.3). If Scout's
  confidence is `low`, the agent opens generically rather than guessing at a hook.

## Needs you

- Whether any of these eight is already a Hexaware client, partner or in an
  active procurement — all four are §8 hard-escalation conditions and it is far
  better to suppress the account now than to discover it mid-call
- Anyone at these banks you already know personally, who should be taken off the
  list and called by you
