# JEVEXA Audit & Release Notes

## Scope
This package is based on the supplied JEVEXA ZIP. Local repository metadata, Wrangler cache/account data, and editor-specific settings were excluded from the delivery ZIP.

## Checks performed
- Inspected the main frontend files (`index.html`, `script.js`, `styles.css`, `admin.html`), Cloudflare Worker (`worker.js`), Wrangler configuration, and Supabase SQL setup.
- JavaScript syntax checks are required before release; this package does not claim full browser, payment-provider, or production end-to-end verification.
- Existing Worker routes include `/api/chat` and `/api/contact`.
- Existing Supabase SQL defines user credit balances, a transaction ledger, pending billing orders, RLS read policies, and a signup trigger granting 100 welcome credits.

## Important production blockers
- Payment checkout and verified provider webhooks are not implemented in the supplied Worker. Do not mark orders paid or grant paid credits from a browser redirect.
- Secure server-authoritative AI credit deduction is not proven by the supplied Worker; frontend credit displays alone are not an accounting system.
- Real authentication, database access, email verification, password reset, and account settings require testing against the configured Supabase project.
- No live browser automation or production credentials were available for this audit; mobile visual acceptance criteria remain unverified.
- Configure Worker secrets with Wrangler secret commands; never commit `.dev.vars`, `.env`, service-role keys, or gateway secrets.

## Before production
1. Review and run `supabase/jevexa_saas_setup.sql` in a backup/staging Supabase project first; review existing policies and user data before production migration.
2. Set Worker secrets securely using `npx wrangler secret put GEMINI_API_KEY`, `RESEND_API_KEY`, and any configured sender/recipient values.
3. Implement a provider-specific checkout endpoint and signature-verified webhook before enabling paid credits or subscriptions.
4. Add atomic server-side credit reservation/deduction/refund operations and idempotency protection.
5. Run browser tests at 320, 360, 375, 390, 414, 768, 820, 1024, 1280, 1366, 1440, and 1920px.
6. Run staging journeys for signup, email verification, login/logout, password reset, chat, credit exhaustion, checkout success/failure, webhook retries, subscription renewal/cancellation, and account deletion.

## Environment template
`.dev.vars.example` documents Worker secrets without containing real credentials. Copy it only for local development and keep actual `.dev.vars` out of Git.
