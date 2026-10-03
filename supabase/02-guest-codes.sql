-- =====================================================================
-- Uma TCG — guest codes (play without an email)
-- Run this AFTER schema.sql: SQL Editor → New query → paste → Run.
-- Also turn on: Authentication → Sign In / Providers → "Allow anonymous sign-ins".
--
-- How it works:
--   1. A signed-in player makes a code in the lobby and picks a preset deck.
--   2. The guest enters the code + a name. They're signed in anonymously,
--      redeem_invite() checks the code, adds them to the friends list,
--      gives them a copy of the preset deck, and creates a challenge from
--      the host, which the guest's browser accepts right away.
--   Codes work once and expire after 24 hours.
-- =====================================================================

-- Guests are whitelisted by account id instead of email.
create table if not exists public.allowed_users (
  user_id uuid primary key references auth.users on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.allowed_users enable row level security;
-- (No policies: only redeem_invite() and the dashboard can touch it.)

-- Friends = whitelisted email OR redeemed guest account.
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
  ) or exists (
    select 1 from public.allowed_users u where u.user_id = auth.uid()
  );
$$;

create table if not exists public.invites (
  code text primary key check (code ~ '^[A-Z0-9]{8}$'),
  host uuid not null default auth.uid() references auth.users on delete cascade,
  host_deck uuid not null references public.decks on delete cascade,
  guest_deck uuid not null references public.decks on delete cascade,
  used_by uuid references auth.users on delete set null,
  expires_at timestamptz not null default now() + interval '24 hours',
  created_at timestamptz not null default now()
);
alter table public.invites enable row level security;

create policy "see my invites" on public.invites
  for select using (public.is_allowed() and host = auth.uid());
create policy "make invites" on public.invites
  for insert with check (public.is_allowed() and host = auth.uid());
create policy "delete my invites" on public.invites
  for delete using (host = auth.uid());

-- Called by the guest's browser right after anonymous sign-in.
create or replace function public.redeem_invite(p_code text, p_name text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  inv public.invites;
  new_deck uuid;
  ch uuid;
  clean text := regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g');
begin
  if uid is null then
    raise exception 'Sign-in failed. Try again.';
  end if;

  select * into inv from public.invites where code = clean for update;
  if not found then
    raise exception 'That code doesn''t exist. Check for typos.';
  end if;
  if inv.used_by is not null then
    raise exception 'That code was already used. Ask for a new one.';
  end if;
  if inv.expires_at < now() then
    raise exception 'That code has expired. Ask for a new one.';
  end if;
  if inv.host = uid then
    raise exception 'You can''t use your own code.';
  end if;

  update public.invites set used_by = uid where code = clean;

  insert into public.allowed_users (user_id) values (uid) on conflict do nothing;

  insert into public.profiles (id, display_name)
  values (uid, left(coalesce(nullif(trim(p_name), ''), 'Guest'), 32))
  on conflict (id) do update set display_name = excluded.display_name;

  insert into public.decks (owner, name, leader_id, cards, stars)
  select uid, d.name, d.leader_id, d.cards, d.stars
  from public.decks d where d.id = inv.guest_deck
  returning id into new_deck;
  if new_deck is null then
    raise exception 'The preset deck was deleted. Ask for a new code.';
  end if;

  insert into public.challenges (from_user, to_user, from_deck)
  values (inv.host, uid, inv.host_deck)
  returning id into ch;

  return json_build_object('challenge_id', ch, 'deck_id', new_deck);
end;
$$;

revoke all on function public.redeem_invite(text, text) from public, anon;
grant execute on function public.redeem_invite(text, text) to authenticated;
