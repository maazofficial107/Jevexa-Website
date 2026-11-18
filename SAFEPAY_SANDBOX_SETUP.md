# JEVEXA Safepay Sandbox Setup

This package adds a one-time hosted checkout flow for the current Starter, Pro and Business price cards. It uses the Safepay **sandbox** endpoint only. It does not enable recurring auto-renewal. Yearly checkout charges the displayed yearly monthly price x 12 as one prepaid purchase.

## 1. Run one SQL migration

In Supabase Dashboard → SQL Editor → New query, paste and run `supabase/safepay_billing_migration.sql`. Do not rerun the older full setup unless needed.

## 2. Add Cloudflare Worker secrets

In Cloudflare → Workers & Pages → `jevexa-website` → Settings → Variables and Secrets, add these as **Secrets**:

- `SUPABASE_SERVICE_ROLE_KEY` — Supabase legacy `service_role` JWT key from Project Settings → API (server-only; never frontend).
- `SAFEPAY_API_KEY` — Safepay sandbox public API key.
- `SAFEPAY_SECRET_KEY` — Safepay sandbox secret API key.
- `SAFEPAY_WEBHOOK_SECRET` — shared HMAC secret shown under Safepay Sandbox Dashboard → Developers → Endpoints.

Optional non-secret values may be configured as Worker variables for the existing production deployment only:

- `SUPABASE_URL` = the production Supabase project URL.
- `SUPABASE_ANON_KEY` = the production Supabase publishable key used by the frontend.

For staging, create a separate Supabase project and use its URL/key on a separate staging Worker or local `.dev.vars`. Never reuse production Supabase settings in staging. The frontend gets the public URL/key from `/config.js`; the service-role key remains Worker-only. Do not deploy this setup as part of staging verification.

Do not paste secrets into chat, GitHub, `script.js`, or the ZIP.

## 3. Configure the Safepay sandbox webhook

In Safepay Sandbox Dashboard → Developers → Endpoints, add this HTTPS endpoint:

`https://jevexa.net/api/safepay/webhook`

Subscribe to `payment.succeeded` (2.0.0). If you test the `workers.dev` hostname instead, use that exact deployed hostname in the endpoint. Use the **sandbox** shared HMAC secret.

## 4. Install/check/deploy

From the project folder in VS Code terminal:

```bash
node --check script.js
node --check worker.js
npx wrangler deploy --dry-run
npx wrangler deploy
```

No extra npm dependency is needed for the Worker implementation.

## 5. Test safely

1. Sign in to JEVEXA.
2. Choose a paid plan; the browser should redirect to Safepay sandbox hosted checkout.
3. Complete a sandbox test payment.
4. Verify the `payment.succeeded` webhook delivery in Safepay and the matching `billing_orders` row becomes `paid`.
5. Confirm `user_credits.balance` and `credit_transactions` update exactly once.
6. Test a cancelled/failed payment and ensure no paid credits are added.

The return page is informational; the signed webhook is the source of truth. If checkout creation fails, check Worker logs and the exact sandbox keys. Do not switch to live keys until Safepay approves the production merchant account and you configure its separate live API/HMAC keys and endpoint.

## Current billing scope

This integration handles one-time purchases and verified credit grants. It does not create automatic recurring subscriptions, subscription cancellation/renewal, refunds/chargebacks credit reversal, or usage-based credit deduction. Do not market those as implemented until they are separately built and tested.
