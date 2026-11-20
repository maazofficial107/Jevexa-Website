-- Follow-up privilege correction for the existing Safepay Worker routes.
-- Apply to the intended staging project after the three existing migrations; repeatable.
-- Does not enable live payments or grant any browser-role access.

-- AUDIT NOTE: This grants only SELECT/INSERT/UPDATE on billing_orders to service_role.
-- The jevexa_apply_safepay_payment() function (SECURITY DEFINER) handles writes internally;
-- direct UPDATE via REST also needs UPDATE privilege which this correctly grants.
-- DELETE is intentionally omitted (orders must not be hard-deleted).
grant select, insert, update on public.billing_orders to service_role;
