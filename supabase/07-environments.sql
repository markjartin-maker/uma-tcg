-- =====================================================================
-- Uma TCG — allow the Environment keyword
-- Only needed if you ran schema.sql BEFORE this update.
-- SQL Editor → New query → paste → Run.
-- =====================================================================
alter table public.cards drop constraint if exists cards_keywords_check;
alter table public.cards add constraint cards_keywords_check check (
  keywords <@ array['reaction', 'duel', 'uma-roar', 'in-the-shadows', 'friendship',
                    'interference', 'conjure', 'showboat', 'exhaust', 'environment']
);
