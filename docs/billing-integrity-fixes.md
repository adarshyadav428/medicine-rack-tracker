# Billing integrity fixes

## Faster automatic sync and customer ledger colours — 9 November 2026

Billing and Customers now check automatically every two seconds while visible,
as well as on focus/reconnect. This replaces the previous 15-second interval;
network/server latency still affects arrival time. No refresh click is required.
Only one refresh per page runs at a time. Customer background reads leave
payment controls usable, keep unchanged list/history markup in place, preserve
drafts and invalidate late responses when a financial write starts.

Customer history uses green received amounts/payment rows/debt reductions, red
charges/debt increases, blue credits, and text labels/legend. Payment controls
use green as well. These styles are scoped to Customers. Phone cards now use
Received, Net change, Bill total and Date labels instead of the generic medicine
entry table's Qty/Sell labels. No database migration is required.

## Phone billing control parity — 9 November 2026

Phone billing now has a labeled native saved-customer dropdown, including phone
numbers and current dues/credits, with explicit new-customer selection. Selection
uses the shared desktop customer-change path and survives list refreshes. The
phone also exposes Save customer details without issuing an invoice, and batch
and expiry editing on item entry. Shared commit persists those fields across
devices. Credit balances are valid in the previous-balance field.

Phone item entry checks supported quantity/price precision before committing;
bill submission checks received/previous-balance inputs. Raw received input is
preserved through blur/redraw so invalid negatives cannot silently become zero.
Phone validation messages persist until corrected or a new saved bill is loaded.
Authoritative bill loads refresh focused phone fields as well as the shared
model, while existing dirty-edit guards prevent replacing unsaved work.

Regression browser flows now choose customers through the actual phone dropdown
and exercise phone controls for batch/expiry, validation, new customer saving,
and credit selection against the real API and isolated PostgreSQL.
The dropdown also retains stable account selection on renamed historical bills.
Phone startup no longer focuses the hidden desktop search or jumps down the
page. Verified 43 cross-device checks, the existing phone layout/flow suite
(320–844 pixels), and saved-bill ownership/receipt/retry browser checks locally.

## Customer account sync — 9 November 2026

The billing refresh now refreshes customer profiles and authoritative current
dues as well as invoice history. New-bill carry-forward updates from that cache;
issued bills retain their original previous-balance snapshots. Older customer
responses cannot replace newer cache results; incomplete reads never become an
empty customer list.

Customers refreshes the list, selected profile, bill history and standalone
payments every 15 seconds while visible, on focus/reconnect, and through Refresh
customer accounts. Background reads preserve unsaved contact/payment inputs and
retain the last good history on a failed read. Account selection follows stable
IDs across renames. Financial writes retain their existing concurrency guards.

Review saved browser records is available on the original device for data still
stored only in that browser. It rechecks server balances before offering the
existing guarded reconciliation preview, even if an old import flag is present.
Missing zero-due customer profiles can now be included; a local zero never
clears an existing shared account's debt. Invalid/conflicting amounts remain for
review. The preview requires confirmation because stale browser balances are
not proof of current debt. Browser-only records are not automatically uploaded.

Deploy billing.html/billing.js and customers.html/customers.js together. No new
database migration is needed beyond the existing atomic-ledger migration.
Local verification: 570 assertions in npm test, 34 cross-device browser/API/
PostgreSQL checks, 18 existing customer browser checks, 13 phone flows, and the
saved-receipt/ownership/retry browser checks all passed. Production records were
not changed or reconciled; merge/deployment and live smoke testing remain.

## Saved bills across phone and PC — 9 November 2026

Save a bill on either device, then open Billing → History → Edit on the other
device using an authorized admin session on the same site. Updates target the
same invoice and ledger. Unfinished bills stay on their current device until
Save; this change does not upload unfinished drafts.

History refreshes every 15 seconds while the page is visible, when it regains
focus, on reconnect, and from Refresh saved bills. Opening phone History also
refreshes it. A clean open invoice loads newer saved revisions automatically.
Unsaved fields and open phone item editors are preserved; Load latest saved bill
requires confirmation before discarding edits. Existing database version checks
reject simultaneous stale saves. Failed refreshes retain previously loaded
history and invoice data. Search filters survive refreshes.

Opening a saved bill now restores its saved amount received (including zero),
instead of retaining the previous form's receipt. Cancelling New Bill preserves
the invoice's optimistic version. Read responses cannot overwrite edits made
while a bill was loading or a subsequently selected bill.

No additional database migration is required beyond the atomic ledger migration.
Deploy the matching billing.js and phone-billing.js together with billing.html
and phone-billing.css; the billing script cache versions were updated.

Regression: tests/billing-device-sync.browser.cjs uses independent PC/phone
browser contexts against the actual API handlers and isolated PostgreSQL/PGlite.
Verified: 23 device-sync assertions, the 13 existing phone flows, saved-bill
ownership/receipt/retry browser checks, 18 customer browser/RPC assertions, and
all 563 assertions in npm test passed. These are local results; production
deployment and cross-device production smoke testing remain rollout steps.

This change replaces independent financial REST writes with a transactional database ledger. It also separates editable bill drafts, issued receipts, customer contact details, and explicit account adjustments.

## Rollout requirement

The staged migration is `supabase/migrations/20261108094041_atomic_billing_ledger.sql`. It has not been applied to production. The new financial API intentionally returns `503 FINANCIAL_SCHEMA_REQUIRED` until the database supports the transactional RPCs. It never falls back to the unsafe old write sequence.

Coordinate deployment with a maintenance window: stop existing billing writes, back up and reconcile the current records, apply the reviewed migration, deploy the matching APIs and frontend, verify the full payment sequence, then resume billing. Do not leave old service-role API code writing concurrently with the migrated schema. The migration must reject unsupported legacy data rather than silently reinterpret balances.

Existing inconsistent records require a separate reviewed reconciliation; these code changes do not infer or silently repair historical money. Customer names become aliases of stable account IDs; issued customer names on historical bills remain snapshots. Archiving preserves opening anchors and transactions.

## Finding coverage

| Findings | Implementation |
|---|---|
| F01, F13, F26 | Coherent database-side account reads; incomplete refreshes block saving instead of becoming empty ledgers. |
| F02, F03, F15 | Transactional headers/items/anchors/imports; no post-save fire-and-forget account writes. |
| F04, F05 | Stable account identities, aliases, archive/restore; preserve historical receipt identity. |
| F06 | Legacy balance reconciliation backs existing activity out and checks for conflicts. |
| F07 | Durable operation IDs and exact replay of submitted transactions, including lost-response retries. |
| F08, F17, F22 | Strict decimal precision and bounded input; integer/decimal line and tax calculation; preserve stored receipt values. |
| F09, F29 | Contact saves never implicitly adjust account anchors; manual account corrections use explicit versioned adjustment. Bill snapshot overrides cannot silently alter current debt. |
| F10, F11, F21, F24 | Atomic server-derived repair from the opening anchor; preserve receipt amounts, signed credits, full event ordering, and failure status. |
| F12, F20 | Refresh scoped account/history together and display receipts captured on bills. |
| F14, F18, F19 | Stable selection/request ownership; lock draft mutations during saves; reject late responses. |
| F23, F30 | Historical receipts use saved fields, original issue dates and amounts; blank values never borrow another draft's data. |
| F25 | Durable invoice issuance counters survive deletion. |
| F27, F28 | Customer-owned price cache with retry state; sale chronology comes from issued bills rather than item-edit timestamps. |
| F31 | Shared received-input notifications; responsive rendering cannot manufacture a full payment. |
| F32 | Safe customer-history storage and distinguish post-commit display failures from transaction failures. |

F16 was a deployment-dependent row-cap concern, not another confirmed production incident. Complete invoice reads, database aggregation, and issuance counters remove reliance on a partial REST page for financial replacement or numbering.

## Verification

Run the repository test runner and the phone/save browser suites. Database transaction tests must use the staged migration in isolated PostgreSQL/PGlite, including rollback, exact replay, stale versions, archived/renamed accounts, invalid imports, full invoice loading, and operation permissions. Browser tests cover metadata-only edits after receipts, stale customer responses, explicit balance conflicts, pending-save locks, stored receipt printing, and responsive partial payments.

The automated security scan remains a separate unresolved environment prerequisite. Passing these correctness tests does not establish a complete security clearance.

Legacy limitation: a counter can be seeded only from surviving records. Before rollout, reconcile previously deleted issued references against retained receipts/imports and seed issuance reservations where necessary. Previously lost anchors, wrong-customer receipts and erased item revisions cannot be reconstructed reliably from arithmetic alone.

Retry keys can survive customer-page reloads when browser storage is available. If site storage is unavailable, same-screen in-memory retries remain protected, but recovery after closing/reloading that page cannot be guaranteed; verify the ledger before manually re-entering an uncertain transaction.

Migration preflight intentionally aborts on invalid/fractional legacy bill totals or receipts, invalid standalone receipts/anchors, mismatched customer identity keys, itemless or mathematically inconsistent invoices, and unattributed debts/payments. Review and reconcile those records against verified receipts before retrying the migration. Only derived balance_due is recomputed; canonical charges, money received and opening anchors are not invented or rewritten.

## Final local verification — 9 November 2026

- npm test: 21 files, 563 assertions passed.
- tests/phone-billing.browser.cjs: 13 named phone flows passed; no page errors.
- tests/billing-save.browser.cjs: save ownership lock, authoritative stored printing/date, and lost-response replay passed.
- tests/customers-page.browser.cjs: 18 actual browser/API/PostgreSQL assertions passed, including the full opening200 → debt900 → receipt200 → debt700 → next bill → debt1000 flow and second-context/reload consistency.
- Migration rerun and invalid-data preflight regressions passed in isolated PostgreSQL.
- git diff --check passed (Windows line-ending advisories only).

All verification used local fixtures/embedded PostgreSQL. No production financial records, schema, deployment, or migration state were changed. Existing user HTML/mobile/assets work was retained. The staged database upgrade is required before the new APIs can serve financial operations; the rollout requirement above is intentional and is not a production deployment completion claim.
