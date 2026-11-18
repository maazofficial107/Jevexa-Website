-- JEVEXA Safepay one-time checkout migration.
-- Run in Supabase SQL Editor after the existing JEVEXA SaaS setup.
-- Paid credits are only granted by the server after a verified Safepay webhook.

alter table public.credit_transactions
  add column if not exists reference text;

create unique index if not exists credit_transactions_unique_reference_idx
  on public.credit_transactions(user_id, reference)
  where reference is not null;

alter table public.billing_orders
  add column if not exists provider text,
  add column if not exists provider_order_id text,
  add column if not exists checkout_url text,
  add column if not exists paid_at timestamptz;

create unique index if not exists billing_orders_provider_order_id_unique_idx
  on public.billing_orders(provider_order_id)
  where provider_order_id is not null;

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

revoke all on function public.jevexa_apply_safepay_payment(text, bigint, text) from public;
revoke all on function public.jevexa_apply_safepay_payment(text, bigint, text) from anon, authenticated;
grant execute on function public.jevexa_apply_safepay_payment(text, bigint, text) to service_role;
