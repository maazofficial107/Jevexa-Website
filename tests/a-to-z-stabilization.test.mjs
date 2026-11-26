import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import worker from "../worker.js";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const readAsset = (relPath) => readFile(new URL(`../${relPath}`, import.meta.url), "utf8");

function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

class SimpleCdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Runtime exception");
    }
    return res.result?.value;
  }
  close() {
    this.ws?.close();
  }
}

test("A-to-Z 1: Worker SSR SEO metadata, chat session meta persistence & unified service credit fields", async () => {
  const workerEnv = {
    SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
    SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    JEVEXA_ENVIRONMENT: "production"
  };

  // 1. Direct nested routes /tools/admin and /tools/email-outreach serve proper SEO HTML & assets cleanly
  const indexHtml = await readAsset("index.html");
  const mockAssetsEnv = {
    ...workerEnv,
    ASSETS: {
      async fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/" || p === "/index.html") {
          return new Response(indexHtml, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (p === "/script.js") {
          return new Response("console.log('ok');", { status: 200, headers: { "Content-Type": "application/javascript; charset=utf-8" } });
        }
        return new Response("Not Found", { status: 404 });
      }
    }
  };

  const adminRouteRes = await worker.fetch(new Request("https://jevexa.net/tools/admin"), mockAssetsEnv);
  assert.equal(adminRouteRes.status, 200);
  const adminHtml = await adminRouteRes.text();
  assert.match(adminHtml, /<title>Team Admin &amp; Role-Based Access Workspace \| JEVEXA<\/title>/);
  assert.match(adminHtml, /<link rel="canonical" href="https:\/\/jevexa\.net\/tools\/team-admin">/);

  const outreachRouteRes = await worker.fetch(new Request("https://jevexa.net/tools/email-outreach"), mockAssetsEnv);
  assert.equal(outreachRouteRes.status, 200);
  const outreachHtml = await outreachRouteRes.text();
  assert.match(outreachHtml, /<title>AI Email &amp; Cold Outreach Sequence Generator \| JEVEXA<\/title>/);

  const nestedAssetRes = await worker.fetch(new Request("https://jevexa.net/tools/ai-chatbot/script.js"), mockAssetsEnv);
  assert.equal(nestedAssetRes.status, 200);
  assert.match(nestedAssetRes.headers.get("Content-Type") || "", /application\/javascript/);

  // 2. Chat session persistence retains assistant credit metadata safely and strips junk
  let persistedBody = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = typeof url === "string" ? new URL(url) : new URL(url.url);
    if (u.pathname === "/auth/v1/user") {
      return Response.json({ id: "11111111-1111-4111-8111-111111111111", email: "user@jevexa.net" });
    }
    if (u.pathname.startsWith("/rest/v1/chat_sessions")) {
      persistedBody = JSON.parse(init.body);
      return Response.json([persistedBody]);
    }
    return Response.json([]);
  };
  try {
    const saveRes = await worker.fetch(new Request("https://jevexa.net/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer jwt" },
      body: JSON.stringify({
        session: {
          id: "sess-1",
          title: "Credit History Chat",
          updatedAt: Date.now(),
          messages: [
            { role: "user", text: "Explain billing", meta: { creditsUsed: 999 } },
            { role: "assistant", text: "Detailed reply.", meta: { creditsUsed: 3, remainingCredits: 97, tier: "pro", modelName: "Jevexa Pro", webSearch: true, extraEvil: "dropme" } }
          ]
        }
      })
    }), workerEnv);
    assert.equal(saveRes.status, 200);
    assert.equal(persistedBody.messages.length, 2);
    assert.equal(persistedBody.messages[0].meta, undefined, "User messages must not store assistant meta");
    assert.deepEqual(persistedBody.messages[1].meta, {
      creditsUsed: 3,
      remainingCredits: 97,
      tier: "pro",
      modelName: "Jevexa Pro",
      webSearch: true
    });
  } finally {
    globalThis.fetch = origFetch;
  }

  // 3. Support fallback responds accurately in Roman Urdu and uses valid domain email
  const supportMock = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "offline" }, { status: 503 });
  try {
    const urduSupRes = await worker.fetch(new Request("https://jevexa.net/api/support/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.88" },
      body: JSON.stringify({ message: "Pro plan kitna ka hai aur credits kaise milte hain?" })
    }), workerEnv);
    assert.equal(urduSupRes.status, 200);
    const urduSupData = await urduSupRes.json();
    assert.match(urduSupData.reply, /Pro \(\$15\/mo/);
    assert.match(urduSupData.reply, /100 welcome credits/i);

    const humanRes = await worker.fetch(new Request("https://jevexa.net/api/support/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.89" },
      body: JSON.stringify({ message: "How do I contact human support?" })
    }), workerEnv);
    const humanData = await humanRes.json();
    assert.match(humanData.reply, /hello@jevexa\.net/);
    assert.doesNotMatch(humanData.reply, /hello@jevexa\.ai/);
  } finally {
    globalThis.fetch = supportMock;
  }
});

test("A-to-Z 2: Pricing page navigation, plan query highlighting, Support & Auth timeout contracts", async () => {
  const pricingHtml = await readAsset("pricing.html");
  const scriptJs = await readAsset("script.js");

  assert.match(pricingHtml, /<ul class="nav-links" id="navLinks">/);
  assert.doesNotMatch(pricingHtml, /href="\/#tools"/);
  assert.match(pricingHtml, /href="\/#features"/);
  assert.match(pricingHtml, /id="pricingNavAuthBtn"/);
  assert.doesNotMatch(pricingHtml, /dataPlan = targetPlan === 'lite' \? 'starter'/);
  assert.match(pricingHtml, /data-plan="\$\{targetPlan\}"/);

  assert.match(scriptJs, /function withTimeout\(/);
  assert.match(scriptJs, /window\.JEVEXA_EXTRACT_CREDIT_USAGE\s*=/);
  assert.match(scriptJs, /window\.JEVEXA_GET_CREDITS_BALANCE\s*=/);
  assert.match(scriptJs, /window\.JEVEXA_RENDER_USED_CREDITS_FOOTER\s*=/);
  assert.match(scriptJs, /window\.JEVEXA_CLEAR_USED_CREDITS_FOOTER\s*=/);
  assert.match(scriptJs, /'\/tools\/admin':\s*\{/);
  assert.match(scriptJs, /'\/tools\/email-outreach':\s*\{/);
  assert.doesNotMatch(scriptJs, /hello@jevexa\.ai/);
});

test("A-to-Z 3: Headless Browser Full Verification across Desktop & Mobile viewports, Auth, Services & Used Credits footers", async (t) => {
  const browserBin = findBrowserExecutable();
  if (!browserBin) {
    t.skip("No Chromium/Edge executable available for headless verification");
    return;
  }

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "jevexa-atoz-e2e-"));
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json"
  };

  let server;
  server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, "http://127.0.0.1");
    const pathname = reqUrl.pathname;

    if (pathname === "/config.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(`window.JEVEXA_SUPABASE_CONFIG={url:"http://127.0.0.1:${server.address().port}",anonKey:"e2e-anon"};`);
      return;
    }
    if (pathname === "/mock-supabase.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(`
        window.__MOCK_LOGGED_IN = true;
        window.supabase = {
          createClient() {
            return {
              auth: {
                async getSession() {
                  return window.__MOCK_LOGGED_IN
                    ? { data: { session: { access_token: "jwt", user: { id: "11111111-1111-4111-8111-111111111111", email: "pro@jevexa.net", user_metadata: { full_name: "Test Builder" } } } }, error: null }
                    : { data: { session: null }, error: null };
                },
                async getUser() {
                  return window.__MOCK_LOGGED_IN
                    ? { data: { user: { id: "11111111-1111-4111-8111-111111111111", email: "pro@jevexa.net" } }, error: null }
                    : { data: { user: null }, error: null };
                },
                async signOut() { window.__MOCK_LOGGED_IN = false; return { error: null }; },
                onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }
              },
              from(table) {
                const chain = {
                  select() { return chain; }, eq() { return chain; }, in() { return chain; }, order() { return chain; }, limit() { return chain; },
                  insert() { return chain; }, update() { return chain; }, delete() { return chain; },
                  async maybeSingle() { return { data: { plan: "pro", balance: 9950 }, error: null }; },
                  then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); }
                };
                return chain;
              }
            };
          }
        };
      `);
      return;
    }
    if (pathname === "/api/credits/pricing") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ services: [] }));
      return;
    }
    if (pathname === "/api/memories" || pathname === "/api/chat/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, memories: [], sessions: [] }));
      return;
    }
    if (pathname === "/api/support/ai" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reply: "Pro plan is **$15/mo** (10,000 credits). Visit /pricing or click Talk to Human Agent." }));
      return;
    }
    if (pathname === "/api/chat" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write(`event: token\ndata: ${JSON.stringify({ text: "Clean AI response without footer pollution." })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({
        reply: "Clean AI response without footer pollution.",
        tier: "pro",
        modelName: "Jevexa Pro",
        creditsCharged: 3,
        creditsUsed: 3,
        credits_used: 3,
        creditsRemaining: 9947,
        remaining_credits: 9947,
        remainingCredits: 9947,
        webSearch: false,
        requestId: "00000000-0000-4000-8000-000000000901"
      })}\n\n`);
      res.end();
      return;
    }
    if (pathname === "/api/content" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        content: "Launch high-converting workflows in minutes.",
        creditsCharged: 2,
        creditsUsed: 2,
        credits_used: 2,
        creditsRemaining: 9945,
        remaining_credits: 9945,
        requestId: "00000000-0000-4000-8000-000000000902"
      }));
      return;
    }
    if (pathname === "/api/ocr/extract" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        tier: "pro",
        charged_credits: 4,
        credits_used: 4,
        remaining_credits: 9941,
        data: {
          vendor_name: "Acme Systems",
          document_type: "Invoice",
          invoice_number: "INV-99",
          date: "2026-10-01",
          due_date: "2026-10-31",
          payment_status: "Paid",
          currency: "USD",
          subtotal: 100,
          tax_amount: 0,
          tax_rate: 0,
          total_amount: 100,
          confidence_score: 99,
          line_items: [{ description: "Hosting", quantity: 1, unit_price: 100, total: 100 }]
        }
      }));
      return;
    }
    if (pathname === "/api/social/generate" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        tier: "pro",
        charged_credits: 2,
        credits_used: 2,
        remaining_credits: 9939,
        data: {
          platform: "linkedin",
          platform_limit: 3000,
          hooks: [{ text: "Stop wasting 10 hours a week on manual CRM triage.", score: 95 }],
          post_body: "Stop wasting 10 hours a week on manual CRM triage.",
          hashtags: ["#AIStudio"],
          best_time: "Tuesday 9 AM",
          strategy_tip: "Ask an engaging question."
        }
      }));
      return;
    }
    if (pathname === "/api/analytics/report" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        tier: "pro",
        charged_credits: 3,
        credits_used: 3,
        remaining_credits: 9936,
        kpis: { mrr: 50000, arr: 600000, revenue: 150000, expenses: 60000, net_profit: 90000, net_margin: 60, customers: 100, cac: 120, ltv: 900, ltv_cac_ratio: 7.5, churn_rate: 2, mom_growth: 12, timeframe: "Last 90 Days" },
        report: { health_score: 91, executive_summary: "Healthy margin and growth.", top_strengths: ["Strong LTV/CAC"], top_risks: ["Churn watch"], forecast: { conservative: 159000, expected: 172500, aggressive: 187500 }, strategic_actions: ["Double down on expansion"] }
      }));
      return;
    }
    if (pathname === "/api/workflows/run" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        tier: "pro",
        durationMs: 42,
        charged_credits: 2,
        credits_used: 2,
        remaining_credits: 9934,
        stepsExecuted: [{ name: "Capture Inbound Lead", durationMs: 14 }]
      }));
      return;
    }
    if (pathname === "/api/data/clean" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        tier: "pro",
        charged_credits: 2,
        credits_used: 2,
        remaining_credits: 9932,
        summary: { originalCount: 2, cleanedCount: 1, duplicatesRemoved: 1, emailsCleaned: 1, datesFixed: 0, anomaliesDetected: 0 },
        records: [{ Name: "Alice", Email: "alice@example.com" }],
        anomalies: [],
        csv: "Name,Email\nAlice,alice@example.com"
      }));
      return;
    }
    if (pathname === "/api/outreach/sequences") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sequences: [] }));
      return;
    }
    if (pathname === "/api/crm/leads") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        leads: [{ id: "lead-e2e-1", name: "Sarah Jenkins", company: "Acme Corp", role: "VP Ops", email: "sarah@acme.com", deal_value: 25000, stage: "qualified", notes: "Ready to scale automation." }]
      }));
      return;
    }
    if (pathname === "/api/crm/score" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        lead_score: 92,
        conversion_likelihood: "High",
        summary: "Strong enterprise automation fit.",
        suggested_outreach_angle: "Propose workflow consolidation pilot.",
        charged_credits: 2,
        credits_used: 2,
        remaining_credits: 9930
      }));
      return;
    }
    if (pathname === "/api/team/members") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        tier: "pro",
        maxSeats: 250,
        members: [{ id: "11111111-1111-4111-8111-111111111111", name: "Test Builder", email: "pro@jevexa.net", role: "Owner", status: "Active" }]
      }));
      return;
    }
    if (pathname === "/api/team/audit") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, logs: [] }));
      return;
    }
    if (pathname === "/api/outreach/generate" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        charged_credits: 3,
        credits_used: 3,
        remaining_credits: 9929,
        sequence: {
          initial: { subject: "Quick AI workflow idea", alternative_subject: "B2B pipeline idea", body: "Hi Alex,\n\nLet us save your ops team 10 hours a week." },
          followup_1: { day: "Day 3", subject: "Re: Quick AI workflow idea", body: "Following up cleanly." },
          followup_2: { day: "Day 7", subject: "Final note", body: "Closing the loop." }
        }
      }));
      return;
    }

    let relPath = pathname === "/" ? "index.html" : pathname.slice(1);
    if (pathname === "/pricing") relPath = "pricing.html";
    else if (pathname === "/about") relPath = "about.html";
    else if (pathname === "/contact") relPath = "contact.html";
    else if (pathname.startsWith("/tools/")) {
      const maybeAsset = pathname.replace(/^\/tools\/[^/]+\//, "");
      relPath = /\.[a-z0-9]+$/i.test(pathname) ? maybeAsset : "index.html";
    }

    const targetPath = path.join(projectRoot, relPath);
    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(targetPath).toLowerCase();
    let content = await readFile(targetPath);
    if (path.basename(targetPath) === "index.html") {
      content = content.toString("utf8")
        .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\/dist\/umd\/supabase\.js/, "/mock-supabase.js");
    }
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(content);
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = spawn(browserBin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const devToolsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DevTools timeout")), 10000);
    const onData = chunk => {
      const m = chunk.toString("utf8").match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    browser.stdout.on("data", onData);
    browser.stderr.on("data", onData);
    browser.once("exit", code => reject(new Error(`Browser exited (${code})`)));
  });

  const targets = await (await fetch(devToolsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const pageTarget = targets.find(x => x.type === "page") || targets[0];
  const cdp = new SimpleCdp(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");

  const pageErrors = [];
  cdp.ws.addEventListener("message", evt => {
    const msg = JSON.parse(evt.data);
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params.exceptionDetails?.text || "Runtime exception");
    }
  });

  const navigateAndWait = async (targetUrl, conditionExpr = "true") => {
    const loaded = new Promise(resolve => {
      const onEvt = evt => {
        const parsed = JSON.parse(evt.data);
        if (parsed.method === "Page.loadEventFired") {
          cdp.ws.removeEventListener("message", onEvt);
          resolve();
        }
      };
      cdp.ws.addEventListener("message", onEvt);
      setTimeout(() => { cdp.ws.removeEventListener("message", onEvt); resolve(); }, 6000);
    });
    await cdp.send("Page.navigate", { url: targetUrl });
    await loaded;
    await cdp.eval(`new Promise(r => {
      const start = Date.now();
      const poll = () => {
        if (document.readyState !== 'loading' && (${conditionExpr})) return r();
        if (Date.now() - start > 6000) return r();
        setTimeout(poll, 40);
      };
      poll();
    })`);
  };

  try {
    // 1. Desktop Laptop viewport (1366x768)
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await navigateAndWait(`${baseUrl}/`, "typeof window.openExactServiceWorkspace === 'function'");

    const desktopOverflow = await cdp.eval(`document.documentElement.scrollWidth <= window.innerWidth`);
    assert.equal(desktopOverflow, true, "Desktop 1366x768 must have zero horizontal overflow");

    const assertUsedBeforeRemaining = (text, usedVal, remVal, label) => {
      assert.match(text, new RegExp(`(?:Core Engine|Pro Engine|Deep Reasoning|Ultra Reasoning)\\s+.*Used credit:\\s*${usedVal}\\s+Remaining credit:\\s*${remVal}`), `${label}: expected <Engine> Used credit: ${usedVal} Remaining credit: ${remVal} (got "${text}")`);
      assert.ok(
        text.indexOf("Used credit:") < text.indexOf("Remaining credit:"),
        `${label}: Used credit must appear before Remaining credit (got "${text}")`
      );
    };

    // 2. Test Chatbot slim header, centered reading column, subtle Used credit -> Remaining credit footer AND clean Copy excluding receipt
    await cdp.eval(`
      window.__COPIED = '';
      navigator.clipboard.writeText = async (t) => { window.__COPIED = t; };
      window.openExactServiceWorkspace('chatbot', true);
    `);
    const emptyChatLayout = await cdp.eval(`(() => {
      const hdr = document.querySelector('#chatbotWindow .chatbot-header');
      const empty = document.getElementById('chatEmptyState');
      const main = document.querySelector('#chatbotWindow .chat-main');
      const dock = document.querySelector('#chatbotWindow .chat-composer-dock');
      const sidebar = document.getElementById('chatSidebar');
      const settingsBtn = document.getElementById('chatOpenCustomizationBtn');
      const hdrRect = hdr.getBoundingClientRect();
      const emptyRect = empty.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      const sbRect = sidebar.getBoundingClientRect();
      const setRect = settingsBtn.getBoundingClientRect();
      return {
        headerHeight: hdrRect.height,
        emptyCenterY: emptyRect.top + emptyRect.height / 2,
        availTop: hdrRect.bottom,
        availBottom: dockRect.top,
        dockHeight: dockRect.height,
        sidebarOverflowX: sidebar.scrollWidth > sidebar.clientWidth + 1,
        settingsInsideSidebar: setRect.bottom <= sbRect.bottom + 1
      };
    })()`);
    assert.ok(emptyChatLayout.headerHeight <= 52, `Chatbot desktop header must be <= 52px (got ${emptyChatLayout.headerHeight})`);
    const availMidY = (emptyChatLayout.availTop + emptyChatLayout.availBottom) / 2;
    assert.ok(Math.abs(emptyChatLayout.emptyCenterY - availMidY) < 40, `Empty state must be vertically centered in available viewport`);
    assert.equal(emptyChatLayout.sidebarOverflowX, false, "Sidebar must have zero horizontal clipping");
    assert.equal(emptyChatLayout.settingsInsideSidebar, true, "Sidebar Settings button must sit cleanly inside sidebar");

    await cdp.eval(`
      document.getElementById('chatInput').value = 'Test clean response';
      document.getElementById('chatSend').click();
    `);
    await cdp.eval(`new Promise((r, rej) => {
      const start = Date.now();
      const check = () => {
        const rc = document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .chat-credit-receipt');
        if (rc && !rc.hidden) return r();
        if (Date.now() - start > 6000) return rej(new Error('Chat receipt timeout'));
        setTimeout(check, 40);
      };
      check();
    })`);
    const chatState = await cdp.eval(`(() => {
      const botMsg = document.querySelector('#chatMessages .message.bot:not([data-chat-welcome])');
      const receipt = botMsg.querySelector('.chat-credit-receipt');
      const style = getComputedStyle(receipt);
      const msgWidth = botMsg.getBoundingClientRect().width;
      botMsg.querySelector('[data-chat-action="copy"]').click();
      return {
        receiptVisible: style.display !== 'none' && !receipt.hidden,
        receiptText: receipt.textContent.trim(),
        msgWidth,
        copied: window.__COPIED
      };
    })()`);
    assert.equal(chatState.receiptVisible, true);
    assert.ok(chatState.msgWidth <= 845, `Centered chat reading column should be <= 845px (got ${chatState.msgWidth})`);
    assertUsedBeforeRemaining(chatState.receiptText, 3, 9947, "Chatbot");
    assert.equal(chatState.copied, "Clean AI response without footer pollution.");
    assert.doesNotMatch(chatState.copied, /Used credit/);

    // 3. Test Content Generator slim top bar, Used credit -> Remaining credit footer & clean copy
    await cdp.eval(`
      window.openExactServiceWorkspace('content-generator', true);
      document.getElementById('contentTopic').value = 'Write a crisp product pitch';
      document.getElementById('contentForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    `);
    await cdp.eval(`new Promise((r, rej) => {
      const start = Date.now();
      const check = () => {
        const rc = document.getElementById('contentCreditReceipt');
        if (rc && !rc.hidden) return r();
        if (Date.now() - start > 6000) return rej(new Error('Content receipt timeout'));
        setTimeout(check, 40);
      };
      check();
    })`);
    const contentState = await cdp.eval(`(() => {
      document.getElementById('contentCopy').click();
      const hdr = document.querySelector('#contentWorkspace .workspace-header');
      return {
        headerHeight: hdr ? hdr.getBoundingClientRect().height : 0,
        receiptText: document.getElementById('contentCreditReceipt').textContent.trim(),
        copied: window.__COPIED
      };
    })()`);
    assert.ok(contentState.headerHeight <= 52, `Content workspace header must be <= 52px (got ${contentState.headerHeight})`);
    assertUsedBeforeRemaining(contentState.receiptText, 2, 9945, "Content Generator");
    assert.equal(contentState.copied, "Launch high-converting workflows in minutes.");

    // Helper for lazy-loaded workspace modules (OCR, Social, Analytics, Workflows, Data, Outreach)
    const runLazyServiceAndAwaitFooter = async (serviceKey, readyExpr, triggerExpr, footerId) => {
      await cdp.eval(`window.openExactServiceWorkspace('${serviceKey}', true);`);
      await cdp.eval(`new Promise((r, rej) => {
        const start = Date.now();
        const waitReady = () => {
          if (${readyExpr}) return r();
          if (Date.now() - start > 6000) return rej(new Error('Module timeout for ${serviceKey}'));
          setTimeout(waitReady, 30);
        };
        waitReady();
      })`);
      await cdp.eval(triggerExpr);
      await cdp.eval(`new Promise((r, rej) => {
        const start = Date.now();
        const waitFooter = () => {
          const el = document.getElementById('${footerId}');
          if (el && !el.hidden) return r();
          if (Date.now() - start > 6000) return rej(new Error('Footer timeout for ${footerId}'));
          setTimeout(waitFooter, 40);
        };
        waitFooter();
      })`);
      return cdp.eval(`document.getElementById('${footerId}').textContent.trim()`);
    };

    const ocrFooter = await runLazyServiceAndAwaitFooter(
      "ocr",
      "Boolean(window.JEVEXA_OCR)",
      "document.getElementById('ocrTextInput').value='Invoice INV-99 Total $100'; document.getElementById('ocrExtractBtn').click();",
      "ocrCreditReceipt"
    );
    assertUsedBeforeRemaining(ocrFooter, 4, 9941, "OCR");

    const socialFooterText = await runLazyServiceAndAwaitFooter(
      "social",
      "Boolean(window.JEVEXA_SOCIAL)",
      "document.getElementById('socialTopic').value='Announcing fast workflows'; document.getElementById('socialForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));",
      "socialCreditReceipt"
    );
    assertUsedBeforeRemaining(socialFooterText, 2, 9939, "Social");
    const socialCopied = await cdp.eval(`document.getElementById('socialCopyPostBtn').click(); window.__COPIED`);
    assert.doesNotMatch(socialCopied, /Used credit/);

    const analyticsFooter = await runLazyServiceAndAwaitFooter(
      "analytics",
      "Boolean(window.JEVEXA_ANALYTICS)",
      "document.getElementById('analyticsGenerateBtn').click();",
      "analyticsCreditReceipt"
    );
    assertUsedBeforeRemaining(analyticsFooter, 3, 9936, "Analytics");

    const wfFooter = await runLazyServiceAndAwaitFooter(
      "workflows",
      "Boolean(window.JEVEXA_WORKFLOWS)",
      "document.getElementById('workflowRunBtn').click();",
      "workflowCreditReceipt"
    );
    assertUsedBeforeRemaining(wfFooter, 2, 9934, "Workflows");

    const dataFooter = await runLazyServiceAndAwaitFooter(
      "data",
      "Boolean(window.JEVEXA_DATA)",
      "document.getElementById('dataProcessBtn').click();",
      "dataCreditReceipt"
    );
    assertUsedBeforeRemaining(dataFooter, 2, 9932, "Data Management");

    const crmFooter = await runLazyServiceAndAwaitFooter(
      "crm",
      "Boolean(window.JEVEXA_CRM && window.JEVEXA_CRM.getLeads().length)",
      "window.JEVEXA_CRM.openLeadDrawer(window.JEVEXA_CRM.getLeads()[0].id); document.getElementById('crmAiScoreBtn').click();",
      "crmScoreCreditReceipt"
    );
    assertUsedBeforeRemaining(crmFooter, 2, 9930, "Mini CRM");

    const teamFooter = await runLazyServiceAndAwaitFooter(
      "admin",
      "Boolean(window.JEVEXA_TEAM)",
      "window.JEVEXA_TEAM.fetchTeamMembers();",
      "teamCreditReceipt"
    );
    assertUsedBeforeRemaining(teamFooter, 0, 9930, "Team Admin");
    assert.match(teamFooter, /Included in plan/);

    const outreachFooter = await runLazyServiceAndAwaitFooter(
      "outreach",
      "Boolean(window.JEVEXA_OUTREACH)",
      "document.getElementById('outreachValueProp').value='Automated lead scoring and CRM outreach in one studio'; document.getElementById('outreachForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));",
      "outreachCreditReceipt"
    );
    assertUsedBeforeRemaining(outreachFooter, 3, 9929, "Outreach");
    const outreachCopied = await cdp.eval(`document.getElementById('outreachCopyEmailBtn').click(); window.__COPIED`);
    assert.doesNotMatch(outreachCopied, /Used credit/);

    // 5. Support Assistant interactive check
    await cdp.eval(`
      window.JEVEXA_CLOSE_ALL_WORKSPACES?.();
      window.JEVEXA_SUPPORT_MODAL_OPEN?.();
      document.getElementById('supportAiInput').value = 'What does Pro cost?';
      document.getElementById('supportAiForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    `);
    await cdp.eval(`new Promise(r => {
      const c = () => {
        const msgs = document.querySelectorAll('#supportAiMessages .support-ai-message:not(.user)');
        const last = msgs[msgs.length - 1];
        if (last && /10,000 credits/.test(last.textContent)) r();
        else setTimeout(c, 40);
      };
      c();
    })`);
    const supportState = await cdp.eval(`(() => {
      const msgs = document.querySelectorAll('#supportAiMessages .support-ai-message:not(.user)');
      const last = msgs[msgs.length - 1];
      return {
        html: last.innerHTML,
        linkHref: last.querySelector('a')?.getAttribute('href')
      };
    })()`);
    assert.equal(supportState.linkHref, "/pricing");
    assert.match(supportState.html, /<strong>\$15\/mo<\/strong>/);

    // Close Support with Escape and verify Logout clears receipts cleanly
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
    await cdp.eval(`window.logoutUser?.();`);
    await cdp.eval(`new Promise(r => setTimeout(r, 120))`);
    const postLogoutHidden = await cdp.eval(`
      ['contentCreditReceipt','ocrCreditReceipt','socialCreditReceipt','analyticsCreditReceipt','workflowCreditReceipt','dataCreditReceipt','outreachCreditReceipt']
        .every(id => { const el = document.getElementById(id); return !el || el.hidden; })
    `);
    assert.equal(postLogoutHidden, true, "All service credit receipts must hide on logout");

    // 6. Mobile viewport checks (375x812 and 320x700) on index + /pricing?plan=max
    for (const width of [375, 320]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 812, deviceScaleFactor: 2, mobile: true });
      await navigateAndWait(`${baseUrl}/`, "document.readyState === 'complete'");
      const homeMobOverflow = await cdp.eval(`document.documentElement.scrollWidth <= window.innerWidth`);
      assert.equal(homeMobOverflow, true, `Studio home must have zero horizontal overflow at ${width}px`);

      await navigateAndWait(`${baseUrl}/pricing?plan=max`, "Boolean(document.querySelector('.js-plan-trigger[data-plan=\"max\"]'))");
      await cdp.eval(`new Promise(r => setTimeout(r, 250))`);
      const pricingState = await cdp.eval(`({
        overflow: document.documentElement.scrollWidth <= window.innerWidth,
        highlightedMaxCard: document.querySelector('.js-plan-trigger[data-plan="max"]')?.closest('.pricing-card')?.style.borderColor || ''
      })`);
      assert.equal(pricingState.overflow, true, `/pricing must have zero horizontal overflow at ${width}px`);
      assert.ok(pricingState.highlightedMaxCard.length > 0, `Max pricing card must highlight for ?plan=max at ${width}px`);
    }

    assert.deepEqual(pageErrors, [], `Expected zero uncaught runtime exceptions, saw: ${pageErrors.join("; ")}`);
  } finally {
    cdp.close();
    browser.kill();
    server.close();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});
