-- ==============================================================================
-- JEVEXA AI Automation Studio — User Memories Migration
-- Plan-Scaled Persistent Memory (Supabase Free-Tier Safe & Lightweight)
-- ==============================================================================

create table if not exists public.user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (length(trim(content)) > 0 and length(content) <= 2000),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fast lookup index per user
create index if not exists idx_user_memories_user_id on public.user_memories(user_id);
create index if not exists idx_user_memories_updated on public.user_memories(user_id, updated_at desc);

-- Enable Row Level Security (RLS)
alter table public.user_memories enable row level security;

-- Policies for authenticated user access
drop policy if exists "Users can view their own memories" on public.user_memories;
create policy "Users can view their own memories"
  on public.user_memories for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own memories" on public.user_memories;
create policy "Users can insert their own memories"
  on public.user_memories for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own memories" on public.user_memories;
create policy "Users can update their own memories"
  on public.user_memories for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own memories" on public.user_memories;
create policy "Users can delete their own memories"
  on public.user_memories for delete
  using (auth.uid() = user_id);
