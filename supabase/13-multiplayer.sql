-- =====================================================================
-- Uma TCG — 1v1v1 and 1v1v1v1 (lobby rooms + matches with 3–4 players)
-- Run this once if you set up the database BEFORE this update.
-- (Safe to run more than once.) SQL Editor → New query → paste → Run.
-- =====================================================================
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
