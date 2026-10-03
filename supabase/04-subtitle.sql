-- =====================================================================
-- Uma TCG — card subtitles (Champion Umas)
-- Only needed if you ran schema.sql BEFORE this update (new projects
-- already have the column). SQL Editor → New query → paste → Run.
-- =====================================================================
alter table public.cards
  add column if not exists subtitle text check (char_length(subtitle) <= 40);
