-- =====================================================================
-- Uma TCG — Card code (rules written on cards, run by the table)
-- Run this once if you set up the database BEFORE this update.
-- (Safe to run more than once.) SQL Editor → New query → paste → Run.
-- =====================================================================
alter table public.cards add column if not exists code text;
alter table public.cards drop constraint if exists cards_code_length;
alter table public.cards add constraint cards_code_length check (code is null or char_length(code) <= 4000);
