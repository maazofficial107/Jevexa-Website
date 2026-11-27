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
const userId = "33333333-3333-4333-8333-333333333333";

function findChromeBinary() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Eval error");
    }
    return res.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

test("Phase 1 & 2: Worker canonicalizes www/HTTP redirects and enforces optimal static Cache-Control", async () => {
  // 1. www.jevexa.net -> 301 https://jevexa.net
  const wwwRes = await worker.fetch(new Request("https://www.jevexa.net/tools/chatbot?ref=test", { method: "GET" }), baseEnv);
  assert.equal(wwwRes.status, 301);
  assert.equal(wwwRes.headers.get("Location"), "https://jevexa.net/tools/chatbot?ref=test");

  // 2. http://jevexa.net -> 301 https://jevexa.net
  const httpRes = await worker.fetch(new Request("http://jevexa.net/", { method: "HEAD" }), baseEnv);
  assert.equal(httpRes.status, 301);
  assert.equal(httpRes.headers.get("Location"), "https://jevexa.net/");

  // 3. https://jevexa.net/ serves HTML with must-revalidate (no redirect loop)
  const mockAssetsEnv = {
    ...baseEnv,
    ASSETS: {
      fetch: async (req) => new Response("asset-body", { status: 200, headers: { "Content-Type": "text/plain" } })
    }
  };
  const rootRes = await worker.fetch(new Request("https://jevexa.net/"), mockAssetsEnv);
  assert.equal(rootRes.status, 200);
  assert.match(rootRes.headers.get("Cache-Control") || "", /must-revalidate/);

  // 4. Long-lived cache for /assets/logo.svg and /assets/icon-192.png
  const logoRes = await worker.fetch(new Request("https://jevexa.net/assets/logo.svg"), mockAssetsEnv);
  assert.equal(logoRes.status, 200);
  assert.match(logoRes.headers.get("Cache-Control") || "", /max-age=2592000/);

  // 5. _headers file configures edge static asset caching
  const headersFile = await readAsset("_headers");
  assert.match(headersFile, /\/assets\/\*/);
  assert.match(headersFile, /max-age=2592000/);
  assert.match(headersFile, /\/\*\.(?:css|js)|\/\*\.css/);
});

test("Phase 1: Auth triggers, tabs, 4s timeout guard, and zero document.write", async () => {
  const indexHtml = await readAsset("index.html");
  const scriptJs = await readAsset("script.js");

  assert.doesNotMatch(indexHtml, /document\.write\(/);
  assert.match(indexHtml, /id="authTabLogin"[^>]*data-auth-tab="login"/);
  assert.match(indexHtml, /id="authTabSignup"[^>]*data-auth-tab="signup"/);
  assert.match(indexHtml, /id="signupNameError"/);
  assert.match(indexHtml, /id="loginEmailError"/);
  assert.match(indexHtml, /id="loginPasswordError"/);
  assert.match(indexHtml, /<script defer src="\/crm\.js"><\/script>/);
  assert.match(indexHtml, /<script defer src="\/analytics\.js"><\/script>/);

  assert.match(scriptJs, /async function fetchSessionWithTimeoutAndRetry\(\{ timeoutMs = 4000, maxRetries = 2 \}/);
  assert.match(scriptJs, /window\.JEVEXA_GET_SESSION = fetchSessionWithTimeoutAndRetry/);
  assert.match(scriptJs, /function validateAuthField\(/);
  assert.match(scriptJs, /target\.closest\('\[data-auth-action\]'\)/);
  assert.match(scriptJs, /cleanPath === '\/login'/);
  assert.match(scriptJs, /cleanPath === '\/signup'/);
});

test("Phase 3: Worker /api/chat/sessions lifecycle and fast Groq failover profile", async () => {
  const originalFetch = globalThis.fetch;
  let storedSession = null;

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId, email: "pro@jevexa.net" });
    if (url.pathname === "/rest/v1/chat_sessions") {
      if (options.method === "POST") {
        storedSession = JSON.parse(options.body);
        return Response.json([storedSession], { status: 201 });
      }
      if (options.method === "DELETE") {
        storedSession = null;
        return new Response(null, { status: 204 });
      }
      return Response.json(storedSession ? [storedSession] : []);
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    // 1. Unauthenticated returns 401
    const unauth = await worker.fetch(new Request("https://jevexa.net/api/chat/sessions"), baseEnv);
    assert.equal(unauth.status, 401);

    // 2. Save session via PUT
    const putRes = await worker.fetch(new Request("https://jevexa.net/api/chat/sessions", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({
        session: {
          id: "sess-1",
          title: "Test Chat",
          pinned: true,
          messages: [{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi there!" }],
          updatedAt: Date.now()
        }
      })
    }), baseEnv);
    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.ok, true);
    assert.equal(putData.storage, "supabase");

    // 3. List sessions via GET
    const getRes = await worker.fetch(new Request("https://jevexa.net/api/chat/sessions", {
      headers: { Authorization: "Bearer tok" }
    }), baseEnv);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.sessions.length, 1);
    assert.equal(getData.sessions[0].title, "Test Chat");

    // 4. Delete session
    const delRes = await worker.fetch(new Request("https://jevexa.net/api/chat/sessions?id=sess-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer tok" }
    }), baseEnv);
    assert.equal(delRes.status, 200);
    assert.equal(storedSession, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Phase 3: Chatbot user Copy/Edit actions, syntax highlighting, and XSS-safe code rendering", async () => {
  const creditsJs = await readAsset("credits.js");
  const stylesCss = await readAsset("styles.css");

  assert.match(creditsJs, /function buildUserActionButtons\(\)/);
  assert.match(creditsJs, /dataset\.chatAction = 'copy-user'/);
  assert.match(creditsJs, /dataset\.chatAction = 'edit-user'/);
  assert.match(creditsJs, /function startInlineUserEdit\(/);
  assert.match(creditsJs, /function copyButtonWithFeedback\(/);
  assert.match(creditsJs, /function highlightCodeTokens\(/);
  assert.match(stylesCss, /\.chat-user-actions/);
  assert.match(stylesCss, /\.chat-user-edit-textarea/);
  assert.match(stylesCss, /\.chat-code-header[\s\S]*?position:\s*sticky/);
  assert.match(stylesCss, /\.tok-kw/);

  // Functional check on renderMarkdown + highlightCodeTokens
  const start = creditsJs.indexOf("function escapeMarkdownHtml(str)");
  const end = creditsJs.indexOf("function trimConversationToMax(");
  const fnSource = creditsJs.slice(start, end);
  const renderMarkdown = new Function(`${fnSource}; return renderMarkdown;`)();
  const out = renderMarkdown("```js\nconst greeting = 'hello'; // test 42\n```");
  assert.match(out, /<span class="tok-kw">const<\/span>/);
  assert.match(out, /<span class="tok-str">&#39;hello&#39;<\/span>/);
  assert.match(out, /<span class="tok-com">\/\/ test 42<\/span>/);
});

test("Phase 4 E2E (Headless Chrome): Auth modal triggers, validation, session hydration, chatbot copy/edit & regenerate, mobile layout", async (t) => {
  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    t.skip("Chrome/Edge binary not found for headless E2E");
    return;
  }

  let currentBalance = 100;
  let currentPlan = "free";
  let lastChatBody = null;
  let chatCalls = 0;
  const mockUser = {
    id: userId,
    email: "architect@jevexa.net",
    created_at: "2026-11-01T00:00:00Z",
    user_metadata: { full_name: "Maaz Architect" }
  };

  // Serve real project files + mocked /config.js, Supabase SDK shim, and /api/chat SSE
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, "http://127.0.0.1");
    const pathname = reqUrl.pathname;

    if (pathname === "/config.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(`window.JEVEXA_SUPABASE_CONFIG={url:"http://127.0.0.1:${server.address().port}",anonKey:"e2e-anon"};`);
      return;
    }

    if (pathname === "/mock-balance") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ balance: currentBalance, plan: currentPlan }));
      return;
    }

    if (pathname === "/mock-upgrade-pro") {
      currentPlan = "pro";
      currentBalance = 10000;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ balance: currentBalance, plan: currentPlan }));
      return;
    }

    if (pathname === "/mock-supabase.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(`
        window.__MOCK_AUTH_STATE = { session: null, listeners: [] };
        window.supabase = {
          createClient() {
            return {
              auth: {
                async getSession() { return { data: { session: window.__MOCK_AUTH_STATE.session }, error: null }; },
                async getUser() { return { data: { user: window.__MOCK_AUTH_STATE.session?.user || null }, error: null }; },
                onAuthStateChange(cb) {
                  window.__MOCK_AUTH_STATE.listeners.push(cb);
                  return { data: { subscription: { unsubscribe() {} } } };
                },
                async signInWithPassword({ email }) {
                  const session = { access_token: "e2e-jwt", user: ${JSON.stringify(mockUser)} };
                  session.user.email = email;
                  window.__MOCK_AUTH_STATE.session = session;
                  window.__MOCK_AUTH_STATE.listeners.forEach(cb => cb("SIGNED_IN", session));
                  return { data: { user: session.user, session }, error: null };
                },
                async signOut() {
                  window.__MOCK_AUTH_STATE.session = null;
                  window.__MOCK_AUTH_STATE.listeners.forEach(cb => cb("SIGNED_OUT", null));
                  return { error: null };
                }
              },
              from(table) {
                return {
                  select() { return this; },
                  eq() { return this; },
                  in() { return this; },
                  order() { return this; },
                  limit() { return this; },
                  async maybeSingle() {
                    if (table === "user_credits") {
                      const r = await fetch('/mock-balance').then(x => x.json()).catch(() => ({ balance: 100, plan: "free" }));
                      return { data: { balance: r.balance, plan: r.plan || "free" }, error: null };
                    }
                    if (table === "profiles") {
                      const r = await fetch('/mock-balance').then(x => x.json()).catch(() => ({ balance: 100, plan: "free" }));
                      return { data: { plan: r.plan || "free", credits: r.balance }, error: null };
                    }
                    return { data: null, error: null };
                  }
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
      res.end(JSON.stringify({ estimatedCredits: 1 }));
      return;
    }

    if (pathname === "/api/memories" || pathname === "/api/chat/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, memories: [], sessions: [] }));
      return;
    }

    if (pathname === "/api/chat" && req.method === "POST") {
      let bodyStr = "";
      for await (const chunk of req) bodyStr += chunk;
      const body = JSON.parse(bodyStr || "{}");
      lastChatBody = body;
      chatCalls += 1;
      const webGrounded = body.webSearch === true;
      currentBalance = Math.max(0, currentBalance - (webGrounded ? 6 : 1));

      const isPythonEdit = /python/i.test(body.message || "");
      const reply = isPythonEdit
        ? "Here is Python:\n```python\ndef hello():\n    return 'world'\n```"
        : "Here is JavaScript:\n```js\nconst hello = () => 'world';\n```";

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      res.write(`event: status\ndata: ${JSON.stringify({ phase: "thinking", tier: body.tier || "lite", model: "Jevexa Lite" })}\n\n`);
      const mid = Math.floor(reply.length / 2);
      res.write(`event: token\ndata: ${JSON.stringify({ text: reply.slice(0, mid) })}\n\n`);
      res.write(`event: token\ndata: ${JSON.stringify({ text: reply.slice(mid) })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({
        reply,
        tier: body.tier || "lite",
        model: body.tier === "pro" ? "Jevexa Pro" : "Jevexa Lite",
        modelName: body.tier === "pro" ? "Jevexa Pro" : "Jevexa Lite",
        webSearch: webGrounded,
        webSearchSurcharge: webGrounded ? 5 : 0,
        creditsCharged: webGrounded ? 6 : 1,
        creditsRemaining: currentBalance,
        credits_used: webGrounded ? 6 : 1,
        remaining_credits: currentBalance,
        requestId: body.requestId
      })}\n\n`);
      res.end();
      return;
    }

    // Static files from ROOT_DIR; inject mock-supabase in place of external CDN for deterministic offline E2E
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.join(ROOT_DIR, rel);
    if (!filePath.startsWith(ROOT_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".webmanifest": "application/manifest+json"
    };
    let content = fs.readFileSync(filePath);
    if (rel === "index.html") {
      let htmlStr = content.toString("utf8");
      htmlStr = htmlStr.replace(
        "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js",
        "/mock-supabase.js"
      );
      // Skip external Google Fonts / Font Awesome / AOS in offline E2E to avoid network noise
      htmlStr = htmlStr.replace(/https:\/\/fonts\.googleapis\.com[^"']*/g, "");
      htmlStr = htmlStr.replace(/https:\/\/cdnjs\.cloudflare\.com[^"']*/g, "");
      htmlStr = htmlStr.replace(/https:\/\/unpkg\.com\/aos[^"']*/g, "");
      content = Buffer.from(htmlStr, "utf8");
    }
    res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream" });
    res.end(content);
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jevexa-e2e-profile-"));
  const chromeProc = spawn(chromeBin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1280,860",
    "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let cdp = null;
  try {
    const devToolsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome DevTools timeout")), 10000);
      const onData = (chunk) => {
        const match = chunk.toString("utf8").match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      chromeProc.stderr.on("data", onData);
      chromeProc.stdout.on("data", onData);
    });

    const targetsRes = await fetch(devToolsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"));
    const targets = await targetsRes.json();
    const pageTarget = targets.find(x => x.type === "page") || targets[0];
    assert.ok(pageTarget?.webSocketDebuggerUrl, "CDP page target must exist");

    cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

    // Grant clipboard permissions for E2E copy testing
    await cdp.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: baseUrl }).catch(() => {});

    const pageErrors = [];
    cdp.ws.addEventListener("message", (evt) => {
      try {
        const m = JSON.parse(evt.data);
        if (m.method === "Runtime.exceptionThrown") {
          pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "Runtime error");
        }
      } catch {}
    });
    const loadStart = Date.now();
    await cdp.send("Page.navigate", { url: baseUrl });
    await cdp.eval(`new Promise(r => { if (document.readyState === 'complete') r(); else window.addEventListener('load', r, { once: true }); })`);
    const loadMs = Date.now() - loadStart;
    const perfMetrics = await cdp.eval(`(async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const paints = performance.getEntriesByType('paint');
      const fcp = paints.find(p => p.name === 'first-contentful-paint')?.startTime ?? null;
      const nav = performance.getEntriesByType('navigation')[0];
      return {
        fcpMs: fcp !== null ? Math.round(fcp) : null,
        domInteractiveMs: nav ? Math.round(nav.domInteractive) : null,
        domCompleteMs: nav ? Math.round(nav.domComplete) : null
      };
    })()`);
    console.log("E2E_PERF_METRICS:", JSON.stringify({ ...perfMetrics, loadMs }));
    assert.deepEqual(pageErrors, [], `Expected zero page runtime errors: ${pageErrors.join(' | ')}`);
    assert.ok(loadMs < 5000, `Page should load fast locally, took ${loadMs}ms`);
    if (perfMetrics.fcpMs !== null) {
      assert.ok(perfMetrics.fcpMs < 2000, `FCP should be fast, got ${perfMetrics.fcpMs}ms`);
    }

    // 1. Fresh unauthenticated visit: click Get Started in navbar -> opens Create Account tab
    await cdp.eval(`document.querySelector('.nav-cta-group [data-auth-action="signup"]').click()`);
    const modalOpenSignup = await cdp.eval(`({
      open: document.getElementById('loginModal').classList.contains('open'),
      signupTabActive: document.getElementById('authTabSignup').classList.contains('active'),
      nameVisible: getComputedStyle(document.getElementById('signupNameWrapper')).display !== 'none'
    })`);
    assert.equal(modalOpenSignup.open, true);
    assert.equal(modalOpenSignup.signupTabActive, true);
    assert.equal(modalOpenSignup.nameVisible, true);

    // 2. Switch to Login tab, test validation + password toggle
    await cdp.eval(`document.getElementById('authTabLogin').click()`);
    const loginTabState = await cdp.eval(`({
      loginTabActive: document.getElementById('authTabLogin').classList.contains('active'),
      nameHidden: getComputedStyle(document.getElementById('signupNameWrapper')).display === 'none'
    })`);
    assert.equal(loginTabState.loginTabActive, true);
    assert.equal(loginTabState.nameHidden, true);

    await cdp.eval(`
      const emailEl = document.getElementById('loginEmail');
      emailEl.focus();
      emailEl.value = 'bad-email';
      emailEl.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      document.getElementById('passwordToggle').click();
    `);
    const validationAndToggle = await cdp.eval(`({
      emailErr: document.getElementById('loginEmailError').textContent,
      emailErrHidden: document.getElementById('loginEmailError').hidden,
      pwType: document.getElementById('loginPassword').type
    })`);
    assert.equal(validationAndToggle.emailErrHidden, false);
    assert.match(validationAndToggle.emailErr, /valid email/i);
    assert.equal(validationAndToggle.pwType, "text");

    // 3. Test Pricing "Get Started Free" button opens modal on signup tab
    await cdp.eval(`document.querySelector('[data-jevexa-action="close-login"]').click()`);
    await cdp.eval(`new Promise(r => setTimeout(r, 50))`);
    const afterClose = await cdp.eval(`document.getElementById('loginModal').classList.contains('open')`);
    assert.equal(afterClose, false, "close-login must close modal");
    await cdp.eval(`document.querySelector('#pricing [data-auth-action="signup"]').click()`);
    await cdp.eval(`new Promise(r => setTimeout(r, 50))`);
    const pricingModalState = await cdp.eval(`({
      open: document.getElementById('loginModal').classList.contains('open'),
      signupTabActive: document.getElementById('authTabSignup').classList.contains('active'),
      errors: ${JSON.stringify([])}
    })`);
    assert.equal(pricingModalState.open, true, `Pricing Get Started Free must open modal; pageErrors=${JSON.stringify(pageErrors)}`);
    assert.equal(pricingModalState.signupTabActive, true);

    // 4. Sign in via Login tab -> instant header hydration (no page reload)
    await cdp.eval(`
      document.getElementById('authTabLogin').click();
      document.getElementById('loginEmail').value = 'architect@jevexa.net';
      document.getElementById('loginPassword').value = 'secret123';
      document.getElementById('authSubmitButton').click();
    `);
    await cdp.eval(`new Promise(r => setTimeout(r, 250))`);
    const hydrated = await cdp.eval(`({
      modalClosed: !document.getElementById('loginModal').classList.contains('open'),
      hasAccountUI: Boolean(document.getElementById('jevexaAccountUI')),
      credits: document.getElementById('creditsCount').textContent
    })`);
    assert.equal(hydrated.modalClosed, true);
    assert.equal(hydrated.hasAccountUI, true);
    assert.equal(hydrated.credits, "100");

    // 5. Open AI Chatbot, send message, stream response, verify user Copy & Edit + Regenerate
    await cdp.eval(`document.getElementById('chatbotToggle').click()`);
    await cdp.eval(`
      const inp = document.getElementById('chatInput');
      inp.value = 'Write a JS hello function';
      document.getElementById('chatSend').click();
    `);
    await cdp.eval(`new Promise(r => {
      const check = () => {
        const botMsg = document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .chat-bot-actions');
        if (botMsg) r();
        else setTimeout(check, 50);
      };
      check();
    })`);

    const firstChatState = await cdp.eval(`({
      userMsgCount: document.querySelectorAll('#chatMessages .message.user').length,
      hasUserCopy: Boolean(document.querySelector('#chatMessages .message.user [data-chat-action="copy-user"]')),
      hasUserEdit: Boolean(document.querySelector('#chatMessages .message.user [data-chat-action="edit-user"]')),
      hasCodeBlock: Boolean(document.querySelector('#chatMessages .message.bot .chat-code-block')),
      botActionsOutsideBubble: Boolean(
        document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .msg-bot-col > .chat-bot-actions')
        && !document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .msg-content .chat-bot-actions')
      ),
      webBtnLabel: document.querySelector('#chatWebSearchBtn .chat-web-search-label')?.textContent.trim(),
      webBtnLocked: document.getElementById('chatWebSearchBtn')?.dataset.locked,
      webBtnAriaDisabled: document.getElementById('chatWebSearchBtn')?.getAttribute('aria-disabled'),
      statusText: document.getElementById('chatCreditStatus')?.textContent.trim(),
      botText: document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .msg-body').textContent,
      credits: document.getElementById('creditsCount').textContent
    })`);
    assert.equal(firstChatState.userMsgCount, 1);
    assert.equal(firstChatState.hasUserCopy, true);
    assert.equal(firstChatState.hasUserEdit, true);
    assert.equal(firstChatState.hasCodeBlock, true);
    assert.equal(firstChatState.botActionsOutsideBubble, true);
    assert.equal(firstChatState.webBtnLabel, "Web Search");
    assert.equal(firstChatState.webBtnLocked, "true");
    assert.equal(firstChatState.webBtnAriaDisabled, "false");
    assert.match(firstChatState.statusText, /Core Engine\s+Used credit:\s*1\s+Remaining credit:\s*99/);
    assert.doesNotMatch(firstChatState.statusText, /Token-weighted|Credits used:/);
    assert.match(firstChatState.botText, /const hello/);
    assert.equal(firstChatState.credits, "99");

    // Verify locked Web Search click opens Pro Upgrade Modal smoothly
    await cdp.eval(`document.getElementById('chatWebSearchBtn').click()`);
    await cdp.eval(`new Promise(r => setTimeout(r, 80))`);
    const webUpgradeState = await cdp.eval(`({
      modalHidden: document.getElementById('upgradeModal')?.hidden,
      requiredPlan: document.getElementById('upgradeModal')?.dataset.requiredPlan,
      title: document.getElementById('upgradeModalTitle')?.textContent.trim()
    })`);
    assert.equal(webUpgradeState.modalHidden, false);
    assert.equal(webUpgradeState.requiredPlan, "pro");
    assert.match(webUpgradeState.title, /Web Search/i);
    await cdp.eval(`document.getElementById('upgradeModalClose').click()`);
    await cdp.eval(`new Promise(r => setTimeout(r, 250))`);

    // Test User Copy button feedback (patch clipboard if headless blocks focus)
    await cdp.eval(`
      window.__COPIED_TEXT = null;
      navigator.clipboard.writeText = async (t) => { window.__COPIED_TEXT = t; };
      document.querySelector('#chatMessages .message.user [data-chat-action="copy-user"]').click();
    `);
    await cdp.eval(`new Promise(r => setTimeout(r, 80))`);
    const copyResult = await cdp.eval(`({
      copiedText: window.__COPIED_TEXT,
      btnText: document.querySelector('#chatMessages .message.user [data-chat-action="copy-user"]').textContent.trim(),
      isCopiedClass: document.querySelector('#chatMessages .message.user [data-chat-action="copy-user"]').classList.contains('is-copied')
    })`);
    assert.equal(copyResult.copiedText, "Write a JS hello function");
    assert.match(copyResult.btnText, /Copied!/);
    assert.equal(copyResult.isCopiedClass, true);

    // Test User Edit -> inline textarea -> Save & Submit -> regenerates Python response
    await cdp.eval(`document.querySelector('#chatMessages .message.user [data-chat-action="edit-user"]').click()`);
    const editBoxVisible = await cdp.eval(`({
      hasTextarea: Boolean(document.querySelector('.chat-user-edit-textarea')),
      val: document.querySelector('.chat-user-edit-textarea')?.value
    })`);
    assert.equal(editBoxVisible.hasTextarea, true);
    assert.equal(editBoxVisible.val, "Write a JS hello function");

    await cdp.eval(`
      const ta = document.querySelector('.chat-user-edit-textarea');
      ta.value = 'Write a Python hello function';
      document.querySelector('.chat-user-edit-save').click();
    `);
    await cdp.eval(`new Promise(r => {
      const check = () => {
        const botBody = document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .msg-body');
        if (botBody && /def hello/.test(botBody.textContent) && document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .chat-bot-actions')) r();
        else setTimeout(check, 50);
      };
      check();
    })`);

    const afterEditState = await cdp.eval(`({
      userMsgCount: document.querySelectorAll('#chatMessages .message.user').length,
      botMsgCount: document.querySelectorAll('#chatMessages .message.bot:not([data-chat-welcome])').length,
      userText: document.querySelector('#chatMessages .message.user .msg-body').textContent,
      botText: document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .msg-body').textContent,
      credits: document.getElementById('creditsCount').textContent
    })`);
    assert.equal(afterEditState.userMsgCount, 1);
    assert.equal(afterEditState.botMsgCount, 1);
    assert.match(afterEditState.userText, /Python hello function/);
    assert.match(afterEditState.botText, /def hello/);
    assert.equal(afterEditState.credits, "98");
    assert.equal(chatCalls, 2);

    // 5b. Pro plan: Web Search unlocks, toggles active with Live pill, persists across New Chat, and sends webSearch: true
    await cdp.eval(`fetch('/mock-upgrade-pro').then(() => { document.getElementById('chatbotToggle').click(); })`);
    await cdp.eval(`new Promise(r => {
      const start = Date.now();
      const check = () => {
        if (document.getElementById('chatWebSearchBtn')?.dataset.locked === 'false' || Date.now() - start > 3000) r();
        else setTimeout(check, 40);
      };
      check();
    })`);
    await cdp.eval(`document.getElementById('chatWebSearchBtn').click()`);
    const proWebState = await cdp.eval(`({
      locked: document.getElementById('chatWebSearchBtn').dataset.locked,
      pressed: document.getElementById('chatWebSearchBtn').getAttribute('aria-pressed'),
      label: document.querySelector('#chatWebSearchBtn .chat-web-search-label').textContent.trim(),
      pill: document.querySelector('#chatWebSearchBtn .chat-web-search-pill').textContent.trim()
    })`);
    assert.equal(proWebState.locked, "false");
    assert.equal(proWebState.pressed, "true");
    assert.equal(proWebState.label, "Web Search");
    assert.equal(proWebState.pill, "Live");

    // Persistence across New Chat
    await cdp.eval(`document.getElementById('chatNewConversation').click()`);
    await cdp.eval(`new Promise(r => setTimeout(r, 60))`);
    assert.equal(await cdp.eval(`document.getElementById('chatWebSearchBtn').getAttribute('aria-pressed')`), "true");

    await cdp.eval(`(() => {
      const inp = document.getElementById('chatInput');
      inp.value = 'Latest AI news';
      document.getElementById('chatSend').click();
    })()`);
    await cdp.eval(`new Promise(r => {
      const check = () => {
        const badge = document.querySelector('#chatMessages .message.bot:not([data-chat-welcome]) .chat-web-grounded-badge');
        if (badge) r();
        else setTimeout(check, 50);
      };
      check();
    })`);
    assert.equal(lastChatBody?.webSearch, true);

    // 6. Mobile viewport (390x844) layout stability check
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.eval(`new Promise(r => setTimeout(r, 250))`);
    const mobileMetrics = await cdp.eval(`({
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      chatOverflow: document.getElementById('chatMessages').scrollWidth > document.getElementById('chatMessages').clientWidth + 2,
      userActionsOpacity: parseFloat(getComputedStyle(document.querySelector('.chat-user-actions')).opacity),
      botActionsOpacity: parseFloat(getComputedStyle(document.querySelector('.chat-bot-actions')).opacity)
    })`);
    assert.equal(mobileMetrics.docOverflow, false, "Mobile page must have zero horizontal overflow");
    assert.equal(mobileMetrics.chatOverflow, false, "Mobile chat thread must have zero horizontal overflow");
    assert.ok(mobileMetrics.userActionsOpacity >= 0.85, "User actions must be accessible on mobile");
    assert.ok(mobileMetrics.botActionsOpacity >= 0.85, "Bot actions must be accessible on mobile");
    assert.deepEqual(pageErrors, []);
  } finally {
    if (cdp) cdp.close();
    try { chromeProc.kill("SIGKILL"); } catch {}
    server.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
});
