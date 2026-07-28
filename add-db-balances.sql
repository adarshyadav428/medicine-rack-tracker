-- ============================================================
-- Database-backed customer balances — Adarsh Medicals
-- Run in Supabase SQL Editor AFTER add-billing-tables.sql
--
-- Moves customer balances out of browser localStorage and into Postgres, so
-- they are the same on every device and survive clearing site data.
--
-- Replaces:
--   localStorage "am.billPrev.<bill id>"          -> bills.previous_balance
--   localStorage "am.billRecv.<bill id>"          -> bills.amount_received
--   localStorage "medicineRackTracker.customers.v1" -> the customers table
--
-- A customer's balance is DERIVED, never stored as a running total:
--
--   balance = customers.opening_balance
--           + Σ (bill grand_total - bill amount_received)
--           - Σ (standalone payments)
--
-- so editing or deleting any bill or payment corrects it immediately.
-- ============================================================

-- 1) Per-bill payment columns -------------------------------------------------

alter table bills
  add column if not exists previous_balance numeric(10,2) not null default 0,
  add column if not exists amount_received  numeric(10,2) not null default 0,
  add column if not exists balance_due      numeric(10,2) not null default 0;

create index if not exists bills_customer_name_idx
  on bills (lower(btrim(customer_name)));

-- 2) Saved customers ----------------------------------------------------------

create table if not exists customers (
  id              uuid          primary key default gen_random_uuid(),
  name            text          not null,
  -- lower(trim(name)) — the identity used to match bills and payments, which
  -- both key off customer_name. Unique so a customer can never be duplicated.
  name_key        text          not null unique,
  phone           text          not null default '',
  -- What they owed before their first bill in this system. This is the anchor
  -- the running balance is chained from.
  opening_balance numeric(10,2) not null default 0,
  created_by      text          not null default '',
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

alter table customers enable row level security;

drop policy if exists customers_select_admin on customers;
drop policy if exists customers_insert_admin on customers;
drop policy if exists customers_update_admin on customers;
drop policy if exists customers_delete_admin on customers;

create policy customers_select_admin
  on customers for select to authenticated
  using (public.is_admin_user());

create policy customers_insert_admin
  on customers for insert to authenticated
  with check (public.is_admin_user());

create policy customers_update_admin
  on customers for update to authenticated
  using (public.is_admin_user()) with check (public.is_admin_user());

create policy customers_delete_admin
  on customers for delete to authenticated
  using (public.is_admin_user());

-- 3) Seed the customer list from existing bill history ------------------------
-- Opening balances stay 0 here. Real opening balances come from the one-time
-- import of your existing localStorage data (the "Import Local Balances"
-- button on the Customers page), or can be typed in per customer.

insert into customers (name, name_key, phone, created_by)
select distinct on (lower(btrim(b.customer_name)))
       btrim(b.customer_name),
       lower(btrim(b.customer_name)),
       coalesce(b.customer_phone, ''),
       'seed'
from bills b
where btrim(coalesce(b.customer_name, '')) <> ''
order by lower(btrim(b.customer_name)), b.created_at desc
on conflict (name_key) do nothing;
