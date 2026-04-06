-- Run this in Supabase SQL Editor to enable login-based roles.

-- 1) Ensure the role table exists.
create table if not exists user_roles (
  email text primary key,
  role text not null check (role in ('admin', 'employee')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2) Bootstrap first admin account.
insert into user_roles (email, role)
values ('adarshyadavazm123@gmail.com', 'admin')
on conflict (email) do update set role = excluded.role;

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

drop policy if exists user_roles_select_self_or_admin on user_roles;
drop policy if exists user_roles_insert_admin_only on user_roles;
drop policy if exists user_roles_update_admin_only on user_roles;
drop policy if exists user_roles_delete_admin_only on user_roles;

-- 4) Medicines policies.
create policy medicines_select_authenticated
on medicines for select
to authenticated
using (true);

create policy medicines_insert_authenticated
on medicines for insert
to authenticated
with check (true);

create policy medicines_update_authenticated
on medicines for update
to authenticated
using (true)
with check (true);

create policy medicines_delete_admin_only
on medicines for delete
to authenticated
using (
  exists (
    select 1 from user_roles ur
    where ur.email = lower(auth.jwt() ->> 'email')
      and ur.role = 'admin'
  )
);

-- 5) User role policies.
create policy user_roles_select_self_or_admin
on user_roles for select
to authenticated
using (
  lower(email) = lower(auth.jwt() ->> 'email')
  or exists (
    select 1 from user_roles ur
    where ur.email = lower(auth.jwt() ->> 'email')
      and ur.role = 'admin'
  )
);

create policy user_roles_insert_admin_only
on user_roles for insert
to authenticated
with check (
  exists (
    select 1 from user_roles ur
    where ur.email = lower(auth.jwt() ->> 'email')
      and ur.role = 'admin'
  )
);

create policy user_roles_update_admin_only
on user_roles for update
to authenticated
using (
  exists (
    select 1 from user_roles ur
    where ur.email = lower(auth.jwt() ->> 'email')
      and ur.role = 'admin'
  )
)
with check (
  exists (
    select 1 from user_roles ur
    where ur.email = lower(auth.jwt() ->> 'email')
      and ur.role = 'admin'
  )
);

create policy user_roles_delete_admin_only
on user_roles for delete
to authenticated
using (
  exists (
    select 1 from user_roles ur
    where ur.email = lower(auth.jwt() ->> 'email')
      and ur.role = 'admin'
  )
);
