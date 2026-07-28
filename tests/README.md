# Tests

Run everything:

```bash
node tests/run-all.js
```

Or a single file:

```bash
node tests/balances.test.js
```

No dependencies and no install step — plain Node, no test framework.

## How they work

The API handlers are `require`d directly, with `lib/supabase-server` swapped for
an in-memory fake via a `Module._load` hook. The fake understands enough
PostgREST syntax to be meaningful: `eq.`, `ilike.`, `like.`, `in.()`,
`limit`/`offset` paging, `on_conflict` with `merge-duplicates`, and the unique
constraint on `bill_number`. Nothing touches a real database, so the suite is
safe to run at any time.

`pdf-import.test.js` is different — it lifts the parsing functions out of
`billing.js` by source extraction and runs them directly, because those
functions are not exported.

## What is covered

**balances.test.js** — customer balances are derived, never stored as a running
total: carry-forward between bills, payments counted once, opening balance as
the anchor, a phone-only edit not wiping that anchor, case- and
whitespace-insensitive name matching, bulk repair, recomputation after a bill
edit or delete, import dedup, and validation.

**bills.test.js** — bill numbers survive deletion and concurrent saves (the bug
where a reused number silently overwrote a live bill), stock is left untouched
by billing, a failed edit restores the original line items, payments can be
deleted, `?all=1` returns the full history, quantity validation, and
case-insensitive payment lookup.

**pdf-import.test.js** — supplier-bill line parsing: the skip-list for totals,
GSTIN, bill numbers and address lines; number assignment across the 1/2/3/4
column layouts including this app's own receipt format; names containing
digits; parsed zeros not being rewritten; and that a reprinted receipt carries
the bill's own date rather than today's.

## What is NOT covered

These run in Node, so anything needing a browser is untested:

- pdf.js loading from the CDN
- `navigator.share` on a phone
- html2pdf rendering
- Any DOM interaction

Changes to those paths still need checking by hand in the app.

## Adding a test

Drop a `*.test.js` file in this folder. `run-all.js` picks it up automatically.
Print `PASS`/`FAIL` at the start of a line and exit non-zero on failure — copy
the `eq()` helper from an existing file.
