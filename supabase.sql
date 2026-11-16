-- Run this once in Supabase: Dashboard -> SQL Editor -> New query

-- Admins table (who may upload)
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;
drop policy if exists "read own admin row" on public.admins;
create policy "read own admin row" on public.admins
  for select to authenticated using (user_id = auth.uid());

create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Comics
create table if not exists public.comics (
  id bigint generated always as identity primary key,
  title text not null,
  description text,
  image_path text not null,
  published_on date not null default current_date,
  created_at timestamptz not null default now()
);
alter table public.comics enable row level security;

drop policy if exists "authed can read comics" on public.comics;
create policy "authed can read comics" on public.comics
  for select to authenticated using (true);

drop policy if exists "admin inserts comics" on public.comics;
create policy "admin inserts comics" on public.comics
  for insert to authenticated with check (public.is_admin());

drop policy if exists "admin updates comics" on public.comics;
create policy "admin updates comics" on public.comics
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin deletes comics" on public.comics;
create policy "admin deletes comics" on public.comics
  for delete to authenticated using (public.is_admin());

-- Private storage bucket for the images
insert into storage.buckets (id, name, public)
values ('comics', 'comics', false)
on conflict (id) do nothing;

drop policy if exists "authed can view comic files" on storage.objects;
create policy "authed can view comic files" on storage.objects
  for select to authenticated using (bucket_id = 'comics');

drop policy if exists "admin uploads comic files" on storage.objects;
create policy "admin uploads comic files" on storage.objects
  for insert to authenticated with check (bucket_id = 'comics' and public.is_admin());

drop policy if exists "admin deletes comic files" on storage.objects;
create policy "admin deletes comic files" on storage.objects
  for delete to authenticated using (bucket_id = 'comics' and public.is_admin());

-- After you sign up on the site, make yourself admin (replace the email):
-- insert into public.admins (user_id)
--   select id from auth.users where email = 'you@example.com';
