-- JEVEXA SaaS foundation: user credits, ledger, orders, RLS, and signup provisioning.
-- Run in Supabase Dashboard > SQL Editor. Review existing custom policies before production use.

create extension if not exists pgcrypto;

create table if not exists public.user_credits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 100 check (balance >= 0),
  monthly_allowance integer not null default 100 check (monthly_allowance >= 0),
  plan text not null default 'free',
  updated_at timestamptz not null default now()
);

alter table public.user_credits add column if not exists balance integer not null default 100;
alter table public.user_credits add column if not exists monthly_allowance integer not null default 100;
alter table public.user_credits add column if not exists plan text not null default 'free';
alter table public.user_credits add column if not exists updated_at timestamptz not null default now();

create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null,
  description text not null default 'Credit activity',
  type text not null default 'adjustment',
  reference text,
  created_at timestamptz not null default now()
);
create index if not exists credit_transactions_user_created_idx
  on public.credit_transactions(user_id, created_at desc);

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
  status text not null default 'pending' check (status in ('pending','paid','failed','refunded','cancelled')),
  checkout_url text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists billing_orders_user_created_idx
  on public.billing_orders(user_id, created_at desc);

-- Create a free account exactly once whenever Supabase Auth creates a user.
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

-- Backfill existing users who signed up before the trigger existed.
insert into public.user_credits(user_id, balance, monthly_allowance, plan)
select id, 100, 100, 'free' from auth.users
on conflict (user_id) do nothing;

-- RLS: users may read their own balances, transaction history, and orders only.
alter table public.user_credits enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.billing_orders enable row level security;

drop policy if exists "Users read own credits" on public.user_credits;
create policy "Users read own credits" on public.user_credits
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users read own credit transactions" on public.credit_transactions;
create policy "Users read own credit transactions" on public.credit_transactions
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users read own billing orders" on public.billing_orders;
create policy "Users read own billing orders" on public.billing_orders
  for select to authenticated using (auth.uid() = user_id);

-- No client-side INSERT/UPDATE/DELETE policies are granted for balances or orders.
revoke insert, update, delete on public.user_credits from anon, authenticated;
revoke insert, update, delete on public.credit_transactions from anon, authenticated;
revoke insert, update, delete on public.billing_orders from anon, authenticated;
grant select on public.user_credits to authenticated;
grant select on public.credit_transactions to authenticated;
grant select on public.billing_orders to authenticated;

-- Payment providers must call a verified server-side webhook before any order is marked paid.
-- Do NOT expose service-role credentials or allow the browser to call a credit-grant function.
