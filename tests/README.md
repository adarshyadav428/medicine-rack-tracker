# Tests

Install the pinned embedded PostgreSQL test dependency, then run the Node suites:

```bash
npm ci
npm test
```

Or a single file:

```bash
node tests/balances.test.js
```

Tests use plain Node assertions plus pinned @electric-sql/pglite for actual PostgreSQL transaction/constraint checks. No live credentials or migrations are required.

## How they work

Financial handlers run through `tests/helpers/financial-fixture.js`, which applies
source schema and the staged atomic-ledger migration to an ephemeral PGlite
database. Real RPC transactions, rollback, operation replay, versions, stable
customer identity, full invoice reads, and permissions are exercised. The Auth
service is mocked for those functional tests; this is not deployed Auth/RLS
verification. Other isolated suites still use purpose-specific local fixtures.
No test accesses the live shop database.

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

**profit-pin.test.js** — the profit PIN is stored hashed in the database and
checked on the server: `/api/profit` returns nothing without a valid unlock,
forged and expired tokens are rejected, five wrong guesses lock it for fifteen
minutes, changing the PIN requires the current one, and non-admins never reach
the PIN at all.

**pdf-import.test.js** — supplier-bill line parsing: the skip-list for totals,
GSTIN, bill numbers and address lines; number assignment across the 1/2/3/4
column layouts including this app's own receipt format; names containing
digits; parsed zeros not being rewritten; and that a reprinted receipt carries
the bill's own date rather than today's.

## Browser checks

The separate `phone-billing.browser.cjs` suite checks the phone Sale → Search →
Item editor flow against a local fixture API. It covers customer auto-fill and
balances, draft cancellation, quantity validation, Cash/Credit and partial
payments, failed saves, history edits, Save & New, and desktop isolation. It
does not access the live shop database.

Run it with Playwright available to Node:

```sh
node tests/phone-billing.browser.cjs
```

For an externally installed Playwright package, set `PLAYWRIGHT_MODULE` to its
module path. Optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing
Chromium executable. Screenshots are saved under the system temporary directory
in `medicine-mobile-qa`. Real iPhone keyboard and share-sheet behavior still
needs checking on the device.

## What is NOT covered

The Node-only `*.test.js` suites do not cover browser integration:

- pdf.js loading from the CDN
- `navigator.share` on a phone
- html2pdf rendering
- Any DOM interaction

Changes to those paths still need checking by hand in the app.

## Adding a test

Drop a `*.test.js` file in this folder. `run-all.js` picks it up automatically.
Print `PASS`/`FAIL` at the start of a line and exit non-zero on failure — copy
the `eq()` helper from an existing file.

## New integrity regressions

- `financial-contract.test.js`: real PostgreSQL rollback, receipt replay,
  operation conflicts, opening anchors, archive preservation, and RPC permissions.
- `billing-integrity.test.js` / `api-response.test.js`: receipt isolation,
  decimal boundaries, customer-owned pricing caches, and unconfirmed replies.
- `customers-page.test.js`: stable selection, late response ownership, explicit
  account adjustments, archive/restore, legacy reconciliation and safe retry state.
- `ledger-order.test.js`: microsecond timestamps, durable tie ordering and credits.

Additional browser suites (Playwright and a Chromium executable required):

```sh
node tests/billing-save.browser.cjs
node tests/customers-page.browser.cjs
node tests/profit-owner-range.browser.cjs
```

The first checks draft locks, persisted printing and exact lost-response replay.
The second runs actual browser assets, API handlers and the staged PostgreSQL
RPCs, including the opening200 → debt900 → payment200 → debt700 → next bill →
debt1000 sequence and reload/second-session consistency. Browser suites use only
local test servers. Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE when
using an externally installed Playwright/browser.

The profit browser suite runs the real auth response, profit and PIN handlers
against a local REST fixture. It checks desktop/phone owner navigation, denial
for another admin, inclusive IST dates on a browser in another timezone, invalid
ranges, late responses and server-side locking. Screenshots go to the temporary
`medicine-profit-owner-qa` directory. It does not verify deployed RLS policies.

Profit ownership defaults to the primary admin in `supabase-rbac-setup.sql`.
To use another account, set the server-only `PROFIT_OWNER_EMAIL`; that account
must also have an active admin role. Other admins cannot use the profit or PIN
endpoints. No new SQL migration is needed for this owner/date-range change.
