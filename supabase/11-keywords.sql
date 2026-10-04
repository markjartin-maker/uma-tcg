-- =====================================================================
-- Uma TCG — Keyword maker
-- Run this once if you set up the database BEFORE this update.
-- (Safe to run more than once.) SQL Editor → New query → paste → Run.
-- =====================================================================
-- Cards may now use custom keywords (their ids start with "x-").
alter table public.cards drop constraint if exists cards_keywords_check;
alter table public.cards add constraint cards_keywords_check check (cardinality(keywords) <= 16);

create table if not exists public.keywords (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  slug text not null unique check (slug ~ '^x-[a-z0-9]{1,30}$'),
  label text not null check (char_length(label) between 1 and 24),
  help text not null default '' check (char_length(help) <= 200),
  color text not null default 'effect' check (color in ('timing', 'place', 'effect') or color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now()
);
alter table public.keywords enable row level security;

drop policy if exists "friends can see keywords" on public.keywords;
create policy "friends can see keywords" on public.keywords
  for select using (public.is_allowed());
drop policy if exists "friends can add keywords" on public.keywords;
create policy "friends can add keywords" on public.keywords
  for insert with check (public.is_allowed() and owner = auth.uid());
drop policy if exists "edit own keywords (admins: any)" on public.keywords;
create policy "edit own keywords (admins: any)" on public.keywords
  for update using (public.is_allowed() and (owner = auth.uid() or public.is_admin()));
drop policy if exists "delete own keywords (admins: any)" on public.keywords;
create policy "delete own keywords (admins: any)" on public.keywords
  for delete using (public.is_allowed() and (owner = auth.uid() or public.is_admin()));
