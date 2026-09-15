# Vendored source data

## `australian-public-holidays-combined-2021-2025.csv`

The official machine-readable Australian public holiday dataset.

- Publisher: Australian Government, `data.gov.au`
- Dataset: *Australian Holidays Machine Readable Dataset* (`b1bc6077-dadd-4f61-9f8c-002ab2cdff10`)
- Resource: `33673aca-0857-42e5-b8f0-9981b4755686`
- Retrieved: 2026-09-15

It is vendored rather than fetched at runtime so that a compliance decision never
depends on a third-party endpoint being up, and so that the exact bytes behind any
past decision can be reproduced.

**The published dataset stops at 2025.** Years after that are derived by the rule
engine in `scripts/holidays/rules.ts` and marked `verified: false` until a human
signs them off. Refresh with `npm run holidays:build` once a newer resource exists.
