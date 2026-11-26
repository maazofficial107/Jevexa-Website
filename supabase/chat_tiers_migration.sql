-- Fixed per-message chat pricing for the Lite, Pro, Max, and Ultra tiers.
-- Safe to rerun. Does not read or modify user balances.

insert into public.jevexa_service_pricing
  (service_key, display_name, integration_status, fixed_credits, credits_per_1000_tokens, enabled)
values
  ('ai_chat', 'AI Chat — Lite', 'available', 1, null, true),
  ('ai_chat_pro', 'AI Chat — Pro', 'available', 3, null, true),
  ('ai_chat_max', 'AI Chat — Max', 'available', 18, null, true),
  ('ai_chat_ultra', 'AI Chat — Ultra', 'available', 18, null, true)
on conflict (service_key) do update
set display_name = excluded.display_name,
    integration_status = excluded.integration_status,
    fixed_credits = excluded.fixed_credits,
    credits_per_1000_tokens = excluded.credits_per_1000_tokens,
    enabled = excluded.enabled,
    updated_at = now();
