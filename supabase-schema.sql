-- 阅读生词 v3.1.0 - Supabase 同步表与 RLS
-- 如果你之前 CET6 Review 已经执行过旧版 supabase-schema.sql，则无需重复执行。
-- deleted=true 的 readingWords 行是删除墓碑，只保留 normalizedTerm + 删除时间，用于跨设备传播删除。

create table if not exists public.cet6_sync_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  store_name text not null check (store_name in ('wordProgress', 'dailySessions', 'readingWords')),
  record_key text not null,
  payload jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  source_updated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, store_name, record_key)
);

create index if not exists cet6_sync_records_user_store_idx
  on public.cet6_sync_records (user_id, store_name);

alter table public.cet6_sync_records enable row level security;

drop policy if exists "cet6_select_own" on public.cet6_sync_records;
drop policy if exists "cet6_insert_own" on public.cet6_sync_records;
drop policy if exists "cet6_update_own" on public.cet6_sync_records;
drop policy if exists "cet6_delete_own" on public.cet6_sync_records;

create policy "cet6_select_own" on public.cet6_sync_records
for select to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "cet6_insert_own" on public.cet6_sync_records
for insert to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "cet6_update_own" on public.cet6_sync_records
for update to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "cet6_delete_own" on public.cet6_sync_records
for delete to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.cet6_sync_records to authenticated;
revoke all on table public.cet6_sync_records from anon;
