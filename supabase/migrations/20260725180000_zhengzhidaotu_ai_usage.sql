begin;

create table if not exists public.zhengzhidaotu_20260715_k4m8_ai_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  prompt_tokens bigint not null default 0 check (prompt_tokens >= 0),
  completion_tokens bigint not null default 0 check (completion_tokens >= 0),
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  cached_tokens bigint not null default 0 check (cached_tokens >= 0),
  request_count bigint not null default 0 check (request_count >= 0),
  estimated_cost_cny numeric(18, 8) not null default 0 check (estimated_cost_cny >= 0),
  last_model text,
  updated_at timestamptz not null default now()
);

alter table public.zhengzhidaotu_20260715_k4m8_ai_usage enable row level security;

revoke all on table public.zhengzhidaotu_20260715_k4m8_ai_usage from anon;
revoke all on table public.zhengzhidaotu_20260715_k4m8_ai_usage from authenticated;
grant select on table public.zhengzhidaotu_20260715_k4m8_ai_usage to authenticated;

drop policy if exists zhengzhidaotu_20260715_k4m8_ai_usage_select_own
  on public.zhengzhidaotu_20260715_k4m8_ai_usage;
create policy zhengzhidaotu_20260715_k4m8_ai_usage_select_own
  on public.zhengzhidaotu_20260715_k4m8_ai_usage
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.zhengzhidaotu_20260715_k4m8_record_ai_usage(
  p_user_id uuid,
  p_prompt_tokens bigint,
  p_completion_tokens bigint,
  p_total_tokens bigint,
  p_cached_tokens bigint,
  p_estimated_cost_cny numeric,
  p_model text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_prompt_tokens < 0
    or p_completion_tokens < 0
    or p_total_tokens < 0
    or p_cached_tokens < 0
    or p_estimated_cost_cny < 0 then
    raise exception 'AI usage values must be non-negative';
  end if;

  insert into public.zhengzhidaotu_20260715_k4m8_ai_usage (
    user_id,
    prompt_tokens,
    completion_tokens,
    total_tokens,
    cached_tokens,
    request_count,
    estimated_cost_cny,
    last_model,
    updated_at
  )
  values (
    p_user_id,
    p_prompt_tokens,
    p_completion_tokens,
    p_total_tokens,
    p_cached_tokens,
    1,
    p_estimated_cost_cny,
    p_model,
    now()
  )
  on conflict (user_id) do update
  set
    prompt_tokens = zhengzhidaotu_20260715_k4m8_ai_usage.prompt_tokens + excluded.prompt_tokens,
    completion_tokens = zhengzhidaotu_20260715_k4m8_ai_usage.completion_tokens + excluded.completion_tokens,
    total_tokens = zhengzhidaotu_20260715_k4m8_ai_usage.total_tokens + excluded.total_tokens,
    cached_tokens = zhengzhidaotu_20260715_k4m8_ai_usage.cached_tokens + excluded.cached_tokens,
    request_count = zhengzhidaotu_20260715_k4m8_ai_usage.request_count + 1,
    estimated_cost_cny =
      zhengzhidaotu_20260715_k4m8_ai_usage.estimated_cost_cny + excluded.estimated_cost_cny,
    last_model = excluded.last_model,
    updated_at = now();
end;
$$;

revoke all on function public.zhengzhidaotu_20260715_k4m8_record_ai_usage(
  uuid, bigint, bigint, bigint, bigint, numeric, text
) from public, anon, authenticated;
grant execute on function public.zhengzhidaotu_20260715_k4m8_record_ai_usage(
  uuid, bigint, bigint, bigint, bigint, numeric, text
) to service_role;

commit;
