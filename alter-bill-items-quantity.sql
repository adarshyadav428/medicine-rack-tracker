-- Migration: Change bill_items.quantity from INTEGER to NUMERIC(10,3)
-- Run this in the Supabase SQL Editor.
-- Allows fractional quantities like 0.33 (5 out of 15 tablets).

alter table bill_items
  alter column quantity type numeric(10,3) using quantity::numeric(10,3);
