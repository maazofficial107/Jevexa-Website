-- Authenticated human-support tickets. Run in Supabase SQL Editor.
-- Does not modify user balances or grant credits.

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

alter table public.support_tickets add column if not exists name text;
alter table public.support_tickets alter column user_id drop not null;
alter table public.support_tickets drop constraint if exists support_tickets_user_id_fkey;
alter table public.support_tickets
  add constraint support_tickets_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

create index if not exists support_tickets_user_created_idx
  on public.support_tickets(user_id, created_at desc);

alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from public, anon, authenticated;
grant select on public.support_tickets to authenticated;
grant select, insert on public.support_tickets to service_role;

drop policy if exists "Users read own support tickets" on public.support_tickets;
create policy "Users read own support tickets" on public.support_tickets
  for select to authenticated using (auth.uid() = user_id);
