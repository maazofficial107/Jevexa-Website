# JEVEXA — SaaS release notes and setup

## Included in this repair package
- Existing website, authentication UI, settings, account menu, contact form, and Cloudflare Worker retained.
- Added `supabase/jevexa_saas_setup.sql` to create/backfill the free-credit account for new and existing users, add transaction/order tables, and enable user-scoped read policies.

## Migration status and safety
The owner has reported that the three credit-system migrations and the Safepay service-role permissions migration have already been applied to `jevexa-staging`. Do not rerun or reapply them there. The owner also reports the latest verification run returned `overall_status = PASS`. The verifier emits that summary only after its assertions and rollback; this result covers the checks listed in its final row, but it does not prove real Gemini/Safepay operation or true parallel database concurrency.

The migration sequence below is for provisioning a separate, empty staging project only. Confirm the target project before applying any SQL. Never use this sequence against production.

The script does not overwrite balances for users who already have a credit row. Existing users who have a row with 0 credits keep that balance intentionally; do not silently grant paid credits. If you want to grant a promotional balance to existing users, decide the policy first and do it as a recorded admin adjustment.

## Atomic credit system
For a new, empty staging project only, run `supabase/jevexa_saas_setup.sql`, then `supabase/safepay_billing_migration.sql`, then `supabase/credit_system_migration.sql` in the Supabase SQL Editor, in that order. The credit migration depends on the tables and Safepay columns created by the first two migrations. These steps are not for the already-migrated `jevexa-staging` project.

New signups retain the existing one-time 100-credit welcome grant. The credit migration does not reset or backfill balances. Browser clients can read only their own balance, ledger and reservation history; all balance changes are made by privileged database functions called from the Worker.

The only currently connected paid AI service is the Gemini-powered chatbot. Its centralized `jevexa_service_pricing` row defaults to 1 credit per 1,000 provider tokens. The Worker reserves a conservative maximum before calling Gemini, then charges from provider-reported token usage and releases unused reserved credits. A definitive provider error releases the reservation. A timeout or transport failure has an uncertain provider outcome, so the reservation stays held; a database/network failure after Gemini succeeds is handled the same way rather than risking uncharged paid work. The browser persists an ambiguous request ID and checks that user's RLS-protected reservation state before allowing another paid request; an active hold remains blocked for support reconciliation. Investigate the request ID in Worker logs before settling or releasing a held reservation. The migration rate-limits a user to 10 AI requests per minute.

The other 11 service cards do not have provider implementations and remain disabled in the pricing catalog; they cannot spend credits. Change the chatbot rate in Supabase only after choosing the intended business pricing. Safepay remains a separate sandbox/payment flow and is not enabled as a top-up in the credit UI.

## Staging credit verification
`tests/staging-credit.integration.mjs` is an opt-in live staging check. It reads `.dev.vars`, requires the exact verified `jevexa-staging` project host, and requires an explicit `JEVEXA_STAGING_CONFIRM=jevexa-staging` confirmation. Its read-only preflight is:

```powershell
$env:JEVEXA_STAGING_CONFIRM = 'jevexa-staging'
node tests/staging-credit.integration.mjs --preflight-only
Remove-Item Env:JEVEXA_STAGING_CONFIRM
```

The full integration run creates or reuses clean, specially marked staging Auth test users and checks signup grants, duplicate signup, RLS, browser write denial, concurrent RPC reservations, measured-token settlement, idempotency, release and final balances. It deliberately keeps its staging test users and audit rows; it does not delete users, call Gemini, deploy, or run migrations. To run it, omit `--preflight-only` from the command. Do not run it against production.

The live staging audit found that `service_role` cannot read `billing_orders`, so the current Safepay checkout route cannot complete its direct order API calls. After reviewing this narrowly scoped grant, apply `supabase/safepay_service_role_permissions_migration.sql` to staging only; it grants `service_role` SELECT/INSERT/UPDATE on billing orders and gives no browser-role access. Do not rerun the three already-applied migrations. This does not enable live payments; checkout code remains on Safepay's sandbox endpoint.

For the database-owner checks, use `supabase/credit_system_staging_verification.sql` in the staging SQL Editor only, after that follow-up grant. Run the **entire file**, not a selected statement. It automatically selects one retained, unused staging test account for rollback-only credit operations and a second account for RLS isolation; no UUID editing is needed. Its temporary test-user table has RLS enabled, self-only reads for each authenticated test user, a service-role-only read policy, and no write grants/policies to browser roles. It sets each selected user's JWT claims without emitting intermediate result sets and verifies `auth.uid()` before checking row visibility. The ledger-trigger probe grants `service_role` only the temporary SELECT/UPDATE/DELETE rights it needs inside the transaction. It checks signup state, RLS/function privileges, sequential reserve/insufficient-balance behavior, settlement/release/duplicates, ledger consistency, and update/delete trigger behavior. On success, it rolls back first and then emits exactly one summary row with named PASS checks. A SQL error before that final row means verification did not complete; capture the exact error and do not treat earlier notices or result rows as full success. It does not create Auth users or prove truly simultaneous database execution; the integration runner separately sends concurrent RPC calls. The reported `overall_status = PASS` is evidence that the verifier reached its final summary; the complete per-check columns and SQL Editor execution metadata were not independently captured in this workspace.

## Isolated staging setup
Use a separate Supabase project for staging. The checked-in application settings no longer contain a Supabase URL or public key, and the Worker no longer falls back to the production project. The frontend loads its public Supabase URL/key from `/config.js`, served from that Worker’s environment; `/config.js` returns 503 when the required Worker settings are missing. Do not point staging settings at the production project.

1. In the Supabase Dashboard, create a new project named `jevexa-staging` (or similar) in your organization. Choose a region, create a unique database password, and save that password in your password manager. Do not restore production data into it.
2. In the new project, open **Project Settings → API** (or **API Keys**) and copy the project URL, publishable/anon public key, and service-role/secret key directly into your local secret store. Do not send any of these values in chat or commit them.
3. In **Authentication → URL Configuration**, set the Site URL to your local app URL for local staging (normally `http://localhost:8787`) and add that origin plus any future staging Worker origin to the allowed redirect URLs. Enable only the sign-in methods you intend to test.
4. In the staging project’s SQL Editor, apply `supabase/jevexa_saas_setup.sql`, then `supabase/safepay_billing_migration.sql`, then `supabase/credit_system_migration.sql`. Never run these staging steps in the production project.
5. Locally, copy `.dev.vars.example` to `.dev.vars` and replace `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` with values from the staging project. Set `JEVEXA_ADMIN_EMAIL` to the verified staging admin account email if testing the protected contacts dashboard. `.dev.vars` is gitignored. Add `GEMINI_API_KEY` only if testing real Gemini calls; use a test-purpose provider key and budget controls. Leave Resend and all `SAFEPAY_*` variables unset unless separately testing those integrations with dedicated staging credentials.
6. Run `npx wrangler dev` and open its local URL. Check that `/config.js` returns the staging project URL and a public key only—never the service-role key. If the local Worker has no complete Supabase configuration, the route must return 503 rather than silently using production.
7. Verify signup credits, user-isolated RLS, client write denial, duplicate request behavior, insufficient balance, successful settlement, provider-failure/timeout release, and concurrent reservations using staging accounts. Use test accounts and inspect staging balances/ledger only.

For a future remotely hosted staging site, create a separate Cloudflare Worker (for example `jevexa-staging`) and set the same Supabase variables in that Worker’s **Settings → Variables and Secrets**. Set `JEVEXA_ADMIN_EMAIL` to the staging admin’s verified account email. Store `SUPABASE_SERVICE_ROLE_KEY` as a secret; `SUPABASE_URL` and `SUPABASE_ANON_KEY` are public configuration values, although they should still point only to staging there. Do not deploy as part of local verification.

## Worker environment variables and secrets
For a future production release, set the production project’s values in Cloudflare Workers > `jevexa-website` > Settings > Variables and Secrets before deploying. Do not use production values in local staging or a staging Worker.
- `JEVEXA_ENVIRONMENT=production` — required environment marker. The Worker rejects configuration unless the Supabase host matches the production allowlist; staging must use `JEVEXA_ENVIRONMENT=staging` and the separate staging project.
- `SUPABASE_URL` — project URL for the corresponding environment (production Worker uses production; a separate staging Worker uses staging).
- `SUPABASE_ANON_KEY` — publishable/anon key for that same project; this is intentionally sent to the browser by `/config.js`.
- `SUPABASE_SERVICE_ROLE_KEY` — service-role/secret key for that same project; server-side only, never returned to the browser.
- `JEVEXA_ADMIN_EMAIL` — exact verified account email allowed to use the Worker-protected admin contacts endpoint; configure separately per environment.
- `GEMINI_API_KEY` — secret required for the AI chatbot.
- `RESEND_API_KEY` — secret required for contact form email.
- `CONTACT_TO_EMAIL` — optional recipient override.
- `CONTACT_FROM_EMAIL` — optional verified sender address; use a sender on a domain verified in Resend for production.
- `SAFEPAY_API_KEY`, `SAFEPAY_SECRET_KEY`, and `SAFEPAY_WEBHOOK_SECRET` — only for a separately configured payment environment; omit them from ordinary credit staging tests.

Safepay sandbox routes are additionally restricted in code to the verified `jevexa-staging` Supabase project (`qibnzlmgewlwzdrihcrs.supabase.co`) and require `JEVEXA_ENVIRONMENT=staging`. A staging flag and payment secrets on the production Worker do not enable those routes for the production project.

The production Worker has previously been observed using `byopcuspgnhwsrmsxqvm.supabase.co`; the Worker only serves browser config when `JEVEXA_ENVIRONMENT=production` and the URL matches that production host. It serves staging config only for `qibnzlmgewlwzdrihcrs.supabase.co` with the staging marker. `/config.js` returns only `SUPABASE_URL` and `SUPABASE_ANON_KEY`; never configure the service-role key as a browser variable.

Never put secret keys in `script.js`, `index.html`, or a public ZIP. A Gemini key shown in a screenshot should be revoked and replaced.

## Payments are not live yet
The existing Pricing buttons correctly avoid pretending that checkout succeeded. The project ZIP does not contain payment-provider credentials or a verified payment webhook. A real payment system cannot be switched on just by adding a button: the merchant account, checkout API, signed webhook, and refund/idempotency handling must all be configured. Until those are supplied and tested, **do not add credits after a browser redirect or screenshot of a receipt**.

Before activating payment, choose the provider and currency for the business and configure its server-side credentials. Then implement its signed webhook to mark one `billing_orders` row paid exactly once and add the purchased credits with a matching `credit_transactions` ledger entry.

## Deploy and verify
1. From the project folder, run `npm ci`, `npm test`, and `npm run build`.
2. Add/verify Cloudflare secrets before deployment; do not put their values in source files.
3. Push the changes to the `main` branch to trigger the configured Cloudflare Workers Build, or deploy manually with `npm run deploy`.
4. Test signup, email confirmation, login, account menu, settings, credit display, logout, chatbot, and contact form on `https://jevexa.net`.
5. Test payments in the provider's sandbox before accepting real payments.

## Current limitations
- The three credit-system migrations and the Safepay service-role permission migration have been reported as applied to staging. The rollback-only SQL verification script still needs a successful SQL Editor run; do not rerun migrations as part of that verification.
- Worker tests mock Supabase and Gemini. They verify request handling and charge/release paths but do not prove PostgreSQL transaction behavior or real provider responses.
- Safepay checkout/top-ups are not activated through the credit UI.
- Google/GitHub OAuth only works after those providers are enabled and callback URLs are configured in Supabase.
