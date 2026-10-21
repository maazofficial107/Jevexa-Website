-- JEVEXA credit ledger and atomic AI usage reservations.
-- Run after jevexa_saas_setup.sql and safepay_billing_migration.sql.
-- Safe to rerun. Existing balances are not reset or granted again.

create table if not exists public.jevexa_service_pricing (
  service_key text primary key,
  display_name text not null,
  integration_status text not null
    check (integration_status in ('available', 'partial', 'unavailable')),
  fixed_credits integer check (fixed_credits is null or fixed_credits > 0),
  credits_per_1000_tokens integer
    check (credits_per_1000_tokens is null or credits_per_1000_tokens > 0),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  check (fixed_credits is null or credits_per_1000_tokens is null)
);

insert into public.jevexa_service_pricing
  (service_key, display_name, integration_status, fixed_credits, credits_per_1000_tokens, enabled)
values
  ('ai_chat', 'AI Chatbots & Agents', 'available', null, 1, true),
  ('workflow_automation', 'Workflow Automation', 'unavailable', null, null, false),
  ('rpa', 'RPA & Process Automation', 'unavailable', null, null, false),
  ('document_ai', 'Document AI & OCR', 'unavailable', null, null, false),
  ('voice_ai', 'Voice AI & Call Agents', 'unavailable', null, null, false),
  ('lead_scoring', 'Lead Scoring & CRM AI', 'unavailable', null, null, false),
  ('content_generation', 'Content Generation', 'unavailable', null, null, false),
  ('email_outreach', 'Email & Outreach AI', 'unavailable', null, null, false),
  ('social_media', 'Social Media Automation', 'unavailable', null, null, false),
  ('analytics', 'Intelligent Analytics', 'unavailable', null, null, false),
  ('data_enrichment', 'Data Enrichment & Scraping', 'unavailable', null, null, false),
  ('enterprise_security', 'Enterprise Security', 'unavailable', null, null, false)
on conflict (service_key) do nothing;

alter table public.credit_transactions
  add column if not exists service text,
  add column if not exists status text not null default 'settled',
  add column if not exists request_id uuid,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create unique index if not exists credit_transactions_user_request_unique_idx
  on public.credit_transactions(user_id, request_id)
  where request_id is not null;

create index if not exists credit_transactions_user_created_idx
  on public.credit_transactions(user_id, created_at desc);

create table if not exists public.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  service text not null references public.jevexa_service_pricing(service_key),
  reserved_credits integer not null check (reserved_credits > 0),
  fixed_credits integer check (fixed_credits is null or fixed_credits > 0),
  credits_per_1000_tokens integer
    check (credits_per_1000_tokens is null or credits_per_1000_tokens > 0),
  charged_credits integer check (charged_credits is null or charged_credits >= 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'settled', 'released')),
  provider_usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, request_id)
);

alter table public.credit_reservations
  add column if not exists fixed_credits integer,
  add column if not exists credits_per_1000_tokens integer;

update public.credit_reservations r
set fixed_credits = p.fixed_credits,
    credits_per_1000_tokens = p.credits_per_1000_tokens
from public.jevexa_service_pricing p
where p.service_key = r.service
  and r.fixed_credits is null
  and r.credits_per_1000_tokens is null;

create index if not exists credit_reservations_user_status_idx
  on public.credit_reservations(user_id, status, created_at desc);
create index if not exists credit_reservations_user_created_idx
  on public.credit_reservations(user_id, created_at desc);

alter table public.user_credits enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.credit_reservations enable row level security;
alter table public.jevexa_service_pricing enable row level security;
alter table public.billing_orders enable row level security;

drop policy if exists "Users read own credits" on public.user_credits;
create policy "Users read own credits" on public.user_credits
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users read own credit transactions" on public.credit_transactions;
create policy "Users read own credit transactions" on public.credit_transactions
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users read own credit reservations" on public.credit_reservations;
create policy "Users read own credit reservations" on public.credit_reservations
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users read own billing orders" on public.billing_orders;
create policy "Users read own billing orders" on public.billing_orders
  for select to authenticated using (auth.uid() = user_id);

revoke all on public.user_credits from public, anon, authenticated;
revoke all on public.credit_transactions from public, anon, authenticated;
revoke all on public.credit_reservations from public, anon, authenticated;
revoke all on public.jevexa_service_pricing from public, anon, authenticated;
revoke all on public.billing_orders from public, anon, authenticated;
grant select on public.user_credits, public.credit_transactions,
  public.credit_reservations, public.billing_orders to authenticated;
grant select on public.jevexa_service_pricing to service_role;

create or replace function public.jevexa_reject_credit_ledger_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Credit ledger entries cannot be changed or deleted';
end;
$$;

drop trigger if exists jevexa_credit_ledger_immutable on public.credit_transactions;
create trigger jevexa_credit_ledger_immutable
before update or delete on public.credit_transactions
for each row execute function public.jevexa_reject_credit_ledger_mutation();

create or replace function public.jevexa_credit_quote(
  p_service text,
  p_estimated_tokens integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pricing public.jevexa_service_pricing%rowtype;
begin
  if p_estimated_tokens is null or p_estimated_tokens < 1 or p_estimated_tokens > 50000 then
    raise exception 'Invalid estimated usage';
  end if;

  select * into v_pricing
  from public.jevexa_service_pricing
  where service_key = p_service and enabled and integration_status in ('available', 'partial');

  if not found then
    raise exception 'Service is unavailable';
  end if;

  if v_pricing.fixed_credits is not null then
    return v_pricing.fixed_credits;
  end if;

  if v_pricing.credits_per_1000_tokens is null then
    raise exception 'Service pricing is not configured';
  end if;

  return greatest(1, pg_catalog.ceil(
    p_estimated_tokens::numeric * v_pricing.credits_per_1000_tokens / 1000
  )::integer);
end;
$$;

create or replace function public.jevexa_credit_reserve(
  p_user_id uuid,
  p_request_id uuid,
  p_service text,
  p_estimated_tokens integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
  v_reserved integer;
  v_recent_requests integer;
  v_existing public.credit_reservations%rowtype;
  v_pricing public.jevexa_service_pricing%rowtype;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'User and idempotency request ID are required';
  end if;

  select balance into v_balance
  from public.user_credits
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Credit account is not provisioned';
  end if;

  select * into v_existing
  from public.credit_reservations
  where user_id = p_user_id and request_id = p_request_id;

  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'duplicate', true, 'status', v_existing.status,
      'reserved_credits', v_existing.reserved_credits,
      'charged_credits', v_existing.charged_credits, 'balance', v_balance
    );
  end if;

  select pg_catalog.count(*) into v_recent_requests
  from public.credit_reservations
  where user_id = p_user_id
    and created_at > pg_catalog.now() - interval '1 minute';
  if v_recent_requests >= 10 then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  if p_estimated_tokens is null or p_estimated_tokens < 1 or p_estimated_tokens > 50000 then
    raise exception 'Invalid estimated usage';
  end if;

  select * into v_pricing from public.jevexa_service_pricing
  where service_key = p_service and enabled
    and integration_status in ('available', 'partial')
  for share;
  if not found then raise exception 'Service is unavailable'; end if;

  if v_pricing.fixed_credits is not null then
    v_reserved := v_pricing.fixed_credits;
  elsif v_pricing.credits_per_1000_tokens is not null then
    v_reserved := greatest(1, pg_catalog.ceil(
      p_estimated_tokens::numeric * v_pricing.credits_per_1000_tokens / 1000
    )::integer);
  else
    raise exception 'Service pricing is not configured';
  end if;
  if v_balance < v_reserved then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'insufficient_credits',
      'required_credits', v_reserved, 'available_credits', v_balance
    );
  end if;

  update public.user_credits
  set balance = balance - v_reserved, updated_at = pg_catalog.now()
  where user_id = p_user_id
  returning balance into v_balance;

  insert into public.credit_reservations
    (user_id, request_id, service, reserved_credits, fixed_credits, credits_per_1000_tokens)
  values (
    p_user_id, p_request_id, p_service, v_reserved,
    v_pricing.fixed_credits, v_pricing.credits_per_1000_tokens
  );

  return pg_catalog.jsonb_build_object(
    'ok', true, 'duplicate', false, 'status', 'reserved',
    'reserved_credits', v_reserved, 'balance', v_balance
  );
end;
$$;

create or replace function public.jevexa_credit_settle(
  p_user_id uuid,
  p_request_id uuid,
  p_usage_tokens integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
  v_charge integer;
  v_reservation public.credit_reservations%rowtype;
begin
  if p_usage_tokens is null or p_usage_tokens < 1 or p_usage_tokens > 50000 then
    raise exception 'Invalid measured provider usage';
  end if;

  select balance into v_balance from public.user_credits
  where user_id = p_user_id for update;
  if not found then raise exception 'Credit account is not provisioned'; end if;

  select * into v_reservation from public.credit_reservations
  where user_id = p_user_id and request_id = p_request_id for update;
  if not found then raise exception 'Credit reservation was not found'; end if;

  if v_reservation.status = 'settled' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'duplicate', true, 'charged_credits', v_reservation.charged_credits,
      'balance', v_balance
    );
  end if;
  if v_reservation.status <> 'reserved' then
    raise exception 'Credit reservation is no longer active';
  end if;

  if v_reservation.fixed_credits is not null then
    v_charge := v_reservation.fixed_credits;
  elsif v_reservation.credits_per_1000_tokens is not null then
    v_charge := greatest(1, pg_catalog.ceil(
      p_usage_tokens::numeric * v_reservation.credits_per_1000_tokens / 1000
    )::integer);
  else
    raise exception 'Service pricing is not configured';
  end if;

  if v_charge > v_reservation.reserved_credits then
    raise exception 'Measured usage exceeds reserved credits';
  end if;

  update public.user_credits
  set balance = balance + v_reservation.reserved_credits - v_charge,
      updated_at = pg_catalog.now()
  where user_id = p_user_id
  returning balance into v_balance;

  update public.credit_reservations
  set status = 'settled', charged_credits = v_charge,
      provider_usage = pg_catalog.jsonb_build_object('total_tokens', p_usage_tokens),
      completed_at = pg_catalog.now()
  where id = v_reservation.id;

  insert into public.credit_transactions
    (user_id, amount, description, type, reference, service, status, request_id, metadata)
  values
    (p_user_id, -v_charge, 'AI chatbot usage', 'usage',
     'usage:' || p_request_id::text, v_reservation.service, 'settled',
     p_request_id, pg_catalog.jsonb_build_object('total_tokens', p_usage_tokens));

  return pg_catalog.jsonb_build_object(
    'ok', true, 'duplicate', false, 'charged_credits', v_charge,
    'balance', v_balance, 'total_tokens', p_usage_tokens
  );
end;
$$;

create or replace function public.jevexa_credit_release(
  p_user_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
  v_reservation public.credit_reservations%rowtype;
begin
  select balance into v_balance from public.user_credits
  where user_id = p_user_id for update;
  if not found then raise exception 'Credit account is not provisioned'; end if;

  select * into v_reservation from public.credit_reservations
  where user_id = p_user_id and request_id = p_request_id for update;
  if not found then raise exception 'Credit reservation was not found'; end if;

  if v_reservation.status = 'released' then
    return pg_catalog.jsonb_build_object('ok', true, 'duplicate', true, 'balance', v_balance);
  end if;
  if v_reservation.status <> 'reserved' then
    raise exception 'Settled usage cannot be released';
  end if;

  update public.user_credits
  set balance = balance + v_reservation.reserved_credits, updated_at = pg_catalog.now()
  where user_id = p_user_id
  returning balance into v_balance;

  update public.credit_reservations
  set status = 'released', charged_credits = 0, completed_at = pg_catalog.now()
  where id = v_reservation.id;

  return pg_catalog.jsonb_build_object('ok', true, 'duplicate', false, 'balance', v_balance);
end;
$$;

create or replace function public.jevexa_credit_adjust(
  p_user_id uuid,
  p_request_id uuid,
  p_amount integer,
  p_type text,
  p_description text,
  p_service text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
  v_existing public.credit_transactions%rowtype;
begin
  if p_user_id is null or p_request_id is null or p_amount is null or p_amount = 0
     or p_amount not between -100000000 and 100000000
     or p_type is null or p_type not in ('grant', 'refund', 'adjustment')
     or p_description is null or pg_catalog.length(pg_catalog.btrim(p_description)) = 0
     or pg_catalog.length(p_description) > 200 then
    raise exception 'Invalid credit adjustment';
  end if;

  select balance into v_balance from public.user_credits
  where user_id = p_user_id for update;
  if not found then raise exception 'Credit account is not provisioned'; end if;

  select * into v_existing from public.credit_transactions
  where user_id = p_user_id and request_id = p_request_id;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'duplicate', true, 'balance', v_balance,
      'amount', v_existing.amount, 'type', v_existing.type
    );
  end if;

  if v_balance::bigint + p_amount::bigint < 0
     or v_balance::bigint + p_amount::bigint > 2147483647 then
    raise exception 'Credit adjustment would create an invalid balance';
  end if;

  update public.user_credits
  set balance = balance + p_amount, updated_at = pg_catalog.now()
  where user_id = p_user_id
  returning balance into v_balance;

  insert into public.credit_transactions
    (user_id, amount, description, type, reference, service, status, request_id)
  values
    (p_user_id, p_amount, p_description, p_type,
     'adjustment:' || p_request_id::text, p_service, 'settled', p_request_id);

  return pg_catalog.jsonb_build_object(
    'ok', true, 'duplicate', false, 'balance', v_balance, 'amount', p_amount
  );
end;
$$;

revoke all on function public.jevexa_reject_credit_ledger_mutation() from public, anon, authenticated;
revoke all on function public.jevexa_credit_quote(text, integer) from public, anon, authenticated;
revoke all on function public.jevexa_credit_reserve(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.jevexa_credit_settle(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.jevexa_credit_release(uuid, uuid) from public, anon, authenticated;
revoke all on function public.jevexa_credit_adjust(uuid, uuid, integer, text, text, text) from public, anon, authenticated;

grant execute on function public.jevexa_credit_quote(text, integer) to service_role;
grant execute on function public.jevexa_credit_reserve(uuid, uuid, text, integer) to service_role;
grant execute on function public.jevexa_credit_settle(uuid, uuid, integer) to service_role;
grant execute on function public.jevexa_credit_release(uuid, uuid) to service_role;
grant execute on function public.jevexa_credit_adjust(uuid, uuid, integer, text, text, text) to service_role;
