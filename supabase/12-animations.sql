-- =====================================================================
-- Uma TCG — Animation maker (play animations for cards)
-- Run this once if you set up the database BEFORE this update.
-- (Safe to run more than once.) SQL Editor → New query → paste → Run.
-- =====================================================================
create table if not exists public.animations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  kind text not null check (kind in ('preset', 'code')),
  config jsonb,                                          -- preset settings
  code text check (char_length(code) <= 20000),          -- custom HTML/CSS/JS (runs sandboxed)
  duration numeric not null default 2.5 check (duration between 0.5 and 6),
  created_at timestamptz not null default now()
);
alter table public.animations enable row level security;

drop policy if exists "friends can see animations" on public.animations;
create policy "friends can see animations" on public.animations
  for select using (public.is_allowed());
drop policy if exists "friends can add animations" on public.animations;
create policy "friends can add animations" on public.animations
  for insert with check (public.is_allowed() and owner = auth.uid());
drop policy if exists "edit own animations (admins: any)" on public.animations;
create policy "edit own animations (admins: any)" on public.animations
  for update using (public.is_allowed() and (owner = auth.uid() or public.is_admin()));
drop policy if exists "delete own animations (admins: any)" on public.animations;
create policy "delete own animations (admins: any)" on public.animations
  for delete using (public.is_allowed() and (owner = auth.uid() or public.is_admin()));

-- The animation a card plays when it's played.
alter table public.cards add column if not exists play_anim uuid references public.animations on delete set null;
