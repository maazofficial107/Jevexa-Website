# JEVEXA Audit & Release Notes

## Scope
This package is based on the supplied JEVEXA ZIP. Local repository metadata, Wrangler cache/account data, and editor-specific settings were excluded from the delivery ZIP.

## Checks performed
- Inspected the main frontend files (`index.html`, `script.js`, `styles.css`, `admin.html`), Cloudflare Worker (`worker.js`), Wrangler configuration, and Supabase SQL setup.
- JavaScript syntax checks are required before release; this package does not claim full browser, payment-provider, or production end-to-end verification.
- Existing Worker routes include `/api/chat`, `/api/contact`, and authenticated `/api/support/tickets`.
- Existing Supabase SQL defines user credit balances, a transaction ledger, pending billing orders, RLS read policies, and a signup trigger granting 100 welcome credits.

## Important production blockers
- The Worker implements a Safepay staging checkout and signed webhook. The browser return page is informational only; only the verified server webhook may mark orders paid or grant paid credits. Live payments remain disabled.
- Chat uses server-side tier checks and fixed-credit reservations; OpenRouter calls require `OPENROUTER_API_KEY`. Content Generation remains metered by provider-reported usage.
- Real authentication, database access, email verification, password reset, and account settings require testing against the configured Supabase project.
- Local browser checks covered 320, 360, 375, 390, 430, 768, 820, 1024, and 1280px. Real Supabase sign-in, production checkout, and authenticated account journeys still require configured credentials and external dashboard verification.
- Configure Worker secrets with Wrangler secret commands; never commit `.dev.vars`, `.env`, service-role keys, or gateway secrets.

## Before production
1. Review and run `supabase/jevexa_saas_setup.sql` in a backup/staging Supabase project first; review existing policies and user data before production migration.
2. Set Worker secrets securely using `npx wrangler secret put OPENROUTER_API_KEY`, `RESEND_API_KEY`, and any configured sender/recipient values. Do not remove any existing secret without explicit authorization.
3. Complete merchant review and production-specific verification before enabling live payments; the current Worker intentionally gates Safepay to staging.
4. Run browser journeys for signup, email verification, login/logout, password reset, chat, credit exhaustion, staging checkout success/failure, webhook retries, and account data access.
5. Confirm responsive layouts at 320, 360, 375, 390, 430, tablet, and desktop widths.

## Environment template
`.dev.vars.example` documents Worker secrets without containing real credentials. Copy it only for local development and keep actual `.dev.vars` out of Git.
