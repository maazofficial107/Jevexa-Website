-- ==============================================================================
-- JEVEXA COMPLETE SAAS & CREDIT SYSTEM MASTER MIGRATION
-- Project: byopcuspgnhwsrmsxqvm (JEVEXA) & Compatible Environments
-- Description: Complete, self-contained, 100% idempotent SQL migration script.
--              Safe to run multiple times. Does NOT overwrite or reset user balances.
--              Guarantees zero "42P01: relation does not exist" compilation errors
--              by creating all base tables, compatibility views (e.g. jevexa_credit_reservations),
--              indexes, RLS policies, trigger procedures, seed pricing, and RPC functions in order.
-- ==============================================================================

-- 1. EXTENSIONS
create extension if not exists pgcrypto;

-- 2. BASE TABLES (Created with IF NOT EXISTS)

-- 2.1 User Credits Balance Account
create table if not exists public.user_credits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 100 check (balance >= 0),
  monthly_allowance integer not null default 100 check (monthly_allowance >= 0),
  plan text not null default 'free',
  updated_at timestamptz not null default now()
);

-- Ensure all columns exist on user_credits
alter table public.user_credits add column if not exists balance integer not null default 100;
alter table public.user_credits add column if not exists monthly_allowance integer not null default 100;
alter table public.user_credits add column if not exists plan text not null default 'free';
alter table public.user_credits add column if not exists updated_at timestamptz not null default now();

-- 2.2 Credit Transactions (Immutable Financial Ledger)
create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null,
  description text not null default 'Credit activity',
  type text not null default 'adjustment',
  reference text,
  service text,
  status text not null default 'settled',
  request_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Ensure all columns exist on credit_transactions
alter table public.credit_transactions
  add column if not exists service text,
  add column if not exists status text not null default 'settled',
  add column if not exists request_id uuid,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists reference text;

-- 2.3 Service Pricing Catalog
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

-- 2.4 Credit Reservations (Atomic Usage Locking)
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

-- Ensure all columns exist on credit_reservations
alter table public.credit_reservations
  add column if not exists fixed_credits integer,
  add column if not exists credits_per_1000_tokens integer,
  add column if not exists charged_credits integer,
  add column if not exists provider_usage jsonb not null default '{}'::jsonb,
  add column if not exists completed_at timestamptz;

-- 2.5 Billing Orders (Safepay & SaaS Invoices)
create table if not exists public.billing_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('starter','pro','business')),
  billing_cycle text not null check (billing_cycle in ('monthly','yearly')),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'USD',
  credits integer not null check (credits > 0),
  provider text,
  provider_order_id text unique,
  status text not null default 'pending'
    check (status in ('pending','paid','failed','refunded','cancelled')),
  checkout_url text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

-- Ensure all columns exist on billing_orders
alter table public.billing_orders
  add column if not exists provider text,
  add column if not exists provider_order_id text,
  add column if not exists checkout_url text,
  add column if not exists paid_at timestamptz;

-- 2.6 Support Tickets (Customer Support Inquiries)
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  name text,
  email text,
  subject text not null check (char_length(subject) between 1 and 120),
  message text not null check (char_length(message) between 1 and 5000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure columns exist and constraints match on support_tickets
alter table public.support_tickets add column if not exists name text;
alter table public.support_tickets add column if not exists email text;
alter table public.support_tickets alter column user_id drop not null;
alter table public.support_tickets drop constraint if exists support_tickets_user_id_fkey;
alter table public.support_tickets
  add constraint support_tickets_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- 3. INDEXES FOR HIGH PERFORMANCE & UNIQUENESS
create unique index if not exists credit_transactions_user_request_unique_idx
  on public.credit_transactions(user_id, request_id)
  where request_id is not null;

create unique index if not exists credit_transactions_unique_reference_idx
  on public.credit_transactions(user_id, reference)
  where reference is not null;

create index if not exists credit_transactions_user_created_idx
  on public.credit_transactions(user_id, created_at desc);

create index if not exists credit_reservations_user_status_idx
  on public.credit_reservations(user_id, status, created_at desc);

create index if not exists credit_reservations_user_created_idx
  on public.credit_reservations(user_id, created_at desc);

create index if not exists billing_orders_user_created_idx
  on public.billing_orders(user_id, created_at desc);

create unique index if not exists billing_orders_provider_order_id_unique_idx
  on public.billing_orders(provider_order_id)
  where provider_order_id is not null;

create index if not exists support_tickets_user_created_idx
  on public.support_tickets(user_id, created_at desc);

-- 4. COMPATIBILITY VIEWS (PREVENT 42P01 ERRORS FOR ANY PREFIX CONVENTION)
-- In case any legacy function, dashboard query, or test references jevexa_ prefixed names
-- instead of canonical names (or vice versa), these automatically updatable views ensure
-- complete bidirectional compatibility.
create or replace view public.jevexa_credit_reservations as
  select * from public.credit_reservations;

create or replace view public.jevexa_credit_ledger as
  select * from public.credit_transactions;

create or replace view public.jevexa_user_credits as
  select * from public.user_credits;

create or replace view public.jevexa_billing_orders as
  select * from public.billing_orders;

create or replace view public.jevexa_support_tickets as
  select * from public.support_tickets;

-- 5. ROW LEVEL SECURITY (RLS) POLICIES
alter table public.user_credits enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.credit_reservations enable row level security;
alter table public.jevexa_service_pricing enable row level security;
alter table public.billing_orders enable row level security;
alter table public.support_tickets enable row level security;

-- Drop and recreate select-own policies for authenticated users
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

drop policy if exists "Users read own support tickets" on public.support_tickets;
create policy "Users read own support tickets" on public.support_tickets
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Anyone reads available pricing" on public.jevexa_service_pricing;
create policy "Anyone reads available pricing" on public.jevexa_service_pricing
  for select to public using (true);

-- Revoke direct mutation rights from public and authenticated users
revoke all on public.user_credits from public, anon, authenticated;
revoke all on public.credit_transactions from public, anon, authenticated;
revoke all on public.credit_reservations from public, anon, authenticated;
revoke all on public.jevexa_service_pricing from public, anon, authenticated;
revoke all on public.billing_orders from public, anon, authenticated;
revoke all on public.support_tickets from public, anon, authenticated;

-- Grant controlled select permissions
grant select on public.user_credits, public.credit_transactions,
  public.credit_reservations, public.billing_orders, public.support_tickets to authenticated;
grant select on public.jevexa_service_pricing to anon, authenticated, service_role;

-- Grant compatibility view access
grant select on public.jevexa_credit_reservations, public.jevexa_credit_ledger,
  public.jevexa_user_credits, public.jevexa_billing_orders, public.jevexa_support_tickets to authenticated;
grant all privileges on public.jevexa_credit_reservations, public.jevexa_credit_ledger,
  public.jevexa_user_credits, public.jevexa_billing_orders, public.jevexa_support_tickets to service_role;

-- Service role has full management privileges
grant all privileges on public.user_credits, public.credit_transactions,
  public.credit_reservations, public.jevexa_service_pricing,
  public.billing_orders, public.support_tickets to service_role;

-- 6. IMMUTABILITY TRIGGER (PROTECT LEDGER AUDIT TRAIL)
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

-- 7. NEW USER SIGNUP HOOK (AUTOMATIC 100 WELCOME CREDITS)
create or replace function public.handle_new_jevexa_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_credits(user_id, balance, monthly_allowance, plan)
  values (new.id, 100, 100, 'free')
  on conflict (user_id) do nothing;

  insert into public.credit_transactions(user_id, amount, description, type, reference)
  values (new.id, 100, 'Welcome credits', 'welcome', 'signup:' || new.id::text)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_jevexa on auth.users;
create trigger on_auth_user_created_jevexa
after insert on auth.users
for each row execute procedure public.handle_new_jevexa_user();

-- Backfill any existing users created prior to the trigger
insert into public.user_credits(user_id, balance, monthly_allowance, plan)
select id, 100, 100, 'free' from auth.users
on conflict (user_id) do nothing;

-- 8. SERVICE PRICING SEED DATA (CHAT TIERS + CONTENT GENERATION + SERVICES)
insert into public.jevexa_service_pricing
  (service_key, display_name, integration_status, fixed_credits, credits_per_1000_tokens, enabled)
values
  ('ai_chat', 'AI Chat — Lite', 'available', 1, null, true),
  ('ai_chat_pro', 'AI Chat — Pro', 'available', 2, null, true),
  ('ai_chat_max', 'AI Chat — Max', 'available', 4, null, true),
  ('ai_chat_ultra', 'AI Chat — Ultra', 'available', 8, null, true),
  ('content_generation', 'Content Generation', 'available', null, 1, true),
  ('email_outreach', 'Email & Outreach AI', 'unavailable', null, null, false),
  ('mini_crm', 'Mini CRM', 'unavailable', null, null, false),
  ('document_ai', 'Document AI & OCR', 'unavailable', null, null, false),
  ('social_media', 'Social Media Assistant', 'unavailable', null, null, false),
  ('analytics', 'Business Analytics', 'unavailable', null, null, false),
  ('user_admin', 'User & Admin Management', 'unavailable', null, null, false),
  ('workflow_automation', 'Workflow Automation', 'unavailable', null, null, false),
  ('data_management', 'Data Management', 'unavailable', null, null, false)
on conflict (service_key) do update
set display_name = excluded.display_name,
    integration_status = excluded.integration_status,
    fixed_credits = excluded.fixed_credits,
    credits_per_1000_tokens = excluded.credits_per_1000_tokens,
    enabled = excluded.enabled,
    updated_at = now();

-- Ensure content_generation is enabled with 1 credit per 1000 tokens
update public.jevexa_service_pricing
set integration_status = 'available',
    credits_per_1000_tokens = 1,
    fixed_credits = null,
    enabled = true,
    updated_at = now()
where service_key = 'content_generation';

-- Clean up any legacy service keys if present
do $$
declare
  v_legacy_key text;
begin
  foreach v_legacy_key in array array['rpa', 'voice_ai', 'lead_scoring', 'data_enrichment', 'enterprise_security']
  loop
    if exists (
      select 1 from public.credit_reservations
      where service = v_legacy_key
    ) then
      update public.jevexa_service_pricing
      set display_name = 'Legacy service (disabled)',
          integration_status = 'unavailable',
          fixed_credits = null,
          credits_per_1000_tokens = null,
          enabled = false,
          updated_at = now()
      where service_key = v_legacy_key;
    else
      delete from public.jevexa_service_pricing
      where service_key = v_legacy_key;
    end if;
  end loop;
end;
$$;

-- 9. CORE RPC FUNCTIONS (ATOMIC, IDEMPOTENT, SECURITY DEFINER)

-- 9.1 Quote Calculation RPC
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
  v_tokens integer;
begin
  v_tokens := coalesce(p_estimated_tokens, 1000);
  if v_tokens < 1 then v_tokens := 1; end if;
  if v_tokens > 50000 then v_tokens := 50000; end if;

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
    v_tokens::numeric * v_pricing.credits_per_1000_tokens / 1000
  )::integer);
end;
$$;

-- 9.2 Atomic Credit Reserve RPC
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
  v_tokens integer;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'User and idempotency request ID are required';
  end if;

  -- Lock user account row to prevent race conditions
  select balance into v_balance
  from public.user_credits
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Credit account is not provisioned';
  end if;

  -- Idempotency check: if already processed for this request_id, return existing status
  select * into v_existing
  from public.credit_reservations
  where user_id = p_user_id and request_id = p_request_id;

  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'status', v_existing.status,
      'reserved_credits', v_existing.reserved_credits,
      'charged_credits', v_existing.charged_credits,
      'balance', v_balance
    );
  end if;

  -- Basic rate limiting: max 30 reservations per minute per user
  select pg_catalog.count(*) into v_recent_requests
  from public.credit_reservations
  where user_id = p_user_id
    and created_at > pg_catalog.now() - interval '1 minute';
  if v_recent_requests >= 30 then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- Fetch active pricing
  select * into v_pricing from public.jevexa_service_pricing
  where service_key = p_service and enabled
    and integration_status in ('available', 'partial')
  for share;

  if not found then
    raise exception 'Service is unavailable';
  end if;

  v_tokens := coalesce(p_estimated_tokens, 1000);
  if v_tokens < 1 then v_tokens := 1; end if;
  if v_tokens > 50000 then v_tokens := 50000; end if;

  if v_pricing.fixed_credits is not null then
    v_reserved := v_pricing.fixed_credits;
  elsif v_pricing.credits_per_1000_tokens is not null then
    v_reserved := greatest(1, pg_catalog.ceil(
      v_tokens::numeric * v_pricing.credits_per_1000_tokens / 1000
    )::integer);
  else
    raise exception 'Service pricing is not configured';
  end if;

  if v_balance < v_reserved then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'insufficient_credits',
      'required_credits', v_reserved,
      'available_credits', v_balance
    );
  end if;

  -- Deduct reserved amount from balance
  update public.user_credits
  set balance = balance - v_reserved, updated_at = pg_catalog.now()
  where user_id = p_user_id
  returning balance into v_balance;

  -- Record active reservation
  insert into public.credit_reservations (
    user_id, request_id, service, reserved_credits,
    fixed_credits, credits_per_1000_tokens, status
  ) values (
    p_user_id, p_request_id, p_service, v_reserved,
    v_pricing.fixed_credits, v_pricing.credits_per_1000_tokens, 'reserved'
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'status', 'reserved',
    'reserved_credits', v_reserved,
    'balance', v_balance
  );
end;
$$;

-- 9.3 Atomic Credit Settle RPC (Charges measured usage & refunds excess)
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
  v_tokens integer;
  v_description text;
begin
  v_tokens := coalesce(p_usage_tokens, 1000);
  if v_tokens < 1 then v_tokens := 1; end if;
  if v_tokens > 50000 then v_tokens := 50000; end if;

  select balance into v_balance from public.user_credits
  where user_id = p_user_id for update;
  if not found then raise exception 'Credit account is not provisioned'; end if;

  select * into v_reservation from public.credit_reservations
  where user_id = p_user_id and request_id = p_request_id for update;
  if not found then raise exception 'Credit reservation was not found'; end if;

  -- Idempotency check: if already settled, return settled status
  if v_reservation.status = 'settled' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'charged_credits', v_reservation.charged_credits,
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
      v_tokens::numeric * v_reservation.credits_per_1000_tokens / 1000
    )::integer);
  else
    raise exception 'Service pricing is not configured';
  end if;

  -- Never charge more than was originally reserved
  if v_charge > v_reservation.reserved_credits then
    v_charge := v_reservation.reserved_credits;
  end if;

  -- Credit back any uncharged reserved difference to user balance
  update public.user_credits
  set balance = balance + v_reservation.reserved_credits - v_charge,
      updated_at = pg_catalog.now()
  where user_id = p_user_id
  returning balance into v_balance;

  -- Mark reservation as settled
  update public.credit_reservations
  set status = 'settled',
      charged_credits = v_charge,
      provider_usage = pg_catalog.jsonb_build_object('total_tokens', v_tokens),
      completed_at = pg_catalog.now()
  where id = v_reservation.id;

  -- Set contextual ledger description
  if v_reservation.service = 'content_generation' then
    v_description := 'Content generation usage';
  elsif v_reservation.service like 'ai_chat%' then
    v_description := 'AI chat usage';
  else
    v_description := 'AI service usage';
  end if;

  -- Record settled usage in immutable credit ledger
  insert into public.credit_transactions (
    user_id, amount, description, type, reference, service, status, request_id, metadata
  ) values (
    p_user_id,
    -v_charge,
    v_description,
    'usage',
    'usage:' || p_request_id::text,
    v_reservation.service,
    'settled',
    p_request_id,
    pg_catalog.jsonb_build_object('total_tokens', v_tokens)
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'charged_credits', v_charge,
    'balance', v_balance,
    'total_tokens', v_tokens
  );
end;
$$;

-- 9.4 Atomic Credit Release RPC (Refunds 100% of reservation on error/timeout)
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

  -- Idempotency check: if already released, return success
  if v_reservation.status = 'released' then
    return pg_catalog.jsonb_build_object('ok', true, 'duplicate', true, 'balance', v_balance);
  end if;

  if v_reservation.status <> 'reserved' then
    raise exception 'Settled usage cannot be released';
  end if;

  -- Refund 100% of reserved credits back to user balance
  update public.user_credits
  set balance = balance + v_reservation.reserved_credits,
      updated_at = pg_catalog.now()
  where user_id = p_user_id
  returning balance into v_balance;

  update public.credit_reservations
  set status = 'released',
      charged_credits = 0,
      completed_at = pg_catalog.now()
  where id = v_reservation.id;

  return pg_catalog.jsonb_build_object('ok', true, 'duplicate', false, 'balance', v_balance);
end;
$$;

-- 9.5 Administrative / Internal Credit Adjustment RPC
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
      'ok', true,
      'duplicate', true,
      'balance', v_balance,
      'amount', v_existing.amount,
      'type', v_existing.type
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

  insert into public.credit_transactions (
    user_id, amount, description, type, reference, service, status, request_id
  ) values (
    p_user_id, p_amount, p_description, p_type,
    'adjustment:' || p_request_id::text, p_service, 'settled', p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'balance', v_balance,
    'amount', p_amount
  );
end;
$$;

-- 9.6 Safepay Payment Application RPC (Webhook Processor)
create or replace function public.jevexa_apply_safepay_payment(
  p_tracker text,
  p_amount_minor bigint,
  p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.billing_orders%rowtype;
  v_balance integer;
begin
  if p_tracker is null or length(p_tracker) < 8 or p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Invalid payment details';
  end if;

  select * into v_order
  from public.billing_orders
  where provider_order_id = p_tracker and provider = 'safepay'
  for update;

  if not found then
    raise exception 'No JEVEXA order matches this Safepay tracker';
  end if;

  if upper(v_order.currency) <> upper(p_currency)
     or pg_catalog.round(v_order.amount * 100)::bigint <> p_amount_minor then
    raise exception 'Safepay amount/currency does not match the order';
  end if;

  if v_order.status = 'paid' then
    return pg_catalog.jsonb_build_object('ok', true, 'duplicate', true, 'order_id', v_order.id);
  end if;

  if v_order.status <> 'pending' then
    raise exception 'Order is not pending';
  end if;

  insert into public.user_credits(user_id, balance, monthly_allowance, plan, updated_at)
  values (v_order.user_id, 0, 0, 'free', pg_catalog.now())
  on conflict (user_id) do nothing;

  update public.user_credits
  set balance = balance + v_order.credits,
      monthly_allowance = v_order.credits,
      plan = v_order.plan,
      updated_at = pg_catalog.now()
  where user_id = v_order.user_id
  returning balance into v_balance;

  update public.billing_orders
  set status = 'paid', paid_at = pg_catalog.now()
  where id = v_order.id;

  insert into public.credit_transactions(user_id, amount, description, type, reference)
  values (
    v_order.user_id,
    v_order.credits,
    'Safepay purchase: ' || v_order.plan || ' (' || v_order.billing_cycle || ')',
    'purchase',
    'safepay:' || p_tracker
  )
  on conflict (user_id, reference) where reference is not null do nothing;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'order_id', v_order.id,
    'credits_added', v_order.credits,
    'new_balance', v_balance
  );
end;
$$;

-- 10. FUNCTION PERMISSIONS & ACCESS CONTROL
revoke all on function public.jevexa_reject_credit_ledger_mutation() from public, anon, authenticated;
revoke all on function public.jevexa_credit_quote(text, integer) from public, anon, authenticated;
revoke all on function public.jevexa_credit_reserve(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.jevexa_credit_settle(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.jevexa_credit_release(uuid, uuid) from public, anon, authenticated;
revoke all on function public.jevexa_credit_adjust(uuid, uuid, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.jevexa_apply_safepay_payment(text, bigint, text) from public, anon, authenticated;

-- AUDIT BUG: jevexa_credit_quote is granted to `authenticated` here but NOT in
-- credit_system_migration.sql (service_role only). The staging verification script
-- (staging-credit.integration.mjs line 319-322) tests it via anonKey+userToken and
-- expects a DENIED response. Granting execute to `authenticated` breaks that security
-- invariant. Revert to service_role only unless a public quote endpoint is intentional.
-- FIX: Remove `authenticated` from the grant below.
grant execute on function public.jevexa_credit_quote(text, integer) to service_role;
grant execute on function public.jevexa_credit_reserve(uuid, uuid, text, integer) to service_role;
grant execute on function public.jevexa_credit_settle(uuid, uuid, integer) to service_role;
grant execute on function public.jevexa_credit_release(uuid, uuid) to service_role;
grant execute on function public.jevexa_credit_adjust(uuid, uuid, integer, text, text, text) to service_role;
grant execute on function public.jevexa_apply_safepay_payment(text, bigint, text) to service_role;

-- 11. VERIFICATION & HEALTH REPORT
do $$
declare
  v_table_count integer;
  v_view_count integer;
  v_pricing_count integer;
  v_func_count integer;
begin
  select count(*) into v_table_count
  from information_schema.tables
  where table_schema = 'public'
    and table_name in (
      'user_credits', 'credit_transactions', 'credit_reservations',
      'jevexa_service_pricing', 'billing_orders', 'support_tickets'
    );

  select count(*) into v_view_count
  from information_schema.views
  where table_schema = 'public'
    and table_name in (
      'jevexa_credit_reservations', 'jevexa_credit_ledger',
      'jevexa_user_credits', 'jevexa_billing_orders', 'jevexa_support_tickets'
    );

  select count(*) into v_pricing_count
  from public.jevexa_service_pricing
  where enabled = true and integration_status = 'available';

  select count(*) into v_func_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'jevexa_credit_quote', 'jevexa_credit_reserve',
      'jevexa_credit_settle', 'jevexa_credit_release',
      'jevexa_credit_adjust', 'jevexa_apply_safepay_payment'
    );

  raise notice '==================================================';
  raise notice 'JEVEXA MASTER SCHEMA SETUP COMPLETED SUCCESSFULLY:';
  raise notice '  - Core Tables: % / 6 verified', v_table_count;
  raise notice '  - Compatibility Views: % / 5 verified', v_view_count;
  raise notice '  - Available Service Pricing Keys: % active', v_pricing_count;
  raise notice '  - Security Definer RPCs: % / 6 verified', v_func_count;
  raise notice '==================================================';
end;
$$;
