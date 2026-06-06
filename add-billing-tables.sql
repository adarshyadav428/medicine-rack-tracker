-- ============================================================
-- Billing Tables Migration — Adarsh Medicals
-- Run this in Supabase SQL Editor AFTER running supabase-rbac-setup.sql
-- ============================================================

-- 1) Bills (header) table
create table if not exists bills (
  id             uuid          primary key default gen_random_uuid(),
  bill_number    text          not null unique,
  customer_name  text          not null default '',
  customer_phone text          not null default '',
  subtotal       numeric(10,2) not null default 0,
  gst_percent    numeric(5,2)  not null default 0,
  gst_amount     numeric(10,2) not null default 0,
  grand_total    numeric(10,2) not null default 0,
  notes          text          not null default '',
  created_by     text          not null,
  created_at     timestamptz   not null default now(),
  updated_at     timestamptz   not null default now()
);

-- 2) Bill line-items table
create table if not exists bill_items (
  id             uuid          primary key default gen_random_uuid(),
  bill_id        uuid          not null references bills(id) on delete cascade,
  medicine_id    uuid,
  medicine_name  text          not null,
  location       text          not null default '',
  quantity       numeric(10,3) not null default 1,
  mrp            numeric(10,2),
  purchase_price numeric(10,2),
  sell_price     numeric(10,2) not null,
  markup_percent numeric(6,2),
  line_total     numeric(10,2) not null,
  created_at     timestamptz   not null default now()
);

-- 3) Enable RLS
alter table bills       enable row level security;
alter table bill_items  enable row level security;

-- 4) Drop old policies if they exist (safe re-run)
drop policy if exists bills_select_admin        on bills;
drop policy if exists bills_insert_admin        on bills;
drop policy if exists bills_update_admin        on bills;
drop policy if exists bills_delete_admin        on bills;
drop policy if exists bill_items_select_admin   on bill_items;
drop policy if exists bill_items_insert_admin   on bill_items;
drop policy if exists bill_items_update_admin   on bill_items;
drop policy if exists bill_items_delete_admin   on bill_items;

-- 5) Bills policies — admin only
create policy bills_select_admin
  on bills for select
  to authenticated
  using (public.is_admin_user());

create policy bills_insert_admin
  on bills for insert
  to authenticated
  with check (public.is_admin_user());

create policy bills_update_admin
  on bills for update
  to authenticated
  using (public.is_admin_user())
  with check (public.is_admin_user());

create policy bills_delete_admin
  on bills for delete
  to authenticated
  using (public.is_admin_user());

-- 6) Bill items policies — admin only (cascade follows bill)
create policy bill_items_select_admin
  on bill_items for select
  to authenticated
  using (public.is_admin_user());

create policy bill_items_insert_admin
  on bill_items for insert
  to authenticated
  with check (public.is_admin_user());

create policy bill_items_update_admin
  on bill_items for update
  to authenticated
  using (public.is_admin_user())
  with check (public.is_admin_user());

create policy bill_items_delete_admin
  on bill_items for delete
  to authenticated
  using (public.is_admin_user());
