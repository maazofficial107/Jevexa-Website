# JEVEXA AI Automation Studio — Ultra Premium (Smooth Edition)

Luxury, fully animated, high-converting single-page website for AI Automation Studio.

## What's Included

### Performance & Smoothness
- Optimized particles (35 particles, throttled ~30fps)
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

### Service cards (12)
1. AI Chatbots & Agents
2. Workflow Automation (300+ integrations)
3. RPA & Process Automation
4. Document AI & OCR
5. Voice AI & Call Agents
6. Lead Scoring & CRM AI
7. Content Generation
8. Email & Outreach AI
9. Social Media Automation
10. Intelligent Analytics
11. Data Enrichment & Scraping
12. Enterprise Security

These cards describe JEVEXA's service offerings; they are not all live integrations. The Gemini-powered AI chatbot is the only currently connected AI operation. The other 11 services remain unavailable until their real providers and server-side workflows are implemented.

### Premium Chatbot
- Luxury floating button (glow + rotating ring + gradient core + AI badge)
- Authenticated Gemini responses with server-side credit reservations and measured-usage settlement
- Typing indicator + suggestion chips

### Social
Facebook • Instagram • X (Twitter) • LinkedIn • YouTube • Discord

### Other
- One-time credit packages: Starter $19/$180, Pro $49/$468, Business $99/$948 (monthly/annual); checkout is Coming Soon outside explicitly configured staging tests
- 8 FAQ • Contact form • current platform availability status (no review claims)
- Fully responsive

## Local checks
1. Run `npm ci`.
2. Run `npm test`.
3. Run `npm run build` for a Cloudflare Workers dry-run.

## Run locally on Windows

In the VS Code terminal, change to the inner app folder (`Jevexa-Website-main`, the folder containing `package.json`) and run:

```powershell
npm.cmd run dev
```

This starts the Cloudflare Worker and website at `http://127.0.0.1:8788`. Local Wrangler persistence is kept outside the static asset directory to prevent its SQLite writes from triggering repeated reloads. Keep this command running while using the site. Stop any existing process already using port 8788 before starting Wrangler. Do not use Live Server for account features: it serves the static files without the Worker `/config.js` endpoint.

Before starting, configure `.dev.vars` from `.dev.vars.example` with a **matching staging** `SUPABASE_URL`, `SUPABASE_ANON_KEY` (Supabase publishable key or legacy anon key), and `SUPABASE_SERVICE_ROLE_KEY`. The URL and keys must all belong to the separate staging project; never use production credentials for local staging. `.dev.vars` is gitignored. See [SAAS_SETUP_AND_RELEASE.md](./SAAS_SETUP_AND_RELEASE.md) for setup and migration requirements.
