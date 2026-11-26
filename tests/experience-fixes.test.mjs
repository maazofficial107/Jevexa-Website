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

test("1. Universal Toast Z-Index & Clipboard Coverage across all copy handlers", async () => {
  const styles = await readAsset("styles.css");
  const scriptJs = await readAsset("script.js");
  const creditsJs = await readAsset("credits.js");
  const contentJs = await readAsset("content.js");
  const ocrJs = await readAsset("ocr.js");
  const socialJs = await readAsset("social.js");
  const analyticsJs = await readAsset("analytics.js");
  const dataJs = await readAsset("data-mgmt.js");
  const outreachJs = await readAsset("outreach.js");

  const toastBlockMatch = styles.match(/\.toast\s*\{[\s\S]*?z-index:\s*(\d+)/);
  assert.ok(toastBlockMatch, ".toast block must specify z-index");
  assert.ok(Number(toastBlockMatch[1]) >= 100100, `.toast z-index must render above #chatbotWindow (99999) and .tool-workspace (100000), got ${toastBlockMatch[1]}`);

  assert.match(scriptJs, /window\.JEVEXA_COPY_TO_CLIPBOARD\s*=/);
  assert.match(creditsJs, /window\.showToast\('Copied to clipboard'\)/);

  for (const [name, code] of [
    ["content.js", contentJs],
    ["ocr.js", ocrJs],
    ["social.js", socialJs],
    ["analytics.js", analyticsJs],
    ["data-mgmt.js", dataJs],
    ["outreach.js", outreachJs]
  ]) {
    assert.match(code, /JEVEXA_COPY_TO_CLIPBOARD/, `${name} must use universal JEVEXA_COPY_TO_CLIPBOARD helper`);
  }
});

test("2. Upgrade Modal /pricing links & Web Search delegation guards", async () => {
  const indexHtml = await readAsset("index.html");
  const pricingHtml = await readAsset("pricing.html");
  const creditsJs = await readAsset("credits.js");
  const scriptJs = await readAsset("script.js");

  assert.match(indexHtml, /id="upgradeModalPlans"[^>]*href="\/pricing"/);
  assert.match(scriptJs, /plansLink\.setAttribute\('href',\s*`\/pricing\?plan=/);
  assert.match(scriptJs, /__jevexaUpgradeCloseTimer/);
  assert.match(pricingHtml, /URLSearchParams\(window\.location\.search/);
  assert.match(creditsJs, /function handleWebSearchButtonActivation/);
  assert.match(creditsJs, /\.chat-tier-controls/);
});

test("3. Worker Chatbot Intelligence: Thinking Budget, Depth Prompts, Roman Urdu Detection & Support AI", async () => {
  const workerEnv = {
    SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
    SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    JEVEXA_ENVIRONMENT: "production",
    GEMINI_API_KEY: "test-gemini-key",
    AI_PRIMARY_PROVIDER: "gemini"
  };
  const authUserId = "11111111-1111-4111-8111-111111111111";

  const makeChat = async (payload, capturedGeminiBody) => {
    const reqId = crypto.randomUUID();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = typeof url === "string" ? new URL(url) : new URL(url.url);
      if (u.pathname === "/auth/v1/user") {
        return Response.json({ id: authUserId, email: "pro@jevexa.net" });
      }
      if (u.pathname === "/rest/v1/user_credits") {
        return Response.json([{ plan: "max", balance: 22000 }]);
      }
      if (u.pathname === "/rest/v1/profiles") {
        return Response.json([{ plan: "max", credits: 22000 }]);
      }
      if (u.pathname === "/rest/v1/jevexa_service_pricing") {
        return Response.json([{ fixed_credits: 18, enabled: true, integration_status: "available" }]);
      }
      if (u.pathname === "/rest/v1/credit_transactions" || u.pathname === "/rest/v1/credit_reservations") {
        return Response.json([]);
      }
      if (u.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
        return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 18, balance: 21982 });
      }
      if (u.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
        return Response.json({ ok: true, charged_credits: 18, balance: 21982 });
      }
      if (u.hostname === "generativelanguage.googleapis.com") {
        capturedGeminiBody.push(JSON.parse(init.body));
        return Response.json({
          candidates: [{ content: { parts: [{ text: "Test response." }], role: "model" }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15, totalTokenCount: 35 }
        });
      }
      return Response.json([], { status: 200 });
    };
    try {
      const res = await worker.fetch(new Request("https://jevexa.net/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer jwt-token",
          "Idempotency-Key": reqId
        },
        body: JSON.stringify({
          requestId: reqId,
          ...payload
        })
      }), workerEnv);
      const bodyText = await res.clone().text();
      assert.equal(res.status, 200, `Expected 200 OK from /api/chat, got ${res.status}: ${bodyText}`);
      return res;
    } finally {
      globalThis.fetch = origFetch;
    }
  };

  // Verify off vs low vs standard vs max produce distinct thinkingBudget and depth guidance
  const captured = [];
  await makeChat({ message: "Explain caching", tier: "max", thinkingLevel: "off" }, captured);
  await makeChat({ message: "Explain caching", tier: "max", thinkingLevel: "low" }, captured);
  await makeChat({ message: "Explain caching", tier: "max", thinkingLevel: "standard" }, captured);
  await makeChat({ message: "Explain caching", tier: "max", thinkingLevel: "max" }, captured);

  assert.equal(captured.length, 4);
  assert.equal(captured[0].generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(captured[1].generationConfig.thinkingConfig.thinkingBudget, 512);
  assert.equal(captured[2].generationConfig.thinkingConfig.thinkingBudget, 1536);
  assert.equal(captured[3].generationConfig.thinkingConfig.thinkingBudget, 4096);

  assert.match(captured[0].systemInstruction.parts[0].text, /THINKING DEPTH = OFF/);
  assert.match(captured[1].systemInstruction.parts[0].text, /THINKING DEPTH = LOW/);
  assert.match(captured[2].systemInstruction.parts[0].text, /THINKING DEPTH = MEDIUM/);
  assert.match(captured[3].systemInstruction.parts[0].text, /THINKING DEPTH = MAX/);

  // Verify expanded concise Roman Urdu detection triggers language guidance
  const romanCaptured = [];
  const romanRes = await makeChat({ message: "bhai ye code samjhao", tier: "max", thinkingLevel: "off" }, romanCaptured);
  const romanJson = await romanRes.json();
  assert.equal(romanJson.detectedLanguage, "roman_urdu");
  assert.match(romanCaptured[0].systemInstruction.parts[0].text, /Roman Urdu/);

  // Verify Support AI handles Roman Urdu pricing query cleanly with exact platform facts
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = typeof url === "string" ? new URL(url) : new URL(url.url);
    if (u.hostname === "generativelanguage.googleapis.com") {
      const b = JSON.parse(init.body);
      assert.match(b.systemInstruction.parts[0].text, /Roman Urdu/i);
      assert.match(b.systemInstruction.parts[0].text, /Pro \(\$15\/mo/);
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Pro plan $15/mo ka hai aur is mein 10,000 credits milte hain." }], role: "model" }, finishReason: "STOP" }]
      });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  try {
    const supRes = await worker.fetch(new Request("https://jevexa.net/api/support/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.77" },
      body: JSON.stringify({ message: "Pro plan ki price kya hai bhai?" })
    }), workerEnv);
    assert.equal(supRes.status, 200);
    const supData = await supRes.json();
    assert.match(supData.reply, /\$15\/mo/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("4. Headless Browser E2E: Web Search Lock -> Upgrade Modal -> /pricing, Clipboard Toast across Services, Mobile Wrap", async (t) => {
  const browserBin = findBrowserExecutable();
  if (!browserBin) {
    t.skip("No Chromium/Edge executable available for headless CDP verification");
    return;
  }

  let server;
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "jevexa-exp-e2e-"));
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
  };

  server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, "http://127.0.0.1");
    const pathname = reqUrl.pathname;

    if (pathname === "/config.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(`window.JEVEXA_SUPABASE_CONFIG={url:"http://127.0.0.1:${server.address().port}",anonKey:"e2e-anon"};`);
      return;
    }
    if (pathname === "/api/credits/pricing") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ services: [] }));
      return;
    }

    let targetPath = path.join(projectRoot, pathname === "/" ? "index.html" : pathname.slice(1));
    if (pathname === "/pricing") targetPath = path.join(projectRoot, "pricing.html");
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

  // Override /mock-supabase.js properly inside request handler
  const originalListeners = server.listeners("request").slice();
  server.removeAllListeners("request");
  server.on("request", async (req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (pathname === "/mock-supabase.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(`
        window.supabase = {
          createClient() {
            return {
              auth: {
                async getSession() { return { data: { session: { access_token: "jwt", user: { id: "11111111-1111-4111-8111-111111111111", email: "free@jevexa.net" } } }, error: null }; },
                async getUser() { return { data: { user: { id: "11111111-1111-4111-8111-111111111111", email: "free@jevexa.net" } }, error: null }; },
                onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }
              },
              from() {
                return {
                  select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; }, limit() { return this; },
                  async maybeSingle() { return { data: { plan: "free", balance: 100 }, error: null }; }
                };
              }
            };
          }
        };
      `);
      return;
    }
    return originalListeners[0](req, res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const proc = spawn(browserBin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--window-size=1280,860",
    "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let cdp = null;
  try {
    const devToolsUrl = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("DevTools timeout")), 10000);
      const onChunk = (chunk) => {
        const match = chunk.toString("utf8").match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(t);
          resolve(match[1]);
        }
      };
      proc.stderr.on("data", onChunk);
      proc.stdout.on("data", onChunk);
    });
    const listRes = await fetch(devToolsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"));
    const list = await listRes.json();
    const target = list.find(x => x.type === "page") || list[0];
    cdp = new SimpleCdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

    await cdp.send("Page.navigate", { url: baseUrl });
    await cdp.eval(`new Promise(r => { if (document.readyState === 'complete') r(); else window.addEventListener('load', r, { once: true }); })`);

    // Open Chatbot and click Web Search on Free plan -> must immediately open Upgrade Modal linking to /pricing
    await cdp.eval(`document.getElementById('chatbotToggle').click()`);
    await cdp.eval(`new Promise(r => setTimeout(r, 150))`);
    await cdp.eval(`document.getElementById('chatWebSearchBtn').click()`);
    await cdp.eval(`new Promise(r => setTimeout(r, 60))`);
    const modal1 = await cdp.eval(`({
      hidden: document.getElementById('upgradeModal').hidden,
      isOpen: document.getElementById('upgradeModal').classList.contains('is-open'),
      plan: document.getElementById('upgradeModal').dataset.requiredPlan,
      href: document.getElementById('upgradeModalPlans').getAttribute('href'),
      msg: document.getElementById('upgradeModalMessage').textContent
    })`);
    assert.equal(modal1.hidden, false);
    assert.equal(modal1.isOpen, true);
    assert.equal(modal1.plan, "pro");
    assert.match(modal1.href, /^\/pricing\?plan=pro/);
    assert.match(modal1.msg, /Pro \(\$15\/mo/);

    // Verify rapid close -> immediate reopen is NOT hidden by stale closeTimer
    await cdp.eval(`
      document.getElementById('upgradeModalClose').click();
      setTimeout(() => document.getElementById('chatWebSearchBtn').click(), 50);
    `);
    await cdp.eval(`new Promise(r => setTimeout(r, 320))`);
    const afterRapidReopen = await cdp.eval(`({
      hidden: document.getElementById('upgradeModal').hidden,
      isOpen: document.getElementById('upgradeModal').classList.contains('is-open')
    })`);
    assert.equal(afterRapidReopen.hidden, false, "Rapid reopen must not be dismissed by stale close timer");
    assert.equal(afterRapidReopen.isOpen, true);
    await cdp.eval(`document.getElementById('upgradeModalClose').click()`);
    await cdp.eval(`new Promise(r => setTimeout(r, 260))`);

    // Verify Universal Copy + Toast renders ABOVE Chatbot/Workspaces across services
    await cdp.eval(`
      window.__LAST_COPIED = null;
      if (navigator.clipboard) navigator.clipboard.writeText = async (t) => { window.__LAST_COPIED = t; };
    `);
    const toastStyleCheck = await cdp.eval(`({
      toastZ: Number(getComputedStyle(document.getElementById('toast')).zIndex),
      chatZ: Number(getComputedStyle(document.getElementById('chatbotWindow')).zIndex)
    })`);
    assert.ok(toastStyleCheck.toastZ > toastStyleCheck.chatZ, `Toast z-index (${toastStyleCheck.toastZ}) must exceed chatbot (${toastStyleCheck.chatZ})`);

    await cdp.eval(`(async () => { await window.JEVEXA_COPY_TO_CLIPBOARD('Test snippet', { toastMessage: 'Copied to clipboard' }); })()`);
    const toastVisible = await cdp.eval(`({
      copied: window.__LAST_COPIED,
      text: document.getElementById('toast').textContent,
      show: document.getElementById('toast').classList.contains('show'),
      opacity: getComputedStyle(document.getElementById('toast')).opacity
    })`);
    assert.equal(toastVisible.copied, "Test snippet");
    assert.equal(toastVisible.text, "Copied to clipboard");
    assert.equal(toastVisible.show, true);

    // Check Copy buttons across Content, OCR, Social, Analytics, Data Management, and Outreach trigger clipboard + toast
    await cdp.eval(`
      document.getElementById('contentOutput').textContent = 'Generated Sample Article';
      document.getElementById('contentCopy').disabled = false;
      document.getElementById('contentCopy').click();
    `);
    await cdp.eval(`new Promise(r => setTimeout(r, 80))`);
    assert.equal(await cdp.eval(`window.__LAST_COPIED`), "Generated Sample Article");
    assert.equal(await cdp.eval(`document.getElementById('toast').classList.contains('show')`), true);

    for (const [btnId, prepExpr] of [
      ["ocrCopyJsonBtn", ""],
      ["ocrCopyTextBtn", ""],
      ["socialCopyPostBtn", "document.getElementById('socialPostBody').value = 'Live post draft copy'"],
      ["analyticsCopyReportBtn", ""],
      ["dataCopyClipboardBtn", ""],
      ["outreachCopyEmailBtn", "document.getElementById('outreachEmailSubject').value = 'Hello'; document.getElementById('outreachEmailBody').value = 'Body copy';"]
    ]) {
      await cdp.eval(`
        window.__LAST_COPIED = null;
        document.getElementById('toast').classList.remove('show');
        ${prepExpr};
        document.getElementById('${btnId}').click();
      `);
      await cdp.eval(`new Promise(r => setTimeout(r, 90))`);
      const copyRes = await cdp.eval(`({
        copied: Boolean(window.__LAST_COPIED && window.__LAST_COPIED.length > 0),
        toastShow: document.getElementById('toast').classList.contains('show')
      })`);
      assert.equal(copyRes.copied, true, `${btnId} must write non-empty text to clipboard`);
      assert.equal(copyRes.toastShow, true, `${btnId} must trigger visible floating toast`);
    }

    // Check Mobile 390x844 Web Search button hitbox & zero horizontal overflow
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.eval(`new Promise(r => setTimeout(r, 150))`);
    const mobileWebCheck = await cdp.eval(`(() => {
      const btn = document.getElementById('chatWebSearchBtn');
      const r = btn.getBoundingClientRect();
      return {
        width: r.width,
        height: r.height,
        rightEdge: r.right,
        vw: window.innerWidth,
        docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    assert.ok(mobileWebCheck.height >= 44, "Mobile Web Search button must remain >= 44px tall");
    assert.ok(mobileWebCheck.rightEdge <= mobileWebCheck.vw + 1, "Mobile Web Search button must stay inside viewport");
    assert.equal(mobileWebCheck.docOverflow, false);

    // Check clicking #upgradeModalPlans navigates to /pricing?plan=pro
    await cdp.eval(`document.getElementById('chatWebSearchBtn').click()`);
    await cdp.eval(`new Promise(r => setTimeout(r, 60))`);
    await Promise.all([
      cdp.eval(`document.getElementById('upgradeModalPlans').click()`),
      new Promise(r => setTimeout(r, 700))
    ]);
    const finalHref = await cdp.eval(`window.location.pathname + window.location.search`);
    assert.equal(finalHref, "/pricing?plan=pro");
  } finally {
    cdp?.close();
    proc.kill();
    await new Promise((resolve) => server.close(resolve));
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});
