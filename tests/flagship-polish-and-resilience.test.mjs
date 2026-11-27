import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import worker from "../worker.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readAsset = (relPath) => readFile(path.join(ROOT_DIR, relPath), "utf8");

const baseEnv = {
  SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
  SUPABASE_ANON_KEY: "unit-anon",
  SUPABASE_SERVICE_ROLE_KEY: "unit-service",
  JEVEXA_ENVIRONMENT: "production"
};

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
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
    try { this.ws.close(); } catch {}
  }
}

test("1. Support AI sanitizes stray *** artifacts and delivers tailored, polite responses", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.groq.com") {
      return Response.json({
        choices: [{
          message: {
            content: "### Plan Details\n***\n***Great news!*** The **Pro Plan** is **$15/mo**.\n* 10,000 credits/month\n***\nVisit /pricing for details."
          }
        }]
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const res = await worker.fetch(new Request("https://jevexa.net/api/support/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.77" },
      body: JSON.stringify({ message: "What does Pro cost?" })
    }), { ...baseEnv, GROQ_API_KEY: "test-groq-key" });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.doesNotMatch(data.reply, /\*\*\*/, "Support AI reply must strip raw *** artifacts");
    assert.doesNotMatch(data.reply, /^###/m, "Support AI reply must not emit raw ### heading hashes");
    assert.match(data.reply, /\*\*Pro Plan\*\*/);
    assert.match(data.reply, /• 10,000 credits\/month/);
  } finally {
    globalThis.fetch = origFetch;
  }

  // Fallback contextual responses (when no provider keys are configured)
  const fallbackQueries = [
    { q: "Hello!", expect: /Welcome to JEVEXA Support/i },
    { q: "How does the refund policy work?", expect: [/7 days/i, /10%/i, /\/refund-policy/] },
    { q: "Why does it say Offline?", expect: [/Offline/i, /Online/i] }
  ];
  for (const { q, expect } of fallbackQueries) {
    const r = await worker.fetch(new Request("https://jevexa.net/api/support/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.78" },
      body: JSON.stringify({ message: q })
    }), baseEnv);
    assert.equal(r.status, 200);
    const payload = await r.json();
    assert.doesNotMatch(payload.reply, /\*\*\*/);
    const checks = Array.isArray(expect) ? expect : [expect];
    for (const pat of checks) {
      assert.match(payload.reply, pat);
    }
  }
});

test("2. Chat Markdown & Support client sanitization clean stray *** artifacts cleanly", async () => {
  const creditsJs = await readAsset("credits.js");
  const start = creditsJs.indexOf("function escapeMarkdownHtml(str)");
  const end = creditsJs.indexOf("function trimConversationToMax(");
  assert.ok(start !== -1 && end !== -1);
  const renderMarkdown = new Function(`${creditsJs.slice(start, end)}; return renderMarkdown;`)();

  const rendered = renderMarkdown("Here is ***critical info*** and stray *** note.");
  assert.match(rendered, /<strong><em>critical info<\/em><\/strong>/);
  assert.doesNotMatch(rendered, /\*\*\*/);
});

test("3. Worker chat responses always emit charged_credits, creditsUsed, credits_used, and remainingCredits", async () => {
  const origFetch = globalThis.fetch;
  const userId = "44444444-4444-4444-8444-444444444444";
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "pro", balance: 120 }]);
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 1, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 119 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 119 });
    }
    if (url.hostname === "api.groq.com") {
      return Response.json({
        choices: [{ message: { content: "Multi-provider response OK." } }],
        usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const reqId = crypto.randomUUID();
    const res = await worker.fetch(new Request("https://jevexa.net/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer jwt",
        "Idempotency-Key": reqId
      },
      body: JSON.stringify({ requestId: reqId, message: "Hello", tier: "lite", thinkingLevel: "off" })
    }), { ...baseEnv, GROQ_API_KEY: "g-key" });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.creditsUsed, 1);
    assert.equal(data.credits_used, 1);
    assert.equal(data.charged_credits, 1);
    assert.equal(data.remainingCredits, 119);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("4. E2E (Headless Chrome): Animated emblem, spacious chat, live Online->Offline->Online across all 10 workspaces, guaranteed Used Credits & clean Support AI", async (t) => {
  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    t.skip("Chrome/Edge binary not found");
    return;
  }

  let balance = 250;
  const userId = "55555555-5555-4555-8555-555555555555";
  const mockUser = { id: userId, email: "flagship@jevexa.net", user_metadata: { full_name: "Flagship Tester" } };
  const remoteSessions = new Map();

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (pathname === "/config.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(`window.JEVEXA_SUPABASE_CONFIG={url:"http://127.0.0.1:${server.address().port}",anonKey:"e2e-anon"};`);
      return;
    }
    if (pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (pathname === "/mock-supabase.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(`
        window.__MOCK_USER = ${JSON.stringify(mockUser)};
        window.__MOCK_AUTH = {
          session: localStorage.getItem('__mock_logged_out') === '1'
            ? null
            : { access_token: "e2e-jwt", user: window.__MOCK_USER },
          listeners: []
        };
        window.__MOCK_LOGIN = () => {
          localStorage.removeItem('__mock_logged_out');
          window.__MOCK_AUTH.session = { access_token: "e2e-jwt", user: window.__MOCK_USER };
          window.__MOCK_AUTH.listeners.forEach(cb => cb('SIGNED_IN', window.__MOCK_AUTH.session));
        };
        window.supabase = {
          createClient() {
            return {
              auth: {
                async getSession() { return { data: { session: window.__MOCK_AUTH.session }, error: null }; },
                async getUser() { return { data: { user: window.__MOCK_AUTH.session?.user || null }, error: null }; },
                async signOut() {
                  localStorage.setItem('__mock_logged_out', '1');
                  window.__MOCK_AUTH.session = null;
                  window.__MOCK_AUTH.listeners.forEach(cb => cb('SIGNED_OUT', null));
                  return { error: null };
                },
                onAuthStateChange(cb) { window.__MOCK_AUTH.listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; }
              },
              from() {
                return {
                  select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; }, limit() { return this; },
                  async maybeSingle() { return { data: { balance: ${balance}, plan: "pro" }, error: null }; }
                };
              }
            };
          }
        };
      `);
      return;
    }
    if (pathname === "/api/credits/quote") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ estimatedCredits: 2 }));
      return;
    }
    if (pathname === "/api/memories") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, memories: [] }));
      return;
    }
    if (pathname === "/api/chat/sessions") {
      if (req.method === "PUT" || req.method === "POST") {
        let body = "";
        for await (const c of req) body += c;
        const parsed = JSON.parse(body || "{}");
        const s = parsed.session || parsed;
        if (s?.id) remoteSessions.set(s.id, s);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: s?.id || null }));
        return;
      }
      if (req.method === "DELETE") {
        remoteSessions.clear();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: Array.from(remoteSessions.values()) }));
      return;
    }
    if (pathname === "/api/chat" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const parsed = JSON.parse(body || "{}");
      // Simulate response that omits creditsUsed to verify client fallback calculation still renders Used credit visibly!
      balance -= 2;
      const reply = "Spacious flagship reply.\n\n***Bold Emphasis*** without stray asterisks.";
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
      res.write(`event: token\ndata: ${JSON.stringify({ text: reply })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ reply, tier: parsed.tier || "lite", remainingCredits: balance, requestId: parsed.requestId })}\n\n`);
      res.end();
      return;
    }
    if (pathname === "/api/support/ai" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        reply: "### Billing Help\n***\nHere is your ***exact*** Pro Plan answer: **$15/mo** for **10,000 credits** at /pricing."
      }));
      return;
    }

    const rel = (pathname === "/" || pathname.startsWith("/tools/")) ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.join(ROOT_DIR, rel);
    if (!filePath.startsWith(ROOT_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimes = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
    let data = fs.readFileSync(filePath);
    if (rel === "index.html") {
      data = Buffer.from(
        data.toString("utf8")
          .replace("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js", "/mock-supabase.js")
          .replace(/https:\/\/fonts\.googleapis\.com[^"']*/g, "")
          .replace(/https:\/\/cdnjs\.cloudflare\.com[^"']*/g, "")
          .replace(/https:\/\/unpkg\.com\/aos[^"']*/g, ""),
        "utf8"
      );
    }
    res.writeHead(200, { "Content-Type": mimes[ext] || "application/octet-stream" });
    res.end(data);
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jevexa-polish-e2e-"));
  const chromeProc = spawn(chromeBin, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`, "--window-size=1280,860", "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let cdp = null;
  try {
    const devToolsUrl = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("DevTools timeout")), 10000);
      const onData = (chunk) => {
        const m = chunk.toString("utf8").match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) { clearTimeout(t); resolve(m[1]); }
      };
      chromeProc.stderr.on("data", onData);
      chromeProc.stdout.on("data", onData);
    });
    const targets = await (await fetch(devToolsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
    cdp = new SimpleCdp((targets.find(x => x.type === "page") || targets[0]).webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

    await cdp.send("Page.navigate", { url: baseUrl });
    await cdp.eval(`new Promise(r => { if (document.readyState === 'complete' && window.JEVEXA_CONNECTIVITY) r(); else window.addEventListener('load', () => setTimeout(r, 150), { once: true }); })`);

    // A. Verify normal '/' load keeps chatbot closed & compact hero spacing
    const homeCheck = await cdp.eval(`(() => {
      const navbar = document.getElementById('navbar');
      const heroBadge = document.querySelector('.hero-badge');
      return {
        chatOpen: document.getElementById('chatbotWindow')?.classList.contains('open'),
        navbarHeight: navbar ? navbar.getBoundingClientRect().height : 999,
        heroBadgeTop: heroBadge ? heroBadge.getBoundingClientRect().top : 999
      };
    })()`);
    assert.equal(homeCheck.chatOpen, false, "Normal '/' load must keep #chatbotWindow closed");
    assert.ok(homeCheck.navbarHeight <= 72, `Navbar must be compact <= 72px (got ${homeCheck.navbarHeight})`);
    assert.ok(homeCheck.heroBadgeTop <= 115, `Hero badge must sit compactly upward <= 115px (got ${homeCheck.heroBadgeTop})`);

    // B. Verify all 10 workspaces have Online badges & Chatbot shows Sparkle-Wand AI logo (no old circular rings) + compact header
    await cdp.eval(`window.openExactServiceWorkspace('chatbot', true);`);
    await cdp.eval(`new Promise(r => setTimeout(r, 120))`);
    const headerCheck = await cdp.eval(`(async () => {
      const badges = Array.from(document.querySelectorAll('[data-jevexa-conn-badge]'));
      const header = document.querySelector('#chatbotWindow .chatbot-header');
      const badgeWrap = document.getElementById('chatHeaderEmblemBadge');
      const emblem = document.getElementById('chatHeaderEmblem');
      const emblemSvg = emblem?.querySelector('svg');
      const emptyEmblemLg = document.querySelector('#chatEmptyState .chat-empty-emblem .chat-ai-emblem-lg');
      const oldRingSelectors = [
        '.emblem-orbit-outer',
        '.emblem-orbit-inner',
        '.emblem-prism-ring',
        '.emblem-glass-disc',
        '.emblem-sheen-arc',
        '.emblem-sat',
        '.emblem-node-a',
        '.emblem-node-b'
      ];
      const oldRingCount = oldRingSelectors.reduce((sum, sel) => sum + document.querySelectorAll(sel).length, 0);
      const layerSels = [
        '#chatHeaderEmblem .wand-actor',
        '#chatHeaderEmblem .wand-aura',
        '#chatHeaderEmblem .wand-sparkle-1',
        '#chatHeaderEmblem .wand-sparkle-2',
        '#chatHeaderEmblem .wand-sparkle-3',
        '#chatHeaderEmblem .wand-sparkle-4',
        '#chatEmptyState .chat-empty-emblem .wand-actor',
        '#chatEmptyState .chat-empty-emblem .wand-aura',
        '#chatEmptyState .chat-empty-emblem .wand-sparkle-1',
        '#chatEmptyState .chat-empty-emblem .wand-sparkle-2'
      ];
      const snap = () => layerSels.map(sel => {
        const el = document.querySelector(sel);
        const s = el ? getComputedStyle(el) : null;
        return {
          sel,
          name: s?.animationName || '',
          iter: s?.animationIterationCount || '',
          state: s?.animationPlayState || '',
          transform: s?.transform || '',
          rect: el ? el.getBoundingClientRect().toJSON() : null
        };
      });
      const t1 = snap();
      await new Promise(r => setTimeout(r, 380));
      const t2 = snap();
      const badgeAfter = badgeWrap ? getComputedStyle(badgeWrap, '::after') : null;
      const emptySheenAfter = document.querySelector('#chatEmptyState .chat-empty-emblem')
        ? getComputedStyle(document.querySelector('#chatEmptyState .chat-empty-emblem'), '::after')
        : null;
      return {
        badgeCount: badges.length,
        allOnline: badges.every(b => b.classList.contains('is-online') && b.querySelector('.conn-label')?.textContent.trim() === 'Online'),
        titleText: document.getElementById('chatbotTitle')?.textContent.trim(),
        chatStatusText: document.getElementById('chatbotStatusText')?.textContent.trim(),
        headerHeight: header ? header.getBoundingClientRect().height : 999,
        headerEmblemSize: emblem ? emblem.getBoundingClientRect().width : 0,
        emblemOverflow: emblem ? getComputedStyle(emblem).overflow : '',
        svgOverflow: emblemSvg ? getComputedStyle(emblemSvg).overflow : '',
        emblemRadius: emblem ? getComputedStyle(emblem).borderRadius : '',
        emptyEmblemSize: emptyEmblemLg ? emptyEmblemLg.getBoundingClientRect().width : 0,
        badgeSheenName: badgeAfter?.animationName || '',
        badgeSheenIter: badgeAfter?.animationIterationCount || '',
        badgeSheenState: badgeAfter?.animationPlayState || '',
        emptySheenName: emptySheenAfter?.animationName || '',
        hasEmblem: Boolean(emblem),
        hasEmptyEmblem: Boolean(document.querySelector('#chatEmptyState .chat-empty-emblem')),
        oldRingCount,
        hasWandShaft: Boolean(document.querySelector('#chatHeaderEmblem .wand-shaft')),
        hasWandTip: Boolean(document.querySelector('#chatHeaderEmblem .wand-tip')),
        hasEmptyWand: Boolean(document.querySelector('#chatEmptyState .chat-empty-emblem .wand-actor')),
        t1,
        t2
      };
    })()`);
    assert.equal(headerCheck.badgeCount, 10, "All 10 workspaces must render a connectivity badge");
    assert.equal(headerCheck.allOnline, true, "All 10 connectivity badges must initialize to Online");
    assert.equal(headerCheck.titleText, "Jevexa AI", "Header badge must show Jevexa AI");
    assert.equal(headerCheck.chatStatusText, "AI chat • Online");
    assert.ok(headerCheck.headerHeight <= 40, `Compact top header must be <= 40px (got ${headerCheck.headerHeight})`);
    assert.ok(headerCheck.headerEmblemSize > 0 && headerCheck.headerEmblemSize <= 24, `Header wand emblem must be compact <= 24px (got ${headerCheck.headerEmblemSize})`);
    assert.equal(headerCheck.emblemOverflow, "visible", "Emblem wrapper must not clip animated sparkles");
    assert.equal(headerCheck.svgOverflow, "visible", "Emblem SVG must not clip animated sparkles");
    assert.notEqual(headerCheck.emblemRadius, "50%", "Old circular badge shape must be replaced by sleek rounded-square badge");
    assert.ok(headerCheck.emptyEmblemSize >= 48 && headerCheck.emptyEmblemSize <= 56, `Desktop empty emblem must be compact 48-56px (got ${headerCheck.emptyEmblemSize})`);
    assert.match(headerCheck.badgeSheenName, /jevBadgeSheen/);
    assert.match(headerCheck.emptySheenName, /jevBadgeSheen/);
    assert.equal(headerCheck.badgeSheenIter, "infinite");
    assert.equal(headerCheck.badgeSheenState, "running");
    assert.equal(headerCheck.hasEmblem, true);
    assert.equal(headerCheck.hasEmptyEmblem, true);
    assert.equal(headerCheck.oldRingCount, 0, "All old circular/radar/crosshair ring elements must be completely removed");
    assert.equal(headerCheck.hasWandShaft, true, "Sparkle-wand shaft must be present");
    assert.equal(headerCheck.hasWandTip, true, "Sparkle-wand luminous tip must be present");
    assert.equal(headerCheck.hasEmptyWand, true, "Welcome empty state must display Sparkle-Wand AI logo");
    for (let i = 0; i < headerCheck.t1.length; i++) {
      const a = headerCheck.t1[i];
      const b = headerCheck.t2[i];
      assert.ok(a.name && a.name !== "none", `${a.sel} must have active animationName (got ${a.name})`);
      assert.ok(a.iter.includes("infinite"), `${a.sel} must loop infinitely (got ${a.iter})`);
      assert.ok(a.state.includes("running"), `${a.sel} must be running (got ${a.state})`);
      assert.notEqual(a.transform, b.transform, `${a.sel} transform must continuously mutate over time`);
    }

    // B2. Mobile 390x844 layout check: non-overlapping compact header, large center emblem, non-overlapping >=44px composer controls
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.eval(`new Promise(r => setTimeout(r, 120))`);
    const mobileCheck = await cdp.eval(`(() => {
      const r = sel => document.querySelector(sel)?.getBoundingClientRect().toJSON() || null;
      const overlaps = (a, b) => a && b && !(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1);
      const header = r('#chatbotWindow .chatbot-header');
      const left = r('#chatbotWindow .chatbot-header-left');
      const center = r('#chatbotWindow .chatbot-header-center');
      const right = r('#chatbotWindow .chatbot-header-right');
      const titleEl = document.getElementById('chatbotTitle');
      const emptyLg = r('#chatEmptyState .chat-empty-emblem .chat-ai-emblem-lg');
      const tierTrigger = r('#chatTierTrigger');
      const thinkTrigger = r('#chatThinkingTrigger');
      const attachBtn = r('#chatAttachButton');
      const webBtn = r('#chatWebSearchBtn');
      const sendBtn = r('#chatSend');
      return {
        headerHeight: header?.height || 999,
        headerLeftCenterOverlap: overlaps(left, center),
        headerCenterRightOverlap: overlaps(center, right),
        titleClipped: titleEl ? titleEl.scrollWidth > titleEl.clientWidth + 1 : true,
        emptyEmblemWidth: emptyLg?.width || 0,
        tierThinkOverlap: overlaps(tierTrigger, thinkTrigger),
        thinkWebOverlap: overlaps(thinkTrigger, webBtn),
        attachWebOverlap: overlaps(attachBtn, webBtn),
        webSendOverlap: overlaps(webBtn, sendBtn),
        webBtnHeight: webBtn?.height || 0,
        tierHeight: tierTrigger?.height || 0,
        thinkHeight: thinkTrigger?.height || 0
      };
    })()`);
    assert.ok(mobileCheck.headerHeight <= 40, `Mobile header must be <= 40px (got ${mobileCheck.headerHeight})`);
    assert.equal(mobileCheck.headerLeftCenterOverlap, false, "Mobile header left controls must not overlap center badge");
    assert.equal(mobileCheck.headerCenterRightOverlap, false, "Mobile header center badge must not overlap right controls");
    assert.equal(mobileCheck.titleClipped, false, "Mobile 'Jevexa AI' badge title must fit without ellipsis truncation");
    assert.ok(mobileCheck.emptyEmblemWidth >= 42 && mobileCheck.emptyEmblemWidth <= 50, `Mobile center emblem must be compact 42-50px (got ${mobileCheck.emptyEmblemWidth})`);
    assert.equal(mobileCheck.tierThinkOverlap, false, "Mobile Engine and Thinking dropdowns must not overlap");
    assert.equal(mobileCheck.thinkWebOverlap, false, "Mobile Thinking dropdown and Web Search button must not overlap");
    assert.equal(mobileCheck.attachWebOverlap, false, "Mobile Attach and Web Search buttons must not overlap");
    assert.equal(mobileCheck.webSendOverlap, false, "Mobile Web Search and Send buttons must not overlap");
    assert.ok(mobileCheck.webBtnHeight >= 44 && mobileCheck.tierHeight >= 44 && mobileCheck.thinkHeight >= 44, "Mobile composer buttons must remain >= 44px tall");

    // Restore desktop viewport for remaining checks
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await cdp.eval(`new Promise(r => setTimeout(r, 80))`);

    // B. Verify guaranteed Used Credits rendering even when server omits creditsUsed
    await cdp.eval(`
      document.getElementById('chatInput').value = 'Test guaranteed credits';
      document.getElementById('chatSend').click();
    `);
    await cdp.eval(`new Promise((r, rej) => {
      const start = Date.now();
      const check = () => {
        const rc = document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .chat-credit-receipt');
        if (rc && !rc.hidden) return r();
        if (Date.now() - start > 6000) return rej(new Error('Receipt timeout'));
        setTimeout(check, 40);
      };
      check();
    })`);
    const chatOutputState = await cdp.eval(`(() => {
      const bot = document.querySelector('#chatMessages .message.bot:not([data-chat-welcome])');
      const statusEl = document.getElementById('chatCreditStatus');
      const statusParts = statusEl ? Array.from(statusEl.children).map(el => el.textContent.trim()) : [];
      return {
        receiptText: bot.querySelector('.chat-credit-receipt')?.textContent.trim() || '',
        bodyHtml: bot.querySelector('.msg-body')?.innerHTML || '',
        bottomStatusText: statusEl?.textContent.trim() || '',
        statusParts,
        statusGap: statusEl ? getComputedStyle(statusEl).columnGap : ''
      };
    })()`);
    assert.match(chatOutputState.receiptText, /Used credit:\s*2/);
    assert.match(chatOutputState.receiptText, /Remaining credit:\s*248/);
    assert.match(chatOutputState.bottomStatusText, /^Core Engine\s+Used credit:\s*2\s+Remaining credit:\s*248$/);
    assert.equal(chatOutputState.statusParts.length, 3, "Bottom credit line must render 3 distinct parts: engine, used credit, remaining credit");
    assert.equal(chatOutputState.statusParts[0], "Core Engine");
    assert.match(chatOutputState.statusParts[1], /^Used credit:\s*2$/);
    assert.match(chatOutputState.statusParts[2], /^Remaining credit:\s*248$/);
    assert.notEqual(chatOutputState.statusGap, "0px", "Bottom credit line parts must have clean spacing gap");
    assert.doesNotMatch(chatOutputState.bodyHtml, /\*\*\*/);
    assert.match(chatOutputState.bodyHtml, /<strong><em>Bold Emphasis<\/em><\/strong>/);

    // B3. Verify Page Refresh (F5 / Reload) preserves active messages, Used Credits receipt, sidebar session & draft input
    await cdp.eval(`
      const inp = document.getElementById('chatInput');
      inp.value = 'Unsent draft message after reload';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await cdp.send("Page.navigate", { url: `${baseUrl}/tools/chatbot` });
    await cdp.eval(`new Promise(r => { if (document.readyState === 'complete' && window.JEVEXA_RESUME_CHAT) r(); else window.addEventListener('load', () => setTimeout(r, 150), { once: true }); })`);
    await cdp.eval(`new Promise(r => setTimeout(r, 180))`);
    const postReloadState = await cdp.eval(`(() => {
      const userMsgs = Array.from(document.querySelectorAll('#chatMessages .message.user .msg-body')).map(el => el.textContent.trim());
      const botMsgs = Array.from(document.querySelectorAll('#chatMessages .message.bot:not([data-chat-welcome]) .msg-body')).map(el => el.textContent.trim());
      const receipt = document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .chat-credit-receipt')?.textContent.trim() || '';
      const sidebarRows = document.querySelectorAll('#chatHistoryList .chat-history-row').length;
      return {
        chatOpen: document.getElementById('chatbotWindow')?.classList.contains('open'),
        userMsgs,
        botMsgs,
        receipt,
        sidebarRows,
        draftValue: document.getElementById('chatInput')?.value || '',
        emptyHidden: Boolean(document.getElementById('chatEmptyState')?.hidden)
      };
    })()`);
    assert.equal(postReloadState.chatOpen, true, "Reloading /tools/chatbot must keep chatbot open");
    assert.ok(postReloadState.userMsgs.some(t => t.includes('Test guaranteed credits')), "User prompt must survive page refresh");
    assert.ok(postReloadState.botMsgs.some(t => t.includes('Spacious flagship reply')), "Assistant reply must survive page refresh");
    assert.match(postReloadState.receipt, /Used credit:\s*2/, "Used Credits receipt must survive page refresh");
    assert.ok(postReloadState.sidebarRows >= 1, "Sidebar session history must survive page refresh");
    assert.equal(postReloadState.draftValue, "Unsent draft message after reload", "Draft input must survive page refresh");
    assert.equal(postReloadState.emptyHidden, true, "Welcome empty state must stay hidden when conversation is restored");

    // B4. Verify Logout -> Login preserves chat history (both local & remote Supabase session restore)
    await cdp.eval(`(async () => { await window.logoutUser(); })()`);
    await cdp.eval(`new Promise(r => setTimeout(r, 150))`);
    const loggedOutState = await cdp.eval(`(() => ({
      botCount: document.querySelectorAll('#chatMessages .message.bot:not([data-chat-welcome])').length,
      sidebarRows: document.querySelectorAll('#chatHistoryList .chat-history-row').length,
      savedLocalSessions: Boolean(localStorage.getItem('jevexa_${userId}_chat_sessions'))
    }))()`);
    assert.equal(loggedOutState.botCount, 0, "Logged-out UI must not expose previous account messages");
    assert.equal(loggedOutState.sidebarRows, 0, "Logged-out sidebar must clear in-memory rows");
    assert.equal(loggedOutState.savedLocalSessions, true, "Logout must NOT wipe user-scoped saved chat sessions");

    // Simulate logging back into the same account
    await cdp.eval(`
      window.__MOCK_LOGIN();
      window.openExactServiceWorkspace('chatbot', true);
    `);
    await cdp.eval(`new Promise(r => setTimeout(r, 220))`);
    const reLoginState = await cdp.eval(`(() => ({
      userMsgs: Array.from(document.querySelectorAll('#chatMessages .message.user .msg-body')).map(el => el.textContent.trim()),
      botMsgs: Array.from(document.querySelectorAll('#chatMessages .message.bot:not([data-chat-welcome]) .msg-body')).map(el => el.textContent.trim()),
      receipt: document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .chat-credit-receipt')?.textContent.trim() || '',
      sidebarRows: document.querySelectorAll('#chatHistoryList .chat-history-row').length
    }))()`);
    assert.ok(reLoginState.userMsgs.some(t => t.includes('Test guaranteed credits')), "User prompt must be restored after logout -> login");
    assert.ok(reLoginState.botMsgs.some(t => t.includes('Spacious flagship reply')), "Assistant reply must be restored after logout -> login");
    assert.match(reLoginState.receipt, /Used credit:\s*2/, "Used Credits receipt must be restored after logout -> login");
    assert.ok(reLoginState.sidebarRows >= 1, "Sidebar sessions must be restored after logout -> login");

    // Simulate clean-storage login (e.g. cleared localStorage) restoring from /api/chat/sessions backend
    await cdp.eval(`(async () => { await window.logoutUser(); localStorage.removeItem('jevexa_${userId}_chat_sessions'); localStorage.removeItem('jevexa_${userId}_active_chat_id'); })()`);
    await cdp.eval(`new Promise(r => setTimeout(r, 120))`);
    await cdp.eval(`
      window.__MOCK_LOGIN();
      window.openExactServiceWorkspace('chatbot', true);
    `);
    await cdp.eval(`new Promise((r, rej) => {
      const start = Date.now();
      const check = () => {
        if (document.querySelectorAll('#chatMessages .message.bot:not([data-chat-welcome])').length > 0) return r();
        if (Date.now() - start > 5000) return rej(new Error('Remote restore timeout'));
        setTimeout(check, 40);
      };
      check();
    })`);
    const remoteRestoreState = await cdp.eval(`(() => ({
      botText: document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .msg-body')?.textContent.trim() || '',
      receipt: document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .chat-credit-receipt')?.textContent.trim() || '',
      sidebarRows: document.querySelectorAll('#chatHistoryList .chat-history-row').length
    }))()`);
    assert.match(remoteRestoreState.botText, /Spacious flagship reply/);
    assert.match(remoteRestoreState.receipt, /Used credit:\s*2/);
    assert.ok(remoteRestoreState.sidebarRows >= 1, "Remote /api/chat/sessions restore must populate sidebar and canvas");

    // C. Verify Offline -> blocked send notice -> Online recovery across ALL 10 workspaces
    await cdp.eval(`
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
      window.dispatchEvent(new Event('offline'));
    `);
    await cdp.eval(`new Promise(r => setTimeout(r, 150))`);
    await cdp.eval(`
      document.getElementById('chatInput').value = 'Should fail offline';
      document.getElementById('chatSend').click();
    `);
    await cdp.eval(`new Promise(r => setTimeout(r, 100))`);
    const offlineState = await cdp.eval(`(() => {
      const badges = Array.from(document.querySelectorAll('[data-jevexa-conn-badge]'));
      return {
        bodyOffline: document.body.classList.contains('is-offline'),
        allOffline: badges.every(b => b.classList.contains('is-offline') && b.querySelector('.conn-label')?.textContent.trim() === 'Offline'),
        chatStatus: document.getElementById('chatbotStatusText')?.textContent.trim(),
        creditNotice: document.getElementById('chatCreditStatus')?.textContent.trim(),
        userMsgCount: document.querySelectorAll('#chatMessages .message.user').length
      };
    })()`);
    assert.equal(offlineState.bodyOffline, true);
    assert.equal(offlineState.allOffline, true, "All 10 workspaces must switch immediately to Offline");
    assert.equal(offlineState.chatStatus, "Offline");
    assert.match(offlineState.creditNotice, /offline/i);
    assert.equal(offlineState.userMsgCount, 1, "Offline send must not append or send message");

    // Restore online
    await cdp.eval(`
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
      window.dispatchEvent(new Event('online'));
    `);
    await cdp.eval(`new Promise(r => setTimeout(r, 150))`);
    const restoredState = await cdp.eval(`(() => {
      const badges = Array.from(document.querySelectorAll('[data-jevexa-conn-badge]'));
      return {
        bodyOffline: document.body.classList.contains('is-offline'),
        allOnline: badges.every(b => b.classList.contains('is-online') && b.querySelector('.conn-label')?.textContent.trim() === 'Online')
      };
    })()`);
    assert.equal(restoredState.bodyOffline, false);
    assert.equal(restoredState.allOnline, true, "All 10 workspaces must automatically switch back to Online");

    // D. Verify Support AI client sanitization strips raw *** artifacts
    await cdp.eval(`
      window.JEVEXA_CLOSE_ALL_WORKSPACES?.();
      window.JEVEXA_SUPPORT_MODAL_OPEN?.();
      document.getElementById('supportAiInput').value = 'What does Pro cost?';
      document.getElementById('supportAiForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    `);
    await cdp.eval(`new Promise((r, rej) => {
      const start = Date.now();
      const check = () => {
        const msgs = document.querySelectorAll('#supportAiMessages .support-ai-message:not(.user)');
        const last = msgs[msgs.length - 1];
        if (last && /10,000 credits/.test(last.textContent)) return r();
        if (Date.now() - start > 5000) return rej(new Error('Support timeout'));
        setTimeout(check, 40);
      };
      check();
    })`);
    const supportRendered = await cdp.eval(`(() => {
      const msgs = document.querySelectorAll('#supportAiMessages .support-ai-message:not(.user)');
      const last = msgs[msgs.length - 1];
      return { text: last.textContent, html: last.innerHTML };
    })()`);
    assert.doesNotMatch(supportRendered.text, /\*\*\*/);
    assert.doesNotMatch(supportRendered.text, /###/);
    assert.match(supportRendered.html, /<strong>exact<\/strong>/);
    assert.match(supportRendered.html, /<strong>\$15\/mo<\/strong>/);
  } finally {
    if (cdp) cdp.close();
    try { chromeProc.kill("SIGKILL"); } catch {}
    server.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
});
