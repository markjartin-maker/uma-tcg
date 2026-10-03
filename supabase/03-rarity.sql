-- =====================================================================
-- Uma TCG — card rarity + full-art frame
-- Only needed if you ran schema.sql BEFORE this update (new projects
-- already have these columns). SQL Editor → New query → paste → Run.
-- =====================================================================
alter table public.cards
  add column if not exists rarity text not null default 'common',
  add column if not exists full_art boolean not null default false;

alter table public.cards drop constraint if exists cards_rarity_check;
alter table public.cards add constraint cards_rarity_check
  check (rarity in ('common', 'uncommon', 'rare', 'epic', 'signature'));
