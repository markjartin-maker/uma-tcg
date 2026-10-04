-- =====================================================================
-- Uma TCG — allow the Environment keyword
-- Only needed if you ran schema.sql BEFORE this update.
-- (Since the Keyword maker update, cards can use any keyword, so this
-- simply removes the old fixed list.) SQL Editor → New query → paste → Run.
-- =====================================================================
alter table public.cards drop constraint if exists cards_keywords_check;
alter table public.cards add constraint cards_keywords_check check (cardinality(keywords) <= 16);
