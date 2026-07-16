begin;

create table if not exists public.zhengzhidaotu_20260715_k4m8_items (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null,
  item_type text not null,
  item_data jsonb not null default '{}'::jsonb,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint zhengzhidaotu_20260715_k4m8_user_item_unique unique (user_id, item_key),
  constraint zhengzhidaotu_20260715_k4m8_item_key_scoped
    check (
      left(item_key, length('zhengzhidaotu_20260715_k4m8:')) =
      'zhengzhidaotu_20260715_k4m8:'
    ),
  constraint zhengzhidaotu_20260715_k4m8_id_scoped
    check (id = user_id::text || '::' || item_key)
);

create index if not exists zhengzhidaotu_20260715_k4m8_items_user_updated_idx
  on public.zhengzhidaotu_20260715_k4m8_items (user_id, updated_at desc);

create index if not exists zhengzhidaotu_20260715_k4m8_items_user_deleted_idx
  on public.zhengzhidaotu_20260715_k4m8_items (user_id, deleted_at)
  where deleted_at is not null;

alter table public.zhengzhidaotu_20260715_k4m8_items enable row level security;

revoke all on table public.zhengzhidaotu_20260715_k4m8_items from anon;
revoke all on table public.zhengzhidaotu_20260715_k4m8_items from authenticated;
grant select, insert, update, delete on table public.zhengzhidaotu_20260715_k4m8_items to authenticated;

drop policy if exists zhengzhidaotu_20260715_k4m8_select_own on public.zhengzhidaotu_20260715_k4m8_items;
create policy zhengzhidaotu_20260715_k4m8_select_own
  on public.zhengzhidaotu_20260715_k4m8_items
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists zhengzhidaotu_20260715_k4m8_insert_own on public.zhengzhidaotu_20260715_k4m8_items;
create policy zhengzhidaotu_20260715_k4m8_insert_own
  on public.zhengzhidaotu_20260715_k4m8_items
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists zhengzhidaotu_20260715_k4m8_update_own on public.zhengzhidaotu_20260715_k4m8_items;
create policy zhengzhidaotu_20260715_k4m8_update_own
  on public.zhengzhidaotu_20260715_k4m8_items
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists zhengzhidaotu_20260715_k4m8_delete_own on public.zhengzhidaotu_20260715_k4m8_items;
create policy zhengzhidaotu_20260715_k4m8_delete_own
  on public.zhengzhidaotu_20260715_k4m8_items
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.zhengzhidaotu_20260715_k4m8_keep_newest()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.updated_at > new.updated_at then
    return old;
  end if;
  if old.updated_at = new.updated_at then
    if old.deleted_at is not null and new.deleted_at is null then
      return old;
    end if;
    if jsonb_build_object(
      'deleted_at', old.deleted_at,
      'item_type', old.item_type,
      'item_data', old.item_data
    )::text > jsonb_build_object(
      'deleted_at', new.deleted_at,
      'item_type', new.item_type,
      'item_data', new.item_data
    )::text then
      return old;
    end if;
  end if;
  new.added_at := old.added_at;
  return new;
end;
$$;

revoke all on function public.zhengzhidaotu_20260715_k4m8_keep_newest() from public;

drop trigger if exists zhengzhidaotu_20260715_k4m8_keep_newest_trigger
  on public.zhengzhidaotu_20260715_k4m8_items;
create trigger zhengzhidaotu_20260715_k4m8_keep_newest_trigger
before update on public.zhengzhidaotu_20260715_k4m8_items
for each row execute function public.zhengzhidaotu_20260715_k4m8_keep_newest();

commit;
