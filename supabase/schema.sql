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
  -- built-in keyword ids, plus "x-…" ids from the Keyword maker
  keywords text[] not null default '{}' constraint cards_keywords_check check (cardinality(keywords) <= 16),
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

-- Custom keywords from the Keyword maker (cards store their "x-…" slug).
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

-- Play animations from the Animation maker (cards point to one).
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

-- Card code: rules written on cards in the small card language (see README).
alter table public.cards add column if not exists code text;
alter table public.cards drop constraint if exists cards_code_length;
alter table public.cards add constraint cards_code_length check (code is null or char_length(code) <= 4000);

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
alter table public.cards drop constraint if exists cards_keywords_check;
alter table public.cards add constraint cards_keywords_check check (cardinality(keywords) <= 16);
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
-- 7b. 1v1v1 / 1v1v1v1: rooms and matches with 3–4 players
-- ---------------------------------------------------------------------
-- Matches can have 3–4 players: everyone is listed in "players".
alter table public.matches add column if not exists players uuid[];
update public.matches set players = array[p1, p2] where players is null;

drop policy if exists "players see their matches" on public.matches;
create policy "players see their matches" on public.matches
  for select using (public.is_allowed() and (auth.uid() in (p1, p2) or auth.uid() = any(coalesce(players, '{}'))));
drop policy if exists "players create their matches" on public.matches;
create policy "players create their matches" on public.matches
  for insert with check (public.is_allowed() and (auth.uid() in (p1, p2) or auth.uid() = any(coalesce(players, '{}'))));
drop policy if exists "players update their matches" on public.matches;
create policy "players update their matches" on public.matches
  for update using (public.is_allowed() and (auth.uid() in (p1, p2) or auth.uid() = any(coalesce(players, '{}'))));

drop policy if exists "players see match cards" on public.match_defs;
create policy "players see match cards" on public.match_defs
  for select using (
    public.is_allowed() and exists (
      select 1 from public.matches m
      where m.id = match_id and (auth.uid() in (m.p1, m.p2) or auth.uid() = any(coalesce(m.players, '{}')))
    )
  );
drop policy if exists "players add match cards" on public.match_defs;
create policy "players add match cards" on public.match_defs
  for insert with check (
    public.is_allowed() and exists (
      select 1 from public.matches m
      where m.id = match_id and (auth.uid() in (m.p1, m.p2) or auth.uid() = any(coalesce(m.players, '{}')))
    )
  );

-- Lobby rooms for 1v1v1 (size 3) and 1v1v1v1 (size 4).
--   members = [{"user": "<id>", "deck": "<deck id>"}, ...] in seat order
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  host uuid not null default auth.uid() references auth.users on delete cascade,
  size int not null check (size between 3 and 4),
  members jsonb not null default '[]',
  status text not null default 'open' check (status in ('open', 'started', 'cancelled')),
  match_id uuid,
  created_at timestamptz not null default now()
);
alter table public.rooms enable row level security;

drop policy if exists "friends can see rooms" on public.rooms;
create policy "friends can see rooms" on public.rooms
  for select using (public.is_allowed());
drop policy if exists "open a room" on public.rooms;
create policy "open a room" on public.rooms
  for insert with check (public.is_allowed() and host = auth.uid());
drop policy if exists "host or members update a room" on public.rooms;
create policy "host or members update a room" on public.rooms
  for update using (public.is_allowed() and (host = auth.uid()
    or members @> jsonb_build_array(jsonb_build_object('user', auth.uid()))));

-- Joining and leaving go through these, so nobody can edit other seats.
create or replace function public.join_room(room uuid, deck uuid)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare r public.rooms;
begin
  if not public.is_allowed() then raise exception 'You are not on the friends list.'; end if;
  select * into r from public.rooms where id = room for update;
  if not found or r.status <> 'open' then raise exception 'That room is no longer open.'; end if;
  if exists (select 1 from jsonb_array_elements(r.members) e where e->>'user' = auth.uid()::text) then return r; end if;
  if jsonb_array_length(r.members) >= r.size then raise exception 'That room is full.'; end if;
  if not exists (select 1 from public.decks d where d.id = deck and d.owner = auth.uid()) then raise exception 'Pick one of your own decks.'; end if;
  update public.rooms
    set members = members || jsonb_build_array(jsonb_build_object('user', auth.uid(), 'deck', deck))
    where id = room returning * into r;
  return r;
end $$;

create or replace function public.leave_room(room uuid)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare r public.rooms;
begin
  select * into r from public.rooms where id = room for update;
  if not found or r.status <> 'open' then return r; end if;
  if r.host = auth.uid() then
    update public.rooms set status = 'cancelled' where id = room returning * into r;
  else
    update public.rooms
      set members = coalesce((select jsonb_agg(e) from jsonb_array_elements(r.members) e where e->>'user' <> auth.uid()::text), '[]'::jsonb)
      where id = room returning * into r;
  end if;
  return r;
end $$;

grant execute on function public.join_room(uuid, uuid) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rooms') then
    alter publication supabase_realtime add table public.rooms;
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
-- 8b. Admin panel settings (sounds, card back) and the sounds bucket
-- ---------------------------------------------------------------------
-- Site-wide settings that admins choose (sounds, the card back image).
create table if not exists public.app_settings (
  key text primary key check (char_length(key) between 1 and 40),
  value jsonb not null default '{}'::jsonb,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;

drop policy if exists "friends can read settings" on public.app_settings;
create policy "friends can read settings" on public.app_settings
  for select using (public.is_allowed());
drop policy if exists "admins can add settings" on public.app_settings;
create policy "admins can add settings" on public.app_settings
  for insert with check (public.is_admin());
drop policy if exists "admins can change settings" on public.app_settings;
create policy "admins can change settings" on public.app_settings
  for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins can delete settings" on public.app_settings;
create policy "admins can delete settings" on public.app_settings
  for delete using (public.is_admin());

-- Sound files (for the admin panel and for animations).
-- Public bucket like card art; friends upload into their own folder.
-- Audio only, max 5 MB — enforced by Supabase, not the website.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sounds', 'sounds', true, 5242880,
        array['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave',
              'audio/webm', 'audio/mp4', 'audio/aac', 'audio/x-m4a'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "friends upload sounds" on storage.objects;
create policy "friends upload sounds" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'sounds'
    and public.is_allowed()
    and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "friends delete own sounds" on storage.objects;
create policy "friends delete own sounds" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'sounds'
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
