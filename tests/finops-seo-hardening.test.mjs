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
