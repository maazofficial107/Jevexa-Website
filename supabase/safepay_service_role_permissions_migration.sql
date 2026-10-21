-- Follow-up privilege correction for the existing Safepay Worker routes.
-- Apply to the intended staging project after the three existing migrations; repeatable.
-- Does not enable live payments or grant any browser-role access.

grant select, insert, update on public.billing_orders to service_role;
