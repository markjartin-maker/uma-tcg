-- =====================================================================
-- Uma TCG — tokens you make in the card maker
-- Run this once if you set up the database BEFORE this update.
-- (Safe to run more than once.) SQL Editor → New query → paste → Run.
-- =====================================================================
alter table public.cards
  add column if not exists is_token boolean not null default false;

-- Tokens may have no type (like the built-in Racer and Carrot).
alter table public.cards drop constraint if exists type_count;
alter table public.cards add constraint type_count check (
  (card_type = 'superhorse' and cardinality(types) = 2)
  or (card_type <> 'superhorse' and cardinality(types) between 1 and 2)
  or (is_token and card_type <> 'superhorse' and cardinality(types) <= 2)
);
