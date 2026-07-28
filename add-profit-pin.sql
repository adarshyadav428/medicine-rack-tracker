-- Profit PIN moves out of the browser and into the database.
--
-- Until now the PIN hash lived in localStorage, so it only guarded the profit
-- page in one browser: opening the app anywhere else offered to set a fresh
-- PIN. The hash now lives here and is checked on the server, and /api/profit
-- refuses to return figures without a valid unlock.
--
-- Run this once in the Supabase SQL editor.

create table if not exists app_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now()
);

alter table app_settings enable row level security;

-- Deliberately no policies. Every read and write goes through the server,
-- which uses the service-role key and bypasses RLS. Anon and logged-in
-- browser clients cannot touch this table at all, so the PIN hash and the
-- lockout counters are never exposed to the front end.

revoke all on app_settings from anon, authenticated;
