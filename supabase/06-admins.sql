-- =====================================================================
-- Uma TCG — admins (edit any card) — for projects set up before this update
-- New projects already have this from schema.sql.
-- SQL Editor → New query → paste → Run. Then add yourself (bottom line).
-- =====================================================================
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

drop policy if exists "edit own cards" on public.cards;
drop policy if exists "delete own cards" on public.cards;
drop policy if exists "edit own cards (admins: any)" on public.cards;
drop policy if exists "delete own cards (admins: any)" on public.cards;
create policy "edit own cards (admins: any)" on public.cards
  for update using (public.is_allowed() and (owner = auth.uid() or public.is_admin()));
create policy "delete own cards (admins: any)" on public.cards
  for delete using (public.is_allowed() and (owner = auth.uid() or public.is_admin()));

-- Make yourself an admin (use the email you sign in with):
-- insert into public.admin_emails (email) values ('you@example.com');
