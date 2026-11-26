import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../worker.js";

const requestId = "00000000-0000-4000-8000-000000000099";
const userId = "9f6d10a8-e03a-4f6b-8aa2-5b7da1c42fb1";

const baseEnv = {
  GEMINI_API_KEY: "unit-test-gemini",
  SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
  SUPABASE_ANON_KEY: "unit-test",
  SUPABASE_SERVICE_ROLE_KEY: "unit-test",
  JEVEXA_ENVIRONMENT: "production"
};

function makeChatReq(body, extraHeaders = {}) {
  return new Request("https://jevexa.test/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer unit-token",
      "Idempotency-Key": requestId,
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
}

test("FinOps: Free daily 15 credit burn cap blocks excess usage with 429", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "free", balance: 85 }]);
    if (url.pathname === "/rest/v1/credit_transactions") {
      return Response.json([{ amount: -10 }, { amount: -5 }]);
    }
    return Response.json([], { status: 200 });
  };
  try {
    const res = await worker.fetch(makeChatReq({ message: "Hello" }), baseEnv);
    assert.equal(res.status, 429);
    const data = await res.json();
    assert.equal(data.code, "daily_burn_limit_reached");
    assert.equal(data.dailyLimit, 15);
    assert.equal(data.dailyUsed, 15);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FinOps: Web Search disabled on Free/Lite (403) and capped on Pro (15/day) with +5 surcharge", async () => {
  const originalFetch = globalThis.fetch;
  let geminiPayload = null;

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "lite", balance: 2500 }]);
    if (url.pathname === "/rest/v1/credit_transactions") return Response.json([]);
    if (url.pathname === "/rest/v1/jevexa_service_pricing") return Response.json([]);
    return Response.json({}, { status: 404 });
  };

  try {
    const liteRes = await worker.fetch(makeChatReq({ message: "Search news", tier: "lite", webSearch: true }), baseEnv);
    assert.equal(liteRes.status, 403);
    const liteData = await liteRes.json();
    assert.equal(liteData.code, "web_search_tier_required");

    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input);
      if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
      if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "pro", balance: 10000 }]);
      if (url.pathname === "/rest/v1/credit_transactions") return Response.json([]);
      if (url.pathname === "/rest/v1/jevexa_service_pricing") return Response.json([{ fixed_credits: 3, enabled: true, integration_status: "available" }]);
      if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
        return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 9997 });
      }
      if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
        return Response.json({ ok: true, charged_credits: 3, balance: 9997 });
      }
      if (url.hostname === "generativelanguage.googleapis.com") {
        geminiPayload = JSON.parse(options.body);
        return Response.json({
          candidates: [{ content: { parts: [{ text: "Live search result" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount: 300, totalTokenCount: 500 }
        });
      }
      return Response.json({}, { status: 200 });
    };

    const proRes = await worker.fetch(makeChatReq({ message: "Search news", tier: "pro", thinkingLevel: "standard", webSearch: true }), baseEnv);
    assert.equal(proRes.status, 200);
    const proData = await proRes.json();
    assert.deepEqual(geminiPayload?.tools, [{ googleSearch: {} }]);
    assert.equal(proData.webSearch, true);
    assert.equal(proData.webSearchSurcharge, 5);
    assert.equal(proData.modelMultiplier, 3.0);
    assert.equal(proData.thinkingTokens, 300);
    assert.equal(proData.creditsCharged, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FinOps: Flagship 18.0x multiplier & Max thinking locked on Pro, allowed on Max", async () => {
  const originalFetch = globalThis.fetch;
  let capturedModel = "";
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "pro", balance: 10000 }]);
    return Response.json({});
  };
  try {
    const blockedRes = await worker.fetch(makeChatReq({ message: "Deep reasoning", tier: "max", thinkingLevel: "max" }), baseEnv);
    assert.equal(blockedRes.status, 403);
    const blockedData = await blockedRes.json();
    assert.equal(blockedData.code, "tier_required");

    globalThis.fetch = async (input) => {
      const url = new URL(input);
      if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
      if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "max", balance: 22000 }]);
      if (url.pathname === "/rest/v1/jevexa_service_pricing") return Response.json([{ fixed_credits: 18, enabled: true, integration_status: "available" }]);
      if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
        return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 18, balance: 21982 });
      }
      if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
        return Response.json({ ok: true, charged_credits: 18, balance: 21982 });
      }
      if (url.hostname === "generativelanguage.googleapis.com") {
        capturedModel = url.pathname;
        return Response.json({
          candidates: [{ content: { parts: [{ text: "Flagship answer" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 250, thoughtsTokenCount: 500, totalTokenCount: 1000 }
        });
      }
      return Response.json({});
    };

    const maxRes = await worker.fetch(makeChatReq({ message: "Deep reasoning", tier: "max", thinkingLevel: "max" }), baseEnv);
    assert.equal(maxRes.status, 200);
    const maxData = await maxRes.json();
    assert.match(capturedModel, /gemini-4-argon/);
    assert.equal(maxData.modelMultiplier, 18.0);
    assert.equal(maxData.thinkingTokens, 500);
    assert.equal(maxData.creditsCharged, 36);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hardening & Keepalive: /api/health runs Supabase LIMIT 1 query & /api/billing/request-activation succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let healthQueryUrl = "";
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      healthQueryUrl = url.search;
      return Response.json([{ service_key: "ai_chat" }]);
    }
    if (url.pathname === "/rest/v1/contact_messages") {
      return Response.json([{ id: "1" }], { status: 201 });
    }
    return Response.json([]);
  };

  try {
    const healthRes = await worker.fetch(new Request("https://jevexa.net/api/health"), baseEnv);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.database, "ok");
    assert.match(healthQueryUrl, /limit=1/i);

    const actRes = await worker.fetch(new Request("https://jevexa.net/api/billing/request-activation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "founder@example.com", plan: "pro", cycle: "monthly" })
    }), baseEnv);
    assert.equal(actRes.status, 201);
    const actJson = await actRes.json();
    assert.equal(actJson.ok, true);
    assert.equal(actJson.amountUsd, 15);
    assert.equal(actJson.credits, 10000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SEO & Trust Cleanup: zero href=# links, zero dev leaks, demo labels present, standalone pages & SSR tool routes", async () => {
  for (const file of ["../index.html", "../about.html", "../contact.html", "../privacy-policy.html", "../terms.html", "../refund-policy.html", "../pricing.html"]) {
    const html = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(html, /href=["']#["']/, `${file} must have zero dead href="#" links`);
  }

  const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const pricingHtml = await readFile(new URL("../pricing.html", import.meta.url), "utf8");
  const refundHtml = await readFile(new URL("../refund-policy.html", import.meta.url), "utf8");
  const sitemapXml = await readFile(new URL("../sitemap.xml", import.meta.url), "utf8");

  const combined = `${indexHtml}\n${scriptJs}`;
  assert.doesNotMatch(combined, /Production behavior must be verified against the live database/);
  assert.doesNotMatch(combined, /Email confirmation may be required by the configured Supabase project/);
  assert.doesNotMatch(combined, /missing its environment-specific public Supabase configuration/);
  assert.doesNotMatch(combined, /Response Time:\s*Not guaranteed|Not guaranteed|24\/7 VIP Concierge|Reply in 2–4 hrs/);

  assert.match(indexHtml, /id="ocrDemoBanner"[\s\S]*?SAMPLE DATA/);
  assert.match(indexHtml, /id="analyticsDemoBanner"[\s\S]*?DEMO PREVIEW/);
  assert.match(indexHtml, /id="teamDemoBanner"[\s\S]*?SAMPLE DATA/);
  assert.match(indexHtml, /Email Support: Response within 24 hours \(Mon–Sat\)/);
  assert.match(pricingHtml, /2,500/);
  assert.match(pricingHtml, /22,000/);
  assert.match(pricingHtml, /40,000/);
  assert.match(refundHtml, /7-day|7 Days/i);
  assert.match(refundHtml, /10%/);

  for (const slug of [
    "/pricing", "/refund-policy",
    "/tools/ai-chatbot", "/tools/content-generator", "/tools/ocr-extractor",
    "/tools/social-media-assistant", "/tools/business-analytics", "/tools/team-admin",
    "/tools/workflow-automation", "/tools/data-management", "/tools/mini-crm", "/tools/outreach-generator"
  ]) {
    assert.ok(sitemapXml.includes(`https://jevexa.net${slug}`), `sitemap.xml must include ${slug}`);
  }

  const mockAssetsEnv = {
    ASSETS: {
      fetch: async () => new Response(indexHtml, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }
  };
  const seoRes = await worker.fetch(new Request("https://jevexa.net/tools/ocr-extractor"), mockAssetsEnv);
  const seoHtml = await seoRes.text();
  assert.match(seoHtml, /<title>AI Document &amp; Invoice OCR Extractor \| JEVEXA<\/title>/);
  assert.match(seoHtml, /<link rel="canonical" href="https:\/\/jevexa\.net\/tools\/ocr-extractor">/);
});

test("Jevexa AI Branding & Web Search UX: zero raw model names, aligned 5-tier pricing, and interactive Web Search toggle", async () => {
  const frontendFiles = [
    "../index.html",
    "../pricing.html",
    "../about.html",
    "../privacy-policy.html",
    "../terms.html",
    "../refund-policy.html",
    "../contact.html",
    "../credits.js",
    "../script.js",
    "../support.js"
  ];
  const rawModelPattern = /gemini-|llama-|argon|carbon|flash-lite|Economy Tier|Standard Tier|Flagship Reasoning|Ultra Flagship|Max 15\/day/i;
  for (const file of frontendFiles) {
    const content = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(content, rawModelPattern, `${file} must not expose raw model IDs or legacy engine labels`);
  }

  const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const pricingHtml = await readFile(new URL("../pricing.html", import.meta.url), "utf8");
  const creditsJs = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const stylesCss = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // 5 tiers & exact credit allocations on both index.html and pricing.html
  for (const html of [indexHtml, pricingHtml]) {
    assert.match(html, /100/);
    assert.match(html, /2,500/);
    assert.match(html, /10,000/);
    assert.match(html, /22,000/);
    assert.match(html, /40,000/);
    assert.match(html, /20%/);
    assert.match(html, /Fast \/ Core Engine/);
    assert.match(html, /Pro Engine/);
    assert.match(html, /Deep Reasoning/);
  }

  // Max vs Ultra differentiation without duplicate 18.0x clutter in selector
  assert.match(indexHtml, /data-value="max"[^>]*data-label="Deep Reasoning \(18\.0x\)"/);
  assert.match(indexHtml, /data-value="ultra"[^>]*data-label="Ultra Reasoning"/);

  // Interactive Web Search toggle wiring, clean label, lock/active pill, composer dock, and upgrade modal gating
  assert.match(indexHtml, /id="chatWebSearchBtn"[^>]*aria-pressed="false"[^>]*aria-disabled="false"[^>]*data-locked="true"/);
  assert.match(indexHtml, /class="chat-web-search-label">Web Search<\/span>/);
  assert.doesNotMatch(indexHtml, /class="chat-web-search-label">Web Search \(\+5 cr\)<\/span>/);
  assert.match(indexHtml, /class="chat-composer-dock"/);
  assert.match(indexHtml, /id="chatComposerWebBadge"/);
  assert.match(creditsJs, /function isWebSearchAllowed\(\)/);
  assert.match(creditsJs, /function syncWebSearchUI\(\)/);
  assert.match(creditsJs, /labelEl\.textContent = 'Web Search';/);
  assert.match(creditsJs, /pillEl\.textContent = 'Live';/);
  assert.match(creditsJs, /saveWebSearchPref/);
  assert.match(creditsJs, /chat-web-grounded-badge/);
  assert.match(creditsJs, /msg-bot-col/);
  assert.match(creditsJs, /window\.JEVEXA_SHOW_UPGRADE_MODAL\('Pro', 'Live Web Search', btn\)/);
  assert.match(scriptJs, /\/web\\s\*search\/i\.test\(feature/);

  // CSS specificity fix, unified composer dock, ghost actions, & dropdown layering
  assert.doesNotMatch(stylesCss, /\.chat-tier-controls button\s*\{/);
  assert.match(stylesCss, /\.chat-composer-dock\s*\{/);
  assert.match(stylesCss, /\.chat-tier-controls \.chat-web-search-btn/);
  assert.match(stylesCss, /\.chat-tier-controls \.chat-web-search-btn\[aria-pressed="true"\]/);
  assert.match(stylesCss, /\.chat-select-menu\s*\{[^}]*z-index:\s*100005;/);
});

test("Audit Fix 1: Web Search & extraCredits ledger sync (extended RPC and 3-arg RPC fallback)", async () => {
  const originalFetch = globalThis.fetch;

  // Case A: Extended 5-arg jevexa_credit_settle RPC handles extra_credits and metadata atomically
  let capturedSettleArgs = null;
  let extraLedgerPosted = false;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "pro", balance: 10000 }]);
    if (url.pathname === "/rest/v1/credit_transactions" && (!options.method || options.method === "GET")) {
      return Response.json([]);
    }
    if (url.pathname === "/rest/v1/credit_transactions" && options.method === "POST") {
      extraLedgerPosted = true;
      return Response.json([{}], { status: 201 });
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 3, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 9997 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      capturedSettleArgs = JSON.parse(options.body);
      return Response.json({
        ok: true,
        duplicate: false,
        charged_credits: 3,
        extra_credits_charged: 5,
        total_charged_credits: 8,
        balance: 9992
      });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Grounded answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 250, totalTokenCount: 500 }
      });
    }
    return Response.json({});
  };

  try {
    const res = await worker.fetch(makeChatReq({ message: "Latest news", tier: "pro", webSearch: true }), baseEnv);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.creditsCharged, 8);
    assert.equal(data.creditsRemaining, 9992);
    assert.equal(data.webSearch, true);
    assert.equal(capturedSettleArgs.p_extra_credits, 5);
    assert.equal(capturedSettleArgs.p_metadata?.web_search, true);
    assert.equal(capturedSettleArgs.p_metadata?.web_search_surcharge, 5);
    assert.equal(extraLedgerPosted, false, "Extended RPC already writes unified ledger row");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Case B: Legacy 3-arg RPC fallback records supplementary credit_transactions row with web_search: true & extraCredits
  let postedLedgerBody = null;
  let settleAttempts = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "pro", balance: 10000 }]);
    if (url.pathname === "/rest/v1/credit_transactions" && (!options.method || options.method === "GET")) {
      return Response.json([]);
    }
    if (url.pathname === "/rest/v1/credit_transactions" && options.method === "POST") {
      postedLedgerBody = JSON.parse(options.body);
      return Response.json([postedLedgerBody], { status: 201 });
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 3, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 9997 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      settleAttempts++;
      const args = JSON.parse(options.body);
      if ("p_extra_credits" in args || "p_metadata" in args) {
        return Response.json({ code: "PGRST202", message: "Could not find the function" }, { status: 404 });
      }
      return Response.json({ ok: true, duplicate: false, charged_credits: 3, balance: 9997 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Grounded answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 400, totalTokenCount: 800 }
      });
    }
    return Response.json({});
  };

  try {
    const res = await worker.fetch(makeChatReq({ message: "Latest news", tier: "pro", webSearch: true }), baseEnv);
    assert.equal(res.status, 200);
    const data = await res.json();
    // 800 tokens * 3.0x / 500 = ceil(4.8) = 5 + 5 webSearch = 10 total (3 base + 7 extra)
    assert.equal(settleAttempts, 2);
    assert.equal(data.creditsCharged, 10);
    assert.equal(data.creditsRemaining, 9990);
    assert.ok(postedLedgerBody, "Supplementary credit_transactions row must be inserted on 3-arg RPC");
    assert.equal(postedLedgerBody.amount, -7);
    assert.equal(postedLedgerBody.type, "usage");
    assert.equal(postedLedgerBody.request_id, null);
    assert.equal(postedLedgerBody.reference, `usage-extra:${requestId}`);
    assert.equal(postedLedgerBody.metadata.web_search, true);
    assert.equal(postedLedgerBody.metadata.extra_credits, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Audit Fix 2: Grounded Search Surcharge Guard skips +5 surcharge & web_search flag on retry-strip or Groq/OpenRouter failover", async () => {
  const originalFetch = globalThis.fetch;

  // Scenario 1: Gemini 400 strips googleSearch tool on retry -> ungrounded -> no +5 surcharge
  let geminiCallCount = 0;
  let retrySettleArgs = null;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "pro", balance: 10000 }]);
    if (url.pathname === "/rest/v1/credit_transactions" && (!options.method || options.method === "GET")) {
      return Response.json([]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 3, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 9997 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      retrySettleArgs = JSON.parse(options.body);
      return Response.json({
        ok: true,
        duplicate: false,
        charged_credits: 3,
        extra_credits_charged: 0,
        total_charged_credits: 3,
        balance: 9997
      });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiCallCount++;
      const reqBody = JSON.parse(options.body);
      if (geminiCallCount === 1 && reqBody.tools) {
        return Response.json({ error: { message: "googleSearch tool grounding unsupported" } }, { status: 400 });
      }
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Ungrounded retry answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, totalTokenCount: 200 }
      });
    }
    return Response.json({});
  };

  try {
    const res = await worker.fetch(makeChatReq({ message: "Search stripped", tier: "pro", webSearch: true }), baseEnv);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(geminiCallCount, 2);
    assert.equal(data.webSearch, false);
    assert.equal(data.webSearchSurcharge, 0);
    assert.equal(data.creditsCharged, 3);
    assert.equal(retrySettleArgs.p_extra_credits, 0);
    assert.equal(retrySettleArgs.p_metadata.web_search, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Scenario 2: Gemini fails -> falls back to Groq -> ungrounded -> no +5 surcharge
  let groqSettleArgs = null;
  const multiEnv = { ...baseEnv, GROQ_API_KEY: "unit-groq" };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "pro", balance: 10000 }]);
    if (url.pathname === "/rest/v1/credit_transactions" && (!options.method || options.method === "GET")) {
      return Response.json([]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 3, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 9997 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      groqSettleArgs = JSON.parse(options.body);
      return Response.json({
        ok: true,
        duplicate: false,
        charged_credits: 3,
        extra_credits_charged: 0,
        total_charged_credits: 3,
        balance: 9997
      });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({ error: { message: "Upstream unavailable" } }, { status: 503 });
    }
    if (url.hostname === "api.groq.com") {
      return Response.json({
        choices: [{ message: { content: "Groq failover answer" } }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
      });
    }
    return Response.json({});
  };

  try {
    const res = await worker.fetch(makeChatReq({ message: "Search failover", tier: "pro", webSearch: true }), multiEnv);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.providerUsed, "Groq");
    assert.equal(data.webSearch, false);
    assert.equal(data.webSearchSurcharge, 0);
    assert.equal(data.creditsCharged, 3);
    assert.equal(groqSettleArgs.p_extra_credits, 0);
    assert.equal(groqSettleArgs.p_metadata.web_search, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Audit Fixes 3 & 4: billing_orders ultra constraint, chat_tiers weights (1/3/18/18), and legacy pricing/multiplier cleanup", async () => {
  const masterSql = await readFile(new URL("../supabase/complete_credit_and_saas_schema.sql", import.meta.url), "utf8");
  const creditSql = await readFile(new URL("../supabase/credit_system_migration.sql", import.meta.url), "utf8");
  const safepaySql = await readFile(new URL("../supabase/safepay_billing_migration.sql", import.meta.url), "utf8");
  const saasSql = await readFile(new URL("../supabase/jevexa_saas_setup.sql", import.meta.url), "utf8");
  const tiersSql = await readFile(new URL("../supabase/chat_tiers_migration.sql", import.meta.url), "utf8");
  const cleanupSql = await readFile(new URL("../supabase/monetization_ledger_cleanup_migration.sql", import.meta.url), "utf8");
  const creditsJs = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const aboutHtml = await readFile(new URL("../about.html", import.meta.url), "utf8");

  // billing_orders.plan includes 'ultra' across all SQL schemas/migrations
  for (const sql of [masterSql, creditSql, safepaySql, saasSql, cleanupSql]) {
    assert.match(sql, /'starter'\s*,\s*'pro'\s*,\s*'business'\s*,\s*'ultra'/i);
  }

  // chat_tiers_migration.sql aligns with production weights 1, 3, 18, 18
  assert.match(tiersSql, /\('ai_chat',\s*'AI Chat — Lite',\s*'available',\s*1,\s*null,\s*true\)/);
  assert.match(tiersSql, /\('ai_chat_pro',\s*'AI Chat — Pro',\s*'available',\s*3,\s*null,\s*true\)/);
  assert.match(tiersSql, /\('ai_chat_max',\s*'AI Chat — Max',\s*'available',\s*18,\s*null,\s*true\)/);
  assert.match(tiersSql, /\('ai_chat_ultra',\s*'AI Chat — Ultra',\s*'available',\s*18,\s*null,\s*true\)/);

  // complete_credit_and_saas_schema.sql and cleanup SQL retire legacy disabled keys
  for (const key of ["document_ai", "social_media", "analytics", "user_admin"]) {
    assert.match(masterSql, new RegExp(`'${key}'`));
    assert.match(cleanupSql, new RegExp(`'${key}'`));
  }

  // /api/credits/pricing filters out legacy retired rows
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([
        { service_key: "ai_chat", display_name: "AI Chat — Lite", integration_status: "available", fixed_credits: 1, credits_per_1000_tokens: null, enabled: true },
        { service_key: "ai_chat_pro", display_name: "AI Chat — Pro", integration_status: "available", fixed_credits: 3, credits_per_1000_tokens: null, enabled: true },
        { service_key: "document_ai", display_name: "Document AI & OCR", integration_status: "unavailable", fixed_credits: null, credits_per_1000_tokens: null, enabled: false },
        { service_key: "social_media", display_name: "Social Media Assistant", integration_status: "unavailable", fixed_credits: null, credits_per_1000_tokens: null, enabled: false },
        { service_key: "analytics", display_name: "Business Analytics", integration_status: "unavailable", fixed_credits: null, credits_per_1000_tokens: null, enabled: false },
        { service_key: "user_admin", display_name: "User & Admin Management", integration_status: "unavailable", fixed_credits: null, credits_per_1000_tokens: null, enabled: false }
      ]);
    }
    return Response.json([]);
  };
  try {
    const pricingRes = await worker.fetch(new Request("https://jevexa.test/api/credits/pricing", {
      method: "GET",
      headers: { Authorization: "Bearer unit-token" }
    }), baseEnv);
    assert.equal(pricingRes.status, 200);
    const pricingData = await pricingRes.json();
    assert.deepEqual(pricingData.services.map(s => s.service_key), ["ai_chat", "ai_chat_pro"]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // credits.js and about.html show accurate 1.0x / 3.0x / 18.0x multipliers without hardcoded (1 cr / 500 tokens)
  assert.doesNotMatch(creditsJs, /Unavailable — provider integration not connected/);
  assert.doesNotMatch(creditsJs, /credit baseline \(1 cr \/ 500 tokens\)/);
  assert.match(creditsJs, /ai_chat_pro:\s*3\.0/);
  assert.match(creditsJs, /ai_chat_max:\s*18\.0/);
  assert.match(creditsJs, /ai_chat_ultra:\s*18\.0/);
  assert.match(aboutHtml, /1\.0x.*3\.0x.*18\.0x/);
  assert.doesNotMatch(aboutHtml, /\(1 credit per 500 tokens\)/);
});
