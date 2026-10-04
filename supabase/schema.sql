-- =====================================================================
-- Uma TCG — Supabase setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run again: it won't duplicate anything or delete your data.
-- (Add your emails in a SEPARATE query — see section 9 at the bottom.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The friends whitelist
--    Only emails in this table can see or change anything.
--    Add friends with:
--      insert into public.allowed_emails (email) values ('friend@example.com');
-- ---------------------------------------------------------------------
create table if not exists public.allowed_emails (
  email text primary key
);
alter table public.allowed_emails enable row level security;
-- (No policies on purpose: nobody can read or edit the list from the website.
--  You manage it from the Supabase dashboard.)

create or replace function public.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_emails a
    where lower(a.email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- ---------------------------------------------------------------------
-- Admins: can edit or delete ANY card (for balancing). Friends can still
-- only edit their own. Add yourself with:
--   insert into public.admin_emails (email) values ('you@example.com');
-- ---------------------------------------------------------------------
create table if not exists public.admin_emails (
  email text primary key
);
alter table public.admin_emails enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_emails a
    where lower(a.email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- ---------------------------------------------------------------------
-- 2. Player profiles (display names)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 32),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "friends can see profiles" on public.profiles;
create policy "friends can see profiles" on public.profiles
  for select using (public.is_allowed());
drop policy if exists "create own profile" on public.profiles;
create policy "create own profile" on public.profiles
  for insert with check (public.is_allowed() and id = auth.uid());
drop policy if exists "edit own profile" on public.profiles;
create policy "edit own profile" on public.profiles
  for update using (public.is_allowed() and id = auth.uid());

-- ---------------------------------------------------------------------
-- 3. Cards (the shared card pool everyone builds from)
--    The CHECK constraints are the server-side validation:
--    a broken or out-of-range card is rejected by the database itself.
-- ---------------------------------------------------------------------
create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  card_type text not null check (card_type in ('uma', 'trick', 'trainer', 'superhorse')),
  types text[] not null check (
    types <@ array['speed', 'stamina', 'power', 'guts', 'wit']
  ),
  energy int not null default 0 check (energy between 0 and 15),
  power int not null default 0 check (power between 0 and 15),
  might int check (might between 0 and 99),
  keywords text[] not null default '{}' check (
    keywords <@ array['reaction', 'duel', 'uma-roar', 'in-the-shadows', 'friendship',
                      'interference', 'conjure', 'showboat', 'exhaust', 'environment']
  ),
  effect text not null default '' check (char_length(effect) <= 500),
  rarity text not null default 'common' check (rarity in ('common', 'uncommon', 'rare', 'epic', 'signature')),
  full_art boolean not null default false,
  subtitle text check (char_length(subtitle) <= 40),
  tags text[] not null default '{}' check (cardinality(tags) <= 6),
  conjure jsonb,  -- Conjure filter settings (see js/cards.js)
  signature_of uuid references public.cards on delete set null, -- Signature card of this Superhorse
  is_token boolean not null default false, -- made during play, never in decks
  image_url text,
  created_at timestamptz not null default now(),
  -- Superhorse leaders have exactly 2 types; other cards have 1 or 2.
  -- (Tokens may have no type.)
  constraint type_count check (
    (card_type = 'superhorse' and cardinality(types) = 2)
    or (card_type <> 'superhorse' and cardinality(types) between 1 and 2)
    or (is_token and card_type <> 'superhorse' and cardinality(types) <= 2)
  )
);
alter table public.cards enable row level security;

drop policy if exists "friends can see cards" on public.cards;
create policy "friends can see cards" on public.cards
  for select using (public.is_allowed());
drop policy if exists "friends can add cards" on public.cards;
create policy "friends can add cards" on public.cards
  for insert with check (public.is_allowed() and owner = auth.uid());
drop policy if exists "edit own cards (admins: any)" on public.cards;
create policy "edit own cards (admins: any)" on public.cards
  for update using (public.is_allowed() and (owner = auth.uid() or public.is_admin()));
drop policy if exists "delete own cards (admins: any)" on public.cards;
create policy "delete own cards (admins: any)" on public.cards
  for delete using (public.is_allowed() and (owner = auth.uid() or public.is_admin()));

-- ---------------------------------------------------------------------
-- 4. Decks
--    cards: {"<card id>": copies, ...}   stars: {"speed": 6, "wit": 6}
--    Friends can read each other's decks (needed to start a match).
-- ---------------------------------------------------------------------
create table if not exists public.decks (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  leader_id uuid references public.cards on delete set null,
  champion_id uuid references public.cards on delete set null, -- the deck's Champion Uma
  sleeve jsonb, -- card sleeve: {"image_url": "...", "border": "gold"}
  cards jsonb not null default '{}',
  stars jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.decks enable row level security;

-- Columns added in later updates (safe to re-run).
alter table public.cards add column if not exists signature_of uuid references public.cards on delete set null;
alter table public.decks add column if not exists champion_id uuid references public.cards on delete set null;
alter table public.cards add column if not exists is_token boolean not null default false;
alter table public.decks add column if not exists sleeve jsonb;
alter table public.cards drop constraint if exists type_count;
alter table public.cards add constraint type_count check (
  (card_type = 'superhorse' and cardinality(types) = 2)
  or (card_type <> 'superhorse' and cardinality(types) between 1 and 2)
  or (is_token and card_type <> 'superhorse' and cardinality(types) <= 2)
);

drop policy if exists "friends can see decks" on public.decks;
create policy "friends can see decks" on public.decks
  for select using (public.is_allowed());
drop policy if exists "add own decks" on public.decks;
create policy "add own decks" on public.decks
  for insert with check (public.is_allowed() and owner = auth.uid());
drop policy if exists "edit own decks" on public.decks;
create policy "edit own decks" on public.decks
  for update using (public.is_allowed() and owner = auth.uid());
drop policy if exists "delete own decks" on public.decks;
create policy "delete own decks" on public.decks
  for delete using (public.is_allowed() and owner = auth.uid());

-- ---------------------------------------------------------------------
-- 5. Challenges
-- ---------------------------------------------------------------------
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null default auth.uid() references auth.users on delete cascade,
  to_user uuid not null references auth.users on delete cascade,
  from_deck uuid not null references public.decks on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  match_id uuid,
  created_at timestamptz not null default now()
);
alter table public.challenges enable row level security;

drop policy if exists "see my challenges" on public.challenges;
create policy "see my challenges" on public.challenges
  for select using (public.is_allowed() and auth.uid() in (from_user, to_user));
drop policy if exists "send challenges" on public.challenges;
create policy "send challenges" on public.challenges
  for insert with check (public.is_allowed() and from_user = auth.uid() and to_user <> auth.uid());
drop policy if exists "answer or cancel my challenges" on public.challenges;
create policy "answer or cancel my challenges" on public.challenges
  for update using (public.is_allowed() and auth.uid() in (from_user, to_user));

-- ---------------------------------------------------------------------
-- 6. Matches
--    state   = the whole table (cards, zones, counters, phase, log)
--    version = bumped on every change so two clicks can't overwrite each other
--    The card definitions are stored once per match in match_defs, so every
--    live update only carries the (small) table state.
-- ---------------------------------------------------------------------
create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  p1 uuid not null references auth.users on delete cascade,
  p2 uuid not null references auth.users on delete cascade,
  state jsonb not null,
  version int not null default 0,
  status text not null default 'active' check (status in ('active', 'finished')),
  updated_at timestamptz not null default now()
);
alter table public.matches enable row level security;

drop policy if exists "players see their matches" on public.matches;
create policy "players see their matches" on public.matches
  for select using (public.is_allowed() and auth.uid() in (p1, p2));
drop policy if exists "players create their matches" on public.matches;
create policy "players create their matches" on public.matches
  for insert with check (public.is_allowed() and auth.uid() in (p1, p2));
drop policy if exists "players update their matches" on public.matches;
create policy "players update their matches" on public.matches
  for update using (public.is_allowed() and auth.uid() in (p1, p2));

create table if not exists public.match_defs (
  match_id uuid primary key references public.matches on delete cascade,
  defs jsonb not null
);
alter table public.match_defs enable row level security;

drop policy if exists "players see match cards" on public.match_defs;
create policy "players see match cards" on public.match_defs
  for select using (
    public.is_allowed() and exists (
      select 1 from public.matches m
      where m.id = match_id and auth.uid() in (m.p1, m.p2)
    )
  );
drop policy if exists "players add match cards" on public.match_defs;
create policy "players add match cards" on public.match_defs
  for insert with check (
    public.is_allowed() and exists (
      select 1 from public.matches m
      where m.id = match_id and auth.uid() in (m.p1, m.p2)
    )
  );

-- ---------------------------------------------------------------------
-- 7. Live updates (challenges popping up, moves appearing instantly)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'challenges') then
    alter publication supabase_realtime add table public.challenges;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'matches') then
    alter publication supabase_realtime add table public.matches;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 8. Card art storage
--    Public bucket (anyone with an image's exact link can view it),
--    but only whitelisted friends can upload, into their own folder.
--    Images only, max 2 MB — enforced by Supabase, not the website.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('card-art', 'card-art', true, 2097152,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

drop policy if exists "friends upload card art" on storage.objects;
create policy "friends upload card art" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'card-art'
    and public.is_allowed()
    and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "friends delete own card art" on storage.objects;
create policy "friends delete own card art" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'card-art'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------
-- 9. Add yourself and your friends (edit these emails, then run)
-- ---------------------------------------------------------------------
-- Run these in a NEW query (not as part of this file):
--
-- insert into public.allowed_emails (email) values
--   ('you@example.com'),
--   ('friend1@example.com')
-- on conflict do nothing;
--
-- insert into public.admin_emails (email) values ('you@example.com')
-- on conflict do nothing;
