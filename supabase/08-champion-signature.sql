-- =====================================================================
-- Uma TCG — Champion slot + Signature cards
-- Run this once if you set up the database BEFORE this update.
-- (Safe to run more than once.) SQL Editor → New query → paste → Run.
-- =====================================================================
alter table public.cards
  add column if not exists signature_of uuid references public.cards on delete set null;
alter table public.decks
  add column if not exists champion_id uuid references public.cards on delete set null;
