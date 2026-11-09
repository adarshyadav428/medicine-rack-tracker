# Billing integrity fixes

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
