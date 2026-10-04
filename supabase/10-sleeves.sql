-- =====================================================================
-- Uma TCG — card sleeves (per deck)
-- Run this once if you set up the database BEFORE this update.
-- (Safe to run more than once.) SQL Editor → New query → paste → Run.
-- =====================================================================
alter table public.decks add column if not exists sleeve jsonb;
