# JEVEXA — AI Tools for Businesses

A 10-tool AI platform for businesses, with AI Chat, Content Generation, and a credit wallet live today.

## What's Included

### Performance & Smoothness
- Optimized particles (24 particles, throttled ~30fps; skipped on mobile and while hidden/reduced-motion)
- No custom cursor (normal mouse — smooth & natural)
- Lightweight AOS + passive scroll listeners
- Reduced blur intensity for better frame rates
- Prefers-reduced-motion support

### Luxury Visual Design
- Dark neon theme (purple / cyan / magenta / gold)
- Glassmorphism cards
- Animated mesh background + AI orb
- Smooth hover & micro-interactions
- Premium preloader

### AI Tool Suite
JEVEXA features 10 specialized AI tools in one unified studio. **All 10 tools are live and unlocked** today:

1. AI Chat — Live
2. Content Generation — Live
3. Email & Outreach AI — Live
4. Mini CRM — Live
5. Document AI & OCR — Live
6. Social Media Assistant — Live
7. Business Analytics — Live
8. User & Admin Management — Live
9. Workflow Automation — Live
10. Data Management — Live

### Premium Chatbot
- Luxury floating button (glow + rotating ring + gradient core + AI badge)
- Authenticated OpenRouter chat with Lite/Pro/Max/Ultra tiers, fixed per-message credits, attachments, and browser-local chat history
- Hybrid support dialog: OpenRouter-powered support AI or a public, rate-limited human support ticket form with email notification
- Authenticated content generation with server-side credit reservations and measured-usage settlement
- Typing indicator + suggestion chips

### Social
Facebook • Instagram • X (Twitter) • LinkedIn • YouTube • Discord

### Other
- Planned credit packages: Lite $5 monthly / $48 annual, Pro $12 / $115.20, Max $25 / $240, Ultra $49 / $470.40 (all annual packages are 20% off and paid once); checkout is Coming Soon
- 8 FAQ • Contact form • current platform availability status (no review claims)
- Fully responsive

## Local checks
1. Run `npm ci`.
2. Run `npm test`.
3. Run `npm run build` for a Cloudflare Workers dry-run.

Production remains a Cloudflare Worker deployment through `wrangler.jsonc`: static assets are served alongside the Worker API routes. Do not replace it with a Pages-only configuration, which would remove the chat, credit, and support APIs.

## Run locally on Windows

In the VS Code terminal, change to the inner app folder (`Jevexa-Website-main`, the folder containing `package.json`) and run:

```powershell
npm.cmd run dev
```

This starts the Cloudflare Worker and website at `http://127.0.0.1:8788`. Local Wrangler persistence is kept outside the static asset directory to prevent its SQLite writes from triggering repeated reloads. Keep this command running while using account features. A static preview server can display the public page, but sign-in, credit balance, and AI chat require the configured Worker.

Before starting, configure `.dev.vars` from `.dev.vars.example` with a **matching staging** `SUPABASE_URL`, `SUPABASE_ANON_KEY` (Supabase publishable key or legacy anon key), `SUPABASE_SERVICE_ROLE_KEY`, and `OPENROUTER_API_KEY`. The URL and keys must all belong to the separate staging project; never use production credentials for local staging. `.dev.vars` is gitignored. See [SAAS_SETUP_AND_RELEASE.md](./SAAS_SETUP_AND_RELEASE.md) for setup and migration requirements.

## Manual QA checklist
- Open a static preview and confirm the preview notice appears without a `/config.js` request or console error.
- Open Wrangler at `http://127.0.0.1:8788` with staging config and confirm the Worker config warning remains visible if required values are missing.
- Confirm the feature section contains exactly 10 cards: two Live tools and eight Coming Soon tools, grouped into three releases.
- Check the feature grid at desktop (3 columns), tablet (2 columns), and mobile (1 column).
- Verify the monthly/annual toggle shows the original monthly rate, the 20%-discounted monthly equivalent, and the one-time annual total for all plans (Lite, Pro, Max, and Ultra). Checkout remains unavailable.
- Verify the FAQ accordion and mobile menu work without account configuration.
- Check reduced-motion behavior, background animation pause when the tab is hidden, and no particle canvas on mobile.
- On a configured staging account, verify sign-in, the 100-credit welcome grant, tier-gated chat and attachments, support AI, human support ticket submission/email notification, content generation, and credit usage history.
