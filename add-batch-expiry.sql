-- Migration: record batch number and expiry against each bill line.
-- Run this in the Supabase SQL Editor.
--
-- Drug Rules require a retailer to be able to trace which batch of a medicine
-- went to which customer on a recall, and near-expiry returns are a routine
-- counter argument. Neither was captured anywhere before this.
--
-- expiry is TEXT, not DATE, on purpose: a strip is printed "11/27", so a DATE
-- column would force a day-of-month that nobody actually knows. What was read
-- off the pack is stored exactly as read.

alter table bill_items
  add column if not exists batch_no text,
  add column if not exists expiry   text;

-- Recall lookup: "which bills carried batch X of medicine Y".
create index if not exists bill_items_batch_no_idx
  on bill_items (batch_no)
  where batch_no is not null;
