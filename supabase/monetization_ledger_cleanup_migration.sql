-- ==============================================================================
-- JEVEXA Monetization, Ledger & Pricing Cleanup Migration
-- Safe to run multiple times in Supabase SQL Editor.
-- Does NOT modify user credit balances or existing ledger history.
-- ==============================================================================

-- 1. Update billing_orders.plan constraint to allow 'ultra' alongside 'starter', 'pro', 'business'
do $$
declare
  v_constraint_name text;
begin
  for v_constraint_name in
    select c.conname
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'billing_orders'
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) ilike '%plan%'
  loop
    execute format('alter table public.billing_orders drop constraint if exists %I', v_constraint_name);
  end loop;

  alter table public.billing_orders
    add constraint billing_orders_plan_check
    check (plan in ('starter', 'pro', 'business', 'ultra'));
end;
$$;

-- 2. Align active service pricing rows (chat tiers 1/3/18/18 + live studio tools)
insert into public.jevexa_service_pricing
  (service_key, display_name, integration_status, fixed_credits, credits_per_1000_tokens, enabled)
values
  ('ai_chat', 'AI Chat — Lite', 'available', 1, null, true),
  ('ai_chat_pro', 'AI Chat — Pro', 'available', 3, null, true),
  ('ai_chat_max', 'AI Chat — Max', 'available', 18, null, true),
  ('ai_chat_ultra', 'AI Chat — Ultra', 'available', 18, null, true),
  ('content_generation', 'Content Generation', 'available', null, 1, true),
  ('email_outreach', 'Email & Outreach AI', 'available', null, 1, true),
  ('mini_crm', 'Mini CRM', 'available', null, 1, true),
  ('document_ocr', 'Document AI & OCR', 'available', null, 1, true),
  ('social_assistant', 'Social Media Assistant', 'available', null, 1, true),
  ('business_analytics', 'Business Analytics', 'available', null, 1, true),
  ('workflow_automation', 'Workflow Automation', 'available', null, 1, true),
  ('data_management', 'Data Management', 'available', null, 1, true)
on conflict (service_key) do update
set display_name = excluded.display_name,
    integration_status = excluded.integration_status,
    fixed_credits = excluded.fixed_credits,
    credits_per_1000_tokens = excluded.credits_per_1000_tokens,
    enabled = excluded.enabled,
    updated_at = now();

-- 3. Retire or delete legacy disabled pricing rows so Settings never shows false unavailable tools
do $$
declare
  v_legacy_key text;
begin
  foreach v_legacy_key in array array[
    'rpa', 'voice_ai', 'lead_scoring', 'data_enrichment', 'enterprise_security',
    'document_ai', 'social_media', 'analytics', 'user_admin'
  ]
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

-- 4. Upgrade jevexa_credit_settle to record extra_credits and metadata (including web_search) atomically
drop function if exists public.jevexa_credit_settle(uuid, uuid, integer);
drop function if exists public.jevexa_credit_settle(uuid, uuid, integer, integer, jsonb);
create or replace function public.jevexa_credit_settle(
  p_user_id uuid,
  p_request_id uuid,
  p_usage_tokens integer,
  p_extra_credits integer default 0,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
  v_charge integer;
  v_extra integer;
  v_applied_extra integer;
  v_total_charged integer;
  v_available_after_base integer;
  v_metadata jsonb;
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

  if v_reservation.status = 'settled' then
    v_applied_extra := coalesce((v_reservation.provider_usage->>'extra_credits')::integer, 0);
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'charged_credits', v_reservation.charged_credits,
      'extra_credits_charged', v_applied_extra,
      'total_charged_credits', v_reservation.charged_credits + v_applied_extra,
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

  if v_charge > v_reservation.reserved_credits then
    v_charge := v_reservation.reserved_credits;
  end if;

  v_available_after_base := v_balance + v_reservation.reserved_credits - v_charge;
  v_extra := greatest(0, coalesce(p_extra_credits, 0));
  v_applied_extra := least(v_extra, greatest(0, v_available_after_base));
  v_total_charged := v_charge + v_applied_extra;
  v_metadata := coalesce(p_metadata, '{}'::jsonb)
    || pg_catalog.jsonb_build_object(
      'total_tokens', v_tokens,
      'base_credits', v_charge,
      'extra_credits', v_applied_extra
    );

  update public.user_credits
  set balance = v_available_after_base - v_applied_extra,
      updated_at = pg_catalog.now()
  where user_id = p_user_id
  returning balance into v_balance;

  update public.credit_reservations
  set status = 'settled',
      charged_credits = v_charge,
      provider_usage = v_metadata,
      completed_at = pg_catalog.now()
  where id = v_reservation.id;

  if v_reservation.service = 'content_generation' then
    v_description := 'Content generation usage';
  elsif v_reservation.service like 'ai_chat%' then
    v_description := 'AI chat usage';
  else
    v_description := 'AI service usage';
  end if;

  insert into public.credit_transactions (
    user_id, amount, description, type, reference, service, status, request_id, metadata
  ) values (
    p_user_id,
    -v_total_charged,
    v_description,
    'usage',
    'usage:' || p_request_id::text,
    v_reservation.service,
    'settled',
    p_request_id,
    v_metadata
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'charged_credits', v_charge,
    'extra_credits_charged', v_applied_extra,
    'total_charged_credits', v_total_charged,
    'balance', v_balance,
    'total_tokens', v_tokens
  );
end;
$$;

revoke all on function public.jevexa_credit_settle(uuid, uuid, integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.jevexa_credit_settle(uuid, uuid, integer, integer, jsonb) to service_role;
