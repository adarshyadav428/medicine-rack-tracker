# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Medicine inventory and billing tracker for a medical shop. Vanilla JS frontend, Vercel serverless Node.js backend, Supabase (PostgreSQL) database.

**No build step, no test suite, no linter.** Deploy via Vercel (push to main). Test manually in the browser.

## Development

**Run locally:**
```
npx vercel dev
```
Requires a `.env.local` with the environment variables listed in `.env.example`.

**Deploy:** Push to `main` (Vercel auto-deploys). Preview deployments are created for all branches.

**Environment variables required:**
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_TABLE_NAME` (default: `medicines`), `SUPABASE_ROLE_TABLE` (default: `user_roles`)
- `SUPABASE_ADMIN_EMAILS` — comma-separated admin email list
- `NODE_ENV` — controls cookie `Secure` flag

**Database setup (one-time, Supabase SQL editor):**
1. `supabase-rbac-setup.sql` — creates `user_roles`, RLS helper functions, medicines RLS policies
2. `add-billing-tables.sql` — creates `bills` and `bill_items`
3. Apply any `alter-*.sql` files as schema changes accumulate

## Architecture

### Frontend
Vanilla JS (ES5/ES6), no framework, no bundler. Each HTML page loads shared scripts plus a page-specific module:

| Page | Script | Purpose |
|------|--------|---------|
| `dashboard.html` | `app.js` | Medicine database (add/edit/search/sync) |
| `billing.html` | `billing.js` | Bill creation, line items, history, print |
| `customers.html` | `customers.js` | Customer profiles, balances, payment recording |
| `profit.html` | `profit.js` | PIN-locked profit dashboard |
| `access.html` | `app.js` | Admin user role management |

`app.js` (~62 KB) handles auth, medicine CRUD, localStorage caching, and the `state` global. Page scripts depend on helpers exported/initialised by `app.js` (e.g. `requestApi`, `normalizeString`, `fmtMoney`, `round2`).

`sync-config.js` bootstraps runtime configuration by fetching `/api/supabase-config` before any page script runs.

**Cache-busting:** HTML `<script>` tags use `?v=YYYYMMDD-tag` query strings. Update these when deploying a JS change so browsers pick up the new file.

### Backend
Vercel serverless functions in `/api/`. Shared utilities live in `/lib/supabase-server.js`:
- `requireAuthContext` — validates HTTP-only auth cookies, enforces role (`adminOnly` flag)
- `callSupabaseRest` — wraps PostgREST HTTP calls (GET/POST/PATCH/DELETE)
- `allowMethods`, `sendJson`, `parseJsonBody`, `normalizeString`

**Auth flow:** Login → `/api/auth/login` validates with Supabase, checks `user_roles`, sets HTTP-only cookies. All `/api/auth/*` paths are rewritten to `/api/auth.js` (single function — Vercel Hobby has a 12-function limit). Frontend never sees tokens.

**Role model:**
- `admin` — full access including purchase prices, user management, profit dashboard
- `employee` — medicines visible but `purchase_price` stripped server-side; no billing write access
- `inactive` — rejected at login

Admin emails in `SUPABASE_ADMIN_EMAILS` are auto-promoted to admin role on login.

### Database patterns
- All PKs are UUID (`gen_random_uuid()`), all tables have `created_at`/`updated_at`
- RLS on every table; policies use `is_admin_user()` / `is_active_user()` helper functions
- `medicine_id` on `bill_items` is nullable (medicine may be deleted after billing)
- Bill numbers: `AM-YYYYMMDD-NNN` (sequential per calendar day)
- `bill_items.sort_order` preserves the order medicines were added to a bill

### State management

**Global (`app.js`):**
```
state.items[]          — medicines array (mirrored in localStorage)
state.auth.user        — { id, email, role } or null
state.sync.*           — polling interval, table names
```
Key localStorage: `medicineRackTracker.v1` (medicines), `medicineRackTracker.customers.v1` (customer list, device-local).

**Billing (`billing.js` → `bState`):**
```
bState.lineItems[]              — current bill rows
bState.currentBillId/Number     — null = unsaved new bill
bState.balanceCarriedForward    — true after first save; blocks double carry-forward
bState.editOriginalGrandTotal/Received/PrevBalance — guard deltas on re-save
bState.currentCustomerBalance   — running ledger value shown as "Opening Balance"
```
Per-bill localStorage: `am.billPrev.<id>` (opening balance snapshot), `am.billRecv.<id>` (amount received snapshot). These drive the print receipt; clearing the UI field doesn't affect them.

**Customers (`customers.js` → `cState`):**
```
cState.allBills[]    — lazy-loaded from /api/bills (all customer bills)
cState.allPayments{} — cached { customerName: Payment[] }
```

### PostgREST query syntax (used in all `/api/*.js` files)

Filters are appended as query-string parameters passed to `callSupabaseRest`. Common patterns:

```
column=eq.value          equality
column=not.is.null       IS NOT NULL   ← NOT "not.column=is.null" (causes 400)
column=like.prefix*      LIKE 'prefix%'
column=in.(a,b,c)        IN list
order=col.asc,col2.desc
limit=100
select=col1,col2
```

Prefer-header shortcuts used in this codebase:
- `return=representation` — returns the inserted/updated rows as JSON
- `return=minimal` — returns empty body (faster for bulk ops)
- `resolution=merge-duplicates` — upsert on unique constraint

### Key behaviours to know
- **Saved customers are localStorage-only** (device/browser-specific). "Restore from History" (`/api/bills?customers=1`) re-populates them from Supabase bill history.
- **Payment cascade:** recording a payment in `customers.js` calls `applyPaymentToBills()` which updates `am.billRecv.*` localStorage keys on the oldest unpaid bills — this is what makes the print receipt show the correct received/balance figures.
- **Bill total rounding:** subtotal → add GST → `Math.ceil(round2(...))` for grand total.
- **Employee sanitization** happens server-side in `/api/medicines.js` (strips `purchase_price`, `rate` fields); never rely on frontend role checks for security.
