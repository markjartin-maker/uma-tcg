-- =====================================================================
-- Uma TCG — running-style tags + Conjure settings
-- Only needed if you ran schema.sql BEFORE this update (new projects
-- already have these columns). SQL Editor → New query → paste → Run.
-- =====================================================================
alter table public.cards
  add column if not exists tags text[] not null default '{}' check (cardinality(tags) <= 6),
  add column if not exists conjure jsonb;
