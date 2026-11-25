import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../worker.js";

const readAsset = (relPath) => readFile(new URL(`../${relPath}`, import.meta.url), "utf8");

const userId = "22222222-2222-4222-8222-222222222222";
const baseEnv = {
  SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
  SUPABASE_ANON_KEY: "unit-anon",
  SUPABASE_SERVICE_ROLE_KEY: "unit-service",
  JEVEXA_ENVIRONMENT: "production"
};

function makeChatReq(body, headers = {}) {
  const reqId = body.requestId || crypto.randomUUID();
  return new Request("https://jevexa.net/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer unit-token",
      "Idempotency-Key": reqId,
      ...headers
    },
    body: JSON.stringify({ requestId: reqId, tier: "lite", thinkingLevel: "low", ...body })
  });
}

function createStoredZipBase64(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const centralDirs = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes = entry.data ? encoder.encode(entry.data) : new Uint8Array(0);
    const flags = entry.encrypted ? 0x0001 : 0x0000;

    const lfh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lfh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, flags, true);
    dv.setUint16(8, 0, true); // stored
    dv.setUint32(18, dataBytes.length, true);
    dv.setUint32(22, dataBytes.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    lfh.set(nameBytes, 30);

    parts.push(lfh, dataBytes);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, flags, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint32(20, dataBytes.length, true);
    cdv.setUint32(24, dataBytes.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    centralDirs.push(cd);

    offset += lfh.length + dataBytes.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const cd of centralDirs) {
    parts.push(cd);
    cdSize += cd.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  parts.push(eocd);

  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const full = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    full.set(p, pos);
    pos += p.length;
  }
  let bin = "";
  for (let i = 0; i < full.length; i++) bin += String.fromCharCode(full[i]);
  return btoa(bin);
}

test("Phase 1: Automatic language mirroring (Roman Urdu, Urdu script, Hindi, Arabic) and sticky explicit switches", async () => {
  const capturedSystemPrompts = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "pro", balance: 500 }]);
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 1, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 499 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 499 });
    }
    if (url.hostname === "api.groq.com") {
      const body = JSON.parse(options.body);
      capturedSystemPrompts.push(body.messages[0].content);
      return Response.json({
        choices: [{ message: { content: "Bilkul, yeh raha jawab." } }],
        usage: { total_tokens: 45 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const env = { ...baseEnv, GROQ_API_KEY: "test-groq" };

    // 1. Roman Urdu question in Auto mode -> mirrors Roman Urdu without forcing English
    const r1 = await worker.fetch(makeChatReq({
      message: "Mujhe batao React me useEffect kaise kaam karta hai",
      customSettings: { language: "auto", responseStyle: "Be concise" },
      memories: ["User prefers Node.js examples"]
    }), env);
    assert.equal(r1.status, 200);
    const d1 = await r1.json();
    assert.equal(d1.detectedLanguage, "roman_urdu");
    assert.match(capturedSystemPrompts[0], /Roman Urdu/i);

    // 2. Explicit language switch in natural Roman Urdu -> switches to English and sticks across subsequent turns
    const r2 = await worker.fetch(makeChatReq({
      message: "ab se English mein baat karo, what is a closure?",
      customSettings: { language: "auto" }
    }), env);
    assert.equal(r2.status, 200);
    const d2 = await r2.json();
    assert.equal(d2.switchedLanguage, "en");
    assert.match(capturedSystemPrompts[1], /CRITICAL LANGUAGE DIRECTIVE:[\s\S]*ENGLISH/i);

    // 3. Subsequent turn without repeating switch command still remembers English from history
    const r3 = await worker.fetch(makeChatReq({
      message: "aur iski ek example bhi do",
      history: [
        { role: "user", text: "ab se English mein baat karo, what is a closure?" },
        { role: "assistant", text: "Sure, a closure is a function bundled with its lexical scope." }
      ],
      customSettings: { language: "auto" }
    }), env);
    assert.equal(r3.status, 200);
    const d3 = await r3.json();
    assert.equal(d3.detectedLanguage, "en");
    assert.match(capturedSystemPrompts[2], /CRITICAL LANGUAGE DIRECTIVE:[\s\S]*ENGLISH/i);

    // 4. Urdu script detection
    const r4 = await worker.fetch(makeChatReq({
      message: "آپ کیسے ہیں؟ مجھے جاوا اسکرپٹ سیکھنی ہے",
      customSettings: { language: "auto" }
    }), env);
    assert.equal(r4.status, 200);
    const d4 = await r4.json();
    assert.equal(d4.detectedLanguage, "urdu");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Phase 2: Real-time SSE token streaming settles credits on completion and releases on upstream failure", async () => {
  let settled = false;
  let released = false;
  let failUpstream = false;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "pro", balance: 500 }]);
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 1, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 499 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      settled = true;
      return Response.json({ ok: true, charged_credits: 1, balance: 499 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
      released = true;
      return Response.json({ ok: true, balance: 500 });
    }
    if (url.hostname === "api.groq.com") {
      if (failUpstream) {
        return Response.json({ error: { message: "upstream busy" } }, { status: 503 });
      }
      const sseBody = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'));
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"World!"}}],"x_groq":{"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}}\n\n'));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      return new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const env = { ...baseEnv, GROQ_API_KEY: "test-groq" };

    // 1. Successful SSE streaming
    const res = await worker.fetch(
      makeChatReq({ message: "Say hello", stream: true }, { Accept: "text/event-stream" }),
      env
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") || "", /text\/event-stream/);
    const rawSse = await res.text();
    assert.match(rawSse, /event: status/);
    assert.match(rawSse, /event: token[\s\S]*Hello /);
    assert.match(rawSse, /event: token[\s\S]*World!/);
    assert.match(rawSse, /event: done[\s\S]*"reply":"Hello World!"/);
    assert.equal(settled, true);

    // 2. Upstream failure during stream releases credits cleanly
    failUpstream = true;
    const errRes = await worker.fetch(
      makeChatReq({ message: "Say hello", stream: true }, { Accept: "text/event-stream" }),
      env
    );
    assert.equal(errRes.status, 200);
    const errSse = await errRes.text();
    assert.match(errSse, /event: error/);
    assert.match(errSse, /"released":true/);
    assert.equal(released, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Phase 3: Groq full 4-model failover chain reaches legacy models then falls through to Gemini & OpenRouter", async () => {
  const groqModelsTried = [];
  const geminiModelsTried = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "pro", balance: 500 }]);
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 2, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 2, balance: 498 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 2, balance: 498 });
    }
    if (url.hostname === "api.groq.com") {
      const body = JSON.parse(options.body);
      groqModelsTried.push(body.model);
      return Response.json({ error: { message: "Groq model unavailable" } }, { status: 503 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiModelsTried.push(url.pathname);
      const reqBody = JSON.parse(options.body);
      // Verify gemini-2.0-flash never receives thinkingConfig
      if (url.pathname.includes("gemini-2.0-flash")) {
        assert.equal("thinkingConfig" in (reqBody.generationConfig || {}), false);
        return Response.json({
          candidates: [{ content: { parts: [{ text: "Recovered on Gemini 2.0 Flash!" }], role: "model" }, finishReason: "STOP" }],
          usageMetadata: { totalTokenCount: 55 }
        });
      }
      return Response.json({ error: { message: "Busy" } }, { status: 429 });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const env = { ...baseEnv, GROQ_API_KEY: "g-key", GEMINI_API_KEY: "gem-key" };
    const res = await worker.fetch(makeChatReq({ message: "Test full cascade", tier: "pro", thinkingLevel: "standard" }), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reply, "Recovered on Gemini 2.0 Flash!");
    assert.equal(groqModelsTried.length, 4, "Groq must try primary, fallback, and both legacy models");
    assert.equal(groqModelsTried[0], "llama-3.3-70b-versatile");
    assert.equal(groqModelsTried[1], "llama-3.1-8b-instant");
    assert.equal(geminiModelsTried.some(p => p.includes("gemini-3.5")), false, "Must not call nonexistent gemini-3.5 models");
    assert.equal(geminiModelsTried.some(p => p.includes("gemini-2.5-flash")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Phase 4: Multimodal routing sends images to vision provider, unpacks ZIP contents, and aligns >5MB tier upload limits", async () => {
  let groqCalled = false;
  let geminiCalled = false;
  let geminiPayload = null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "lite", balance: 500 }]);
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 1, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 499 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 499 });
    }
    if (url.hostname === "api.groq.com") {
      groqCalled = true;
      return Response.json({ choices: [{ message: { content: "Groq should not handle image/pdf first" } }] });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiCalled = true;
      geminiPayload = JSON.parse(options.body);
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Analyzed image and ZIP code!" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { totalTokenCount: 120 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const env = { ...baseEnv, GROQ_API_KEY: "g-key", GEMINI_API_KEY: "gem-key" };
    const samplePngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const zipB64 = createStoredZipBase64([
      { name: "src/app.js", data: "export const hello = () => 'world';" },
      { name: "secret.txt", data: "locked", encrypted: true }
    ]);

    // 1. Image + ZIP bypass text-only Groq, route to Gemini with inlineData + extracted ZIP summary
    const res = await worker.fetch(makeChatReq({
      message: "Check this screenshot and zip",
      tier: "lite",
      attachments: [
        { name: "screen.png", type: "image/png", data: `data:image/png;base64,${samplePngB64}` },
        { name: "project.zip", type: "application/zip", data: `data:application/zip;base64,${zipB64}` }
      ]
    }), env);
    assert.equal(res.status, 200);
    assert.equal(groqCalled, false, "Text-only Groq must NOT be invoked first for visual attachments");
    assert.equal(geminiCalled, true);

    const parts = geminiPayload.contents.at(-1).parts;
    assert.equal(parts.some(p => p.inlineData?.mimeType === "image/png"), true);
    const zipPart = parts.find(p => typeof p.text === "string" && p.text.includes("ZIP ARCHIVE INSPECTED: project.zip"));
    assert.ok(zipPart, "ZIP summary must be extracted into prompt parts");
    assert.match(zipPart.text, /src\/app\.js/);
    assert.match(zipPart.text, /export const hello/);
    assert.match(zipPart.text, /password-encrypted/i);

    // 2. Lite tier (10 MB limit) accepts >5 MB image without hitting hardcoded 5 MB parseChatPayload error
    const sixMbZeroPayload = new Uint8Array(6 * 1024 * 1024);
    sixMbZeroPayload.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    let bin = "";
    for (let i = 0; i < sixMbZeroPayload.length; i += 0x8000) {
      bin += String.fromCharCode(...sixMbZeroPayload.subarray(i, i + 0x8000));
    }
    const sixMbPngB64 = btoa(bin);
    const res6Mb = await worker.fetch(makeChatReq({
      message: "Inspect 6MB image on Lite plan",
      tier: "lite",
      attachments: [{ name: "large.png", type: "image/png", data: `data:image/png;base64,${sixMbPngB64}` }]
    }), env);
    assert.equal(res6Mb.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Phase 5 & 6: History integrity, Markdown tables & strikethrough, system theme, and mobile luxury CSS", async () => {
  const creditsJs = await readAsset("credits.js");
  const stylesCss = await readAsset("styles.css");
  const indexHtml = await readAsset("index.html");
  const workerJs = await readAsset("worker.js");

  // Phase 2 & 3 worker checks
  assert.doesNotMatch(workerJs, /timeoutMs\s*=\s*8500/);
  assert.match(workerJs, /createStreamTimeoutController/);

  // Phase 5 history integrity: hardcoded 16-message splice removed
  assert.doesNotMatch(creditsJs, /conversation\.length\s*>\s*16\)\s*conversation\.splice/);
  assert.match(creditsJs, /function trimConversationToMax/);
  assert.match(creditsJs, /conversation\.slice\(0,\s*-1\)\.slice\(-planLimits\.maxHistoryMessages\)/);

  // Phase 5 Markdown tables, strikethrough, paragraph grouping, and XSS escaping
  assert.match(creditsJs, /chat-table-wrap/);
  assert.match(creditsJs, /chat-md-table/);
  assert.match(creditsJs, /<del>\$1<\/del>/);
  assert.match(creditsJs, /flushParagraph/);

  // Phase 5 & 6 CSS: system theme light mode, tables, streaming caret, 100dvh, safe-area, 16px mobile input
  assert.match(stylesCss, /@media\s*\(prefers-color-scheme:\s*light\)[\s\S]*?\.chatbot-window\[data-chat-theme="system"\]/);
  assert.match(stylesCss, /\.chat-table-wrap/);
  assert.match(stylesCss, /\.chat-md-table/);
  assert.match(stylesCss, /\.message\.bot\.is-streaming\s+\.msg-body::after/);
  assert.match(stylesCss, /font-size:\s*16px\s*!important/);
  assert.match(stylesCss, /env\(safe-area-inset-bottom\)/);
  assert.match(stylesCss, /jevexa-reduce-motion/);

  // Phase 6 HTML: viewport-fit=cover & enterkeyhint
  assert.match(indexHtml, /viewport-fit=cover/);
  assert.match(indexHtml, /id="chatInput"[^>]*enterkeyhint="send"/);
});

test("Phase 5 functional: renderMarkdown renders tables, strikethrough, grouped paragraphs, code blocks, and escapes XSS", async () => {
  const creditsJs = await readAsset("credits.js");
  const start = creditsJs.indexOf("function escapeMarkdownHtml(str)");
  const end = creditsJs.indexOf("function trimConversationToMax(");
  assert.ok(start !== -1 && end !== -1);

  const fnSource = creditsJs.slice(start, end);
  const renderMarkdown = new Function(`${fnSource}; return renderMarkdown;`)();

  const md = [
    "First line",
    "Second line in same paragraph",
    "",
    "| Plan | Price | Status |",
    "| :--- | :---: | ---: |",
    "| Pro | \$12 | ~~Old~~ **Live** |",
    "",
    "```js",
    "const x = '<script>alert(1)</script>';",
    "```",
    "",
    "<img src=x onerror=alert(1)>"
  ].join("\n");

  const html = renderMarkdown(md);
  assert.match(html, /<p>First line<br>Second line in same paragraph<\/p>/);
  assert.match(html, /<div class="chat-table-wrap"><table class="chat-md-table">/);
  assert.match(html, /<th style="text-align:center">Price<\/th>/);
  assert.match(html, /<del>Old<\/del> <strong>Live<\/strong>/);
  assert.match(html, /<div class="chat-code-block">[\s\S]*?chat-code-copy/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
