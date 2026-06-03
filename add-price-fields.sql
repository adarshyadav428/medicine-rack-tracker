-- Run this in Supabase SQL Editor to add price fields to your medicines table.
-- This is safe to run even if you already have medicines saved.

alter table medicines
  add column if not exists sell_price numeric(10, 2),
  add column if not exists mrp        numeric(10, 2),
  add column if not exists rate       numeric(10, 2),
  add column if not exists discount   numeric(5, 2),
  add column if not exists seller     text not null default '';
