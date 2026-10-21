# JEVEXA fixes and verification

## Changes in this bundle
- Hid Login and Create Account entry points while a Supabase user is signed in; these return after sign-out.
- Restored the built-in JEVEXA chat widget that was hidden by a global CSS rule.
- Added layout separation for the built-in chat and Botpress launcher, including a mobile breakpoint.
- Corrected the apparent zero/O character typo in the Botpress hosted configuration URL based on the earlier provided snippet. The remote Botpress script could not be fetched from this environment, so its live availability still needs a browser check.
- Removed planned-only automation cards from the public feature section and simplified copy to describe only current capabilities.
- Replaced repeated customer-facing provider branding with neutral “AI chat” language.
- Excluded local credentials, Wrangler state, and installed dependencies from this release archive.

## Automated checks
- `npm test`: 54 tests passed before these presentation/auth-navigation edits. Re-run after edits to confirm the updated bundle.
- `node --check` and complete test suite are run during packaging.
- ZIP integrity and secret-file exclusion are verified.

## Not claimed as verified
- Live Supabase login/signup, production credit balance, Gemini/provider key, Botpress hosted script, payment provider/webhook, and real mobile browser rendering require live credentials and browser/network access.
- Payments remain disabled/Coming Soon until merchant approval and verified production webhook configuration.
