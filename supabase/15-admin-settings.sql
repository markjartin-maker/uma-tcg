-- =====================================================================
-- Uma TCG — Admin panel (game sounds + card back) and sounds for animations
-- Run this once if you set up the database BEFORE this update.
-- (Safe to run more than once.) SQL Editor → New query → paste → Run.
-- =====================================================================

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
