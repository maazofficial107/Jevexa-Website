# JEVEXA fixes and verification

## Changes in this bundle
- Hid Login and Create Account entry points while a Supabase user is signed in; these return after sign-out.
- Restored the built-in JEVEXA chat widget and removed the third-party Botpress widget.
- Added responsive layout separation for the chatbot and JEVEXA support launcher.
- Removed planned-only automation cards from the public feature section and simplified copy to describe only current capabilities.
- Replaced repeated customer-facing provider branding with neutral “AI chat” language.
- Excluded local credentials, Wrangler state, and installed dependencies from this release archive.

## Automated checks
- `npm test`: all 79 tests passed, including fixed-pricing validation and reservation-mismatch release coverage.
- `node --check` and complete test suite are run during packaging.
- ZIP integrity and secret-file exclusion are verified.

## Not claimed as verified
- Live Supabase login/signup, production credit balance, OpenRouter provider access, payment provider/webhook, and authenticated mobile journeys require live credentials and browser/network access.
- Payments remain disabled/Coming Soon until merchant approval and verified production webhook configuration.
