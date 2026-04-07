-- Run this in Supabase SQL Editor to enable login-based roles.

-- 1) Ensure the role table exists.
create table if not exists user_roles (
  email text primary key,
  role text not null check (role in ('admin', 'employee')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table user_roles add column if not exists is_active boolean not null default true;

-- Helper functions make policy checks reliable and avoid nested-RLS edge cases.
create or replace function public.current_user_email()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    where lower(ur.email) = public.current_user_email()
      and ur.is_active = true
  );
$$;

create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    where lower(ur.email) = public.current_user_email()
      and ur.role = 'admin'
      and ur.is_active = true
  );
$$;

grant execute on function public.current_user_email() to authenticated, anon;
grant execute on function public.is_active_user() to authenticated, anon;
grant execute on function public.is_admin_user() to authenticated, anon;

-- 2) Bootstrap first admin account.
insert into user_roles (email, role, is_active)
values ('adarshyadavazm123@gmail.com', 'admin', true)
on conflict (email) do update set role = excluded.role, is_active = excluded.is_active;

-- 3) Turn on RLS and remove old open/demo policies.
alter table medicines enable row level security;
alter table user_roles enable row level security;

drop policy if exists allow_all_demo_read on medicines;
drop policy if exists allow_all_demo_insert on medicines;
drop policy if exists allow_all_demo_update on medicines;
drop policy if exists allow_all_demo_delete on medicines;

drop policy if exists medicines_select_authenticated on medicines;
drop policy if exists medicines_insert_authenticated on medicines;
drop policy if exists medicines_update_authenticated on medicines;
drop policy if exists medicines_delete_admin_only on medicines;
drop policy if exists medicines_insert_admin_only on medicines;
drop policy if exists medicines_update_admin_only on medicines;

drop policy if exists user_roles_select_self_or_admin on user_roles;
drop policy if exists user_roles_insert_admin_only on user_roles;
drop policy if exists user_roles_update_admin_only on user_roles;
drop policy if exists user_roles_delete_admin_only on user_roles;

-- 4) Medicines policies.
create policy medicines_select_authenticated
on medicines for select
to authenticated
using (public.is_active_user());

create policy medicines_insert_admin_only
on medicines for insert
to authenticated
with check (public.is_admin_user());

create policy medicines_update_admin_only
on medicines for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

create policy medicines_delete_admin_only
on medicines for delete
to authenticated
using (public.is_admin_user());

-- 5) User role policies.
create policy user_roles_select_self_or_admin
on user_roles for select
to authenticated
using (
  lower(email) = public.current_user_email()
  or public.is_admin_user()
);

create policy user_roles_insert_admin_only
on user_roles for insert
to authenticated
with check (public.is_admin_user());

create policy user_roles_update_admin_only
on user_roles for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

create policy user_roles_delete_admin_only
on user_roles for delete
to authenticated
using (public.is_admin_user());
