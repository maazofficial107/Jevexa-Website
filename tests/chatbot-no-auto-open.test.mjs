import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

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

test("Static contract: script.js never persists jevexa_last_workspace or auto-opens chatbot on /", async () => {
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const contactHtml = await readFile(new URL("../contact.html", import.meta.url), "utf8");

  assert.doesNotMatch(scriptJs, /localStorage\.setItem\(['"]jevexa_last_workspace['"]/);
  assert.doesNotMatch(scriptJs, /sessionStorage\.setItem\(['"]jevexa_last_workspace['"]/);
  assert.doesNotMatch(scriptJs, /localStorage\.getItem\(['"]jevexa_last_workspace['"]\)\s*===\s*['"]chatbot['"]/);
  assert.match(scriptJs, /function clearLastWorkspaceState\(\)/);
  assert.match(contactHtml, /href="\/tools\/chatbot"[^>]*>\s*<span>Open AI Chatbot<\/span>/);
});

test("Headless E2E: Normal website visit never auto-opens chatbot even with stale storage, while explicit triggers and routes work", async (t) => {
  const browserBin = findBrowserExecutable();
  if (!browserBin) {
    t.skip("No headless Chromium/Edge binary available in this environment");
    return;
  }

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "jevexa-no-auto-chat-"));
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json"
  };

  const mockSupabaseScript = `
    window.supabase = {
      createClient() {
        return {
          auth: {
            async getSession() { return { data: { session: null }, error: null }; },
            onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }
          }
        };
      }
    };
  `;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, "http://127.0.0.1");
    const pathname = reqUrl.pathname;

    if (pathname === "/config.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end('window.JEVEXA_SUPABASE_CONFIG = { url: "https://byopcuspgnhwsrmsxqvm.supabase.co", anonKey: "test-anon" };');
      return;
    }
    if (pathname === "/mock-supabase.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(mockSupabaseScript);
      return;
    }
    if (pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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

  const navigateAndWait = async (targetUrl, conditionExpr = "typeof window.openExactServiceWorkspace === 'function'") => {
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
        setTimeout(poll, 30);
      };
      poll();
    })`);
    await cdp.eval(`new Promise(r => setTimeout(r, 120))`);
  };

  const readUiState = () => cdp.eval(`(() => {
    const chatWin = document.getElementById('chatbotWindow');
    const chatToggle = document.getElementById('chatbotToggle');
    const contentWs = document.getElementById('contentWorkspace');
    const ocrWs = document.getElementById('ocrWorkspace');
    const chatStyle = chatWin ? getComputedStyle(chatWin) : null;
    return {
      pathname: window.location.pathname,
      hash: window.location.hash,
      chatOpenClass: Boolean(chatWin?.classList.contains('open')),
      chatAriaHidden: chatWin?.getAttribute('aria-hidden'),
      chatVisibility: chatStyle?.visibility,
      chatOpacity: chatStyle?.opacity,
      bodyChatModalOpen: document.body.classList.contains('chat-modal-open'),
      bodyWorkspaceOpen: document.body.classList.contains('workspace-open'),
      toggleHidden: Boolean(chatToggle?.classList.contains('hidden')),
      contentOpen: Boolean(contentWs?.classList.contains('open')),
      ocrOpen: Boolean(ocrWs?.classList.contains('open')),
      activeElementId: document.activeElement?.id || null,
      localLastWorkspace: localStorage.getItem('jevexa_last_workspace'),
      sessionLastWorkspace: sessionStorage.getItem('jevexa_last_workspace'),
      localPendingIntent: localStorage.getItem('jevexa_pending_service_intent')
    };
  })()`);

  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

    // 1. Fresh visit to '/' opens normal website, NOT chatbot
    await navigateAndWait(`${baseUrl}/`);
    let state = await readUiState();
    assert.equal(state.chatOpenClass, false, "Fresh '/' load must NOT add .open to #chatbotWindow");
    assert.equal(state.chatAriaHidden, "true", "Fresh '/' load must keep #chatbotWindow aria-hidden='true'");
    assert.equal(state.chatVisibility, "hidden", "Fresh '/' load must keep #chatbotWindow hidden");
    assert.equal(state.bodyChatModalOpen, false, "Fresh '/' load must NOT set body.chat-modal-open");
    assert.equal(state.toggleHidden, false, "Fresh '/' load must keep #chatbotToggle visible");
    assert.notEqual(state.activeElementId, "chatInput", "Fresh '/' load must NOT auto-focus #chatInput");

    // 2. Seed stale localStorage/sessionStorage from older session & reload '/' -> must NOT auto-open chatbot AND must clean up stale keys
    await cdp.eval(`
      localStorage.setItem('jevexa_last_workspace', 'chatbot');
      sessionStorage.setItem('jevexa_last_workspace', 'chatbot');
      localStorage.setItem('jevexa_pending_service_intent', 'chatbot');
      localStorage.setItem('jevexa_pending_service_intent_ts', String(Date.now() - 3600000));
    `);
    await navigateAndWait(`${baseUrl}/`);
    state = await readUiState();
    assert.equal(state.chatOpenClass, false, "Stale jevexa_last_workspace='chatbot' must NEVER auto-open chatbot on '/'");
    assert.equal(state.bodyChatModalOpen, false);
    assert.equal(state.localLastWorkspace, null, "Stale localStorage.jevexa_last_workspace must be cleaned up on '/' load");
    assert.equal(state.sessionLastWorkspace, null, "Stale sessionStorage.jevexa_last_workspace must be cleaned up on '/' load");

    // 3. Normal query params, /index.html & section hashes do NOT open chatbot
    await navigateAndWait(`${baseUrl}/?utm_source=google&ref=home#features`);
    state = await readUiState();
    assert.equal(state.chatOpenClass, false, "Marketing query params + #features must NOT open chatbot");

    await navigateAndWait(`${baseUrl}/index.html`);
    state = await readUiState();
    assert.equal(state.chatOpenClass, false, "/index.html must NOT auto-open chatbot");

    // 4. Explicit floating chatbot toggle click opens chatbot, and reloading '/' afterwards loads normal website cleanly
    await cdp.eval(`document.getElementById('chatbotToggle').click();`);
    await cdp.eval(`new Promise(r => setTimeout(r, 80))`);
    state = await readUiState();
    assert.equal(state.chatOpenClass, true, "Explicit click on #chatbotToggle must open #chatbotWindow");
    assert.equal(state.bodyChatModalOpen, true);
    assert.equal(state.localLastWorkspace, null, "Opening chatbot toggle must NOT persist jevexa_last_workspace");

    await navigateAndWait(`${baseUrl}/`);
    state = await readUiState();
    assert.equal(state.chatOpenClass, false, "Reloading '/' after opening chatbot toggle must load normal website cleanly");

    // 5. Explicit launcher card click opens chatbot & Back to Studio closes cleanly
    await cdp.eval(`document.querySelector('.tool-launcher-card[data-tool-id="chatbot"]').click();`);
    await cdp.eval(`new Promise(r => setTimeout(r, 80))`);
    state = await readUiState();
    assert.equal(state.chatOpenClass, true, "Clicking AI Chatbot launcher card must open #chatbotWindow");
    assert.equal(state.pathname, "/tools/chatbot");

    await cdp.eval(`document.getElementById('chatBackToStudio').click();`);
    await cdp.eval(`new Promise(r => setTimeout(r, 80))`);
    state = await readUiState();
    assert.equal(state.chatOpenClass, false, "Clicking Back to Studio must close #chatbotWindow");
    assert.equal(state.pathname, "/");

    // 6. Explicit chatbot URLs (/tools/chatbot, /tools/ai-chatbot, /#chatbot, /?tool=chatbot) DO open chatbot
    for (const explicitUrl of [
      `${baseUrl}/tools/chatbot`,
      `${baseUrl}/tools/ai-chatbot`,
      `${baseUrl}/#chatbot`,
      `${baseUrl}/?tool=chatbot`
    ]) {
      await navigateAndWait(explicitUrl);
      state = await readUiState();
      assert.equal(state.chatOpenClass, true, `Explicit URL ${explicitUrl} must open #chatbotWindow`);
      assert.equal(state.chatAriaHidden, "false");
    }

    // 7. Browser Back from /tools/chatbot to '/' closes chatbot cleanly
    await navigateAndWait(`${baseUrl}/`);
    await cdp.eval(`document.getElementById('tryChatLink').click();`);
    await cdp.eval(`new Promise(r => setTimeout(r, 80))`);
    state = await readUiState();
    assert.equal(state.chatOpenClass, true);
    assert.equal(state.pathname, "/tools/chatbot");

    await cdp.eval(`window.history.back();`);
    await cdp.eval(`new Promise(r => setTimeout(r, 150))`);
    state = await readUiState();
    assert.equal(state.pathname, "/");
    assert.equal(state.chatOpenClass, false, "Browser Back from /tools/chatbot to '/' must close #chatbotWindow");

    // 8. Navigating to or clicking another service opens that exact service and keeps chatbot closed
    await navigateAndWait(`${baseUrl}/tools/content`);
    state = await readUiState();
    assert.equal(state.contentOpen, true, "/tools/content must open Content Generation workspace");
    assert.equal(state.chatOpenClass, false, "/tools/content must keep #chatbotWindow closed");

    await navigateAndWait(`${baseUrl}/`);
    await cdp.eval(`document.querySelector('.tool-launcher-card[data-tool-id="ocr"]').click();`);
    await cdp.eval(`new Promise(r => setTimeout(r, 100))`);
    state = await readUiState();
    assert.equal(state.ocrOpen, true, "Clicking OCR card must open OCR workspace");
    assert.equal(state.chatOpenClass, false, "Clicking OCR card must keep #chatbotWindow closed");

    assert.deepEqual(pageErrors, [], `Expected zero uncaught runtime exceptions, saw: ${pageErrors.join("; ")}`);
  } finally {
    cdp.close();
    browser.kill();
    server.close();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});
