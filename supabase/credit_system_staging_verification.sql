-- Staging verification only. Do not run this in production.
-- Confirm the SQL Editor is connected to jevexa-staging before running.
-- Run the complete file, not a selected statement. The sole result row is emitted
-- only after every assertion succeeds and the transaction has been rolled back.
-- Automatically selects one unused test account and a second account for RLS checks.
-- This script rolls back all reservation/settlement test data at the end.
-- It does not create Auth users, call Gemini, or permanently alter wallet/ledger data.

begin;

create temporary table jevexa_credit_test_users (
  user_id uuid primary key,
  test_slot text not null unique check (test_slot in ('a', 'b')),
  reserve_one uuid not null default gen_random_uuid(),
  reserve_two uuid not null default gen_random_uuid(),
  reserve_three uuid not null default gen_random_uuid()
) on commit drop;

insert into jevexa_credit_test_users (user_id, test_slot)
with valid_test_users as (
  select u.id, u.created_at, c.balance,
         (select count(*) from public.credit_transactions t where t.user_id = u.id) as transaction_count,
         not exists (
           select 1 from public.credit_reservations r where r.user_id = u.id
         ) as has_no_reservations
  from auth.users u
  join public.user_credits c on c.user_id = u.id
  where u.email like 'jevexa-credit-%@example.com'
    and u.raw_user_meta_data->>'jevexa_staging_credit_test' = 'true'
    and exists (
      select 1 from public.credit_transactions t
      where t.user_id = u.id
        and t.reference = 'signup:' || u.id::text
        and t.type = 'welcome'
        and t.amount = 100
    )
), fresh_user as (
  select id
  from valid_test_users
  where balance = 100 and transaction_count = 1 and has_no_reservations
  order by created_at desc, id
  limit 1
), other_user as (
  select v.id
  from valid_test_users v
  where v.id <> (select id from fresh_user)
  order by v.created_at desc, v.id
  limit 1
)
select id, 'a' from fresh_user
union all
select id, 'b' from other_user;

do $$
begin
  if (select count(*) from jevexa_credit_test_users) <> 2 then
    raise exception 'FAIL: two retained, unused staging credit-test accounts were not found; run the guarded staging integration test first';
  end if;
end;
$$;

alter table jevexa_credit_test_users enable row level security;

create policy staging_credit_test_users_self_read
  on jevexa_credit_test_users
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy staging_credit_test_users_service_read
  on jevexa_credit_test_users
  for select to service_role
  using (true);

revoke all on jevexa_credit_test_users from public, anon, authenticated, service_role;
grant select on jevexa_credit_test_users to authenticated, service_role;

do $$
declare
  v_user_a uuid;
  v_user_b uuid;
  v_index_count integer;
  v_trigger_count integer;
  v_security_function_count integer;
  v_service_count integer;
  v_client_count integer;
  v_unavailable_count integer;
begin
  select user_id into v_user_a
  from jevexa_credit_test_users where test_slot = 'a';
  select user_id into v_user_b
  from jevexa_credit_test_users where test_slot = 'b';

  if v_user_a = v_user_b then
    raise exception 'FAIL: two distinct staging test users are required';
  end if;
  if not (
    select relrowsecurity and relpersistence = 't'
    from pg_catalog.pg_class
    where oid = 'pg_temp.jevexa_credit_test_users'::regclass
  ) then
    raise exception 'FAIL: test-user table must be temporary and have row-level security enabled';
  end if;
  if (
    select count(*) from pg_catalog.pg_policy
    where polrelid = 'pg_temp.jevexa_credit_test_users'::regclass
  ) <> 2 or exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'pg_temp.jevexa_credit_test_users'::regclass
      and polcmd <> 'r'
  ) or not exists (
    select 1
    from pg_catalog.pg_policy p
    where p.polrelid = 'pg_temp.jevexa_credit_test_users'::regclass
      and p.polname = 'staging_credit_test_users_self_read'
      and p.polcmd = 'r'
      and p.polroles = array[(select oid from pg_catalog.pg_roles where rolname = 'authenticated')]
      and pg_catalog.pg_get_expr(p.polqual, p.polrelid) ilike '%auth.uid%'
      and pg_catalog.pg_get_expr(p.polqual, p.polrelid) ilike '%user_id%'
  ) or not exists (
    select 1
    from pg_catalog.pg_policy p
    where p.polrelid = 'pg_temp.jevexa_credit_test_users'::regclass
      and p.polname = 'staging_credit_test_users_service_read'
      and p.polcmd = 'r'
      and p.polroles = array[(select oid from pg_catalog.pg_roles where rolname = 'service_role')]
      and pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true'
  ) then
    raise exception 'FAIL: temporary test-user table must have only its two scoped read policies';
  end if;
  if not has_table_privilege('authenticated', 'pg_temp.jevexa_credit_test_users', 'SELECT')
     or has_table_privilege('authenticated', 'pg_temp.jevexa_credit_test_users', 'INSERT')
     or has_table_privilege('authenticated', 'pg_temp.jevexa_credit_test_users', 'UPDATE')
     or has_table_privilege('authenticated', 'pg_temp.jevexa_credit_test_users', 'DELETE')
     or has_table_privilege('anon', 'pg_temp.jevexa_credit_test_users', 'SELECT')
     or has_table_privilege('anon', 'pg_temp.jevexa_credit_test_users', 'INSERT')
     or has_table_privilege('anon', 'pg_temp.jevexa_credit_test_users', 'UPDATE')
     or has_table_privilege('anon', 'pg_temp.jevexa_credit_test_users', 'DELETE')
     or not has_table_privilege('service_role', 'pg_temp.jevexa_credit_test_users', 'SELECT')
     or has_table_privilege('service_role', 'pg_temp.jevexa_credit_test_users', 'INSERT')
     or has_table_privilege('service_role', 'pg_temp.jevexa_credit_test_users', 'UPDATE')
     or has_table_privilege('service_role', 'pg_temp.jevexa_credit_test_users', 'DELETE') then
    raise exception 'FAIL: temporary test-user table grants do not match the required read-only roles';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_class c
    cross join lateral pg_catalog.aclexplode(
      coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
    ) acl
    where c.oid = 'pg_temp.jevexa_credit_test_users'::regclass
      and acl.grantee = 0
  ) then
    raise exception 'FAIL: PUBLIC must not have privileges on the temporary test-user table';
  end if;
  if not exists (select 1 from auth.users where id = v_user_a)
     or not exists (select 1 from auth.users where id = v_user_b) then
    raise exception 'FAIL: one or both test users do not exist in this Supabase project';
  end if;

  if (select count(*) from public.user_credits where user_id = v_user_a) <> 1
     or (select balance from public.user_credits where user_id = v_user_a) <> 100
     or (select count(*) from public.user_credits where user_id = v_user_b) <> 1 then
    raise exception 'FAIL: the fresh account must have 100 credits and both test accounts must have wallets';
  end if;

  if (select count(*) from public.credit_transactions
      where user_id = v_user_a and reference = 'signup:' || v_user_a::text
        and type = 'welcome' and amount = 100) <> 1
     or (select count(*) from public.credit_transactions
      where user_id = v_user_b and reference = 'signup:' || v_user_b::text
        and type = 'welcome' and amount = 100) <> 1 then
    raise exception 'FAIL: each test account must have exactly one 100-credit signup ledger row';
  end if;
  raise notice 'PASS: signup wallets and welcome ledger entries exist exactly once';

  if not (
    select relrowsecurity from pg_catalog.pg_class
    where oid = 'public.user_credits'::regclass
  ) or not (
    select relrowsecurity from pg_catalog.pg_class
    where oid = 'public.credit_transactions'::regclass
  ) or not (
    select relrowsecurity from pg_catalog.pg_class
    where oid = 'public.credit_reservations'::regclass
  ) then
    raise exception 'FAIL: RLS is not enabled on every credit data table';
  end if;

  select count(*) into v_index_count
  from pg_catalog.pg_indexes
  where schemaname = 'public'
    and indexname = 'credit_transactions_unique_reference_idx';
  if v_index_count <> 1 then
    raise exception 'FAIL: unique signup/payment reference index is missing';
  end if;

  select count(*) into v_trigger_count
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
    and (
      (n.nspname = 'auth' and c.relname = 'users'
        and t.tgname = 'on_auth_user_created_jevexa')
      or
      (n.nspname = 'public' and c.relname = 'credit_transactions'
        and t.tgname = 'jevexa_credit_ledger_immutable')
    );
  if v_trigger_count <> 2 then
    raise exception 'FAIL: signup or ledger immutability trigger is missing';
  end if;

  select count(*) into v_security_function_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'jevexa_credit_quote', 'jevexa_credit_reserve',
      'jevexa_credit_settle', 'jevexa_credit_release',
      'jevexa_credit_adjust'
    )
    and p.prosecdef
    and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%';
  if v_security_function_count <> 5 then
    raise exception 'FAIL: credit RPC SECURITY DEFINER or fixed search_path configuration is missing';
  end if;

  select count(*) into v_service_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'jevexa_credit_quote', 'jevexa_credit_reserve',
      'jevexa_credit_settle', 'jevexa_credit_release',
      'jevexa_credit_adjust'
    )
    and has_function_privilege('service_role', p.oid, 'EXECUTE');

  select count(*) into v_client_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'jevexa_credit_quote', 'jevexa_credit_reserve',
      'jevexa_credit_settle', 'jevexa_credit_release',
      'jevexa_credit_adjust'
    )
    and (
      has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
    );
  if v_service_count <> 5 or v_client_count <> 0 then
    raise exception 'FAIL: credit RPC execution grants are not service-role-only';
  end if;

  if not has_table_privilege('service_role', 'public.billing_orders', 'SELECT')
     or not has_table_privilege('service_role', 'public.billing_orders', 'INSERT')
     or not has_table_privilege('service_role', 'public.billing_orders', 'UPDATE') then
    raise exception 'FAIL: Safepay Worker billing-order privileges are missing; apply safepay_service_role_permissions_migration.sql in staging';
  end if;

  if (select count(*) from public.jevexa_service_pricing) <> 12
     or not exists (
       select 1 from public.jevexa_service_pricing
       where service_key = 'ai_chat' and enabled
         and integration_status in ('available', 'partial')
         and credits_per_1000_tokens = 1
     ) then
    raise exception 'FAIL: staging pricing catalog does not match the expected chat test configuration';
  end if;
  select count(*) into v_unavailable_count
  from public.jevexa_service_pricing
  where service_key <> 'ai_chat'
    and enabled = false
    and integration_status = 'unavailable';
  if v_unavailable_count <> 11 then
    raise exception 'FAIL: all eleven unimplemented services must remain unavailable and disabled';
  end if;
  raise notice 'PASS: RLS, triggers, function security/grants, and service availability configuration';
end;
$$;

do $$
begin
  perform set_config('jevexa.credit_test.user_a', user_id::text, true)
  from jevexa_credit_test_users
  where test_slot = 'a';
end;
$$;

set local role authenticated;
do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', current_setting('jevexa.credit_test.user_a'),
      'role', 'authenticated'
    )::text,
    true
  );
  perform set_config(
    'request.jwt.claim.sub',
    current_setting('jevexa.credit_test.user_a'),
    true
  );
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

do $$
begin
  if auth.uid() is distinct from current_setting('jevexa.credit_test.user_a')::uuid then
    raise exception 'FAIL: User A JWT claims did not resolve to the selected staging test user';
  end if;
  if (select count(*) from jevexa_credit_test_users) <> 1
     or not exists (
       select 1 from jevexa_credit_test_users
       where user_id = auth.uid() and test_slot = 'a'
     ) then
    raise exception 'FAIL: User A can see another row in the temporary test-user table';
  end if;
  if (select count(*) from public.user_credits) <> 1
     or not exists (
       select 1 from public.user_credits
       where user_id = auth.uid() and balance = 100
     ) then
    raise exception 'FAIL: User A cannot read their own wallet';
  end if;
  if not exists (
       select 1 from public.credit_transactions where user_id = auth.uid()
     ) or exists (
       select 1 from public.credit_transactions
       where user_id <> auth.uid()
     ) then
    raise exception 'FAIL: User A ledger RLS is not isolated';
  end if;

  begin
    update public.user_credits set balance = 100 where user_id = auth.uid();
    raise exception 'TEST_FAIL: authenticated wallet update unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.jevexa_credit_adjust(
      '00000000-0000-0000-0000-000000000001'::uuid,
      gen_random_uuid(), 1, 'grant', 'Permission probe', null
    );
    raise exception 'TEST_FAIL: authenticated credit adjustment unexpectedly executed';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'PASS: User A RLS isolation and browser-side balance/RPC write denial';
end;
$$;

reset role;

do $$
begin
  perform set_config('jevexa.credit_test.user_b', user_id::text, true)
  from jevexa_credit_test_users
  where test_slot = 'b';
end;
$$;

set local role authenticated;
do $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', current_setting('jevexa.credit_test.user_b'),
      'role', 'authenticated'
    )::text,
    true
  );
  perform set_config(
    'request.jwt.claim.sub',
    current_setting('jevexa.credit_test.user_b'),
    true
  );
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

do $$
begin
  if auth.uid() is distinct from current_setting('jevexa.credit_test.user_b')::uuid then
    raise exception 'FAIL: User B JWT claims did not resolve to the selected staging test user';
  end if;
  if (select count(*) from jevexa_credit_test_users) <> 1
     or not exists (
       select 1 from jevexa_credit_test_users
       where user_id = auth.uid() and test_slot = 'b'
     ) then
    raise exception 'FAIL: User B can see another row in the temporary test-user table';
  end if;
  if (select count(*) from public.user_credits) <> 1
     or not exists (
       select 1 from public.user_credits
       where user_id = auth.uid()
     )
     or exists (select 1 from public.user_credits where user_id <> auth.uid())
     or exists (select 1 from public.credit_transactions where user_id <> auth.uid()) then
    raise exception 'FAIL: User B can see another user wallet or ledger';
  end if;
  raise notice 'PASS: User B cannot read User A wallet or ledger';
end;
$$;

reset role;

do $$
declare
  v_user_a uuid;
  v_first uuid;
  v_second uuid;
  v_third uuid;
  v_result_one jsonb;
  v_result_two jsonb;
  v_result_three jsonb;
  v_settlement jsonb;
  v_release jsonb;
  v_replay jsonb;
  v_replay_settlement jsonb;
  v_replay_release jsonb;
begin
  select user_id, reserve_one, reserve_two, reserve_three
  into v_user_a, v_first, v_second, v_third
  from jevexa_credit_test_users
  where test_slot = 'a';

  if exists (
    select 1 from public.credit_reservations
    where user_id = v_user_a
      and created_at > now() - interval '1 minute'
  ) then
    raise exception 'FAIL: use a fresh test account with no recent reservations';
  end if;

  -- Sequential calls in this transaction test serialized balance accounting,
  -- not true parallel execution. The SQL Editor uses one database session.
  v_result_one := public.jevexa_credit_reserve(v_user_a, v_first, 'ai_chat', 50000);
  v_result_two := public.jevexa_credit_reserve(v_user_a, v_second, 'ai_chat', 50000);
  v_result_three := public.jevexa_credit_reserve(v_user_a, v_third, 'ai_chat', 50000);

  if v_result_one->>'status' <> 'reserved'
     or v_result_two->>'status' <> 'reserved'
     or v_result_one->>'reserved_credits' <> '50'
     or v_result_two->>'reserved_credits' <> '50'
     or v_result_three->>'error' <> 'insufficient_credits'
     or (select balance from public.user_credits where user_id = v_user_a) <> 0 then
    raise exception 'FAIL: reservation or insufficient-credit behavior did not match expectations';
  end if;
  raise notice 'PASS: reservations consume only available credits and reject insufficient balance';

  v_settlement := public.jevexa_credit_settle(v_user_a, v_first, 1000);
  if v_settlement->>'ok' <> 'true'
     or v_settlement->>'charged_credits' <> '1'
     or (select balance from public.user_credits where user_id = v_user_a) <> 49 then
    raise exception 'FAIL: one measured 1,000-token settlement did not charge one credit';
  end if;

  v_replay := public.jevexa_credit_reserve(v_user_a, v_first, 'ai_chat', 50000);
  v_replay_settlement := public.jevexa_credit_settle(v_user_a, v_first, 1000);
  if v_replay->>'duplicate' <> 'true'
     or v_replay->>'status' <> 'settled'
     or v_replay_settlement->>'duplicate' <> 'true'
     or (select count(*) from public.credit_transactions
         where user_id = v_user_a and request_id = v_first) <> 1 then
    raise exception 'FAIL: duplicate reservation or settlement was not idempotent';
  end if;

  v_release := public.jevexa_credit_release(v_user_a, v_second);
  v_replay_release := public.jevexa_credit_release(v_user_a, v_second);
  if v_release->>'ok' <> 'true'
     or v_replay_release->>'duplicate' <> 'true'
     or (select balance from public.user_credits where user_id = v_user_a) <> 99 then
    raise exception 'FAIL: reservation release or duplicate release was not idempotent';
  end if;

  if (select count(*) from public.credit_transactions
      where user_id = v_user_a and request_id = v_first
        and amount = -1 and metadata->>'total_tokens' = '1000') <> 1
     or (select count(*) from public.credit_reservations
      where user_id = v_user_a and request_id = v_first and status = 'settled') <> 1
     or (select count(*) from public.credit_reservations
      where user_id = v_user_a and request_id = v_second and status = 'released') <> 1
     or exists (
       select 1 from public.credit_reservations
       where user_id = v_user_a and request_id = v_third
     ) then
    raise exception 'FAIL: ledger or reservation history does not match settlement/release results';
  end if;
  raise notice 'PASS: usage settlement, duplicate protection, release/refund, and transaction history';
end;
$$;

set local role authenticated;
do $$
declare
  v_user_b uuid;
begin
  select user_id into v_user_b
  from jevexa_credit_test_users
  where test_slot = 'b';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_user_b::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', v_user_b::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

do $$
begin
  if exists (
    select 1 from public.credit_reservations
    where user_id = current_setting('jevexa.credit_test.user_a')::uuid
  ) or exists (
    select 1 from public.credit_transactions
    where user_id = current_setting('jevexa.credit_test.user_a')::uuid
  ) then
    raise exception 'FAIL: User B can read User A test reservations or ledger';
  end if;
  raise notice 'PASS: RLS hides User A reservation and transaction rows from User B';
end;
$$;

reset role;
grant select, update, delete on public.credit_transactions to service_role;
set local role service_role;

do $$
declare
  v_user_a uuid;
  v_request_id uuid;
  v_transaction_id uuid;
begin
  if (select count(*) from jevexa_credit_test_users) <> 2 then
    raise exception 'FAIL: service_role cannot read both temporary test-user rows';
  end if;
  select user_id, reserve_one into v_user_a, v_request_id
  from jevexa_credit_test_users
  where test_slot = 'a';
  select id into v_transaction_id
  from public.credit_transactions
  where user_id = v_user_a and request_id = v_request_id;
  if v_transaction_id is null then
    raise exception 'FAIL: settled test ledger row is missing';
  end if;

  begin
    update public.credit_transactions
    set amount = amount
    where id = v_transaction_id;
    raise exception 'TEST_FAIL: ledger update was not blocked';
  exception when others then
    if sqlerrm = 'Credit ledger entries cannot be changed or deleted' then
      null;
    elsif sqlerrm = 'TEST_FAIL: ledger update was not blocked' then
      raise;
    else
      raise;
    end if;
  end;

  begin
    delete from public.credit_transactions where id = v_transaction_id;
    raise exception 'TEST_FAIL: ledger delete was not blocked';
  exception when others then
    if sqlerrm = 'Credit ledger entries cannot be changed or deleted' then
      null;
    elsif sqlerrm = 'TEST_FAIL: ledger delete was not blocked' then
      raise;
    else
      raise;
    end if;
  end;

  if not exists (
    select 1 from public.credit_transactions
    where id = v_transaction_id and amount = -1
  ) then
    raise exception 'FAIL: immutability probes changed the ledger';
  end if;
  raise notice 'PASS: ledger update and delete are blocked; original ledger row remains intact';
end;
$$;

rollback;

select
  'PASS' as overall_status,
  'PASS' as signup_wallet_and_100_credit_grant,
  'PASS' as signup_welcome_ledger_single_entry,
  'PASS' as credit_table_rls_enabled,
  'PASS' as temporary_user_table_least_privilege,
  'PASS' as user_a_isolation_and_browser_write_denial,
  'PASS' as user_b_isolation,
  'PASS' as credit_rpc_security_and_grants,
  'PASS' as safepay_billing_order_permissions,
  'PASS' as pricing_and_eleven_services_disabled,
  'PASS' as reservation_and_insufficient_credit_handling,
  'PASS' as token_settlement_and_duplicate_protection,
  'PASS' as release_and_duplicate_protection,
  'PASS' as cross_user_reservation_and_ledger_isolation,
  'PASS' as ledger_immutability;
