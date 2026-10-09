# JEVEXA — SaaS release notes and setup

## Included in this repair package
- Existing website, authentication UI, settings, account menu, contact form, and Cloudflare Worker retained.
- Added `supabase/jevexa_saas_setup.sql` to create/backfill the free-credit account for new and existing users, add transaction/order tables, and enable user-scoped read policies.
- Removed local `.git` history and `.wrangler` cache from the release ZIP so local account/cache files are not shipped.

## Required first step: fix the 0-credit accounts
1. Open Supabase Dashboard for the project configured in `script.js`.
2. Open **SQL Editor** → **New query**.
3. Open `supabase/jevexa_saas_setup.sql`, copy all SQL into the editor, and click **Run**.
4. Test with a new account and an existing account. Existing users should receive a `user_credits` row if they did not already have one.

The script does not overwrite balances for users who already have a credit row. Existing users who have a row with 0 credits keep that balance intentionally; do not silently grant paid credits. If you want to grant a promotional balance to existing users, decide the policy first and do it as a recorded admin adjustment.

## Environment secrets (Cloudflare Worker)
Set secrets in Cloudflare Workers > `jevexa-website` > Settings > Variables and Secrets:
- `GEMINI_API_KEY` — required for the AI chatbot.
- `RESEND_API_KEY` — required for contact form email.
- `CONTACT_TO_EMAIL` — optional recipient override.
- `CONTACT_FROM_EMAIL` — optional verified sender address; use a sender on a domain verified in Resend for production.

Never put secret keys in `script.js`, `index.html`, or a public ZIP. A Gemini key shown in a screenshot should be revoked and replaced.

## Payments are not live yet
The existing Pricing buttons correctly avoid pretending that checkout succeeded. The project ZIP does not contain payment-provider credentials or a verified payment webhook. A real payment system cannot be switched on just by adding a button: the merchant account, checkout API, signed webhook, and refund/idempotency handling must all be configured. Until those are supplied and tested, **do not add credits after a browser redirect or screenshot of a receipt**.

Before activating payment, choose the provider and currency for the business and configure its server-side credentials. Then implement its signed webhook to mark one `billing_orders` row paid exactly once and add the purchased credits with a matching `credit_transactions` ledger entry.

## Deploy and verify
1. Run `node --check script.js` and `node --check worker.js`.
2. Run `npx wrangler deploy --dry-run` from the project folder.
3. Add/verify Cloudflare secrets before deployment.
4. Deploy with `npx wrangler deploy`.
5. Test signup, email confirmation, login, account menu, settings, credit display, logout, chatbot, and contact form on `https://jevexa.net`.
6. Test payments in the provider's sandbox before accepting real payments.

## Current limitations
- This package prepares the database foundation for credits and billing but does not claim a live payment gateway or automatic credit deduction for AI usage until the chosen provider and server-side usage path are configured and tested.
- Google/GitHub OAuth only works after those providers are enabled and callback URLs are configured in Supabase.
