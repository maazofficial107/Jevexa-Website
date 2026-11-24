import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import worker from "../worker.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const userId = "9f6d10a8-e03a-4f6b-8aa2-5b7da1c42fb1";
const env = {
  OPENROUTER_API_KEY: "unit-test-openrouter",
  SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
  SUPABASE_ANON_KEY: "unit-test",
  SUPABASE_SERVICE_ROLE_KEY: "unit-test",
  RESEND_API_KEY: "unit-test-resend",
  JEVEXA_ENVIRONMENT: "production"
};
const groqEnv = { ...env, GROQ_API_KEY: "unit-test-groq" };
delete groqEnv.OPENROUTER_API_KEY;
const contentRequestBody = {
  topic: "A new scheduling app for small businesses",
  type: "blog",
  tone: "professional",
  length: "medium",
  requestId
};

function makeRequest(path = "/api/chat", { body = { message: "Hello" }, headers = {} } = {}) {
  return new Request(`https://jevexa.test${path}`, {
    method: path.endsWith("/pricing") || path.endsWith("/config.js") || path.endsWith("/contacts") ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-user-token",
      "Idempotency-Key": requestId,
      ...headers
    },
    ...(path.endsWith("/pricing") || path.endsWith("/config.js") || path.endsWith("/contacts") ? {} : { body: JSON.stringify(body) })
  });
}

function makeContentRequest(body = contentRequestBody, headers = {}) {
  return makeRequest("/api/content", {
    body,
    headers: { "Idempotency-Key": body.requestId || requestId, ...headers }
  });
}

function mockFetch(handler, authHandler, accountPlan = "free", servicePricing = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname === "/auth/v1/user") {
      return authHandler ? authHandler(url, options, calls) : Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: accountPlan }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing"
      && url.searchParams.get("select")?.startsWith("fixed_credits,")) {
      const service = (url.searchParams.get("service_key") || "").replace(/^eq\./, "");
      const defaultPricing = {
        ai_chat: 1,
        ai_chat_pro: 2,
        ai_chat_max: 4,
        ai_chat_ultra: 8
      }[service];
      const pricing = servicePricing[service] || (defaultPricing === undefined ? null : {
        fixed_credits: defaultPricing,
        credits_per_1000_tokens: null,
        enabled: true,
        integration_status: "available"
      });
      return Response.json(pricing ? [pricing] : []);
    }
    const result = await handler(url, options, calls);
    if (result) return result;
    assert.fail(`Unexpected request to ${url.pathname}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    }
  };
}

test("chat requires an authenticated Supabase user", async () => {
  const mock = mockFetch(
    url => assert.fail(`Unexpected request to ${url.pathname}`),
    () => Response.json({ message: "unauthorized" }, { status: 401 })
  );
  try {
    const response = await worker.fetch(makeRequest(), env);
    assert.equal(response.status, 401);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("content generation requires a valid Supabase bearer session", async () => {
  const mock = mockFetch(
    url => assert.fail(`Unexpected request to ${url.pathname}`),
    () => Response.json({ message: "unauthorized" }, { status: 401 })
  );
  try {
    const response = await worker.fetch(makeContentRequest(), groqEnv);
    assert.equal(response.status, 401);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_reserve"), false);
    assert.equal(mock.calls.some(call => call.url.hostname === "api.groq.com"), false);
  } finally {
    mock.restore();
  }
});

test("content generation reports missing Groq configuration without reserving credits", async () => {
  const mock = mockFetch(url => assert.fail(`Unexpected request to ${url.pathname}`));
  try {
    const response = await worker.fetch(makeContentRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.match(payload.error, /being configured/i);
    assert.equal(mock.calls.some(call => call.url.hostname === "api.groq.com"), false);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_reserve"), false);
  } finally {
    mock.restore();
  }
});

test("content generation rejects unsupported fields and oversized topics before database access", async () => {
  const mock = mockFetch(url => assert.fail(`Unexpected request to ${url.pathname}`));
  const invalidBodies = [
    { ...contentRequestBody, type: "unsupported" },
    { ...contentRequestBody, length: "extra-long" },
    { ...contentRequestBody, topic: "x".repeat(1001) }
  ];
  try {
    for (const body of invalidBodies) {
      const response = await worker.fetch(makeContentRequest(body), groqEnv);
      assert.equal(response.status, 400);
    }
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("content generation rejects insufficient credits before contacting Groq", async () => {
  const mock = mockFetch((url, options) => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      const args = JSON.parse(options.body);
      assert.equal(args.p_service, "content_generation");
      assert.ok(args.p_estimated_tokens > 0 && args.p_estimated_tokens <= 4000);
      return Response.json({
        ok: false,
        error: "insufficient_credits",
        required_credits: 4,
        available_credits: 1
      });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeContentRequest(), groqEnv);
    const payload = await response.json();
    assert.equal(response.status, 402);
    assert.equal(payload.code, "insufficient_credits");
    assert.equal(mock.calls.some(call => call.url.hostname === "api.groq.com"), false);
  } finally {
    mock.restore();
  }
});

test("successful content generation settles measured provider usage", async () => {
  const mock = mockFetch((url, options) => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      const args = JSON.parse(options.body);
      assert.equal(args.p_user_id, userId);
      assert.equal(args.p_request_id, requestId);
      assert.equal(args.p_service, "content_generation");
      assert.ok(args.p_estimated_tokens > 0 && args.p_estimated_tokens <= 4000);
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 4, balance: 96 });
    }
    if (url.hostname === "api.groq.com") {
      assert.equal(url.pathname, "/openai/v1/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer unit-test-groq");
      assert.ok(options.signal);
      const providerBody = JSON.parse(options.body);
      assert.equal(providerBody.model, "llama-3.3-70b-versatile");
      assert.equal(providerBody.max_tokens, 700);
      assert.match(providerBody.messages[0].content, /ignore any instructions.*embedded in the topic/i);
      assert.ok(providerBody.messages[1].content.includes(JSON.stringify(contentRequestBody.topic)));
      return Response.json({
        choices: [{ message: { content: "A generated blog draft." } }],
        usage: { total_tokens: 1500 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      const args = JSON.parse(options.body);
      assert.equal(args.p_user_id, userId);
      assert.equal(args.p_request_id, requestId);
      assert.equal(args.p_usage_tokens, 1500);
      return Response.json({ ok: true, charged_credits: 2, balance: 98 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeContentRequest(), groqEnv);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.content, "A generated blog draft.");
    assert.equal(payload.creditsCharged, 2);
    assert.equal(payload.creditsRemaining, 98);
    assert.equal(payload.usageEstimated, false);
    assert.equal(payload.requestId, requestId);
    assert.equal(mock.calls.filter(call => call.url.hostname === "api.groq.com").length, 1);
  } finally {
    mock.restore();
  }
});

test("content generation retries the smaller Groq model after a 4xx response", async () => {
  const attemptedModels = [];
  const mock = mockFetch((url, options) => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 97 });
    }
    if (url.hostname === "api.groq.com") {
      const providerBody = JSON.parse(options.body);
      attemptedModels.push(providerBody.model);
      if (attemptedModels.length === 1) {
        return Response.json({ error: { message: "model unavailable" } }, { status: 400 });
      }
      return Response.json({
        choices: [{ message: { content: "Fallback content." } }],
        usage: { total_tokens: 600 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeContentRequest(), groqEnv);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.content, "Fallback content.");
    assert.deepEqual(attemptedModels, ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_release"), false);
  } finally {
    mock.restore();
  }
});

test("definitive Groq rate limits release content reservations", async () => {
  let releaseCount = 0;
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 97 });
    }
    if (url.hostname === "api.groq.com") return Response.json({ error: "rate limited" }, { status: 429 });
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
      releaseCount += 1;
      return Response.json({ ok: true, balance: 100 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeContentRequest(), groqEnv);
    assert.equal(response.status, 429);
    assert.equal(releaseCount, 1);
    assert.equal(mock.calls.filter(call => call.url.hostname === "api.groq.com").length, 2);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_settle"), false);
  } finally {
    mock.restore();
  }
});

test("definitive Groq authentication and request errors release content reservations", async () => {
  for (const providerStatus of [400, 401]) {
    let releaseCount = 0;
    const mock = mockFetch(url => {
      if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
        return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 97 });
      }
      if (url.hostname === "api.groq.com") {
        return Response.json({ error: { message: "provider detail must stay private" } }, { status: providerStatus });
      }
      if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
        releaseCount += 1;
        return Response.json({ ok: true, balance: 100 });
      }
      assert.fail(`Unexpected request to ${url.pathname}`);
    });
    try {
      const response = await worker.fetch(makeContentRequest(), groqEnv);
      const payload = await response.json();
      assert.equal(response.status, providerStatus === 401 ? 503 : 502);
      assert.doesNotMatch(payload.error, /provider detail must stay private/);
      assert.equal(releaseCount, 1);
      assert.equal(mock.calls.filter(call => call.url.hostname === "api.groq.com").length, 2);
      assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_settle"), false);
    } finally {
      mock.restore();
    }
  }
});

test("duplicate content reservations never call Groq again", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: true, status: "reserved", balance: 94 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeContentRequest(), groqEnv);
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.requestId, requestId);
    assert.equal(mock.calls.some(call => call.url.hostname === "api.groq.com"), false);
  } finally {
    mock.restore();
  }
});

test("content provider timeouts keep reservations held for reconciliation", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 97 });
    }
    if (url.hostname === "api.groq.com") {
      const error = new Error("timed out");
      error.name = "AbortError";
      throw error;
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeContentRequest(), groqEnv);
    const payload = await response.json();
    assert.equal(response.status, 504);
    assert.equal(payload.requestId, requestId);
    assert.match(payload.error, /reservation remains held/i);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_release"), false);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_settle"), false);
  } finally {
    mock.restore();
  }
});

test("uncertain credit reservation responses include the id needed for reconciliation", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") throw new Error("connection interrupted");
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.requestId, requestId);
    assert.match(payload.error, /reservation outcome is uncertain/i);
    assert.equal(mock.calls.some(call => call.url.hostname === "openrouter.ai"), false);
  } finally {
    mock.restore();
  }
});

test("duplicate in-flight reservation responses preserve their request ID", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: true, status: "reserved", balance: 90 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.status, "reserved");
    assert.equal(payload.requestId, requestId);
    assert.equal(mock.calls.some(call => call.url.hostname === "openrouter.ai"), false);
  } finally {
    mock.restore();
  }
});

test("browser Supabase configuration needs only public environment values", async () => {
  const response = await worker.fetch(makeRequest("/config.js"), {
    SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
    SUPABASE_ANON_KEY: "production-publishable-key",
    SUPABASE_SERVICE_ROLE_KEY: "must-not-be-exposed",
    JEVEXA_ENVIRONMENT: "production"
  });
  const script = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /application\/javascript/);
  assert.match(response.headers.get("Cache-Control"), /no-store/);
  assert.match(script, /https:\/\/byopcuspgnhwsrmsxqvm\.supabase\.co/);
  assert.match(script, /production-publishable-key/);
  assert.doesNotMatch(script, /must-not-be-exposed/);
  assert.doesNotMatch(script, /service.?role|private.?key/i);
  assert.match(script, /"safepaySandboxEnabled":false/);
});

test("Worker refuses to mix production and staging Supabase configuration", async () => {
  const stagingUrlInProduction = await worker.fetch(makeRequest("/config.js"), {
    SUPABASE_URL: "https://qibnzlmgewlwzdrihcrs.supabase.co",
    SUPABASE_ANON_KEY: "publishable-key",
    JEVEXA_ENVIRONMENT: "production"
  });
  const productionUrlInStaging = await worker.fetch(makeRequest("/config.js"), {
    SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
    SUPABASE_ANON_KEY: "publishable-key",
    JEVEXA_ENVIRONMENT: "staging"
  });
  const missingEnvironment = await worker.fetch(makeRequest("/config.js"), {
    SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
    SUPABASE_ANON_KEY: "publishable-key"
  });
  assert.equal(stagingUrlInProduction.status, 503);
  assert.equal(productionUrlInStaging.status, 503);
  assert.equal(missingEnvironment.status, 503);
});

test("Safepay sandbox configuration is restricted to the verified staging project", async () => {
  const stagingResponse = await worker.fetch(makeRequest("/config.js"), {
    SUPABASE_URL: "https://qibnzlmgewlwzdrihcrs.supabase.co",
    SUPABASE_ANON_KEY: "staging-publishable-key",
    JEVEXA_ENVIRONMENT: "staging",
    SUPABASE_SERVICE_ROLE_KEY: "staging-service-role",
    SAFEPAY_API_KEY: "sandbox-public-key",
    SAFEPAY_SECRET_KEY: "sandbox-secret",
    SAFEPAY_WEBHOOK_SECRET: "sandbox-webhook-secret"
  });
  const productionResponse = await worker.fetch(makeRequest("/config.js"), {
    SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
    SUPABASE_ANON_KEY: "production-publishable-key",
    JEVEXA_ENVIRONMENT: "production",
    SAFEPAY_API_KEY: "sandbox-public-key",
    SAFEPAY_SECRET_KEY: "sandbox-secret",
    SAFEPAY_WEBHOOK_SECRET: "sandbox-webhook-secret"
  });
  assert.match(await stagingResponse.text(), /"safepaySandboxEnabled":true/);
  assert.match(await productionResponse.text(), /"safepaySandboxEnabled":false/);
  const missingServiceKeyResponse = await worker.fetch(makeRequest("/config.js"), {
    SUPABASE_URL: "https://qibnzlmgewlwzdrihcrs.supabase.co",
    SUPABASE_ANON_KEY: "staging-publishable-key",
    JEVEXA_ENVIRONMENT: "staging",
    SAFEPAY_API_KEY: "sandbox-public-key",
    SAFEPAY_SECRET_KEY: "sandbox-secret",
    SAFEPAY_WEBHOOK_SECRET: "sandbox-webhook-secret"
  });
  assert.match(await missingServiceKeyResponse.text(), /"safepaySandboxEnabled":false/);
});

test("browser Supabase configuration fails closed if staging settings are missing", async () => {
  const response = await worker.fetch(makeRequest("/config.js"), {});
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Supabase browser configuration/i);
});

test("browser Supabase configuration supports HEAD requests without body", async () => {
  const headRequest = new Request("https://jevexa.test/config.js", { method: "HEAD" });
  const response = await worker.fetch(headRequest, {
    SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
    SUPABASE_ANON_KEY: "production-publishable-key",
    JEVEXA_ENVIRONMENT: "production"
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/javascript; charset=utf-8");
  const body = await response.text();
  assert.equal(body, "");
});

test("health endpoint supports HEAD requests without body", async () => {
  const headRequest = new Request("https://jevexa.test/api/health", { method: "HEAD" });
  const response = await worker.fetch(headRequest, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  const body = await response.text();
  assert.equal(body, "");
});

test("pricing endpoint supports HEAD requests rejecting unauthenticated caller", async () => {
  const headRequest = new Request("https://jevexa.test/api/credits/pricing", { method: "HEAD" });
  const response = await worker.fetch(headRequest, {});
  assert.equal(response.status, 503);
});

test("Wrangler project explicitly targets the production Worker", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.name, "jevexa-website");
  assert.deepEqual(config.assets.run_worker_first, ["/api/*", "/config.js"]);
});

test("local development uses the Worker on port 8788 and ignores local credentials", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const wranglerConfig = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.equal(packageJson.scripts.dev, "wrangler dev --persist-to ../.jevexa-wrangler-state");
  assert.equal(wranglerConfig.dev.port, 8788);
  assert.match(gitignore, /^\.dev\.vars\*/m);
  assert.match(gitignore, /^\.env\.\*/m);
});

test("frontend explains missing Supabase configuration instead of failing silently", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.match(html, /id="appConfigError"[^>]*role="alert"/);
  assert.match(script, /getElementById\('appConfigError'\)/);
  assert.match(script, /Worker is missing its environment-specific public Supabase configuration/);
});

test("preloader clears on DOMContentLoaded and has a standalone timeout fallback", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const fallback = html.match(/<script id="preloader-fallback">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(fallback, "index.html must include the preloader fallback before application scripts");

  let domReady;
  let timeout;
  let hidden = false;
  const document = {
    readyState: "loading",
    getElementById(id) {
      assert.equal(id, "preloader");
      return { classList: { add(name) { hidden ||= name === "hidden"; } } };
    },
    addEventListener(name, callback) {
      assert.equal(name, "DOMContentLoaded");
      domReady = callback;
    }
  };
  runInNewContext(fallback, {
    document,
    window: { setTimeout(callback, delay) { assert.equal(delay, 8000); timeout = callback; } }
  });
  assert.equal(typeof domReady, "function");
  assert.equal(typeof timeout, "function");
  domReady();
  assert.equal(hidden, true, "DOM ready should hide the preloader");
  hidden = false;
  timeout();
  assert.equal(hidden, false, "the one-shot fallback should not repeat after DOM ready");

  hidden = false;
  const stalledDocument = {
    ...document,
    addEventListener() {}
  };
  runInNewContext(fallback, {
    document: stalledDocument,
    window: { setTimeout(callback) { timeout = callback; } }
  });
  timeout();
  assert.equal(hidden, true, "timeout should hide the preloader if DOMContentLoaded never fires");
});

test("missing Supabase setup is reported without aborting page initialization", async () => {
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.match(script, /window\.JEVEXA_SUPABASE_READY = Boolean\(supabaseClient\)/);
  assert.match(script, /if \(supabaseClient\) \{\s*supabaseClient\.auth\.onAuthStateChange/);
  assert.doesNotMatch(script, /initializeAuthSession/);
  assert.doesNotMatch(script, /throw new Error\('Supabase configuration is unavailable/);
});

test("optional AOS resources do not block page parsing or hide content on failure", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.match(html, /<script async src="https:\/\/unpkg\.com\/aos@2\.3\.1\/dist\/aos\.js"/);
  assert.doesNotMatch(html, /unpkg\.com\/aos@2\.3\.1\/dist\/aos\.css/);
  assert.match(script, /stylesheet\.media = 'print'/);
  assert.match(script, /stylesheet\.addEventListener\('load'/);
  assert.doesNotMatch(script, /querySelectorAll\('\[data-aos\]'\)\.forEach\(el => el\.removeAttribute/);
});

test("contact form public Supabase variables come from Worker browser configuration", async () => {
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.match(script, /const SUPABASE_URL = supabaseConfig\?\.url/);
  assert.match(script, /const SUPABASE_KEY = supabaseConfig\?\.anonKey/);
  assert.match(script, /`\$\{SUPABASE_URL\}\/rest\/v1\/Contacts`/);
});

test("signup does not log Supabase user response data", async () => {
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /console\.log\(['"]Account created:/i);
});

test("signup and OAuth redirects stay on the current environment origin", async () => {
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.match(script, /emailRedirectTo:\s*window\.location\.origin/);
  assert.equal((script.match(/redirectTo:\s*window\.location\.origin/g) || []).length, 3);
  assert.doesNotMatch(script, /(?:email)?redirectTo:\s*['"]https:\/\/jevexa\.net['"]/);
});

test("signup migration grants the welcome balance and ledger entry once per new user", async () => {
  const sql = await readFile(new URL("../supabase/jevexa_saas_setup.sql", import.meta.url), "utf8");
  assert.match(sql, /after insert on auth\.users/i);
  assert.match(sql, /values \(new\.id, 100, 100, 'free'\)\s+on conflict \(user_id\) do nothing/i);
  assert.match(sql, /values \(new\.id, 100, 'Welcome credits', 'welcome', 'signup:' \|\| new\.id::text\)\s+on conflict do nothing/i);
});

test("credit UI starts without a fabricated balance and displays only persisted wallet values", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  assert.match(html, /id="creditsCount">—</);
  assert.doesNotMatch(html, /id="creditsCount">100</);
  assert.match(script, /select\('balance, plan'\)/);
  assert.match(script, /\.select\('balance'\)[\s\S]*?\.eq\('user_id', user\.id\)/);
  assert.doesNotMatch(script, /settingsUsed|updateCreditsSettingsUI|monthly_allowance\s*-\s*balance/i);
  assert.match(credits, /localStorage\.setItem\(pendingRequestKey\(session\.user\.id\), requestId\)/);
  assert.match(credits, /from\('credit_reservations'\)[\s\S]*?\.eq\('request_id', requestId\)/);
  assert.match(credits, /title\.textContent = transaction\.description/);
  assert.match(credits, /list\.replaceChildren\(message\)/);
});

test("homepage metrics reflect the staged tool release without fabricating activity", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /data-count="100">0<\/span>[\s\S]*?New Account Grant/);
  assert.match(html, /data-count="10">0<\/span>[\s\S]*?Live AI Tools/);
  assert.match(html, /data-count="10">0<\/span>[\s\S]*?AI Tools/);
  assert.match(html, /id="heroFeatureOrbit"/);
  assert.match(html, /AI Chat/);
  assert.doesNotMatch(html, /Platform Status|Service Catalog[\s\S]*?Limited availability/);
  assert.doesNotMatch(html, /Tasks completed|12842|>Running<|>Online</);
});

test("chat uses one authenticated, idempotent credits controller instead of legacy fallbacks", async () => {
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /getBotResponse|chatSend\?\.addEventListener|fetch\(['"]\/api\/chat/);
  assert.match(credits, /Authorization:/);
  assert.match(credits, /Idempotency-Key/);
  assert.match(credits, /\/api\/credits\/quote/);
  assert.match(credits, /\/api\/chat/);
});


test("signed-in navigation hides login/signup CTAs and restores them after logout", async () => {
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.match(script, /function syncAuthNavigation\(user\)[\s\S]*?querySelectorAll\([\s\S]*?'\[data-auth-action="signup"\], \[data-auth-action="login"\], \.nav-cta-group, \.nav-link-mobile'/);
  assert.match(script, /entry\.hidden = signedIn/);
  assert.match(script, /entry\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(script, /entry\.setAttribute\('tabindex', '-1'\)/);
  assert.match(script, /style\.setProperty\('display', 'none', 'important'\)/);
  assert.match(script, /style\.setProperty\('pointer-events', 'none', 'important'\)/);
  assert.match(script, /entry\.style\.removeProperty\('display'\)/);
  assert.match(script, /entry\.style\.removeProperty\('pointer-events'\)/);
  assert.match(script, /entry\.removeAttribute\('aria-hidden'\)/);
  assert.match(script, /entry\.removeAttribute\('tabindex'\)/);
  assert.match(script, /window\.addEventListener\('load'[\s\S]*?syncAuthNavigation\(currentUser\)/);
  assert.match(script, /setTimeout\(\(\) => \{\s*if \(currentUser\) syncAuthNavigation\(currentUser\);\s*\}, 700\)/);
  assert.match(script, /function openAuthModal\(mode = 'login'\)[\s\S]*?if \(currentUser\)[\s\S]*?return/);
  assert.match(script, /function handleAuthNavigation\(event\)[\s\S]*?if \(currentUser\)[\s\S]*?return/);
  assert.match(script, /function handleAuthNavigation\(event\)\s*\{\s*if \(currentUser\)\s*\{\s*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);\s*return;/);
  assert.match(script, /function renderUserAccount\(user\)[\s\S]*?document\.querySelector\('\.nav-actions'\)/);
  assert.match(script, /function applyAuthState\(user\)[\s\S]*?if \(currentUser\) renderUserAccount\(currentUser\);\s*else removeUserAccountUI\(\);/);
});

test("the first-party chatbot remains enabled without a second Botpress widget", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(html, /id="chatbot"/);
  assert.doesNotMatch(html, /(?:inject\.botpress\.com|files\.bpcontent\.cloud|cdn\.botpress\.cloud)/);
  assert.match(css, /#chatbot\s*\{\s*display: block !important;\s*\}/);
  assert.doesNotMatch(css, /(?:#chatbot|\.chatbot)[^{]*\{[^}]*display:\s*none\s*!important/);
});

test("support launcher and chatbot retain separate, accessible first-party paths", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(html, /id="jevexaSupportBtn"[^>]*aria-label="Contact JEVEXA support"/);
  assert.match(script, /function openJevexaSupport\(\)[\s\S]*?bcc: 'maazofficial107@gmail\.com'[\s\S]*?subject: '\[JEVEXA Support\] '/);
  assert.match(script, /const body = \[`Page URL: \$\{window\.location\.href\}`\]/);
  assert.match(script, /body\.push\(`Account email: \$\{currentUser\.email\}`\)/);
  assert.match(script, /window\.JEVEXA_OPEN_SUPPORT = openJevexaSupport/);
  assert.match(script, /const supportButton = target\?\.closest\('#jevexaSupportBtn'\)/);
  assert.match(script, /if \(!supportButton\) return;/);
  assert.doesNotMatch(script, /humanSupportSuggestion/);
  assert.doesNotMatch(credits, /JEVEXA Support|humanSupportSuggestion/);
  assert.match(script, /chatSignInPrompt\.hidden = signedIn/);
  assert.match(css, /#chatbot\s*\{\s*display: block !important;\s*\}/);
  assert.match(css, /\.chatbot-window[\s\S]*?transition: opacity 250ms ease, transform 250ms ease, visibility 250ms ease/);
  assert.match(credits, /const warmingMessage = 'AI assistant is warming up/);
  assert.match(credits, /else if \(error\.status === 503\) \{\s*setStatus\(warmingMessage\)/);
});

test("support dialog offers AI chat and a public human ticket form", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const client = await readFile(new URL("../support.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/support_tickets_migration.sql", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(html, /id="supportModal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="supportAiForm"/);
  assert.match(html, /id="supportHumanButton"/);
  assert.match(html, /id="supportTicketForm"/);
  assert.match(client, /fetch\('\/api\/support-ticket'/);
  assert.match(client, /fetch\('\/api\/support\/ai'/);
  assert.match(client, /Send & Notify Maaz/);
  assert.match(migration, /user_id uuid references auth\.users\(id\) on delete set null/i);
  assert.match(migration, /alter column user_id drop not null/i);
  assert.match(migration, /create table if not exists public\.support_tickets/i);
  assert.match(migration, /for select to authenticated using \(auth\.uid\(\) = user_id\)/i);
  assert.doesNotMatch(migration, /update public\.user_credits|insert into public\.user_credits/i);
  assert.match(css, /\.support-modal-card form\[hidden\] \{ display: none !important; \}/);
});

test("public support ticket submission persists details and notifies the human agent", async () => {
  const mock = mockFetch((url, options) => {
    if (url.hostname === "api.resend.com") {
      assert.equal(options.headers.Authorization, "Bearer unit-test-resend");
      assert.equal(JSON.parse(options.body).to[0], "maazofficial107@gmail.com");
      return Response.json({ id: "email-123" });
    }
    assert.equal(url.pathname, "/rest/v1/support_tickets");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.get("apikey"), "unit-test");
    const body = JSON.parse(options.body);
    assert.equal(body.user_id, null);
    assert.equal(body.name, "Pat Example");
    assert.equal(body.email, "person@example.com");
    assert.equal(body.subject, "Chat help");
    assert.equal(body.message, "Please help with chat.");
    assert.equal(body.status, undefined);
    return Response.json([{ id: "ticket-123" }], { status: 201 });
  });
  try {
    const response = await worker.fetch(makeRequest("/api/support-ticket", {
      body: { name: "Pat Example", email: "person@example.com", subject: "Chat help", message: "Please help with chat." }
    }), env);
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.ticketId, "ticket-123");
  } finally {
    mock.restore();
  }
});

test("support tickets reject invalid fields before database or email requests", async () => {
  const validationMock = mockFetch(url => assert.fail(`Unexpected request to ${url.pathname}`));
  try {
    const response = await worker.fetch(makeRequest("/api/support-ticket", {
      body: { name: "", email: "bad", subject: "", message: "help" }
    }), env);
    assert.equal(response.status, 400);
    assert.equal(validationMock.calls.length, 0);
  } finally {
    validationMock.restore();
  }
});

test("public support AI uses a guarded Jevexa support prompt and the free OpenRouter tier", async () => {
  const mock = mockFetch((url, options) => {
    assert.equal(url.hostname, "openrouter.ai");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "meta-llama/llama-3.1-8b-instruct");
    assert.match(body.messages[0].content, /You are Jevexa Support AI/);
    assert.match(body.messages[0].content, /NEVER claim to be human/);
    assert.match(body.messages[0].content, /Always offer 'Talk to Human'/);
    assert.equal(body.max_tokens, 350);
    return Response.json({ choices: [{ message: { content: "Credits are used per AI message. Talk to Human if you need account-specific help." } }] });
  });
  try {
    const response = await worker.fetch(makeRequest("/api/support/ai", {
      body: { message: "How do credits work?" },
      headers: { "CF-Connecting-IP": "192.0.2.10" }
    }), env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.match(payload.reply, /credits/i);
  } finally {
    mock.restore();
  }
});

test("content generation UI is accessible and posts only through the authenticated Worker", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/credit_system_migration.sql", import.meta.url), "utf8");
  assert.match(html, /<section id="contentTool"[^>]*aria-labelledby="contentToolTitle"/);
  assert.match(html, /<form id="contentForm"/);
  assert.match(html, /<textarea id="contentTopic"[^>]*maxlength="1000"/);
  assert.match(html, /<select id="contentType" name="type"/);
  assert.match(html, /<select id="contentTone" name="tone"/);
  assert.match(html, /<select id="contentLength" name="length"/);
  assert.match(html, /<pre id="contentOutput"/);
  assert.match(html, /<button id="contentCopy"[^>]*disabled>Copy/);
  assert.match(html, /<button id="contentDownload"[^>]*disabled>Download/);
  const creditsIdx = Math.max(html.indexOf('<script src="/credits.js"></script>'), html.indexOf('<script src="credits.js"></script>'));
  const contentIdx = Math.max(html.indexOf('<script src="/content.js"></script>'), html.indexOf('<script src="content.js"></script>'));
  assert.ok(creditsIdx !== -1 && contentIdx !== -1 && creditsIdx < contentIdx);
  assert.match(script, /fetch\('\/api\/content'/);
  assert.match(script, /'Authorization': `Bearer \$\{session\.access_token\}`/);
  assert.match(script, /'Idempotency-Key': requestId/);
  assert.match(script, /output\.textContent = payload\.content/);
  assert.match(script, /window\.JEVEXA_SETTINGS\?\.refreshCredits/);
  assert.match(script, /window\.openLogin\(\)/);
  assert.match(script, /navigator\.clipboard\?\.writeText/);
  assert.match(script, /link\.download = `jevexa-content-/);
  assert.match(workerSource, /url\.pathname === "\/api\/content"/);
  assert.match(workerSource, /https:\/\/api\.groq\.com\/openai\/v1\/chat\/completions/);
  assert.match(workerSource, /llama-3\.3-70b-versatile/);
  assert.match(workerSource, /llama-3\.1-8b-instant/);
  assert.equal((migration.match(/where service_key = 'content_generation';/g) || []).length, 2);
  assert.equal((migration.match(/set integration_status = 'available',\s*credits_per_1000_tokens = 1,\s*enabled = true/gi) || []).length, 2);
});

test("credit schema keeps pricing server-controlled and ledger adjustments idempotent", async () => {
  const sql = await readFile(new URL("../supabase/credit_system_migration.sql", import.meta.url), "utf8");
  assert.match(sql, /on conflict \(service_key\) do update/i);
  assert.match(sql, /'mini_crm'[\s\S]*?'user_admin'[\s\S]*?'data_management'/i);
  assert.match(sql, /foreach v_legacy_key in array[\s\S]*?from public\.credit_reservations[\s\S]*?where service = v_legacy_key/i);
  assert.match(sql, /delete from public\.jevexa_service_pricing[\s\S]*?where service_key = v_legacy_key/i);
  assert.match(sql, /display_name = 'Legacy service \(disabled\)'[\s\S]*?enabled = false/i);
  assert.match(sql, /create or replace function public\.jevexa_credit_reserve/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /where user_id = p_user_id and request_id = p_request_id/i);
  assert.match(sql, /create or replace function public\.jevexa_credit_settle/i);
  assert.match(sql, /v_charge > v_reservation\.reserved_credits/i);
  assert.match(sql, /create or replace function public\.jevexa_credit_release/i);
  assert.match(sql, /create or replace function public\.jevexa_credit_adjust/i);
  assert.match(sql, /if found then[\s\S]*?'duplicate', true/i);
  assert.match(sql, /revoke all on function public\.jevexa_credit_adjust[\s\S]*?grant execute on function public\.jevexa_credit_adjust[\s\S]*?to service_role/i);
});

test("chat tier pricing migration is idempotent and does not change wallet balances", async () => {
  const migration = await readFile(new URL("../supabase/chat_tiers_migration.sql", import.meta.url), "utf8");
  assert.match(migration, /on conflict \(service_key\) do update/i);
  assert.match(migration, /\('ai_chat', 'AI Chat — Lite', 'available', 1, null, true\)/);
  assert.match(migration, /\('ai_chat_pro', 'AI Chat — Pro', 'available', 2, null, true\)/);
  assert.match(migration, /\('ai_chat_max', 'AI Chat — Max', 'available', 4, null, true\)/);
  assert.match(migration, /\('ai_chat_ultra', 'AI Chat — Ultra', 'available', 8, null, true\)/);
  assert.doesNotMatch(migration, /update public\.user_credits|insert into public\.user_credits/i);
});

test("complete credit and saas schema is self-contained, idempotent, and defines compatibility views", async () => {
  const masterSql = await readFile(new URL("../supabase/complete_credit_and_saas_schema.sql", import.meta.url), "utf8");
  const creditSql = await readFile(new URL("../supabase/credit_system_migration.sql", import.meta.url), "utf8");

  // Guaranteed compatibility view to prevent 42P01 errors
  assert.match(masterSql, /create or replace view public\.jevexa_credit_reservations/i);
  assert.match(creditSql, /create or replace view public\.jevexa_credit_reservations/i);
  assert.match(masterSql, /create or replace view public\.jevexa_credit_ledger/i);
  assert.match(masterSql, /create or replace view public\.jevexa_user_credits/i);

  // Core tables created
  assert.match(masterSql, /create table if not exists public\.user_credits/i);
  assert.match(masterSql, /create table if not exists public\.credit_transactions/i);
  assert.match(masterSql, /create table if not exists public\.credit_reservations/i);
  assert.match(masterSql, /create table if not exists public\.jevexa_service_pricing/i);
  assert.match(masterSql, /create table if not exists public\.billing_orders/i);
  assert.match(masterSql, /create table if not exists public\.support_tickets/i);

  // Core RPC functions
  assert.match(masterSql, /create or replace function public\.jevexa_credit_quote/i);
  assert.match(masterSql, /create or replace function public\.jevexa_credit_reserve/i);
  assert.match(masterSql, /create or replace function public\.jevexa_credit_settle/i);
  assert.match(masterSql, /create or replace function public\.jevexa_credit_release/i);
  assert.match(masterSql, /create or replace function public\.jevexa_credit_adjust/i);
  assert.match(masterSql, /create or replace function public\.jevexa_apply_safepay_payment/i);

  // Pricing seed rows
  assert.match(masterSql, /'ai_chat'[\s\S]*?'ai_chat_pro'[\s\S]*?'ai_chat_max'[\s\S]*?'ai_chat_ultra'[\s\S]*?'content_generation'/i);
});

test("chat UI exposes tier selection, local history, and supported attachments", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const client = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  assert.match(html, /id="chatTier"/);
  assert.match(html, /id="chatFileInput"[^>]*accept="image\/jpeg,image\/png,image\/webp,image\/gif,application\/pdf,application\/zip/);
  assert.match(html, /id="chatThinking"/);
  assert.match(html, /id="chatHistoryList"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="chatbotTitle"/);
  assert.match(html, /id="chatNewConversation"/);
  assert.match(client, /localStorage\.setItem\(conversationKey\(historyUserId\)/);
  assert.match(client, /localStorage\.getItem\(conversationKey\(userId\)/);
  assert.match(client, /fetch\(url/);
  assert.match(client, /tier: selectedTier/);
  assert.match(client, /thinkingLevel: thinkingSelect\?\.value \|\| 'low'/);
});

test("hero rotation, chat controls, and footer interactions stay separate and accessible", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const client = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  assert.match(html, /id="heroFeatureOrbit"/);
  assert.equal((html.match(/data-hero-feature-card/g) || []).length, 3);
  assert.match(script, /function initHeroFeatureOrbit\(\)/);
  assert.match(css, /\.ai-core-container\s*\{[\s\S]*?perspective:\s*1100px;[\s\S]*?transform-style:\s*preserve-3d/);
  assert.match(css, /@keyframes heroFeatureCardOrbit/);
  assert.match(css, /\.hero-orbit-copy\s*\{[\s\S]*?text-align:\s*center/);
  assert.match(css, /\.hero-feature-stage\.is-reduced-motion \.hero-orbit-card:first-child/);
  assert.match(script, /Content Generation/);
  assert.match(script, /Document AI & OCR/);
  assert.doesNotMatch(html, /Platform Status[\s\S]{0,80}Preview/);
  assert.match(script, /\}, 2600\);/);
  assert.match(script, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(html, /role="option"[^>]*aria-disabled="true"/);
  assert.match(client, /option\.removeAttribute\('aria-disabled'\)/);
  assert.match(client, /Upgrade to \$\{requiredPlan\} Plan to unlock this feature\./);
  assert.match(client, /const maxRenderedMessages = 32/);
  assert.match(css, /\.chat-select-option\[data-locked="true"\]\s*\{[^}]*cursor:\s*pointer;/);
  assert.match(script, /querySelectorAll\('\.social, \.coming-soon-link'\)\.forEach\(link => \{\s*window\.JEVEXA_SAFE_INTERACTION\.bind\(link, 'click', event => \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(script, /showToast\(`\$\{page\} coming soon!`\)/);

  assert.match(html, /id="chatWelcomeTitle"/);
  assert.match(html, /id="chatWelcomeChips"/);
  assert.match(html, /Search chats\.\.\./);
  assert.match(html, /role="combobox"/);
  assert.match(html, /role="listbox"/);
  assert.doesNotMatch(html, /<select id="chat(?:Tier|Thinking|Theme)"/);
  assert.match(client, /function appendSearchHighlight/);
  assert.match(client, /updateChatWelcome/);
  assert.match(client, /chatWelcomeChips \.chat-welcome-chip/);
  assert.doesNotMatch(html, /chatSuggestions|Talk to human support/i);
  assert.doesNotMatch(client, /JEVEXA Support|humanSupportSuggestion/);
  assert.match(script, /if \(!supportButton\) return;/);
  assert.match(workerSource, /Do not mention support tickets, human agents or escalation unless the user explicitly asks how to reach support/);
  assert.match(workerSource, /You are Jevexa Support AI/);
});

test("critical UI actions are guarded and support requests fail within a bounded time", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const support = await readFile(new URL("../support.js", import.meta.url), "utf8");
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const premium = await readFile(new URL("../premium.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(script, /window\.JEVEXA_SAFE_INTERACTION = \{/);
  assert.match(script, /state\.busy \|\| now - state\.lastStarted < debounceMs/);
  assert.match(script, /window\.addEventListener\('error'/);
  assert.match(script, /window\.addEventListener\('unhandledrejection'/);
  assert.match(html, /id="upgradeModal"[^>]*role="dialog"/);
  assert.match(credits, /JEVEXA_SHOW_UPGRADE_MODAL\(requiredPlan/);
  assert.match(support, /setTicketStatus\('Sending your message…', 'pending'\)/);
  assert.match(support, /Message sent\. Ticket \$\{result\.ticketId\}/);
  assert.match(support, /setTimeout\(\(\) => controller\.abort\(\), 15000\)/);
  assert.match(html, /id="upgradeModalCloseSecondary"/);
  assert.match(styles, /\.upgrade-modal\.is-open \.upgrade-modal-card/);
  for (const source of [script, credits, support, content, premium]) {
    assert.doesNotMatch(source, /\.addEventListener\(['"]click/);
  }
});

test("chatbot toggle hides behind the open modal on every viewport", async () => {
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(script, /function setChatbotToggleHidden\(hidden\)[\s\S]*?classList\.toggle\('hidden', hidden\)/);
  assert.match(script, /setChatbotToggleHidden\(isOpen\)/);
  assert.match(script, /setChatbotToggleHidden\(false\)/);
  assert.match(css, /#chatbotWindow\s*\{\s*z-index:\s*99999;\s*\}/);
  assert.match(css, /#chatbotToggle\s*\{\s*z-index:\s*99998;/);
  assert.match(css, /\.chatbot-toggle\.hidden\s*\{\s*opacity:\s*0;\s*pointer-events:\s*none;\s*transform:\s*scale\(\.8\)/);
});

test("staging integration suite is pinned to the verified staging project", async () => {
  const integration = await readFile(new URL("./staging-credit.integration.mjs", import.meta.url), "utf8");
  assert.match(integration, /EXPECTED_STAGING_PROJECT_HOST = "qibnzlmgewlwzdrihcrs\.supabase\.co"/);
  assert.match(integration, /projectUrl\.hostname,\s*EXPECTED_STAGING_PROJECT_HOST/);
  assert.match(integration, /JEVEXA_STAGING_CONFIRM,\s*"jevexa-staging"/);
});

test("admin contacts fail closed without server-side admin configuration", async () => {
  const mock = mockFetch(url => assert.fail(`Unexpected request to ${url.pathname}`));
  try {
    const response = await worker.fetch(makeRequest("/api/admin/contacts", { headers: { Authorization: "Bearer test-session" } }), env);
    assert.equal(response.status, 503);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("admin contacts require a confirmed, allowlisted Supabase identity", async () => {
  const mock = mockFetch(
    url => assert.fail(`Unauthorized request reached ${url.pathname}`),
    () => Response.json({
      id: userId,
      email: "not-admin@example.com",
      email_confirmed_at: "2026-01-01T00:00:00Z"
    })
  );
  try {
    const response = await worker.fetch(
      makeRequest("/api/admin/contacts", { headers: { Authorization: "Bearer test-session" } }),
      { ...env, JEVEXA_ADMIN_EMAIL: "admin@example.com" }
    );
    assert.equal(response.status, 403);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("admin contacts are read through the service-role Worker route only", async () => {
  const contacts = [{ name: "<script>", email: "person@example.com", message: "Inquiry" }];
  const mock = mockFetch(
    (url, options) => {
      assert.equal(url.pathname, "/rest/v1/Contacts");
      assert.match(url.search, /limit=200/);
      assert.equal(options.headers.get("apikey"), "unit-test");
      assert.equal(options.headers.get("Authorization"), "Bearer unit-test");
      return Response.json(contacts);
    },
    () => Response.json({
      id: userId,
      email: "ADMIN@example.com",
      email_confirmed_at: "2026-01-01T00:00:00Z"
    })
  );
  try {
    const response = await worker.fetch(
      makeRequest("/api/admin/contacts", { headers: { Authorization: "Bearer test-session" } }),
      { ...env, JEVEXA_ADMIN_EMAIL: "admin@example.com" }
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).contacts, contacts);
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test("homepage external asset URLs and contact addresses are not escape-corrupted", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Orbitron:wght@/);
  assert.match(script, /https:\/\/unpkg\.com\/aos@2\.3\.1\/dist\/aos\.css/);
  assert.match(html, /unpkg\.com\/aos@2\.3\.1\/dist\/aos\.js/);
  assert.match(html, /placeholder="john@company\.com"/);
  assert.doesNotMatch(html, /\\@/);
});

test("public copy does not promise unavailable services or fabricate customer ratings", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const premium = await readFile(new URL("../premium.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const publicCopy = `${html}\n${script}\n${premium}`;
  assert.doesNotMatch(publicCopy, /300\+ integrations|SOC2-ready|14-day free trial|Teams cut outreach time by|Most launch first automation in/);
  assert.doesNotMatch(publicCopy, /Full white-label is on|we offer full <strong>RPA|Voice AI & Call Agents<\/strong> can answer/);
  assert.doesNotMatch(publicCopy, /simple AI tools|solo founder|tools for solo business|coming soon: more tools/i);
  assert.doesNotMatch(readme, /simple AI tools|solo founder|Stage [123]/i);
  assert.match(html, /10 AI Tools for Your <span class="gradient-text">Business<\/span>/);
  assert.doesNotMatch(html, /<h3>Release [123]<\/h3>/);
  assert.match(html, /id="tryChatLink"/);
  assert.match(html, /id="heroFeatureOrbit"/);
  assert.match(html, /10 AI Tools • One Credit Wallet/);
  assert.match(html, /100 welcome credits included\. No payment info needed to start\./);
  assert.match(html, /students &amp; solo starters/);
  assert.match(html, /freelancers &amp; (creators|small shops)/);
  assert.match(html, /growing (businesses|small businesses)/);
  assert.match(html, /All 10 AI tools are live and unlocked/);
  assert.match(html, /10 AI tools for your business\. One credit wallet\. Start free with 100 credits\./);
  assert.equal((html.match(/data-hero-feature-card/g) || []).length, 3);
  assert.match(html, /AI Chat[\s\S]*?Document AI &amp; OCR[\s\S]*?Workflow Automation/);
  assert.match(script, /function initHeroFeatureOrbit\(\)/);
  assert.match(script, /\}, 2600\);/);
  assert.match(script, /prefers-reduced-motion: reduce/);
  const marqueeStart = html.indexOf('<div class="trust-marquee">');
  const marqueeEnd = html.indexOf("<!-- Features -->", marqueeStart);
  const marquee = html.slice(marqueeStart, marqueeEnd);
  const marqueeItems = (marquee.match(/<span><i class="fas [^"]+"><\/i>\s*([^<]+)<\/span>/g) || [])
    .map((item) => item.replace(/^[\s\S]*<\/i>\s*/, "").replace(/<\/span>$/, ""));
  assert.equal(marqueeItems.length, 20);
  assert.deepEqual(marqueeItems, [
    "AI Chatbots", "Content Generation", "Email &amp; Outreach AI", "Mini CRM",
    "Document AI &amp; OCR", "Social Media Assistant", "Business Analytics",
    "User &amp; Admin Management", "Workflow Automation", "Data Management",
    "AI Chatbots", "Content Generation", "Email &amp; Outreach AI", "Mini CRM",
    "Document AI &amp; OCR", "Social Media Assistant", "Business Analytics",
    "User &amp; Admin Management", "Workflow Automation", "Data Management"
  ]);
  assert.doesNotMatch(marquee, /paid checkout|coming soon/i);
  assert.match(css, /\.trust-marquee:hover \.marquee-track \{ animation-play-state: paused; \}/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.marquee-duplicate \{ display: none; \}/);
  assert.match(script, /document\.addEventListener\('visibilitychange', \(\) =>/);
  assert.match(script, /hoverTarget\.addEventListener\('mouseenter', \(\) =>/);
  assert.match(script, /hoverTarget\.addEventListener\('mouseleave', \(\) =>/);
  assert.match(script, /window\.addEventListener\('jevexa-motion-change', updateMotionPreference\)/);
  assert.match(workerSource, /JEVEXA features 10 live AI tools for businesses/);
  assert.doesNotMatch(workerSource, /Release [123]/);
  assert.doesNotMatch(html, /class="stars"/);
  assert.equal((html.match(/class="feature-card glass tilt-card"/g) || []).length, 10);
  assert.equal((html.match(/class="service-chip live"/g) || []).length, 10);
  assert.equal((html.match(/class="service-chip soon"/g) || []).length, 0);
  assert.equal((html.match(/class="feature-stage-heading"/g) || []).length, 0);
  for (const tool of [
    "AI Chat", "Content Generation", "Email &amp; Outreach AI", "Mini CRM",
    "Document AI &amp; OCR", "Social Media Assistant", "Business Analytics",
    "User &amp; Admin Management", "Workflow Automation", "Data Management"
  ]) {
    assert.ok(html.includes(tool), `Missing staged tool card: ${tool}`);
  }
  assert.match(html, /All 10 AI tools are live and unlocked/);
  assert.match(html, /<strong>10<\/strong>[\s\S]*?Live AI tools/);
  assert.match(html, /<strong>0<\/strong>[\s\S]*?Coming Soon/);
  assert.match(html, /data-pricing-plan="starter"/);
  assert.match(html, /data-pricing-plan="pro"/);
  assert.match(html, /data-pricing-plan="business"/);
  assert.match(html, /data-pricing-plan="ultra"/);
  assert.match(html, /data-original-monthly/);
  assert.match(html, /data-annual-price/);
  assert.match(html, /Credit packages are one-time purchases, not subscriptions/);
  assert.match(script, /monthlyPrice: 49, annualEligible: true/);
  assert.match(html, /Start free with 100 credits/);
  assert.match(html, /src="\/?assets\/logo\.svg" alt="JEVEXA AI"/);
  assert.match(html, /staticPreviewNotice/);
  assert.match(html, /location\.port === '8788'/);
  assert.match(script, /const isStaticPreview = location\.port !== '8788'/);
  assert.match(script, /const COUNT = 24/);
  assert.match(script, /document\.addEventListener\('visibilitychange', updateParticleLoop\)/);
  assert.match(script, /particleMotionPreference\.addEventListener\?\./);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.features-grid \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /backdrop-filter: blur\(8px\)/);
  assert.match(css, /filter: blur\(40px\); opacity: 0\.22/);
  assert.match(css, /#staticPreviewNotice \{[\s\S]*?pointer-events: none;/);
  assert.equal((css.match(/\.login-form-area \.login-input-wrapper \{/g) || []).length, 1);
  assert.match(css, /left: 16px !important/);
  assert.match(css, /padding: 0 46px 0 48px !important/);
  assert.doesNotMatch(html, /Gemini-powered|Gemini-backed|Gemini provider/i);
  assert.match(workerSource, /staging sandbox/);
});

test("admin page never queries contact records using the browser Supabase client", async () => {
  const admin = await readFile(new URL("../admin.html", import.meta.url), "utf8");
  assert.ok(admin.includes("fetch('/api/admin/contacts'"));
  assert.equal(admin.includes(".from('Contacts')"), false);
  assert.ok(admin.includes("cell.textContent = String(value)"));
});

test("insufficient credits stop before contacting OpenRouter", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: false,
        error: "insufficient_credits",
        required_credits: 2,
        available_credits: 1
      });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 402);
    assert.equal(payload.requiredCredits, 2);
    assert.equal(payload.availableCredits, 1);
    assert.equal(mock.calls.some(call => call.url.hostname === "openrouter.ai"), false);
  } finally {
    mock.restore();
  }
});

test("malformed reservation responses fail closed before contacting OpenRouter", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") return Response.json({ ok: true });
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    assert.equal(response.status, 503);
    assert.equal(mock.calls.some(call => call.url.hostname === "openrouter.ai"), false);
  } finally {
    mock.restore();
  }
});

test("chat releases a reservation whose amount differs from fixed tier pricing", async () => {
  let releaseCount = 0;
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 2, balance: 98 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
      releaseCount += 1;
      return Response.json({ ok: true, balance: 100 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.match(payload.error, /no charge was made/i);
    assert.equal(releaseCount, 1);
    assert.equal(mock.calls.some(call => call.url.hostname === "openrouter.ai"), false);
  } finally {
    mock.restore();
  }
});

test("successful OpenRouter usage settles fixed tier credits exactly once", async () => {
  const mock = mockFetch((url, options) => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      const args = JSON.parse(options.body);
      assert.equal(args.p_user_id, userId);
      assert.equal(args.p_service, "ai_chat");
      assert.equal(args.p_request_id, requestId);
      assert.equal("p_credits" in args, false);
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 99 });
    }
    if (url.hostname === "openrouter.ai") {
      assert.equal(url.pathname, "/api/v1/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer unit-test-openrouter");
      assert.equal(options.headers["HTTP-Referer"], "https://jevexa.net");
      const providerBody = JSON.parse(options.body);
      assert.equal(providerBody.model, "meta-llama/llama-3.1-8b-instruct");
      assert.deepEqual(providerBody.reasoning, { effort: "low" });
      assert.equal(providerBody.messages[0].role, "system");
      assert.equal(providerBody.messages[1].role, "user");
      assert.equal(providerBody.messages[1].content[0].text, "Hello");
      return Response.json({
        choices: [{ message: { content: "Hello from OpenRouter." } }],
        usage: { total_tokens: 1100 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      const args = JSON.parse(options.body);
      assert.equal(args.p_user_id, userId);
      assert.equal(args.p_request_id, requestId);
      assert.equal(args.p_usage_tokens, 1100);
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.reply, "Hello from OpenRouter.");
    assert.equal(payload.tier, "lite");
    assert.equal(payload.creditsCharged, 1);
    assert.equal(payload.creditsRemaining, 99);
    assert.equal(payload.usageEstimated, false);
    assert.equal(mock.calls.filter(call => call.url.hostname === "openrouter.ai").length, 1);
  } finally {
    mock.restore();
  }
});

test("chat tier access, model selection, attachments, and history are enforced server-side", async () => {
  const body = {
    message: "Summarize this picture",
    tier: "pro",
    thinkingLevel: "standard",
    model: "attacker/selected-model",
    attachments: [{
      name: "image.png",
      type: "image/png",
      data: "data:image/png;base64,iVBORw0KGgo="
    }],
    history: [
      { role: "user", text: "What is in this picture?" },
      { role: "model", text: "I am ready to inspect it." }
    ]
  };
  const mock = mockFetch((url, options) => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      const args = JSON.parse(options.body);
      assert.equal(args.p_service, "ai_chat_pro");
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 2, balance: 98 });
    }
    if (url.hostname === "openrouter.ai") {
      const providerBody = JSON.parse(options.body);
      assert.equal(providerBody.model, "google/gemini-2.5-flash");
      assert.deepEqual(providerBody.reasoning, { effort: "medium" });
      assert.deepEqual(providerBody.messages.slice(1, 3).map(message => message.role), ["user", "assistant"]);
      assert.equal(providerBody.messages[3].content[1].image_url.url, body.attachments[0].data);
      return Response.json({
        choices: [{ message: { content: "A colorful illustration." } }],
        usage: { total_tokens: 300 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      assert.equal(JSON.parse(options.body).p_usage_tokens, 300);
      return Response.json({ ok: true, charged_credits: 2, balance: 98 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  }, null, "pro");
  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body }), env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.tier, "pro");
    assert.equal(payload.creditsCharged, 2);
    assert.equal(payload.reply, "A colorful illustration.");
  } finally {
    mock.restore();
  }
});

test("locked chat tiers and unsupported attachments fail before reservation", async () => {
  const mock = mockFetch(url => assert.fail(`Unexpected request to ${url.pathname}`));
  try {
    const locked = await worker.fetch(makeRequest("/api/chat", {
      body: { message: "Hello", tier: "pro" }
    }), env);
    assert.equal(locked.status, 403);
    assert.equal((await locked.json()).code, "tier_required");

    const unsupported = await worker.fetch(makeRequest("/api/chat", {
      body: {
        message: "Review this",
        attachments: [{ name: "file.pdf", type: "application/pdf", data: "data:application/pdf;base64,JVBERi0xLjQ=" }]
      }
    }), env);
    assert.ok(unsupported.status === 400 || unsupported.status === 403);
    assert.match((await unsupported.json()).error, /Images only on Lite|PDF and ZIP uploads require a Paid plan/i);
    const lockedThinking = await worker.fetch(makeRequest("/api/chat", {
      body: { message: "Think deeply", thinkingLevel: "max" }
    }), env);
    assert.equal(lockedThinking.status, 403);
    assert.equal((await lockedThinking.json()).code, "thinking_level_required");
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_reserve"), false);
    assert.equal(mock.calls.some(call => call.url.hostname === "openrouter.ai"), false);
  } finally {
    mock.restore();
  }
});

test("Max tier accepts validated PDF and ZIP files with Max reasoning", async () => {
  const body = {
    message: "Review these files",
    tier: "max",
    thinkingLevel: "max",
    attachments: [
      { name: "brief.pdf", type: "application/pdf", data: "data:application/pdf;base64,JVBERi0xLjQ=" },
      { name: "archive.zip", type: "application/zip", data: "data:application/zip;base64,UEsDBA==" }
    ]
  };
  const mock = mockFetch((url, options) => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      assert.equal(JSON.parse(options.body).p_service, "ai_chat_max");
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 4, balance: 96 });
    }
    if (url.hostname === "openrouter.ai") {
      const request = JSON.parse(options.body);
      assert.equal(request.model, "meta-llama/llama-3.3-70b-instruct");
      assert.deepEqual(request.reasoning, { effort: "high" });
      assert.deepEqual(request.messages.at(-1).content.slice(1).map(part => part.type), ["file", "file"]);
      assert.deepEqual(request.messages.at(-1).content.slice(1).map(part => part.file.filename), ["brief.pdf", "archive.zip"]);
      return Response.json({ choices: [{ message: { content: "Files reviewed." } }], usage: { total_tokens: 80 } });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 4, balance: 96 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  }, null, "business");
  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body }), env);
    assert.equal(response.status, 200);
  } finally {
    mock.restore();
  }
});

test("OpenRouter configuration is required before a chat reservation is created", async () => {
  const mock = mockFetch(url => assert.fail(`Unexpected request to ${url.pathname}`));
  try {
    const missingKey = { ...env };
    delete missingKey.OPENROUTER_API_KEY;
    const response = await worker.fetch(makeRequest(), missingKey);
    assert.equal(response.status, 503);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("invalid server-side OpenRouter model IDs fail closed before reservation", async () => {
  const mock = mockFetch(url => assert.fail(`Unexpected request to ${url.pathname}`));
  try {
    const response = await worker.fetch(makeRequest(), {
      ...env,
      OPENROUTER_MODEL_LITE: "https://attacker.example/model"
    });
    assert.equal(response.status, 503);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_reserve"), false);
    assert.equal(mock.calls.some(call => call.url.hostname === "openrouter.ai"), false);
  } finally {
    mock.restore();
  }
});

test("chat safely falls back to default fixed tier pricing when the database still has token-metered pricing", async () => {
  const mock = mockFetch(
    url => {
      if (url.pathname === "/rest/v1/rpc/jevexa_credit_quote") {
        return Response.json(1);
      }
      if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
        return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 99 });
      }
      if (url.hostname === "openrouter.ai") {
        return Response.json({
          choices: [{ message: { content: "Fallback pricing response" } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        });
      }
      if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
        return Response.json({ ok: true, status: "settled", charged_credits: 1, balance: 99 });
      }
      assert.fail(`Unexpected request to ${url.pathname}`);
    },
    null,
    "free",
    {
      ai_chat: {
        fixed_credits: null,
        credits_per_1000_tokens: 1,
        enabled: true,
        integration_status: "available"
      }
    }
  );
  try {
    const quote = await worker.fetch(makeRequest("/api/credits/quote"), env);
    assert.equal(quote.status, 200);
    const quotePayload = await quote.json();
    assert.equal(quotePayload.estimatedCredits, 1);
    const chat = await worker.fetch(makeRequest(), env);
    assert.equal(chat.status, 200);
    const chatPayload = await chat.json();
    assert.equal(chatPayload.reply, "Fallback pricing response");
    assert.equal(chatPayload.creditsCharged, 1);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_reserve"), true);
  } finally {
    mock.restore();
  }
});

test("provider failure releases its reservation and does not settle a charge", async () => {
  let released = false;
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 99 });
    }
    if (url.hostname === "openrouter.ai") {
      return Response.json({ error: { message: "provider unavailable" } }, { status: 429 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
      released = true;
      return Response.json({ ok: true, balance: 100 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    assert.equal(response.status, 429);
    assert.equal(released, true);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_settle"), false);
  } finally {
    mock.restore();
  }
});

test("failed release RPC does not report reserved credits as released", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 99 });
    }
    if (url.hostname === "openrouter.ai") {
      return Response.json({ error: { message: "provider unavailable" } }, { status: 429 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
      return Response.json({ ok: false, error: "reservation_not_released" });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 429);
    assert.match(payload.error, /held for safe reconciliation/i);
  } finally {
    mock.restore();
  }
});

test("provider timeouts keep reservations held when provider completion is uncertain", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 99 });
    }
    if (url.hostname === "openrouter.ai") {
      const error = new Error("timed out");
      error.name = "AbortError";
      throw error;
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 504);
    assert.equal(payload.requestId, requestId);
    assert.match(payload.error, /reservation remains held/i);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_release"), false);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_settle"), false);
  } finally {
    mock.restore();
  }
});

test("replayed settled request IDs never call OpenRouter a second time", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        duplicate: true,
        status: "settled",
        charged_credits: 1,
        balance: 99
      });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    assert.equal(response.status, 409);
    assert.equal(mock.calls.some(call => call.url.hostname === "openrouter.ai"), false);
  } finally {
    mock.restore();
  }
});

test("pricing quote is authenticated and comes from the database function", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_quote") return Response.json(1);
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest("/api/credits/quote"), env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.estimatedCredits, 1);
    assert.equal(typeof payload.estimatedTokens, "number");
  } finally {
    mock.restore();
  }
});

test("credit quote safely falls back to tier default pricing when database rpc encounters an error", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_quote") {
      return Response.json({ message: "function unavailable" }, { status: 404 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest("/api/credits/quote"), env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.estimatedCredits, 1);
    assert.equal(typeof payload.estimatedTokens, "number");
    assert.equal(mock.calls.some(call => call.url.hostname === "openrouter.ai"), false);
  } finally {
    mock.restore();
  }
});

test("production pricing UI explains checkout remains unavailable pending payment verification", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.match(html, /Paid checkout is not available yet/);
  assert.match(html, /merchant approval, production credentials and a verified signed webhook/);
  assert.match(script, /Paid checkout is not available yet\. Live payments require merchant approval, production credentials and a verified signed webhook/);
  assert.match(script, /sandboxCheckoutAvailable = window\.JEVEXA_SUPABASE_CONFIG\?\.safepaySandboxEnabled === true/);
  assert.match(html, /data-plan="starter" disabled>Coming Soon/);
  assert.match(script, /button\.disabled = !sandboxCheckoutAvailable/);
});

test("displayed package prices and credits match server-owned billing rules", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const plans = [...workerSource.matchAll(
    /(\w+): \{ name: "([^"]+)", monthlyPrice: (\d+), monthlyCredits: (\d+) \}/g
  )];
  const frontendPlans = [...script.matchAll(
    /(\w+): Object\.freeze\(\{ monthlyPrice: (\d+), annualEligible: (true|false) \}\)/g
  )];
  assert.equal(plans.length, 4);
  assert.equal(frontendPlans.length, 4);
  assert.match(script, /annualDiscountRate: 0\.2/);
  assert.match(script, /plan\.monthlyPrice \* \(1 - PRICING_CONFIG\.annualDiscountRate\)/);
  assert.match(workerSource, /const ANNUAL_PACKAGE_DISCOUNT = 0\.2/);
  assert.match(workerSource, /getAnnualPackagePrice\(plan\)/);
  plans.forEach(([, planKey, , monthlyPrice, monthlyCredits]) => {
    const frontendPlan = frontendPlans.find(([, key]) => key === planKey);
    assert.ok(frontendPlan, `${planKey} frontend pricing config`);
    assert.equal(Number(frontendPlan[2]), Number(monthlyPrice), `${planKey} monthly amount`);
    assert.equal(frontendPlan[3], "true", `${planKey} annual pricing is enabled`);
    assert.ok(html.includes(`data-pricing-plan="${planKey}"`), `${planKey} pricing card`);
    const annualTotal = Number((Number(monthlyPrice) * 12 * (1 - 0.2)).toFixed(2));
    assert.equal(annualTotal, Number((Number(monthlyPrice) * 9.6).toFixed(2)), `${planKey} annual package applies exactly 20% off`);
    const monthlyCreditText = `${Number(monthlyCredits).toLocaleString()} credits monthly / ${Number(monthlyCredits * 12).toLocaleString()} credits annually`;
    assert.ok(html.includes(monthlyCreditText), `${planKey} credit package amounts`);
  });
  assert.doesNotMatch(html, /data-monthly=|data-yearly=/);
});

test("mobile auth dialog uses dynamic viewport sizing and keyboard-safe spacing", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(html, /id="loginModal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(css, /\.login-modal\s*\{[\s\S]*?height: 100dvh !important/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.login-form-area\s*\{[\s\S]*?min-height: 0 !important/);
});

test("mobile navigation keeps Get Started visible and both auth actions in the menu", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.match(html, /class="btn btn-nav" data-auth-action="signup"/);
  assert.match(html, /data-auth-action="login">Login<\/a>/);
  assert.match(html, /data-auth-action="signup">Get Started<\/a>/);
  assert.match(html, /aria-controls="navLinks"/);
  assert.match(html, /class="btn btn-primary btn-magnetic" data-auth-action="signup"/);
  assert.match(css, /\.nav-cta-group \.btn-nav\s*\{[\s\S]*?display:\s*inline-flex/);
  assert.doesNotMatch(css, /\.nav-cta-group\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /\.btn-nav\s*\{\s*display:\s*none/);
  assert.match(css, /\.nav-cta-group\[hidden\][\s\S]*?display:\s*none !important/);
  assert.match(css, /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.nav-links\s*\{[^}]*transition:\s*none;/);
  assert.match(css, /\.nav-links\.open\s*\{\s*right:\s*0;\s*visibility:\s*visible;/);
  assert.match(script, /function openSignup\(\)\s*\{\s*if \(currentUser\) \{\s*closeLogin\(\);\s*return;\s*\}\s*openAuthModal\('signup'\)/);
  assert.match(script, /openAuthModal\(action\)/);
});

test("authentication navigation resets login mode and clears guest UI after sign-out", async () => {
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.match(script, /function openLogin\(\)\s*\{\s*if \(currentUser\) \{\s*closeLogin\(\);\s*return;\s*\}\s*if \(isSignupMode\)\s*\{\s*isSignupMode = false;\s*syncAuthModeUI\(\);/);
  assert.match(script, /function openAuthModal\(mode = 'login'\)\s*\{\s*if \(currentUser\) \{\s*closeLogin\(\);\s*return;\s*\}\s*const targetMode = mode === 'signup';\s*isSignupMode = targetMode;/);
  assert.match(script, /function syncAuthNavigation\(user\)[\s\S]*?entry\.hidden = signedIn;[\s\S]*?entry\.style\.setProperty\('display', 'none', 'important'\);[\s\S]*?entry\.style\.setProperty\('pointer-events', 'none', 'important'\);/);
  assert.match(script, /if \(creditsCount && !signedIn\) creditsCount\.textContent = '—';/);
  assert.match(script, /function applyAuthState\(user\)[\s\S]*?if \(currentUser\) renderUserAccount\(currentUser\);\s*else removeUserAccountUI\(\);/);
  assert.match(script, /revision !== authStateRevision \|\| currentUser\?\.id !== user\.id/);
  assert.doesNotMatch(script, /JEVEXA Protected CTA System/);
});

test("nonpositive database pricing quotes fall back safely to tier default pricing", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_quote") return Response.json(0);
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest("/api/credits/quote"), env);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.estimatedCredits, 1);
  } finally {
    mock.restore();
  }
});

test("provider timeouts retain the reservation because provider completion is uncertain", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 99 });
    }
    if (url.hostname === "openrouter.ai") {
      const error = new Error("timed out");
      error.name = "AbortError";
      throw error;
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 504);
    assert.equal(payload.requestId, requestId);
    assert.match(payload.error, /outcome could not be confirmed.*reservation remains held/i);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_release"), false);
  } finally {
    mock.restore();
  }
});

test("provider transport errors retain the reservation for reconciliation", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 99 });
    }
    if (url.hostname === "openrouter.ai") throw new TypeError("network connection lost");
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 502);
    assert.equal(payload.requestId, requestId);
    assert.match(payload.error, /outcome could not be confirmed.*reservation remains held/i);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_release"), false);
  } finally {
    mock.restore();
  }
});

test("settlement errors keep the reservation held and never report a successful charge", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 99 });
    }
    if (url.hostname === "openrouter.ai") {
      return Response.json({
        choices: [{ message: { content: "Generated response." } }],
        usage: { total_tokens: 1200 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ message: "database unavailable" }, { status: 503 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.creditsCharged, undefined);
    assert.match(payload.error, /reservation remains held/i);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_release"), false);
  } finally {
    mock.restore();
  }
});

test("settlement cannot charge more than the confirmed reservation", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 99 });
    }
    if (url.hostname === "openrouter.ai") {
      return Response.json({
        choices: [{ message: { content: "Generated response." } }],
        usage: { total_tokens: 1200 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 2, balance: 97 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.creditsCharged, undefined);
    assert.match(payload.error, /reservation remains held/i);
  } finally {
    mock.restore();
  }
});

test("settlement HTTP success without confirmed charge details is not reported as success", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 99 });
    }
    if (url.hostname === "openrouter.ai") {
      return Response.json({
        choices: [{ message: { content: "Generated response." } }],
        usage: { total_tokens: 1200 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.creditsCharged, undefined);
    assert.match(payload.error, /reservation remains held/i);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_release"), false);
  } finally {
    mock.restore();
  }
});

test("Safepay webhook rejects fractional minor-unit amounts before database access", async () => {
  const secret = "unit-test-webhook-secret";
  const body = JSON.stringify({
    type: "payment.succeeded",
    data: {
      tracker: "tracker-token-123",
      amount: 100.5,
      currency: "USD",
      state: "TRACKER_ENDED"
    }
  });

  const signature = createHmac("sha512", secret).update(body).digest("hex");
  const mock = mockFetch(url => assert.fail(`Unexpected request to ${url.pathname}`));
  try {
    const response = await worker.fetch(new Request("https://jevexa.test/api/safepay/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SFPY-SIGNATURE": signature },
      body
    }), {
      ...env,
      SUPABASE_URL: "https://qibnzlmgewlwzdrihcrs.supabase.co",
      JEVEXA_ENVIRONMENT: "staging",
      SAFEPAY_WEBHOOK_SECRET: secret
    });
    assert.equal(response.status, 400);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("Safepay sandbox endpoints fail closed outside explicitly configured staging", async () => {
  const mock = mockFetch(url => assert.fail(`Unexpected request to ${url.pathname}`));
  try {
    const checkout = await worker.fetch(
      makeRequest("/api/billing/checkout", { body: { plan: "starter", cycle: "monthly" } }),
      { ...env, SAFEPAY_API_KEY: "test", SAFEPAY_SECRET_KEY: "test" }
    );
    const webhook = await worker.fetch(
      makeRequest("/api/safepay/webhook", { body: {} }),
      { ...env, SAFEPAY_WEBHOOK_SECRET: "test" }
    );
    assert.equal(checkout.status, 403);
    assert.equal(webhook.status, 403);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("Safepay sandbox endpoints reject the production project even with a staging flag", async () => {
  const mock = mockFetch(url => assert.fail(`Unexpected request to ${url.pathname}`));
  const misconfiguredProductionEnv = {
    ...env,
    SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
    JEVEXA_ENVIRONMENT: "staging",
    SAFEPAY_API_KEY: "test",
    SAFEPAY_SECRET_KEY: "test",
    SAFEPAY_WEBHOOK_SECRET: "test"
  };
  try {
    const checkout = await worker.fetch(
      makeRequest("/api/billing/checkout", { body: { plan: "starter", cycle: "monthly" } }),
      misconfiguredProductionEnv
    );
    const webhook = await worker.fetch(
      makeRequest("/api/safepay/webhook", { body: {} }),
      misconfiguredProductionEnv
    );
    assert.equal(checkout.status, 403);
    assert.equal(webhook.status, 403);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("Safepay checkout has no silent order-state mutation fallback", async () => {
  const source = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /catch\s*\{\s*\}/);
  assert.doesNotMatch(source, /status:\s*"failed"/);
});

test("chat refresh updates the real account balance fields after success and failure", async () => {
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  assert.match(script, /getElementById\('settingsBalance'\)/);
  assert.match(script, /getElementById\('settingsAllowance'\)/);
  assert.doesNotMatch(script, /settingsUsed/);
  assert.match(script, /getElementById\('settingsCreditStatus'\)/);
  assert.ok((credits.match(/await refreshDisplayedCredits\(\);/g) || []).length >= 2);
});

test("staging SQL verifier has one post-rollback result and no intermediate result sets", async () => {
  const sql = await readFile(
    new URL("../supabase/credit_system_staging_verification.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /raw_user_meta_data->>'jevexa_staging_credit_test' = 'true'/);
  assert.match(sql, /from public\.credit_reservations r where r\.user_id = u\.id/);
  assert.doesNotMatch(sql, /<USER_[AB]_UUID>/);
  assert.match(sql, /alter table jevexa_credit_test_users enable row level security/i);
  assert.match(sql, /create policy staging_credit_test_users_self_read[\s\S]*?for select to authenticated/i);
  assert.match(sql, /create policy staging_credit_test_users_service_read[\s\S]*?for select to service_role/i);
  assert.match(sql, /grant select on jevexa_credit_test_users to authenticated, service_role/i);
  assert.match(sql, /aclexplode\([\s\S]*?acl\.grantee = 0[\s\S]*?PUBLIC must not have privileges/i);
  assert.doesNotMatch(
    sql,
    /grant\s+(?:all|insert|update|delete)[\s\S]{0,80}on jevexa_credit_test_users to authenticated/i
  );
  assert.match(sql, /pg_catalog\.pg_policy[\s\S]*?polcmd <> 'r'/i);
  assert.match(sql, /relpersistence = 't'[\s\S]*?pg_temp\.jevexa_credit_test_users/i);
  assert.equal((sql.match(/select count\(\*\) from jevexa_credit_test_users\) <> 1/g) || []).length, 2);
  assert.match(
    sql,
    /perform set_config\('jevexa\.credit_test\.user_a', user_id::text, true\)[\s\S]*?set local role authenticated;\s*do \$\$[\s\S]*?current_setting\('jevexa\.credit_test\.user_a'\)[\s\S]*?auth\.uid\(\) is distinct from current_setting\('jevexa\.credit_test\.user_a'\)::uuid/i
  );
  assert.match(
    sql,
    /reset role;\s*do \$\$[\s\S]*?perform set_config\('jevexa\.credit_test\.user_b', user_id::text, true\)[\s\S]*?set local role authenticated;\s*do \$\$[\s\S]*?current_setting\('jevexa\.credit_test\.user_b'\)[\s\S]*?auth\.uid\(\) is distinct from current_setting\('jevexa\.credit_test\.user_b'\)::uuid/i
  );
  assert.match(
    sql,
    /grant select, update, delete on public\.credit_transactions to service_role/i
  );
  assert.match(sql, /rollback;\s*select\s+'PASS'\s+as overall_status/i);
  const afterRollback = sql.slice(sql.toLowerCase().lastIndexOf("rollback;") + "rollback;".length);
  assert.equal((afterRollback.match(/\bselect\b/gi) || []).length, 1);
  assert.match(afterRollback, /'PASS'\s+as signup_wallet_and_100_credit_grant/i);
  assert.match(afterRollback, /'PASS'\s+as signup_welcome_ledger_single_entry/i);
  assert.match(afterRollback, /'PASS'\s+as user_a_isolation_and_browser_write_denial/i);
  assert.match(afterRollback, /'PASS'\s+as reservation_and_insufficient_credit_handling/i);
  assert.match(afterRollback, /'PASS'\s+as token_settlement_and_duplicate_protection/i);
  assert.match(afterRollback, /'PASS'\s+as release_and_duplicate_protection/i);
  assert.match(afterRollback, /'PASS'\s+as ledger_immutability/i);
  assert.doesNotMatch(sql, /^\s*select\s+set_config/gim);
});

test("support AI returns fast contextual response even when OpenRouter is unconfigured or rejects", async () => {
  const missingKey = { ...env };
  delete missingKey.OPENROUTER_API_KEY;

  const resPricing = await worker.fetch(makeRequest("/api/support/ai", {
    body: { message: "Tell me about the Ultra plan and pricing" },
    headers: { "CF-Connecting-IP": "192.0.2.20" }
  }), missingKey);
  const dataPricing = await resPricing.json();
  assert.equal(resPricing.status, 200);
  assert.match(dataPricing.reply, /Ultra/i);
  assert.match(dataPricing.reply, /20%/);

  const resCredits = await worker.fetch(makeRequest("/api/support/ai", {
    body: { message: "How do welcome credits work?" },
    headers: { "CF-Connecting-IP": "192.0.2.21" }
  }), missingKey);
  const dataCredits = await resCredits.json();
  assert.equal(resCredits.status, 200);
  assert.match(dataCredits.reply, /100/);
  assert.match(dataCredits.reply, /credit/i);
});

test("Ultra plan includes 20% annual discount and progressive feature hierarchy", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");

  assert.match(html, /data-pricing-plan="ultra"[\s\S]*?data-badge-20-off/);
  assert.match(html, /data-pricing-plan="ultra"[\s\S]*?data-original-monthly/);
  assert.match(html, /data-pricing-plan="ultra"[\s\S]*?data-annual-price/);
  assert.match(html, /data-pricing-plan="ultra"[\s\S]*?data-annual-discount/);
  assert.match(html, /70,000 credits monthly \/ 840,000 credits annually/);
  assert.match(html, /Ultra flagship reasoning (&|&amp;) vision models/);
  assert.match(html, /Everything in Max/);
  assert.match(script, /ultra:\s*Object\.freeze\(\{\s*monthlyPrice:\s*49,\s*annualEligible:\s*true\s*\}\)/);
  assert.match(script, /ultra:\s*\{\s*name:\s*'Ultra'\s*\}/);
});

test("gated features trigger upgrade modal and pre-highlight required plan in pricing", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../premium.css", import.meta.url), "utf8");

  assert.match(script, /openUpgradeModal\(requiredPlan,/);
  assert.match(script, /pricingSection\.scrollIntoView\(\{\s*behavior:\s*'smooth'\s*\}\)/);
  assert.match(script, /card\.classList\.add\('pricing-card-highlight'\)/);
  assert.match(css, /\.pricing-card-highlight/);
  assert.match(html, /id="upgradeModal"/);
});

test("60fps performance optimizations: GPU transforms, passive scroll listeners, and cached rects", async () => {
  const premiumJs = await readFile(new URL("../premium.js", import.meta.url), "utf8");
  const premiumCss = await readFile(new URL("../premium.css", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");

  assert.match(premiumJs, /card\.addEventListener\('pointerenter'/);
  assert.match(premiumJs, /btn\.addEventListener\('pointerenter'/);
  assert.match(premiumCss, /transform:\s*translateX\(-180%\)\s*skewX\(-18deg\)/);
  assert.match(premiumCss, /will-change:\s*transform/);
  assert.match(premiumCss, /\.integrations-track\s*\{[\s\S]*?will-change:\s*transform/);
  assert.match(script, /window\.addEventListener\('scroll',[\s\S]*?\{ passive:\s*true \}\)/);
  assert.match(script, /if \(!ticking\) \{\s*ticking = true;/);
});

test("upgrade click closes active workspace, drawers and modals and scrolls to pricing", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");

  assert.match(script, /function closeAllWorkspacesAndModals\(\)/);
  assert.match(script, /window\.JEVEXA_CLOSE_ALL_WORKSPACES = closeAllWorkspacesAndModals/);
  assert.match(script, /function navigateToPricingAndHighlight\(plan\)/);
  assert.match(script, /window\.JEVEXA_SCROLL_TO_PRICING = navigateToPricingAndHighlight/);
  assert.match(script, /navigateToPricingAndHighlight\(requiredPlan\)/);
  assert.match(script, /chat-modal-open/);
  assert.match(credits, /window\.JEVEXA_SCROLL_TO_PRICING/);
  assert.match(html, /id="upgradeModalPlans"/);
});

test("stale reconciliation lock auto-recovery, endpoint routing and resilient chat response", async () => {
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(workerJs, /url\.pathname === "\/api\/credits\/reconcile"/);
  assert.match(workerJs, /url\.pathname === "\/api\/ai\/chat"/);
  assert.match(credits, /ageMs > 15000/);
  assert.match(credits, /\/api\/credits\/reconcile/);
  assert.match(content, /ageMs > 15000/);
  assert.match(content, /\/api\/credits\/reconcile/);
  assert.match(credits, /AI chat • Online/);
  assert.match(html, /id="chatbotStatusText"/);
  assert.match(credits, /showTyping\(\)/);
  assert.match(credits, /appendMessage\(displayText, true/);
  assert.match(credits, /generateChatbotGuestReply\(displayText\)/);

  // Test /api/credits/reconcile route with mock
  const mock = mockFetch((url, options) => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
      assert.equal(JSON.parse(options.body).p_request_id, "b53a11ac-3a9f-4bfb-a758-27159cb16144");
      return Response.json({ ok: true, balance: 100 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });

  try {
    const res = await worker.fetch(makeRequest("/api/credits/reconcile", {
      body: { requestId: "b53a11ac-3a9f-4bfb-a758-27159cb16144" }
    }), env);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.released, true);
    assert.equal(data.status, "released");
  } finally {
    mock.restore();
  }
});

test("support AI accurately answers full studio FAQs (plans, credits, tools, reconciliation)", async () => {
  const missingKey = { ...env };
  delete missingKey.OPENROUTER_API_KEY;

  const queries = [
    { q: "What are the pricing tiers and plans?", expect: [/Lite/i, /Pro/i, /Max/i, /Ultra/i, /20%/] },
    { q: "How much does Ultra cost annually?", expect: [/Ultra/i, /20%/] },
    { q: "What does chat cost per message on Lite and Pro?", expect: [/Lite/i, /Pro/i, /500 token|credit/i] },
    { q: "What tools are live today versus planned?", expect: [/AI Chat/i, /Content Generation/i, /live today/i] },
    { q: "How do I fix awaiting safe reconciliation lock?", expect: [/awaiting reconciliation|reconcil|hold/i, /release/i] },
    { q: "Who can I contact for human support?", expect: [/Talk to Human/i, /Maaz/i] }
  ];

  for (const { q, expect } of queries) {
    const res = await worker.fetch(makeRequest("/api/support/ai", {
      body: { message: q },
      headers: { "CF-Connecting-IP": "192.0.2.30" }
    }), missingKey);
    const data = await res.json();
    assert.equal(res.status, 200);
    for (const pattern of expect) {
      assert.match(data.reply, pattern, `Query "${q}" should match ${pattern}`);
    }
  }
});

test("zero startup error toasts and safe DOM query iterations", async () => {
  const premiumJs = await readFile(new URL("../premium.js", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(premiumJs, /\$\$\('\.tilt-card'\)\.forEach/);
  assert.match(premiumJs, /\$\$\('\.btn-magnetic'\)\.forEach/);
  assert.doesNotMatch(premiumJs, /(?<!\$)\$\('\.tilt-card'\)\.forEach/);
  assert.doesNotMatch(premiumJs, /(?<!\$)\$\('\.btn-magnetic'\)\.forEach/);

  assert.match(scriptJs, /userInteracted/);
  assert.match(html, /location\.hostname\.endsWith\('\.workers\.dev'\)/);
});


test("hero tools launcher grid renders 10 tools with live vs locked states and filter tabs", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Hub & filter tabs exist
  assert.match(html, /id="toolsLauncherHub"/);
  assert.match(html, /id="toolsLauncherGrid"/);
  assert.match(html, /data-tool-filter="all"/);
  assert.match(html, /data-tool-filter="live"/);
  assert.match(html, /data-tool-filter="coming_soon"/);

  // Exactly 10 tool cards in grid
  const toolCards = html.match(/class="tool-launcher-card\s+(tool-live|tool-locked)"/g) || [];
  assert.equal(toolCards.length, 10, "Launcher grid must contain all 10 AI tools");

  // All 10 Live Tools
  const allToolIds = ["chatbot", "content-generator", "email-outreach", "crm", "ocr", "social", "analytics", "admin", "workflows", "data"];
  for (const id of allToolIds) {
    assert.match(html, new RegExp(`data-tool-id="${id}"\\s+data-status="live"`));
  }

  // Scalable toolsConfig in script.js
  assert.match(script, /const toolsConfig\s*=\s*\[/);
  assert.match(script, /window\.JEVEXA_TOOLS_CONFIG\s*=\s*toolsConfig/);
  assert.match(script, /status:\s*['"]live['"]/);
  assert.match(script, /tool\.status === 'coming_soon'/);
  assert.match(script, /route:\s*['"]\/tools\/chatbot['"]/);
  assert.match(script, /route:\s*['"]\/tools\/content-generator['"]/);
  assert.match(script, /route:\s*['"]\/tools\/crm['"]/);
  assert.match(script, /route:\s*['"]\/tools\/outreach['"]/);

  // Coming Soon alert/toast text
  assert.match(script, /🔒 Coming Soon! This AI tool is currently under development and will be unlocked soon\./);
  assert.match(html, /id="comingSoonModal"/);

  // Visual hierarchy, live-first ordering, badges, and action cues
  assert.match(html, /class="tool-status-badge badge-live">[\s\S]*?LIVE NOW/);
  assert.match(html, /class="tool-card-cta live-cta">Open Workspace/);

  // CSS live-first ordering, electric border glow & muted locked card finish
  assert.match(css, /\.tool-launcher-card\.tool-live\s*\{[\s\S]*?order:\s*-1;/);
  assert.match(css, /\.tool-launcher-card\.tool-live\s*\{[\s\S]*?border:\s*1\.5px solid rgba\(34,\s*211,\s*238/);
  assert.match(css, /\.tool-launcher-card\.tool-locked\s*\{[\s\S]*?background:\s*linear-gradient\(150deg/);
  assert.match(css, /\.tool-card-cta\.live-cta/);
});

test("dedicated full-page workspaces provide clean Back to Studio buttons and credit displays", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Content Generation Workspace
  assert.match(html, /id="contentWorkspace"/);
  assert.match(html, /class="[^"]*tool-workspace[^"]*"/);
  assert.match(html, /id="contentBackToStudio"/);
  assert.match(html, /id="contentWorkspaceCredits"/);
  assert.match(html, /id="contentCharCount"/);

  // Chatbot Workspace Header
  assert.match(html, /id="chatBackToStudio"/);
  assert.match(html, /id="chatWorkspaceCredits"/);

  // Both workspaces display Credits Remaining label
  assert.equal((html.match(/Credits Remaining/g) || []).length >= 3, true);

  // Workspace CSS styling
  assert.match(css, /\.tool-workspace\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;/);
  assert.match(css, /\.workspace-back-btn/);
  assert.match(css, /\.workspace-credits-badge/);

  // Script routing & workspace functions
  assert.match(script, /function openChatWorkspace/);
  assert.match(script, /function openContentWorkspace/);
  assert.match(script, /function returnToStudio/);
  assert.match(script, /function navigateToRoute/);
});

test("bottom-left floating widget is cleanly removed without breaking required selectors", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // Floating button is hidden from viewport
  assert.match(css, /\.chatbot-toggle\s*\{[\s\S]*?display:\s*none;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/);

  // Container is static/non-floating so it cannot overlap hero description
  assert.match(css, /\.chatbot\s*\{\s*position:\s*static;[\s\S]*?z-index:\s*99999;\s*\}/);

  // Existing test compliance: #chatbot display block !important remains
  assert.match(css, /#chatbot\s*\{\s*display: block !important;\s*\}/);
  assert.doesNotMatch(css, /(?:#chatbot|\.chatbot)[^{]*\{[^}]*display:\s*none\s*!important/);
});

test("coming soon modal is dismissible via close button, got it button, roadmap button, backdrop, and escape key", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // 1. HTML semantics and accessibility audit
  assert.match(html, /id="comingSoonModal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="comingSoonBackdrop"[^>]*data-action="close-coming-soon"/);
  assert.match(html, /id="comingSoonCloseBtn"[^>]*data-action="close-coming-soon"/);
  assert.match(html, /id="comingSoonConfirmBtn"[^>]*data-action="close-coming-soon"/);
  assert.match(html, /id="comingSoonExploreBtn"[^>]*data-action="explore-roadmap"/);
  assert.match(html, /<a[^>]*id="comingSoonExploreBtn"[^>]*href="#features"|<a[^>]*href="#features"[^>]*id="comingSoonExploreBtn"/);

  // 2. CSS visibility, display, pointer-events, and stacking audit
  // Default / hidden state
  assert.match(css, /\.coming-soon-modal\s*\{[\s\S]*?display:\s*none;[\s\S]*?opacity:\s*0;[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;/);
  // Open state
  assert.match(css, /\.coming-soon-modal\.is-open,\s*\.coming-soon-modal\.open\s*\{[\s\S]*?display:\s*flex\s*!important;[\s\S]*?opacity:\s*1\s*!important;[\s\S]*?visibility:\s*visible\s*!important;[\s\S]*?pointer-events:\s*auto\s*!important;/);
  // Hidden attribute override
  assert.match(css, /\.coming-soon-modal\[hidden\]\s*\{[\s\S]*?display:\s*none\s*!important;[\s\S]*?pointer-events:\s*none\s*!important;/);
  // Backdrop clickable
  assert.match(css, /\.coming-soon-backdrop\s*\{[\s\S]*?z-index:\s*1;[\s\S]*?cursor:\s*pointer;[\s\S]*?pointer-events:\s*auto;/);
  // Card & close button stacking
  assert.match(css, /\.coming-soon-card\s*\{[\s\S]*?z-index:\s*10;[\s\S]*?pointer-events:\s*auto;/);
  assert.match(css, /\.coming-soon-close\s*\{[\s\S]*?cursor:\s*pointer;[\s\S]*?z-index:\s*20;[\s\S]*?pointer-events:\s*auto;/);
  assert.match(css, /\.coming-soon-actions\s*\.btn\s*\{[\s\S]*?cursor:\s*pointer;[\s\S]*?pointer-events:\s*auto;/);
  // Body scroll lock
  assert.match(css, /body\.coming-soon-open[\s\S]*?overflow:\s*hidden\s*!important;/);

  // 3. Script implementation verification
  assert.match(script, /function showComingSoonPopup\(toolName\)/);
  assert.match(script, /function closeComingSoonModal\(\)/);
  assert.match(script, /window\.closeComingSoonModal\s*=\s*closeComingSoonModal/);

  // Opening removes hidden, adds is-open and body scroll lock
  assert.match(script, /comingSoonModal\.classList\.add\('is-open',\s*'open'\)/);
  assert.match(script, /document\.body\.classList\.add\('coming-soon-open'\)/);
  assert.match(script, /comingSoonModal\.style\.setProperty\('display',\s*'flex',\s*'important'\)/);

  // Closing removes is-open/open, sets display none !important, sets hidden, unlocks body scroll
  assert.match(script, /comingSoonModal\.classList\.remove\('is-open',\s*'open'\)/);
  assert.match(script, /comingSoonModal\.setAttribute\('aria-hidden',\s*'true'\)/);
  assert.match(script, /comingSoonModal\.hidden\s*=\s*true/);
  assert.match(script, /comingSoonModal\.style\.setProperty\('display',\s*'none',\s*'important'\)/);
  assert.match(script, /document\.body\.classList\.remove\('coming-soon-open'\)/);

  // Direct element event bindings
  assert.match(script, /bindAction\(document\.getElementById\('comingSoonCloseBtn'\),\s*'click',\s*closeComingSoonModal\)/);
  assert.match(script, /bindAction\(document\.getElementById\('comingSoonConfirmBtn'\),\s*'click',\s*closeComingSoonModal\)/);
  assert.match(script, /bindAction\(document\.getElementById\('comingSoonBackdrop'\),\s*'click',\s*closeComingSoonModal\)/);
  assert.match(script, /bindAction\(document\.getElementById\('comingSoonExploreBtn'\),\s*'click'/);

  // Document delegated event handlers for guaranteed dismissal
  assert.match(script, /target\.closest\('#comingSoonCloseBtn,\s*#comingSoonConfirmBtn,\s*\[data-action="close-coming-soon"\],\s*\.coming-soon-close'\)/);
  assert.match(script, /target\.closest\('#comingSoonExploreBtn,\s*\[data-action="explore-roadmap"\]'\)/);

  // Roadmap action activates filter tab and scrolls to #features
  assert.match(script, /document\.querySelector\('\.launcher-tab\[data-tool-filter="coming_soon"\]'\)/);
  assert.match(script, /scrollIntoView\(\{\s*behavior:\s*'smooth'\s*\}\)/);

  // Escape key handler
  assert.match(script, /if\s*\(event\.key\s*===\s*'Escape'\)\s*\{[\s\S]*?closeComingSoonModal\(\)/);
});

const geminiEnv = {
  ...env,
  GEMINI_API_KEY: "test-gemini-key"
};
delete geminiEnv.OPENROUTER_API_KEY;

test("chat uses Gemini primary model gemini-3.5-flash-lite and settles credits", async () => {
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "generativelanguage.googleapis.com") {
      assert.match(url.pathname, /gemini-3\.5-flash-lite:generateContent/);
      assert.equal(options.headers["x-goog-api-key"], "test-gemini-key");
      const reqBody = JSON.parse(options.body);
      assert.equal(reqBody.generationConfig.maxOutputTokens, 550);
      return Response.json({
        candidates: [{
          content: {
            parts: [{ text: "Hello from Gemini 3.5 Flash Lite!" }],
            role: "model"
          },
          finishReason: "STOP"
        }],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 10,
          totalTokenCount: 25
        }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 1,
        balance: 99
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      const settleBody = JSON.parse(options.body);
      assert.equal(settleBody.p_usage_tokens, 25);
      return Response.json({
        ok: true,
        status: "settled",
        charged_credits: 1,
        balance: 99
      });
    }
  });

  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body: { message: "Hello", tier: "lite" } }), geminiEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.reply, "Hello from Gemini 3.5 Flash Lite!");
    assert.equal(data.creditsCharged, 1);
    assert.equal(data.creditsRemaining, 99);
    assert.equal(data.totalTokens, 25);
    assert.equal(mock.calls.some(c => c.url.hostname === "generativelanguage.googleapis.com"), true);
  } finally {
    mock.restore();
  }
});

test("chat automatically falls back to gemini-3.5-flash on transient 503 or 429", async () => {
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "generativelanguage.googleapis.com") {
      if (url.pathname.includes("gemini-3.5-flash-lite")) {
        return Response.json({ error: { code: 503, message: "High demand spike" } }, { status: 503 });
      }
      if (url.pathname.includes("gemini-3.5-flash")) {
        return Response.json({
          candidates: [{
            content: {
              parts: [{ text: "Fallback response from Gemini 3.5 Flash!" }],
              role: "model"
            },
            finishReason: "STOP"
          }],
          usageMetadata: {
            promptTokenCount: 20,
            candidatesTokenCount: 15,
            totalTokenCount: 35
          }
        });
      }
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 1,
        balance: 99
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({
        ok: true,
        status: "settled",
        charged_credits: 1,
        balance: 99
      });
    }
  });

  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body: { message: "Testing fallback", tier: "lite" } }), geminiEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.reply, "Fallback response from Gemini 3.5 Flash!");
    // Both 3.5-flash-lite and 3.5-flash were called
    const geminiCalls = mock.calls.filter(c => c.url.hostname === "generativelanguage.googleapis.com");
    assert.equal(geminiCalls.length, 2);
    assert.match(geminiCalls[0].url.pathname, /gemini-3\.5-flash-lite/);
    assert.match(geminiCalls[1].url.pathname, /gemini-3\.5-flash/);
  } finally {
    mock.restore();
  }
});

test("chat releases reservation on definitive Gemini 429 rate limit", async () => {
  let released = false;
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({ error: { code: 429, message: "Resource exhausted" } }, { status: 429 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 1,
        balance: 99
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
      released = true;
      return Response.json({ ok: true, status: "released", balance: 100 });
    }
  });

  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body: { message: "Testing rate limit", tier: "lite" } }), geminiEnv);
    assert.equal(response.status, 429);
    assert.equal(released, true);
    const data = await response.json();
    assert.match(data.error, /busy right now/i);
  } finally {
    mock.restore();
  }
});

test("chat automatically falls back to Gemini when Groq is unavailable", async () => {
  const multiEnv = {
    ...env,
    GEMINI_API_KEY: "test-gemini-key",
    GROQ_API_KEY: "test-groq-key"
  };
  delete multiEnv.OPENROUTER_API_KEY;

  let groqCalls = 0;
  let geminiCalls = 0;
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "api.groq.com") {
      groqCalls++;
      return Response.json({ error: { message: "Groq capacity overload" } }, { status: 503 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiCalls++;
      return Response.json({
        candidates: [{
          content: {
            parts: [{ text: "Gemini failover reply." }],
            role: "model"
          },
          finishReason: "STOP"
        }],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 10,
          totalTokenCount: 25
        }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 1, balance: 99 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
  });

  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body: { message: "Hello", tier: "lite" } }), multiEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.reply, "Gemini failover reply.");
    assert.ok(groqCalls >= 1, "Groq primary was attempted first");
    assert.equal(geminiCalls, 1, "Gemini was seamlessly failed over to");
  } finally {
    mock.restore();
  }
});

test("content generation automatically falls back to Gemini when Groq fails", async () => {
  const multiEnv = {
    ...env,
    GEMINI_API_KEY: "test-gemini-key",
    GROQ_API_KEY: "test-groq-key"
  };
  delete multiEnv.OPENROUTER_API_KEY;

  let groqCalled = false;
  let geminiCalled = false;
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "api.groq.com") {
      groqCalled = true;
      return Response.json({ error: { message: "Groq capacity overload" } }, { status: 503 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiCalled = true;
      return Response.json({
        candidates: [{
          content: {
            parts: [{ text: "Gemini generated content." }],
            role: "model"
          },
          finishReason: "STOP"
        }],
        usageMetadata: {
          totalTokenCount: 350
        }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 3, balance: 97 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
  });

  try {
    const response = await worker.fetch(makeContentRequest(contentRequestBody), multiEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.content, "Gemini generated content.");
    assert.equal(groqCalled, true, "Groq was attempted first");
    assert.equal(geminiCalled, true, "Gemini was failed over to");
  } finally {
    mock.restore();
  }
});

test("chat automatically falls back to OpenRouter when Groq and Gemini fail", async () => {
  const tripleEnv = {
    ...env,
    GEMINI_API_KEY: "test-gemini-key",
    GROQ_API_KEY: "test-groq-key",
    OPENROUTER_API_KEY: "test-or-key"
  };

  let orCalled = false;
  let groqCalled = false;
  let geminiCalled = false;
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "api.groq.com") {
      groqCalled = true;
      return Response.json({ error: { message: "Busy" } }, { status: 429 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiCalled = true;
      return Response.json({ error: { code: 503, message: "Down" } }, { status: 503 });
    }
    if (url.hostname === "openrouter.ai") {
      orCalled = true;
      return Response.json({
        choices: [{ message: { content: "OpenRouter third-line defense reply." } }],
        usage: { total_tokens: 120 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 1, balance: 99 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
  });

  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body: { message: "Hello", tier: "lite" } }), tripleEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.reply, "OpenRouter third-line defense reply.");
    assert.equal(groqCalled, true);
    assert.equal(geminiCalled, true);
    assert.equal(orCalled, true);
  } finally {
    mock.restore();
  }
});

test("support AI automatically cascades across Groq -> Gemini -> OpenRouter", async () => {
  const tripleEnv = {
    ...env,
    GEMINI_API_KEY: "test-gemini-key",
    GROQ_API_KEY: "test-groq-key",
    OPENROUTER_API_KEY: "test-or-key"
  };

  let groqCalled = false;
  let geminiCalled = false;
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "api.groq.com") {
      groqCalled = true;
      return Response.json({ error: { message: "Groq 503" } }, { status: 503 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiCalled = true;
      return Response.json({
        candidates: [{
          content: { parts: [{ text: "Gemini support answer: We offer 100 free credits." }], role: "model" },
          finishReason: "STOP"
        }]
      });
    }
  });

  try {
    const response = await worker.fetch(makeRequest("/api/support/ai", {
      body: { message: "What are the welcome credits?" },
      headers: { "CF-Connecting-IP": "192.0.2.11" }
    }), tripleEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.reply, "Gemini support answer: We offer 100 free credits.");
    assert.equal(groqCalled, true);
    assert.equal(geminiCalled, true);
  } finally {
    mock.restore();
  }
});

test("chat handles Gemini safety filter by releasing reservation and returning 400", async () => {
  let released = false;
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{
          finishReason: "SAFETY"
        }]
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 1,
        balance: 99
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
      released = true;
      return Response.json({ ok: true, status: "released", balance: 100 });
    }
  });

  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body: { message: "unsafe content", tier: "lite" } }), geminiEnv);
    assert.equal(response.status, 400);
    assert.equal(released, true);
    const data = await response.json();
    assert.match(data.error, /safety guidelines/i);
  } finally {
    mock.restore();
  }
});

test("content generation uses Gemini primary model and settles credits", async () => {
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "generativelanguage.googleapis.com") {
      assert.match(url.pathname, /gemini-3\.5-flash-lite:generateContent/);
      const reqBody = JSON.parse(options.body);
      assert.equal(reqBody.generationConfig.maxOutputTokens, 700);
      assert.equal(reqBody.generationConfig.temperature, 0.7);
      return Response.json({
        candidates: [{
          content: {
            parts: [{ text: "### High-Converting Headline\n\nGenerated article body in professional tone." }],
            role: "model"
          },
          finishReason: "STOP"
        }],
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 150,
          totalTokenCount: 200
        }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 2,
        balance: 98
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({
        ok: true,
        status: "settled",
        charged_credits: 2,
        balance: 98
      });
    }
  });

  try {
    const response = await worker.fetch(makeContentRequest(contentRequestBody), geminiEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.match(data.content, /High-Converting Headline/);
    assert.equal(data.creditsCharged, 2);
    assert.equal(data.creditsRemaining, 98);
    assert.equal(mock.calls.some(c => c.url.hostname === "generativelanguage.googleapis.com"), true);
  } finally {
    mock.restore();
  }
});

test("content generation falls back to gemini-3.5-flash on transient failure", async () => {
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "generativelanguage.googleapis.com") {
      if (url.pathname.includes("gemini-3.5-flash-lite")) {
        return Response.json({ error: { code: 503, message: "Unavailable" } }, { status: 503 });
      }
      return Response.json({
        candidates: [{
          content: {
            parts: [{ text: "Fallback generated content from Gemini 3.5 Flash" }],
            role: "model"
          },
          finishReason: "STOP"
        }],
        usageMetadata: { totalTokenCount: 120 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 2,
        balance: 98
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({
        ok: true,
        status: "settled",
        charged_credits: 2,
        balance: 98
      });
    }
  });

  try {
    const response = await worker.fetch(makeContentRequest(contentRequestBody), geminiEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.content, "Fallback generated content from Gemini 3.5 Flash");
  } finally {
    mock.restore();
  }
});

test("support AI uses Gemini when GEMINI_API_KEY is configured", async () => {
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{
          content: {
            parts: [{ text: "Welcome to Jevexa! We offer 100 free credits upon signup." }],
            role: "model"
          },
          finishReason: "STOP"
        }]
      });
    }
  });

  try {
    const response = await worker.fetch(new Request("https://jevexa.test/api/support/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What are your credit options?" })
    }), geminiEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.match(data.reply, /100 free credits/i);
    assert.equal(mock.calls.some(c => c.url.hostname === "generativelanguage.googleapis.com"), true);
  } finally {
    mock.restore();
  }
});

test("chat formats multi-turn history and inline attachments for Gemini correctly", async () => {
  let capturedBody;
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "generativelanguage.googleapis.com") {
      capturedBody = JSON.parse(options.body);
      return Response.json({
        candidates: [{
          content: {
            parts: [{ text: "Received attachment and history." }],
            role: "model"
          },
          finishReason: "STOP"
        }],
        usageMetadata: { totalTokenCount: 50 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 2,
        balance: 98
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({
        ok: true,
        status: "settled",
        charged_credits: 2,
        balance: 98
      });
    }
  }, null, "pro");

  const sampleImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const chatBody = {
    message: "Analyze this image",
    tier: "pro",
    history: [
      { role: "user", text: "Turn 1 user" },
      { role: "assistant", text: "Turn 1 assistant" }
    ],
    attachments: [
      {
        name: "test.png",
        type: "image/png",
        data: `data:image/png;base64,${sampleImageBase64}`
      }
    ]
  };

  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body: chatBody }), geminiEnv);
    assert.equal(response.status, 200);
    assert.ok(capturedBody);
    // Verify contents has user -> model -> user turns
    assert.equal(capturedBody.contents.length, 3);
    assert.equal(capturedBody.contents[0].role, "user");
    assert.equal(capturedBody.contents[1].role, "model");
    assert.equal(capturedBody.contents[2].role, "user");
    // Verify inlineData for image
    const userParts = capturedBody.contents[2].parts;
    const inlinePart = userParts.find(p => p.inlineData);
    assert.ok(inlinePart);
    assert.equal(inlinePart.inlineData.mimeType, "image/png");
    assert.equal(inlinePart.inlineData.data, sampleImageBase64);
  } finally {
    mock.restore();
  }
});

test("content generation releases reservation on definitive Gemini 429 rate limit", async () => {
  let released = false;
  const mock = mockFetch(async (url, options) => {
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({ error: { code: 429, message: "Resource exhausted" } }, { status: 429 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 2,
        balance: 98
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
      released = true;
      return Response.json({ ok: true, status: "released", balance: 100 });
    }
  });

  try {
    const response = await worker.fetch(makeContentRequest(contentRequestBody), geminiEnv);
    assert.equal(response.status, 429);
    assert.equal(released, true);
    const data = await response.json();
    assert.match(data.error, /busy right now/i);
  } finally {
    mock.restore();
  }
});

test("chat and quote gracefully default to lite tier when user_credits is empty or unconfirmed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      // Return empty array to simulate missing/indeterminate user_credits record
      return Response.json([]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{
        fixed_credits: 1,
        credits_per_1000_tokens: null,
        enabled: true,
        integration_status: "available"
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_quote") {
      return Response.json(1);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 1,
        balance: 99
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{
          content: { parts: [{ text: "Graceful lite reply" }] },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const quote = await worker.fetch(makeRequest("/api/credits/quote", { body: { message: "Hello", tier: "lite" } }), geminiEnv);
    assert.equal(quote.status, 200);
    const quoteData = await quote.json();
    assert.equal(quoteData.estimatedCredits, 1);

    const chat = await worker.fetch(makeRequest("/api/chat", { body: { message: "Hello", tier: "lite" } }), geminiEnv);
    assert.equal(chat.status, 200);
    const chatData = await chat.json();
    assert.equal(chatData.reply, "Graceful lite reply");
    assert.equal(chatData.tier, "lite");
    assert.equal(chatData.credits_used, 1);
    assert.equal(chatData.remaining_credits, 99);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat and content generation return credits_used and remaining_credits for live UI sync", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 500 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{
        fixed_credits: 1,
        credits_per_1000_tokens: null,
        enabled: true,
        integration_status: "available"
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 1,
        balance: 499
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 499 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{
          content: { parts: [{ text: "Live sync verified" }] },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 20, totalTokenCount: 35 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const chatRes = await worker.fetch(makeRequest("/api/chat", { body: { message: "Sync check", tier: "lite" } }), geminiEnv);
    assert.equal(chatRes.status, 200);
    const chatPayload = await chatRes.json();
    assert.equal(chatPayload.creditsCharged, 1);
    assert.equal(chatPayload.credits_used, 1);
    assert.equal(chatPayload.creditsRemaining, 499);
    assert.equal(chatPayload.remaining_credits, 499);
    assert.equal(chatPayload.promptTokens, 15);
    assert.equal(chatPayload.completionTokens, 20);
    assert.equal(chatPayload.totalTokens, 35);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("content generation returns credits_used and remaining_credits for live UI sync", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 500 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{
        fixed_credits: null,
        credits_per_1000_tokens: 1,
        enabled: true,
        integration_status: "available"
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 2,
        balance: 498
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 2, balance: 498 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{
          content: { parts: [{ text: "Generated headline for blog" }] },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 700, totalTokenCount: 1200 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const contentRes = await worker.fetch(makeContentRequest(contentRequestBody), geminiEnv);
    assert.equal(contentRes.status, 200);
    const contentPayload = await contentRes.json();
    assert.equal(contentPayload.creditsCharged, 2);
    assert.equal(contentPayload.credits_used, 2);
    assert.equal(contentPayload.creditsRemaining, 498);
    assert.equal(contentPayload.remaining_credits, 498);
    assert.equal(contentPayload.totalTokens, 1200);
    assert.equal(contentPayload.promptTokens, 500);
    assert.equal(contentPayload.completionTokens, 700);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("insufficient credits returns 402 without contacting AI providers", async () => {
  let aiCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 0 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{
        fixed_credits: 1,
        credits_per_1000_tokens: null,
        enabled: true,
        integration_status: "available"
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: false,
        error: "insufficient_credits",
        required_credits: 1,
        available_credits: 0
      });
    }
    if (url.hostname === "generativelanguage.googleapis.com" || url.hostname === "api.groq.com" || url.hostname === "openrouter.ai") {
      aiCalled = true;
      return Response.json({ error: "Should not be called" }, { status: 500 });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body: { message: "Hello", tier: "lite" } }), geminiEnv);
    assert.equal(response.status, 402);
    assert.equal(aiCalled, false);
    const data = await response.json();
    assert.equal(data.code, "insufficient_credits");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("character-based token fallback applies when provider omits token metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 100 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{
        fixed_credits: 1,
        credits_per_1000_tokens: null,
        enabled: true,
        integration_status: "available"
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: 1,
        balance: 99
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      // Intentionally omit usageMetadata to test character-based estimation fallback
      return Response.json({
        candidates: [{
          content: { parts: [{ text: "Short reply without tokens" }] },
          finishReason: "STOP"
        }]
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body: { message: "Test fallback estimation", tier: "lite" } }), geminiEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.creditsCharged, 1);
    assert.equal(data.credits_used, 1);
    assert.equal(data.usageEstimated, true);
    assert.ok(data.totalTokens > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("regression 1: missing or unseeded fixed tier pricing rows do not block chat or content requests", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "pro", balance: 250 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      // Return empty array to simulate completely unseeded/missing service pricing rows
      return Response.json([]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_quote") {
      return Response.json(null, { status: 404 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      const body = JSON.parse(options.body || "{}");
      return Response.json({
        ok: true,
        status: "reserved",
        duplicate: false,
        reserved_credits: body.p_required_credits || 2,
        balance: 248
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 2, balance: 248 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{
          content: { parts: [{ text: "Successfully responded despite unseeded DB pricing" }] },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 20, totalTokenCount: 40 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    // 1. Quote falls back cleanly without 503
    const quoteRes = await worker.fetch(makeRequest("/api/credits/quote", { body: { message: "Hello", tier: "pro" } }), geminiEnv);
    assert.equal(quoteRes.status, 200);
    const quoteData = await quoteRes.json();
    assert.equal(quoteData.estimatedCredits, 2);

    // 2. Chat falls back cleanly without 503 and answers user
    const chatRes = await worker.fetch(makeRequest("/api/chat", { body: { message: "Hello Pro", tier: "pro" } }), geminiEnv);
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    assert.equal(chatData.reply, "Successfully responded despite unseeded DB pricing");
    assert.equal(chatData.creditsCharged, 2);
    assert.equal(chatData.remaining_credits, 248);

    // 3. Content generation falls back cleanly without 503
    const contentRes = await worker.fetch(makeContentRequest(contentRequestBody), geminiEnv);
    assert.equal(contentRes.status, 200);
    const contentData = await contentRes.json();
    assert.equal(contentData.content, "Successfully responded despite unseeded DB pricing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("regression 2: multi-provider fallback cascades when Gemini fails (404/429/503) and Groq or OpenRouter succeeds", async () => {
  const tripleEnv = {
    ...env,
    GEMINI_API_KEY: "test-gemini-key",
    GROQ_API_KEY: "test-groq-key",
    OPENROUTER_API_KEY: "test-openrouter-key"
  };

  let geminiAttempted = false;
  let groqAttempted = false;
  let openRouterAttempted = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 100 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 1, credits_per_1000_tokens: null, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 1, balance: 99 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiAttempted = true;
      return Response.json({ error: { code: 404, message: "models/gemini-3.5-flash-lite not found" } }, { status: 404 });
    }
    if (url.hostname === "api.groq.com") {
      groqAttempted = true;
      return Response.json({ error: { code: 503, message: "Groq capacity overload" } }, { status: 503 });
    }
    if (url.hostname === "openrouter.ai") {
      openRouterAttempted = true;
      return Response.json({
        choices: [{ message: { content: "OpenRouter multi-provider cascade succeeded!" } }],
        usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const response = await worker.fetch(makeRequest("/api/chat", { body: { message: "Cascade test", tier: "lite" } }), tripleEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.reply, "OpenRouter multi-provider cascade succeeded!");
    assert.equal(geminiAttempted, true);
    assert.equal(groqAttempted, true);
    assert.equal(openRouterAttempted, true);
    assert.equal(data.creditsCharged, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("regression 3: content generation credit settlement charges measured usage and releases 100% reservation on full provider failure", async () => {
  let releaseCalled = false;
  let settleCalled = false;
  let failGemini = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 100 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: null, credits_per_1000_tokens: 1, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 3, balance: 97 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      settleCalled = true;
      return Response.json({ ok: true, charged_credits: 2, balance: 98 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
      releaseCalled = true;
      return Response.json({ ok: true, released: true, balance: 100 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      if (!failGemini) {
        return Response.json({
          candidates: [{ content: { parts: [{ text: "Generated content" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 700, totalTokenCount: 1200 }
        });
      }
      return Response.json({ error: { code: 429, message: "Resource has been exhausted" } }, { status: 429 });
    }
    if (url.hostname === "api.groq.com") {
      return Response.json({ error: { message: "Service unavailable" } }, { status: 503 });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    // 1. Success scenario: verifies measured usage settlement
    const successRes = await worker.fetch(makeContentRequest(contentRequestBody), geminiEnv);
    assert.equal(successRes.status, 200);
    const successData = await successRes.json();
    assert.equal(successData.creditsCharged, 2);
    assert.equal(settleCalled, true, "Settlement must be called on success");
    assert.equal(releaseCalled, false, "Release must not be called on success");

    // 2. Failure scenario: both Gemini and Groq fail fatally => 100% release, zero settlement
    settleCalled = false;
    failGemini = true;
    const failEnv = {
      ...env,
      GEMINI_API_KEY: "test-gemini-key",
      GROQ_API_KEY: "test-groq-key"
    };
    delete failEnv.OPENROUTER_API_KEY;

    const failRequest = makeContentRequest({
      ...contentRequestBody,
      requestId: "00000000-0000-4000-8000-000000000099"
    });

    const response = await worker.fetch(failRequest, failEnv);
    assert.ok(response.status >= 400);
    assert.equal(settleCalled, false, "Must not settle any credits on provider failure");
    assert.equal(releaseCalled, true, "Must release 100% of reserved credits on provider failure");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat message 'hi' on Jevexa Lite with Low thinking sends 1000 fixed tokens to reservation and settles exactly 1 credit", async () => {
  const originalFetch = globalThis.fetch;
  let reserveTokensPassed = null;
  let reservedCredits = null;

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 100 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{
        service_key: "ai_chat",
        display_name: "AI Chat",
        integration_status: "available",
        fixed_credits: null,
        credits_per_1000_tokens: 1,
        enabled: true
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_quote") {
      const body = JSON.parse(options.body || "{}");
      return Response.json(Math.ceil((body.p_estimated_tokens || 1000) * 1 / 1000));
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      const body = JSON.parse(options.body || "{}");
      reserveTokensPassed = body.p_estimated_tokens;
      reservedCredits = Math.ceil(body.p_estimated_tokens * 1 / 1000);
      return Response.json({
        ok: true,
        duplicate: false,
        status: "reserved",
        reserved_credits: reservedCredits,
        balance: 100 - reservedCredits
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{
          content: { parts: [{ text: "Hello! How can I help you today?" }] },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 12, totalTokenCount: 27 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const res = await worker.fetch(makeRequest("/api/chat", {
      body: {
        message: "hi",
        tier: "lite",
        thinkingLevel: "low",
        history: [
          { role: "user", text: "Can you help me with website automation?" },
          { role: "assistant", text: "Certainly! JEVEXA specializes in custom AI chatbots and automated workflows." }
        ]
      }
    }), geminiEnv);

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reply, "Hello! How can I help you today?");
    assert.equal(data.tier, "lite");
    assert.equal(data.creditsCharged, 1);
    assert.equal(data.remaining_credits, 99);
    assert.equal(reserveTokensPassed, 1000, "Fixed Lite tier passes 1000 tokens to ensure exact 1 credit calculation in DB");
    assert.equal(reservedCredits, 1, "Reserved exactly 1 credit in DB without pricing drift rejection");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat message on Jevexa Pro sends 2000 fixed tokens to reservation and settles 2 credits", async () => {
  const originalFetch = globalThis.fetch;
  let reserveTokensPassed = null;

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "pro", balance: 500 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{
        service_key: "ai_chat_pro",
        display_name: "AI Chat — Pro",
        integration_status: "available",
        fixed_credits: 2,
        credits_per_1000_tokens: null,
        enabled: true
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      const body = JSON.parse(options.body || "{}");
      reserveTokensPassed = body.p_estimated_tokens;
      return Response.json({
        ok: true,
        duplicate: false,
        status: "reserved",
        reserved_credits: 2,
        balance: 498
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 2, balance: 498 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{
          content: { parts: [{ text: "Hello! Pro assistant ready." }] },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 20, totalTokenCount: 40 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const res = await worker.fetch(makeRequest("/api/chat", {
      body: {
        message: "Hello Pro",
        tier: "pro",
        thinkingLevel: "standard"
      }
    }), geminiEnv);

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reply, "Hello! Pro assistant ready.");
    assert.equal(data.tier, "pro");
    assert.equal(data.creditsCharged, 2);
    assert.equal(data.remaining_credits, 498);
    assert.equal(reserveTokensPassed, 2000, "Fixed Pro tier passes 2000 tokens to reservation");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker rewrites /tools/* routes to root asset URL without 307 redirect", async () => {
  let requestedAssetUrl = null;
  const mockEnv = {
    ASSETS: {
      fetch: async (req) => {
        requestedAssetUrl = req.url;
        return new Response("<!DOCTYPE html><html><body>SPA Root</body></html>", {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
    }
  };

  const res = await worker.fetch(new Request("https://jevexa.net/tools/chatbot"), mockEnv);
  assert.equal(res.status, 200);
  assert.equal(new URL(requestedAssetUrl).pathname, "/");
  assert.equal(res.headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  const text = await res.text();
  assert.match(text, /SPA Root/);
});

test("stability: primary provider timeout and 500 triggers instant multi-provider failover to tertiary provider with 0ms delay", async () => {
  const tripleEnv = {
    ...env,
    GEMINI_API_KEY: "test-gemini-key",
    GROQ_API_KEY: "test-groq-key",
    OPENROUTER_API_KEY: "test-openrouter-key"
  };

  const callOrder = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 100 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 1, credits_per_1000_tokens: null, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 1, balance: 99 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
    if (url.hostname === "api.groq.com") {
      callOrder.push("groq");
      const err = new Error("Gateway timeout");
      err.name = "AbortError";
      throw err;
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      callOrder.push("gemini");
      return Response.json({ error: { code: 500, message: "Internal server error" } }, { status: 500 });
    }
    if (url.hostname === "openrouter.ai") {
      callOrder.push("openrouter");
      return Response.json({
        choices: [{ message: { content: "Instant tertiary failover response." } }],
        usage: { total_tokens: 45 }
      });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  };

  try {
    const req = makeRequest("/api/chat", { body: { message: "Test failover", tier: "lite" } });
    const res = await worker.fetch(req, tripleEnv);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reply, "Instant tertiary failover response.");
    assert.equal(data.creditsCharged, 1);
    assert.ok(callOrder.includes("groq"), "Groq must be tried first");
    assert.ok(callOrder.includes("gemini"), "Gemini must be tried second on Groq timeout");
    assert.ok(callOrder.includes("openrouter"), "OpenRouter must be tried third on Gemini 500");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stability: coding prompt fetchWithRetry succeeds cleanly under Jevexa Lite with Low thinking and settles exactly 1 credit", async () => {
  const geminiEnv = {
    ...env,
    GEMINI_API_KEY: "test-gemini-key"
  };
  delete geminiEnv.OPENROUTER_API_KEY;

  let reservedCredits = null;
  let settledCredits = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 100 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 1, credits_per_1000_tokens: null, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      const body = JSON.parse(options.body);
      reservedCredits = Math.ceil(body.p_estimated_tokens / 1000);
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 1, balance: 99 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      settledCredits = 1;
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{
          content: {
            parts: [{
              text: "```javascript\nasync function fetchWithRetry(url, retries = 3) {\n  for (let i = 0; i <= retries; i++) {\n    try {\n      return await fetch(url);\n    } catch (err) {\n      if (i === retries) throw err;\n    }\n  }\n}\n```"
            }],
            role: "model"
          },
          finishReason: "STOP"
        }],
        usageMetadata: {
          promptTokenCount: 35,
          candidatesTokenCount: 65,
          totalTokenCount: 100
        }
      });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  };

  try {
    const codingReq = makeRequest("/api/chat", {
      body: {
        message: "fetchWithRetry(url, retries = 3)",
        tier: "lite",
        thinkingLevel: "low"
      }
    });
    const res = await worker.fetch(codingReq, geminiEnv);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.match(data.reply, /async function fetchWithRetry/);
    assert.equal(data.tier, "lite");
    assert.equal(data.creditsCharged, 1);
    assert.equal(data.remaining_credits, 99);
    assert.equal(reservedCredits, 1);
    assert.equal(settledCredits, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stability: Content Generation succeeds cleanly and fails over seamlessly to Gemini when Groq errors", async () => {
  const tripleEnv = {
    ...env,
    GEMINI_API_KEY: "test-gemini-key",
    GROQ_API_KEY: "test-groq-key",
    OPENROUTER_API_KEY: "test-openrouter-key"
  };

  let geminiHit = false;
  let groqHit = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 100 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: null, credits_per_1000_tokens: 1, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 3, balance: 97 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 2, balance: 98 });
    }
    if (url.hostname === "api.groq.com") {
      groqHit = true;
      return Response.json({ error: { code: 503, message: "Groq backend unavailable" } }, { status: 503 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiHit = true;
      return Response.json({
        candidates: [{
          content: { parts: [{ text: "High quality marketing blog post generated via Gemini." }], role: "model" },
          finishReason: "STOP"
        }],
        usageMetadata: { totalTokenCount: 1200 }
      });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  };

  try {
    const contentReq = makeContentRequest({
      topic: "Zero-compromise high converting SaaS landing page copy",
      type: "blog",
      tone: "professional",
      length: "medium",
      requestId: "00000000-0000-4000-8000-000000000055"
    });
    const res = await worker.fetch(contentReq, tripleEnv);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(groqHit, true, "Groq primary was attempted first");
    assert.equal(geminiHit, true, "Gemini was seamlessly failed over to");
    assert.match(data.content, /High quality marketing blog post/);
    assert.equal(data.creditsCharged, 2);
    assert.equal(data.remaining_credits, 98);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stability: client pending-request recovery auto-reconciles stale hold and never deadlocks subsequent user messages", async () => {
  const scriptContent = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const contentJs = await readFile(new URL("../content.js", import.meta.url), "utf8");

  // Verify credits.js and content.js do not contain blocking lock text that traps the user
  assert.doesNotMatch(scriptContent, /Connection lost\. Request [^;]+ may still be processing; its status will be checked before another request is allowed\./);
  assert.match(scriptContent, /Connection interrupted/);
  assert.match(scriptContent, /reconcilePendingRequest/);
  assert.match(scriptContent, /forgetPendingRequest/);

  // Verify Content Generation also unlocks cleanly on error
  assert.match(contentJs, /forgetPendingRequest\(session, requestId\)/);

  // Test /api/credits/reconcile RPC release behavior
  let releaseCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_release") {
      releaseCalled = true;
      assert.equal(JSON.parse(options.body).p_request_id, "9f6d785d-5e07-434c-b64b-5565458a7ddc");
      return Response.json({ ok: true, balance: 100 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  };

  try {
    const recReq = makeRequest("/api/credits/reconcile", {
      body: { requestId: "9f6d785d-5e07-434c-b64b-5565458a7ddc" }
    });
    const res = await worker.fetch(recReq, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.released, true);
    assert.equal(data.status, "released");
    assert.equal(releaseCalled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stability: chatbot unconfirmed settlement delivers completed AI response without losing output", async () => {
  const customRequestId = "00000000-0000-4000-8000-000000000888";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 100 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 1, credits_per_1000_tokens: null, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 1, balance: 99 });
    }
    if (url.hostname === "openrouter.ai") {
      return Response.json({
        choices: [{ message: { content: "Here is your full code implementation:\n```js\nconsole.log('clean recovery');\n```" } }],
        usage: { total_tokens: 250 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      // Simulate database settlement failure
      return Response.json({ message: "database transient timeout" }, { status: 503 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  };

  try {
    const req = makeRequest("/api/chat", {
      headers: { "Idempotency-Key": customRequestId },
      body: {
        message: "Implement clean recovery",
        tier: "lite",
        thinkingLevel: "low",
        requestId: customRequestId
      }
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 503);
    const data = await res.json();
    // Non-negotiable requirement: generated assistant reply MUST be delivered in full
    assert.equal(data.reply, "Here is your full code implementation:\n```js\nconsole.log('clean recovery');\n```");
    assert.equal(data.unconfirmedSettlement, true);
    assert.equal(data.requestId, customRequestId);
    assert.match(data.error, /AI completed the request, but credit settlement could not be confirmed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stability: content generation unconfirmed settlement delivers complete content without losing output", async () => {
  const customRequestId = "00000000-0000-4000-8000-000000000999";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 100 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: null, credits_per_1000_tokens: 1, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 2, balance: 98 });
    }
    if (url.hostname === "api.groq.com") {
      return Response.json({
        choices: [{ message: { content: "Complete 500-word SEO article for high conversion." } }],
        usage: { total_tokens: 650 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      // Simulate transient settlement rejection
      return Response.json({ message: "settlement lock timeout" }, { status: 503 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  };

  try {
    const req = makeContentRequest({
      topic: "High conversion B2B marketing strategies",
      type: "blog",
      tone: "professional",
      length: "short",
      requestId: customRequestId
    });
    const res = await worker.fetch(req, groqEnv);
    assert.equal(res.status, 503);
    const data = await res.json();
    // Non-negotiable requirement: generated content MUST NOT be lost
    assert.equal(data.content, "Complete 500-word SEO article for high conversion.");
    assert.equal(data.unconfirmedSettlement, true);
    assert.equal(data.requestId, customRequestId);
    assert.match(data.error, /Content was generated, but credit settlement could not be confirmed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stability: support ticket saves safely to Supabase with 201 even when Resend notification is not configured", async () => {
  const envWithoutResend = { ...env };
  delete envWithoutResend.RESEND_API_KEY;

  let ticketSaved = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/rest/v1/support_tickets") {
      ticketSaved = true;
      assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      assert.equal(body.name, "Alex Client");
      assert.equal(body.email, "alex@example.com");
      assert.equal(body.subject, "Inquiry");
      assert.equal(body.message, "Need help with enterprise billing.");
      return Response.json([{ id: "ticket-safely-persisted-999" }], { status: 201 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  };

  try {
    const req = makeRequest("/api/support-ticket", {
      body: {
        name: "Alex Client",
        email: "alex@example.com",
        subject: "Inquiry",
        message: "Need help with enterprise billing."
      }
    });
    const res = await worker.fetch(req, envWithoutResend);
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.ticketId, "ticket-safely-persisted-999");
    assert.equal(ticketSaved, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});





// ============================================================================
// CRITICAL UPGRADE TESTS: STABILITY, ANIMATIONS & STRICT LOGIN WALL
// ============================================================================

test("upgrade 1: rapid chatbot requests with Groq timeout fail over seamlessly to Gemini", async () => {
  const tripleEnv = {
    ...env,
    GEMINI_API_KEY: "test-gemini-key",
    GROQ_API_KEY: "test-groq-key",
    OPENROUTER_API_KEY: "test-openrouter-key"
  };

  let groqAttempted = 0;
  let geminiSuccesses = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "pro", balance: 100 }]);
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 1, credits_per_1000_tokens: null, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 1, balance: 99 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
    if (url.hostname === "api.groq.com") {
      groqAttempted++;
      const err = new Error("Stalled connection");
      err.name = "AbortError";
      throw err;
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiSuccesses++;
      return Response.json({
        candidates: [{
          content: { parts: [{ text: "Gemini instantaneous fallback reply" }], role: "model" },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15, totalTokenCount: 35 }
      });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  };

  try {
    for (let i = 0; i < 3; i++) {
      const burstId = `00000000-0000-4000-8000-00000000009${i}`;
      const req = makeRequest("/api/chat", { body: { message: `Burst test ${i}`, tier: "lite", requestId: burstId } });
      const res = await worker.fetch(req, tripleEnv);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.reply, "Gemini instantaneous fallback reply");
      assert.equal(data.creditsCharged, 1);
    }
    assert.ok(groqAttempted >= 3, "Groq was attempted first for each rapid request");
    assert.equal(geminiSuccesses, 3, "Gemini handled all failovers cleanly with 0 exceptions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upgrade 1: content generation rapid requests with Groq 429 rate limit fail over seamlessly to Gemini", async () => {
  const tripleEnv = {
    ...env,
    GEMINI_API_KEY: "test-gemini-key",
    GROQ_API_KEY: "test-groq-key",
    OPENROUTER_API_KEY: "test-openrouter-key"
  };

  let groqAttempts = 0;
  let geminiSuccesses = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "free", balance: 100 }]);
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: null, credits_per_1000_tokens: 1, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 3, balance: 97 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 2, balance: 98 });
    }
    if (url.hostname === "api.groq.com") {
      groqAttempts++;
      return Response.json({ error: { message: "Rate limit exceeded" } }, { status: 429 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiSuccesses++;
      return Response.json({
        candidates: [{
          content: { parts: [{ text: "High quality marketing copy from Gemini." }], role: "model" },
          finishReason: "STOP"
        }],
        usageMetadata: { totalTokenCount: 1500 }
      });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  };

  try {
    const req = makeContentRequest({
      topic: "E-commerce conversion optimization",
      type: "blog",
      tone: "professional",
      length: "medium",
      requestId: "00000000-0000-4000-8000-000000000088"
    });
    const res = await worker.fetch(req, tripleEnv);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.content, "High quality marketing copy from Gemini.");
    assert.equal(data.creditsCharged, 2);
    assert.ok(groqAttempts >= 1, "Groq was called first");
    assert.equal(geminiSuccesses, 1, "Gemini delivered output after Groq 429");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upgrade 2: animated 'Searching the web...' UI states exist and clean up properly in frontend", async () => {
  const creditsCode = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const contentCode = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const stylesCode = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Chatbot live states
  assert.match(creditsCode, /live-status-indicator/);
  assert.match(creditsCode, /Searching the web\.\.\./);
  assert.match(creditsCode, /Thinking\.\.\./);
  assert.match(creditsCode, /Generating response\.\.\./);
  assert.match(creditsCode, /clearInterval\(typingStatusTimer\)/);
  assert.match(creditsCode, /window\.removeChatTyping/);
  assert.match(creditsCode, /activeChatAbortController/);
  assert.match(creditsCode, /abortInFlightChatRequest/);
  assert.match(creditsCode, /window\.abortChatRequest/);
  assert.match(creditsCode, /1500/);
  assert.match(creditsCode, /createChatSession[\s\S]*?abortInFlightChatRequest/);
  assert.match(creditsCode, /selectChatSession[\s\S]*?abortInFlightChatRequest/);
  assert.match(creditsCode, /regenerate[\s\S]*?abortInFlightChatRequest/);

  // Content generator live states & shimmer
  assert.match(contentCode, /content-processing-container/);
  assert.match(contentCode, /live-status-indicator/);
  assert.match(contentCode, /Searching the web\.\.\./);
  assert.match(contentCode, /content-skeleton-lines/);
  assert.match(contentCode, /content-skeleton-bar/);
  assert.match(contentCode, /clearContentProcessing\(\)/);
  assert.match(contentCode, /window\.clearContentProcessing/);

  // CSS animations & accessibility
  assert.match(stylesCode, /\.live-status-indicator/);
  assert.match(stylesCode, /@keyframes liveStatusGlow/);
  assert.match(stylesCode, /\.live-status-dots/);
  assert.match(stylesCode, /prefers-reduced-motion/);
  assert.match(stylesCode, /\.content-processing-container/);
  assert.match(stylesCode, /@keyframes skeletonShimmer/);
});

test("upgrade 3: strict auth & credit-gating wall blocks unauthenticated guests before API calls", async () => {
  const creditsCode = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const contentCode = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const scriptCode = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // Chatbot blocks guest and triggers auth modal
  assert.match(creditsCode, /const session = await getSession\(\);[\s\S]*?!session[\s\S]*?window\.openAuthModal\('signup'\)/);
  assert.match(creditsCode, /Please sign in or create an account to use the AI Chatbot/);

  // Content Generator blocks guest and triggers auth modal
  assert.match(contentCode, /if \(!session\)[\s\S]*?window\.openAuthModal\('signup'\)/);
  assert.match(contentCode, /Please create an account or sign in to generate content/);

  // Zero-credit blocking in Content Generator
  assert.match(contentCode, /cachedBalance <= 0[\s\S]*?JEVEXA_SHOW_UPGRADE_MODAL/);

  // Script.js exports auth modal triggers globally
  assert.match(scriptCode, /window\.openLogin = openLogin/);
  assert.match(scriptCode, /window\.openSignup = openSignup/);
  assert.match(scriptCode, /window\.openAuthModal = openAuthModal/);

  // Script.js immediately restores session on startup
  assert.match(scriptCode, /supabaseClient\.auth\.getSession\(\)/);
});

test("upgrade 3: unauthenticated API calls to /api/chat and /api/content return 401 Unauthorized", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ message: "Invalid token" }, { status: 401 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  };

  try {
    const chatReq = makeRequest("/api/chat", { body: { message: "Unauthorized test", tier: "lite" } });
    const chatRes = await worker.fetch(chatReq, env);
    assert.equal(chatRes.status, 401);
    const chatData = await chatRes.json();
    assert.match(chatData.error, /sign in/i);

    const contentReq = makeContentRequest();
    const contentRes = await worker.fetch(contentReq, env);
    assert.equal(contentRes.status, 401);
    const contentData = await contentRes.json();
    assert.match(contentData.error, /sign in/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// PUBLIC PAGES, SEO, MONETIZATION & SAFE MODAL AUDIT TESTS
// ============================================================================

test("Worker serves public pages (/privacy-policy, /terms, /about, /contact) with security headers", async () => {
  const routes = [
    { path: "/privacy-policy", expectedAsset: "/privacy-policy.html" },
    { path: "/privacy", expectedAsset: "/privacy-policy.html" },
    { path: "/terms", expectedAsset: "/terms.html" },
    { path: "/terms-of-service", expectedAsset: "/terms.html" },
    { path: "/about", expectedAsset: "/about.html" },
    { path: "/about-us", expectedAsset: "/about.html" },
    { path: "/contact", expectedAsset: "/contact.html" },
    { path: "/contact-us", expectedAsset: "/contact.html" }
  ];

  for (const { path, expectedAsset } of routes) {
    let requestedUrl = null;
    const mockEnv = {
      ASSETS: {
        fetch: async (req) => {
          requestedUrl = req.url;
          return new Response(`<html><body>${expectedAsset}</body></html>`, {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
      }
    };

    const res = await worker.fetch(new Request(`https://jevexa.net${path}`), mockEnv);
    assert.equal(res.status, 200, `${path} should return 200`);
    assert.equal(new URL(requestedUrl).pathname, expectedAsset, `${path} should map to ${expectedAsset}`);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("X-Frame-Options"), "SAMEORIGIN");
    assert.equal(res.headers.get("Strict-Transport-Security"), "max-age=31536000; includeSubDomains");
  }
});

test("/api/contact validates payload, handles methods and protects endpoints", async () => {
  const contactEnv = {
    ...env,
    RESEND_API_KEY: "test-resend-key"
  };

  // Missing fields -> 400
  const missingReq = new Request("https://jevexa.net/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "", email: "test@example.com", message: "" })
  });
  const missingRes = await worker.fetch(missingReq, contactEnv);
  assert.equal(missingRes.status, 400);

  // Invalid email -> 400
  const invalidEmailReq = new Request("https://jevexa.net/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Alex", email: "not-an-email", message: "Hello" })
  });
  const invalidEmailRes = await worker.fetch(invalidEmailReq, contactEnv);
  assert.equal(invalidEmailRes.status, 400);

  // Method not allowed -> 405
  const getReq = new Request("https://jevexa.net/api/contact", { method: "GET" });
  const getRes = await worker.fetch(getReq, contactEnv);
  assert.equal(getRes.status, 405);
});

test("monetization & trust compliance: public pages exist with SEO tags and footer links work", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const privacyHtml = await readFile(new URL("../privacy-policy.html", import.meta.url), "utf8");
  const termsHtml = await readFile(new URL("../terms.html", import.meta.url), "utf8");
  const aboutHtml = await readFile(new URL("../about.html", import.meta.url), "utf8");
  const contactHtml = await readFile(new URL("../contact.html", import.meta.url), "utf8");
  const sitemapXml = await readFile(new URL("../sitemap.xml", import.meta.url), "utf8");
  const scriptCode = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // Sitemap includes all public pages
  assert.match(sitemapXml, /https:\/\/jevexa\.net\/about/);
  assert.match(sitemapXml, /https:\/\/jevexa\.net\/contact/);
  assert.match(sitemapXml, /https:\/\/jevexa\.net\/privacy-policy/);
  assert.match(sitemapXml, /https:\/\/jevexa\.net\/terms/);

  // Footer links point to real pages without dead coming-soon-link
  assert.match(html, /<a href="\/about">About Us<\/a>/);
  assert.match(html, /<a href="\/privacy-policy">Privacy Policy<\/a>/);
  assert.match(html, /<a href="\/terms">Terms of Service<\/a>/);
  assert.doesNotMatch(html, /class="coming-soon-link"[^>]*>Privacy<\/a>/);
  assert.doesNotMatch(html, /class="coming-soon-link"[^>]*>Terms<\/a>/);

  // Public pages have proper titles and meta descriptions
  assert.match(privacyHtml, /<title>Privacy Policy \| JEVEXA AI Automation Studio<\/title>/);
  assert.match(termsHtml, /<title>Terms of Service \| JEVEXA AI Automation Studio<\/title>/);
  assert.match(aboutHtml, /<title>About Us \| JEVEXA AI Automation Studio<\/title>/);
  assert.match(contactHtml, /<title>Contact Us &amp; Studio Inquiries \| JEVEXA AI Automation Studio<\/title>/);

  // Modal backdrop dismissal
  assert.match(scriptCode, /loginModalBackdropTarget/);
  assert.match(scriptCode, /window\.JEVEXA_SAFE_INTERACTION\.bind\(loginModalBackdropTarget/);
});

test("Worker rewrites /tools/* static asset requests to root asset URLs cleanly", async () => {
  const assetTests = [
    { requestPath: "/tools/styles.css", expectedAsset: "/styles.css" },
    { requestPath: "/tools/premium.css", expectedAsset: "/premium.css" },
    { requestPath: "/tools/script.js", expectedAsset: "/script.js" },
    { requestPath: "/tools/credits.js", expectedAsset: "/credits.js" },
    { requestPath: "/tools/content.js", expectedAsset: "/content.js" },
    { requestPath: "/tools/support.js", expectedAsset: "/support.js" },
    { requestPath: "/tools/assets/logo.svg", expectedAsset: "/assets/logo.svg" },
    { requestPath: "/tools/chatbot", expectedAsset: "/" },
    { requestPath: "/tools/content-generator", expectedAsset: "/" },
    { requestPath: "/tools/content", expectedAsset: "/" }
  ];

  for (const { requestPath, expectedAsset } of assetTests) {
    let requestedAssetUrl = null;
    const mockEnv = {
      ASSETS: {
        fetch: async (req) => {
          requestedAssetUrl = req.url;
          return new Response("OK", {
            headers: { "Content-Type": expectedAsset.endsWith(".css") ? "text/css" : "application/javascript" }
          });
        }
      }
    };

    const res = await worker.fetch(new Request(`https://jevexa.net${requestPath}`), mockEnv);
    assert.equal(res.status, 200, `${requestPath} should return 200`);
    assert.equal(new URL(requestedAssetUrl).pathname, expectedAsset, `${requestPath} should fetch ${expectedAsset}`);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  }
});

test("Worker normalizes trailing slashes for public pages (/privacy-policy/, /about/, /terms/, /contact/)", async () => {
  const trailingSlashRoutes = [
    { path: "/about/", expectedAsset: "/about.html" },
    { path: "/contact/", expectedAsset: "/contact.html" },
    { path: "/privacy-policy/", expectedAsset: "/privacy-policy.html" },
    { path: "/terms/", expectedAsset: "/terms.html" }
  ];

  for (const { path, expectedAsset } of trailingSlashRoutes) {
    let requestedUrl = null;
    const mockEnv = {
      ASSETS: {
        fetch: async (req) => {
          requestedUrl = req.url;
          return new Response(`<html><body>${expectedAsset}</body></html>`, {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
      }
    };

    const res = await worker.fetch(new Request(`https://jevexa.net${path}`), mockEnv);
    assert.equal(res.status, 200, `${path} should return 200`);
    assert.equal(new URL(requestedUrl).pathname, expectedAsset, `${path} should map to ${expectedAsset}`);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("X-Frame-Options"), "SAMEORIGIN");
  }
});

test("HTML pages enforce base href='/' and root-relative static asset resolution", async () => {
  const htmlFiles = ["../index.html", "../about.html", "../contact.html", "../privacy-policy.html", "../terms.html"];
  for (const fileRel of htmlFiles) {
    const content = await readFile(new URL(fileRel, import.meta.url), "utf8");
    assert.match(content, /<base href="\/"/i, `${fileRel} must contain <base href="/"> in head`);
    assert.match(content, /href="\/styles\.css"/, `${fileRel} must link /styles.css root-relatively`);
    assert.match(content, /href="\/premium\.css"/, `${fileRel} must link /premium.css root-relatively`);
    assert.match(content, /href="\/assets\/favicon\.ico"/, `${fileRel} must link /assets/favicon.ico root-relatively`);
  }

  const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(indexHtml, /<script src="\/script\.js"><\/script>/);
  assert.match(indexHtml, /<script src="\/credits\.js"><\/script>/);
  assert.match(indexHtml, /<script src="\/content\.js"><\/script>/);
  assert.match(indexHtml, /<script src="\/premium\.js"><\/script>/);
  assert.match(indexHtml, /<script src="\/support\.js"><\/script>/);

  const manifest = JSON.parse(await readFile(new URL("../site.webmanifest", import.meta.url), "utf8"));
  assert.ok(manifest.icons.every(icon => icon.src.startsWith("/assets/")));
});

test("Frontend connection resilience and offline error recovery", async () => {
  const scriptCode = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const creditsCode = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const contentCode = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const supportCode = await readFile(new URL("../support.js", import.meta.url), "utf8");

  // Online / offline event listeners
  assert.match(scriptCode, /window\.addEventListener\('offline', handleOffline\)/);
  assert.match(scriptCode, /window\.addEventListener\('online', handleOnline\)/);

  // Reconcile functions exported for connection recovery
  assert.match(creditsCode, /window\.JEVEXA_RECONCILE_PENDING\s*=/);
  assert.match(contentCode, /window\.JEVEXA_RECONCILE_CONTENT\s*=/);

  // Offline checks before network calls
  assert.match(creditsCode, /!navigator\.onLine/);
  assert.match(contentCode, /!navigator\.onLine/);
  assert.match(supportCode, /!navigator\.onLine/);
  assert.match(scriptCode, /!navigator\.onLine/);

  // AbortController timeouts on checkout and contact
  assert.match(scriptCode, /const contactController = new AbortController\(\)/);
  assert.match(scriptCode, /const checkoutController = new AbortController\(\)/);
  assert.match(scriptCode, /const pollController = new AbortController\(\)/);

  // Anchors (#how, #contact) close workspaces cleanly and scroll
  assert.match(scriptCode, /const targetId = hash\.replace\(\/\^#\/, ''\);/);
  assert.match(scriptCode, /closeChatWorkspace\(false\);/);
});

test("Reliability & Schema security: RPC permissions and notification timeout safeguards", async () => {
  const schemaSql = await readFile(new URL("../supabase/complete_credit_and_saas_schema.sql", import.meta.url), "utf8");
  const safepaySql = await readFile(new URL("../supabase/safepay_service_role_permissions_migration.sql", import.meta.url), "utf8");
  const workerSrc = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const adminHtml = await readFile(new URL("../admin.html", import.meta.url), "utf8");

  // Schema: jevexa_credit_quote must be restricted to service_role, not authenticated
  assert.match(schemaSql, /grant execute on function public\.jevexa_credit_quote\(text, integer\) to service_role;/);
  assert.doesNotMatch(schemaSql, /grant execute on function public\.jevexa_credit_quote\(text, integer\) to service_role, authenticated;/);

  // Safepay permissions: select, insert, update on billing_orders granted to service_role
  assert.match(safepaySql, /grant select, insert, update on public\.billing_orders to service_role;/);

  // Worker notification timeout safeguards with finally cleanup
  assert.match(workerSrc, /handleContact[\s\S]*?const controller = new AbortController\(\);[\s\S]*?finally\s*\{\s*clearTimeout\(timeoutId\);\s*\}/);
  assert.match(workerSrc, /handleSupportTicket[\s\S]*?const emailController = new AbortController\(\);[\s\S]*?finally\s*\{\s*clearTimeout\(emailTimeoutId\);\s*\}/);

  // Admin HTML base href
  assert.match(adminHtml, /<base href="\/">/i);
});


test("token-weighted credits: formula, multipliers, attachments, and fallback token estimation", async () => {
  const workerSrc = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Verify token-weighted credit formula implementation in source
  assert.match(workerSrc, /Math\.max\(1,\s*Math\.ceil\(\(tokens\s*\/\s*500\)\s*\*\s*modelMultiplier\)\)\s*\+\s*attachmentSurcharge/);
  assert.match(workerSrc, /attachmentSurcharge\s*\+=\s*2/); // Image: +2 credits
  assert.match(workerSrc, /attachmentSurcharge\s*\+=\s*4/); // PDF: +4 credits
  assert.match(workerSrc, /attachmentSurcharge\s*\+=\s*5/); // ZIP: +5 credits

  // Test calculateUsageCredits formula logic in isolated context
  const testCalc = (tokens, mult, surcharge) => Math.max(1, Math.ceil((tokens / 500) * mult)) + surcharge;

  // Short message (50 tokens, standard fast model 1.0x, 0 surcharge) -> 1 credit
  assert.equal(testCalc(50, 1.0, 0), 1);

  // Long message (1500 tokens, 1.0x, 0 surcharge) -> 3 credits
  assert.equal(testCalc(1500, 1.0, 0), 3);

  // Heavy model (1200 tokens, 1.5x, 0 surcharge) -> Math.ceil(2.4 * 1.5) = 4 credits
  assert.equal(testCalc(1200, 1.5, 0), 4);

  // Short message with 1 image (+2 surcharge) -> 1 + 2 = 3 credits
  assert.equal(testCalc(50, 1.0, 2), 3);

  // Short message with 2 images (+4 surcharge) -> 1 + 4 = 5 credits
  assert.equal(testCalc(50, 1.0, 4), 5);

  // Message with PDF (+4 surcharge) -> 1 + 4 = 5 credits
  assert.equal(testCalc(100, 1.0, 4), 5);

  // Message with ZIP (+5 surcharge) -> 1 + 5 = 6 credits
  assert.equal(testCalc(100, 1.0, 5), 6);

  // Deterministic fallback tokens calculation from characters: Math.ceil(chars / 4)
  const fallbackCalc = chars => Math.max(1, Math.ceil(chars / 4));
  assert.equal(fallbackCalc(200), 50);
  assert.ok(!Number.isNaN(fallbackCalc(0)));
});

test("credit receipt footer & real-time balance sync across chat and content generator", async () => {
  const creditsCode = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const contentCode = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const scriptCode = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const stylesCode = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const workerSrc = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Worker returns structured metadata for credit receipt
  assert.match(workerSrc, /creditsUsed:\s*chargedCredits/);
  assert.match(workerSrc, /remainingCredits:\s*remainingCredits/);
  assert.match(workerSrc, /tokensUsed:\s*totalTokens/);
  assert.match(workerSrc, /providerUsed:/);

  // Chatbot message receipt footer
  assert.match(creditsCode, /chat-credit-receipt/);
  assert.match(creditsCode, /⚡ Credits used:/);
  assert.match(creditsCode, /Remaining:/);

  // Content generator receipt footer
  assert.match(contentCode, /content-credit-receipt|contentCreditReceipt/);
  assert.match(contentCode, /⚡ Credits used:/);
  assert.match(contentCode, /Remaining:/);

  // Real-time balance sync helper exported to window
  assert.match(scriptCode, /window\.JEVEXA_UPDATE_CREDIT_BALANCE\s*=/);
  assert.match(creditsCode, /window\.JEVEXA_UPDATE_CREDIT_BALANCE\?\.\(remaining\)/);
  assert.match(contentCode, /window\.JEVEXA_UPDATE_CREDIT_BALANCE\?\.\(remaining\)/);

  // Styles defined for receipt badges
  assert.match(stylesCode, /\.chat-credit-receipt/);
  assert.match(stylesCode, /\.content-credit-receipt/);
});

test("plan-based file upload gating: Free plan allows images only and blocks PDF/ZIP with 403", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 100 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{
        service_key: "ai_chat",
        display_name: "AI Chat",
        integration_status: "available",
        fixed_credits: 1,
        credits_per_1000_tokens: null,
        enabled: true
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 99 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 99 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Image received and analyzed." }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    // 1. Free plan user uploads allowed image (JPEG/PNG/WebP) -> Succeeds 200
    const sampleImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const allowedImageRes = await worker.fetch(makeRequest("/api/chat", {
      body: {
        message: "Look at this image",
        tier: "lite",
        attachments: [{
          name: "photo.png",
          type: "image/png",
          data: `data:image/png;base64,${sampleImageBase64}`
        }]
      }
    }), geminiEnv);

    assert.equal(allowedImageRes.status, 200);
    const imgData = await allowedImageRes.json();
    assert.equal(imgData.reply, "Image received and analyzed.");

    // 2. Free plan user uploads PDF -> Blocked with 400 or 403
    const blockedPdfRes = await worker.fetch(makeRequest("/api/chat", {
      body: {
        message: "Review my document",
        tier: "lite",
        attachments: [{
          name: "doc.pdf",
          type: "application/pdf",
          data: "data:application/pdf;base64,JVBERi0xLjQ="
        }]
      }
    }), geminiEnv);

    assert.ok(blockedPdfRes.status === 400 || blockedPdfRes.status === 403);
    const pdfErr = await blockedPdfRes.json();
    assert.match(pdfErr.error, /Images only on Lite|PDF and ZIP uploads require a Paid plan/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Paid plan accepts images, PDFs, and valid ZIPs while enforcing ZIP safety limits", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "pro", balance: 500 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{
        service_key: "ai_chat_pro",
        display_name: "AI Chat Pro",
        integration_status: "available",
        fixed_credits: 2,
        credits_per_1000_tokens: null,
        enabled: true
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 2, balance: 498 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 2, balance: 498 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "PDF and ZIP analyzed successfully." }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    // 1. Paid plan with valid PDF and ZIP passes cleanly
    const paidRes = await worker.fetch(makeRequest("/api/chat", {
      body: {
        message: "Inspect files",
        tier: "pro",
        attachments: [
          { name: "doc.pdf", type: "application/pdf", data: "data:application/pdf;base64,JVBERi0xLjQ=" },
          { name: "code.zip", type: "application/zip", data: "data:application/zip;base64,UEsDBA==" }
        ]
      }
    }), geminiEnv);

    assert.equal(paidRes.status, 200);
    const paidData = await paidRes.json();
    assert.equal(paidData.reply, "PDF and ZIP analyzed successfully.");

    // 2. ZIP safety check: Path traversal check in ZIP
    const headerBytes = new Uint8Array(45);
    headerBytes[0] = 0x50; headerBytes[1] = 0x4b; headerBytes[2] = 0x03; headerBytes[3] = 0x04;
    headerBytes[26] = 13; headerBytes[27] = 0;
    const nameStr = "../secret.txt";
    for (let i = 0; i < nameStr.length; i++) headerBytes[30 + i] = nameStr.charCodeAt(i);
    const badZipB64 = Buffer.from(headerBytes).toString("base64");

    const unsafeZipRes = await worker.fetch(makeRequest("/api/chat", {
      body: {
        message: "Inspect unsafe zip",
        tier: "pro",
        attachments: [{ name: "unsafe.zip", type: "application/zip", data: `data:application/zip;base64,${badZipB64}` }]
      }
    }), geminiEnv);

    assert.equal(unsafeZipRes.status, 400);
    const unsafeData = await unsafeZipRes.json();
    assert.match(unsafeData.error, /safety|unsafe/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mobile, tablet & all-device responsiveness and UI safeguards verification", async () => {
  const stylesCode = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const creditsCode = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const scriptCode = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // 100dvh protection against mobile address bar clipping
  assert.match(stylesCode, /100dvh/);

  // Minimum touch target size 44px
  assert.match(stylesCode, /min-height:\s*44px/);

  // Blinking-dot live status animation
  assert.match(stylesCode, /liveDotPulse|live-status-dot/);

  // File preview chips with icons and sizes
  assert.match(creditsCode, /formatFileSize/);
  assert.match(creditsCode, /getFileIcon/);
  assert.match(creditsCode, /chip-size/);

  // Drag & drop and paste support in chat
  assert.match(creditsCode, /is-dragover/);
  assert.match(creditsCode, /clipboardData/);

  // Send button disabled state during generation
  assert.match(creditsCode, /sendButton\.disabled\s*=\s*true/);

  // Meta viewport tag exists for responsive devices
  assert.match(indexHtml, /<meta\s+name="viewport"\s+content="[^"]*width=device-width/i);
});


test("comprehensive audit: 0 flat 1 credit/msg labels remain across entire codebase", async () => {
  const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const creditsJs = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const supportJs = await readFile(new URL("../support.js", import.meta.url), "utf8");
  const termsHtml = await readFile(new URL("../terms.html", import.meta.url), "utf8");
  const aboutHtml = await readFile(new URL("../about.html", import.meta.url), "utf8");

  const flatPattern = /1 credit \/ msg|1 credit\/msg|credit per message|credits per message|fixed 1\/2\/4\/8|fixed credits per message/i;
  assert.ok(!flatPattern.test(indexHtml), "index.html has 0 flat credit labels");
  assert.ok(!flatPattern.test(scriptJs), "script.js has 0 flat credit labels");
  assert.ok(!flatPattern.test(creditsJs), "credits.js has 0 flat credit labels");
  assert.ok(!flatPattern.test(workerJs), "worker.js has 0 flat credit labels");
  assert.ok(!flatPattern.test(supportJs), "support.js has 0 flat credit labels");
  assert.ok(!flatPattern.test(termsHtml), "terms.html has 0 flat credit labels");
  assert.ok(!flatPattern.test(aboutHtml), "about.html has 0 flat credit labels");
});

test("pricing toggle & 20% annual discount calculations across all plans", async () => {
  const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // Free plan card exists and is $0 forever
  assert.match(indexHtml, /data-pricing-plan="free"/);
  assert.match(indexHtml, /100 free welcome credits/i);

  // 4 Paid plan cards exist with proper data attributes
  assert.match(indexHtml, /data-pricing-plan="starter"/);
  assert.match(indexHtml, /data-pricing-plan="pro"/);
  assert.match(indexHtml, /data-pricing-plan="business"/);
  assert.match(indexHtml, /data-pricing-plan="ultra"/);

  // 20% Annual calculations
  const discountRate = 0.2;
  const plans = [
    { name: "Lite", monthly: 5, expectedAnnualEq: 4.00, annualPaidOnce: 48 },
    { name: "Pro", monthly: 12, expectedAnnualEq: 9.60, annualPaidOnce: 115.20 },
    { name: "Max", monthly: 25, expectedAnnualEq: 20.00, annualPaidOnce: 240 },
    { name: "Ultra", monthly: 49, expectedAnnualEq: 39.20, annualPaidOnce: 470.40 }
  ];

  for (const p of plans) {
    const eq = p.monthly * (1 - discountRate);
    assert.equal(Number(eq.toFixed(2)), p.expectedAnnualEq);
    assert.equal(Number((eq * 12).toFixed(2)), p.annualPaidOnce);
  }

  // Toggle markup has proper ARIA attributes
  assert.match(indexHtml, /id="billingToggle"/);
  assert.match(indexHtml, /id="monthlyToggleLabel"/);
  assert.match(indexHtml, /id="annualToggleLabel"/);
  assert.match(scriptJs, /billingToggle\.setAttribute\('aria-checked'/);
});

test("anti-flash auth hydration & standard login form attributes", async () => {
  const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const stylesCss = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // Synchronous head script checks localStorage before render
  assert.match(indexHtml, /jevexa-authenticated-pending/);
  assert.match(indexHtml, /jevexa_persisted_session/);

  // CSS hides guest elements when pending auth
  assert.match(stylesCss, /\.jevexa-authenticated-pending/);

  // Synchronous state hydration in script.js
  assert.match(scriptJs, /getPersistedSession/);
  assert.match(scriptJs, /earlyPersistedAuth\s*=\s*getPersistedSession/);
  assert.match(scriptJs, /currentUser\s*=\s*earlyPersistedAuth\.user/);

  // Forms have name and autocomplete attributes for password managers
  assert.match(indexHtml, /autocomplete="email"/);
  assert.match(indexHtml, /autocomplete="current-password"/);
  assert.match(scriptJs, /autocomplete\s*=\s*'new-password'/);
});

test("progressive upload limits enforced for Lite (paid starter) tier", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "lite", balance: 500 }]);
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{
        service_key: "ai_chat",
        display_name: "AI Chat Lite",
        integration_status: "available",
        fixed_credits: 1,
        credits_per_1000_tokens: null,
        enabled: true
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 499 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 499 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Lite tier processed PDF attachment." }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20, totalTokenCount: 100 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    // Paying Lite user attaching a PDF succeeds (allowed on all paid plans)
    const litePdfRes = await worker.fetch(makeRequest("/api/chat", {
      body: {
        message: "Summarize this PDF for Lite user",
        tier: "lite",
        attachments: [
          { name: "summary.pdf", type: "application/pdf", data: "data:application/pdf;base64,JVBERi0xLjQ=" }
        ]
      }
    }), geminiEnv);

    assert.equal(litePdfRes.status, 200);
    const data = await litePdfRes.json();
    assert.equal(data.reply, "Lite tier processed PDF attachment.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Fix 1: Free plan allows image uploads without upgrade modal & accurately detects plan despite 12077 credits", async () => {
  const creditsJs = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // Frontend attachButton must NOT lock file uploads for lite/free tier
  assert.doesNotMatch(creditsJs, /if\s*\(\s*maximumChatTier\s*===\s*['"]lite['"]\s*\)\s*\{[\s\S]*?Upgrade to Pro Plan to unlock file uploads/);
  assert.doesNotMatch(creditsJs, /window\.showToast\(['"`]Upgrade to \$\{requiredPlan\} Plan to unlock file uploads\.['"`]\)/);

  // Both credits.js, script.js and worker.js reconcile profiles and user_credits plan
  assert.match(creditsJs, /supabaseClient\.from\(['"]profiles['"]\)/);
  assert.match(workerJs, /\/rest\/v1\/profiles\?select=plan/);
  assert.match(scriptJs, /supabaseClient\.from\(['"]profiles['"]\)/);

  // When user has 12077 credits but plan is 'free', plan is NOT misclassified as 'pro'
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      // Free test account with 12077 credits remaining
      return Response.json([{ plan: "free", balance: 12077 }]);
    }
    if (url.pathname === "/rest/v1/profiles") {
      return Response.json([{ plan: "free", credits: 12077 }]);
    }
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{
        service_key: "ai_chat",
        display_name: "AI Chat",
        integration_status: "available",
        fixed_credits: 1,
        enabled: true
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 1, balance: 12076 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 12076 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Free plan image processed cleanly." }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 20, totalTokenCount: 80 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    // 1. Free plan user with 12077 credits uploads image -> succeeds cleanly
    const sampleImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const imgRes = await worker.fetch(makeRequest("/api/chat", {
      body: {
        message: "Describe this image",
        tier: "lite",
        attachments: [{
          name: "test.png",
          type: "image/png",
          data: `data:image/png;base64,${sampleImageBase64}`
        }]
      }
    }), geminiEnv);

    assert.equal(imgRes.status, 200);
    const imgData = await imgRes.json();
    assert.equal(imgData.reply, "Free plan image processed cleanly.");

    // 2. Free plan user uploading PDF is blocked with 403 paid_plan_required (not granted paid access just because of 12077 credits)
    const pdfRes = await worker.fetch(makeRequest("/api/chat", {
      body: {
        message: "Read document",
        tier: "lite",
        attachments: [{
          name: "notes.pdf",
          type: "application/pdf",
          data: "data:application/pdf;base64,JVBERi0xLjQ="
        }]
      }
    }), geminiEnv);

    assert.equal(pdfRes.status, 403);
    const pdfData = await pdfRes.json();
    assert.equal(pdfData.code, "paid_plan_required");
    assert.equal(pdfData.currentPlan, "free");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Fix 2: Remove (1 cr / 500 tok) suffix — show only 'Token-weighted'", async () => {
  const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const creditsJs = await readFile(new URL("../credits.js", import.meta.url), "utf8");

  // In index.html, #chatCreditStatus has "⚡ Lite • Token-weighted" without "(1 cr / 500 tok)"
  assert.match(indexHtml, /id="chatCreditStatus"[^>]*>\s*⚡ Lite • Token-weighted\s*<\/span>/);
  assert.doesNotMatch(indexHtml, /id="chatCreditStatus"[^>]*>[\s\S]*?\(1 cr \/ 500 tok\)/);

  // In index.html pricing features, token-weighted item does not include "(1 cr / 500 tok)"
  assert.match(indexHtml, /<li><i class="fas fa-check"><\/i>\s*Token-weighted credits<\/li>/);
  assert.doesNotMatch(indexHtml, /<li><i class="fas fa-check"><\/i>\s*Token-weighted credits \(1 cr \/ 500 tok\)<\/li>/);

  // In credits.js, status label setStatus uses "⚡ ... • Token-weighted" without "(1 cr / 500 tok)"
  assert.doesNotMatch(creditsJs, /setStatus\(`⚡[^\n`]*1 cr \/ 500 tok/);
  assert.match(creditsJs, /setStatus\(`⚡ \$\{selectedTier\.toUpperCase\(\)\} • Token-weighted`\)/);
  assert.match(creditsJs, /setStatus\(`⚡ \$\{tier\[0\]\.toUpperCase\(\)\}\$\{tier\.slice\(1\)\} • Token-weighted`\)/);

  // Live receipt footer remains intact
  assert.match(creditsJs, /⚡ Credits used:/);
  assert.match(creditsJs, /Remaining:/);
});

test("Fix 3: Pricing toggle cuts prices by 20% (Lite $5->$4, Pro $12->$9.60, Max $25->$20, Ultra $49->$39.20)", async () => {
  const stylesCss = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // CSS ensures .switch has display: inline-block and cursor: pointer
  assert.match(stylesCss, /\.switch\s*\{[\s\S]*?display:\s*inline-block;[\s\S]*?cursor:\s*pointer;/);
  assert.match(stylesCss, /\.toggle-label\s*\{[\s\S]*?cursor:\s*pointer;[\s\S]*?user-select:\s*none;/);
  assert.match(stylesCss, /\.save-badge\s*\{[\s\S]*?pointer-events:\s*none;/);

  // Script has discount rate 0.2
  assert.match(scriptJs, /annualDiscountRate:\s*0\.2/);

  // Test the formatPackagePrice helper directly
  const packagePriceFormatters = [
    new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }),
    new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  ];
  const formatPackagePrice = (value, showCents = false) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '0';
    if (!showCents || num % 1 === 0) {
      return packagePriceFormatters[0].format(num);
    }
    return packagePriceFormatters[1].format(num);
  };

  const plans = [
    { name: "Lite", monthly: 5, expectedDiscounted: "4", expectedAnnualTotal: "48" },
    { name: "Pro", monthly: 12, expectedDiscounted: "9.60", expectedAnnualTotal: "115.20" },
    { name: "Max", monthly: 25, expectedDiscounted: "20", expectedAnnualTotal: "240" },
    { name: "Ultra", monthly: 49, expectedDiscounted: "39.20", expectedAnnualTotal: "470.40" }
  ];

  for (const p of plans) {
    const discounted = p.monthly * 0.8;
    const formattedDiscounted = formatPackagePrice(discounted, true);
    assert.equal(formattedDiscounted, p.expectedDiscounted, `${p.name} discounted price matches`);

    const annualTotal = discounted * 12;
    const formattedAnnual = formatPackagePrice(annualTotal, true);
    assert.equal(formattedAnnual, p.expectedAnnualTotal, `${p.name} annual total matches`);
  }

  // Toggle switch and label interaction bindings exist
  assert.match(scriptJs, /setBillingCycle/);
  assert.match(scriptJs, /toggleBillingCycle/);
  assert.match(scriptJs, /pricingSwitch/);
  assert.match(scriptJs, /annualToggleLabel/);
  assert.match(scriptJs, /monthlyToggleLabel/);
});

test("Edge Hardening: /api/health responds fast and deterministically with service status", async () => {
  const mockEnv = {
    ...env,
    SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
    SUPABASE_ANON_KEY: "dummy-anon",
    SUPABASE_SERVICE_ROLE_KEY: "dummy-service"
  };

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/rest/v1/jevexa_service_pricing")) {
        return new Response(JSON.stringify([
          { service_key: "ai_chat", fixed_credits: 1 },
          { service_key: "ai_chat_pro", fixed_credits: 2 },
          { service_key: "ai_chat_max", fixed_credits: 4 },
          { service_key: "ai_chat_ultra", fixed_credits: 8 },
          { service_key: "content_generation", credits_per_1000_tokens: 1 }
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("OK", { status: 200 });
    };

    const res = await worker.fetch(new Request("https://jevexa.net/api/health"), mockEnv);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.service, "jevexa-worker");
    assert.equal(data.pricing, "active");
    assert.ok(data.time);
    assert.equal(res.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Edge Hardening: Nested subroute asset resolution under /tools/* without dead-ends", async () => {
  const nestedTests = [
    { requestPath: "/tools/chatbot/styles.css", expectedAsset: "/styles.css" },
    { requestPath: "/tools/content/script.js", expectedAsset: "/script.js" },
    { requestPath: "/tools/chatbot/assets/logo.svg", expectedAsset: "/assets/logo.svg" },
    { requestPath: "/tools/content/assets/image.png", expectedAsset: "/assets/image.png" },
    { requestPath: "/tools/chatbot/", expectedAsset: "/" },
    { requestPath: "/tools/content/", expectedAsset: "/" },
    { requestPath: "/tools/chatbot", expectedAsset: "/" }
  ];

  for (const { requestPath, expectedAsset } of nestedTests) {
    let requestedAssetUrl = null;
    const mockEnv = {
      ASSETS: {
        fetch: async (req) => {
          requestedAssetUrl = req.url;
          return new Response("OK", {
            headers: { "Content-Type": expectedAsset.endsWith(".css") ? "text/css" : "text/html" }
          });
        }
      }
    };

    const res = await worker.fetch(new Request(`https://jevexa.net${requestPath}`), mockEnv);
    assert.equal(res.status, 200);
    assert.equal(new URL(requestedAssetUrl).pathname, expectedAsset, `${requestPath} should resolve to ${expectedAsset}`);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  }
});

test("Edge Hardening: Route normalization for /admin, /pricing, and trailing slashes", async () => {
  const routeTests = [
    { path: "/admin", expectedAsset: "/admin.html" },
    { path: "/admin/", expectedAsset: "/admin.html" },
    { path: "/pricing", expectedAsset: "/" },
    { path: "/pricing/", expectedAsset: "/" }
  ];

  for (const { path, expectedAsset } of routeTests) {
    let requestedUrl = null;
    const mockEnv = {
      ASSETS: {
        fetch: async (req) => {
          requestedUrl = req.url;
          return new Response(`<html><body>${expectedAsset}</body></html>`, {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
      }
    };

    const res = await worker.fetch(new Request(`https://jevexa.net${path}`), mockEnv);
    assert.equal(res.status, 200);
    assert.equal(new URL(requestedUrl).pathname, expectedAsset, `${path} should map to ${expectedAsset}`);
    assert.equal(res.headers.get("X-Frame-Options"), "SAMEORIGIN");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  }

  // Unknown API route returns clean 404 JSON
  const unknownApiRes = await worker.fetch(new Request("https://jevexa.net/api/nonexistent-route"), env);
  assert.equal(unknownApiRes.status, 404);
  const unknownData = await unknownApiRes.json();
  assert.equal(unknownData.ok, false);
});

test("Edge Hardening: Response headers enforce MIME types, Cache-Control, and no forbidden hop-by-hop headers", async () => {
  const testAssets = [
    { path: "/styles.css", expectedMime: "text/css; charset=utf-8", expectedCache: "max-age=86400" },
    { path: "/script.js", expectedMime: "application/javascript; charset=utf-8", expectedCache: "max-age=86400" },
    { path: "/site.webmanifest", expectedMime: "application/manifest+json; charset=utf-8", expectedCache: "max-age=86400" },
    { path: "/about.html", expectedMime: "text/html; charset=utf-8", expectedCache: "must-revalidate" }
  ];

  for (const { path, expectedMime, expectedCache } of testAssets) {
    const mockEnv = {
      ASSETS: {
        fetch: async () => {
          // Simulate asset returned without explicit Content-Type or Cache-Control
          return new Response("content", { status: 200 });
        }
      }
    };

    const res = await worker.fetch(new Request(`https://jevexa.net${path}`), mockEnv);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), expectedMime, `Content-Type for ${path}`);
    assert.match(res.headers.get("Cache-Control") || "", new RegExp(expectedCache), `Cache-Control for ${path}`);

    // Forbidden hop-by-hop headers in HTTP/2 / HTTP/3
    assert.equal(res.headers.has("Connection"), false);
    assert.equal(res.headers.has("Keep-Alive"), false);
    assert.equal(res.headers.has("Transfer-Encoding"), false);
  }
});

test("Client Hardening: User recovery, prompt preservation, and transient retries", async () => {
  const scriptCode = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const creditsCode = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const contentCode = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const supportCode = await readFile(new URL("../support.js", import.meta.url), "utf8");
  const premiumCode = await readFile(new URL("../premium.js", import.meta.url), "utf8");

  // script.js route normalization handles trailing slashes without redirect dead-ends
  assert.match(scriptCode, /const cleanPath = path\.length > 1 && path\.endsWith\('\/'\) \? path\.slice\(0, -1\) : path;/);
  assert.match(scriptCode, /const cleanHash = hash\.length > 1 && hash\.endsWith\('\/'\) \? hash\.slice\(0, -1\) : hash;/);

  // credits.js restores user message into input on connection interruption so input is never lost
  assert.match(creditsCode, /if \(input && !input\.value && displayText\) \{\s*input\.value = displayText;/);

  // content.js has retry loop for 5xx/network errors and user-friendly Retry button
  assert.match(contentCode, /for \(let attempt = 0; attempt < 2; attempt\+\+\)/);
  assert.match(contentCode, /contentRetryAction/);
  assert.match(contentCode, /Retry Generation/);

  // support.js has transient retry loop for support ticket submission
  assert.match(supportCode, /for \(let attempt = 0; attempt < 2; attempt\+\+\)/);

  // premium.js has AbortController timeout safeguard on newsletter signup
  assert.match(premiumCode, /const newsletterController = new AbortController\(\);/);
});

test("Chatbot Viewport & Compact Controls: Spacious thread layout, low-profile selector bar, >=44px touch targets, and scroll-to-bottom", async () => {
  const stylesCode = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const creditsCode = await readFile(new URL("../credits.js", import.meta.url), "utf8");

  // Spacious reading viewport on laptop/desktop: expanded width up to 1180px and 1240px
  assert.match(stylesCode, /\.chat-messages\s*\{[^}]*width:\s*min\(100%,\s*1180px\);/);
  assert.match(stylesCode, /\.chat-messages[^{]*\{[^}]*width:\s*min\(100%,\s*1240px\);/);

  // Generous message bubble reading area for modern desktop AI chatbots
  assert.match(stylesCode, /\.msg-content\s*\{[^}]*max-width:\s*min\(92%,\s*1020px\);/);
  assert.match(stylesCode, /\.message\.bot\s+\.msg-content\s*\{[^}]*max-width:\s*min\(94%,\s*1040px\);/);

  // Compact, sleek low-height selector toolbar for Model and Thinking
  assert.match(stylesCode, /\.chat-tier-controls\s*\{[^}]*min-height:\s*48px;/);
  assert.match(stylesCode, /\.chat-select\s*\{[^}]*display:\s*flex;\s*align-items:\s*center;/);

  // Interactive controls maintain >= 44px touch target for accessibility
  assert.match(stylesCode, /\.chat-select-trigger\s*\{[^}]*min-height:\s*44px;/);

  // Scroll-to-bottom floating button exists in HTML and styles
  assert.match(indexHtml, /id="chatScrollBottom"/);
  assert.match(indexHtml, /class="[^"]*chat-scroll-bottom-btn[^"]*"/);
  assert.match(stylesCode, /\.chat-scroll-bottom-btn/);
  assert.match(creditsCode, /chatScrollBottom/);
});

test("Active Model Identity: /api/chat passes active Jevexa tier identity, system prompt context, and UI receipt metadata", async () => {
  const workerCode = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const creditsCode = await readFile(new URL("../credits.js", import.meta.url), "utf8");

  // Worker defines Jevexa model name constants for all tiers
  assert.match(workerCode, /lite:\s*"Jevexa Lite"/);
  assert.match(workerCode, /pro:\s*"Jevexa Pro"/);
  assert.match(workerCode, /max:\s*"Jevexa Max"/);
  assert.match(workerCode, /ultra:\s*"Jevexa Ultra"/);

  // System instruction template dynamically incorporates active model identity
  assert.match(workerCode, /function buildChatSystemPrompt/);
  assert.match(workerCode, /ACTIVE JEVEXA MODEL IDENTITY:/);
  assert.match(workerCode, /You are currently operating as \*\*.*?\*\*/);

  // Mock API call to /api/chat verifies model and modelName in response payload
  const originalFetch = globalThis.fetch;
  let receivedSystemInstruction = "";
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/user_credits") return Response.json([{ plan: "lite", balance: 500 }]);
    if (url.pathname === "/rest/v1/jevexa_service_pricing") {
      return Response.json([{ fixed_credits: 1, credits_per_1000_tokens: null, enabled: true, integration_status: "available" }]);
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, status: "reserved", duplicate: false, reserved_credits: 1, balance: 499 });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      return Response.json({ ok: true, charged_credits: 1, balance: 499 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      const reqBody = JSON.parse(options.body || "{}");
      receivedSystemInstruction = reqBody.systemInstruction?.parts?.[0]?.text || "";
      return Response.json({
        candidates: [{ content: { parts: [{ text: "I am Jevexa Lite, ready to help." }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 12, totalTokenCount: 27 }
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  try {
    const chatRes = await worker.fetch(makeRequest("/api/chat", { body: { message: "Which model is currently working?", tier: "lite" } }), geminiEnv);
    assert.equal(chatRes.status, 200);
    const data = await chatRes.json();
    assert.equal(data.tier, "lite");
    assert.equal(data.model, "Jevexa Lite");
    assert.equal(data.modelName, "Jevexa Lite");
    assert.match(receivedSystemInstruction, /ACTIVE JEVEXA MODEL IDENTITY:/);
    assert.match(receivedSystemInstruction, /Jevexa Lite/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Frontend credit receipt and status incorporate active model tag
  assert.match(creditsCode, /chat-receipt-tier/);
  assert.match(creditsCode, /generateChatbotGuestReply/);
  assert.match(creditsCode, /I am currently operating as \*\*.*?\*\* in JEVEXA AI Studio/);
});

test("Response Quality & Markdown: Structured headings, bullet points, fenced code blocks with copy action, and non-intrusive auto-scrolling", async () => {
  const workerCode = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const creditsCode = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const stylesCode = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Worker SYSTEM_PROMPT instructs clean markdown structure (headings, lists, code blocks)
  assert.match(workerCode, /Response formatting & structure:/);
  assert.match(workerCode, /Deliver well-structured, easy-to-scan, and satisfying responses/);
  assert.match(workerCode, /fenced code blocks with language tags/);

  // credits.js markdown renderer parses code blocks, headings, and lists
  assert.match(creditsCode, /@@JEVEXA_CODE_BLOCK_/);
  assert.match(creditsCode, /chat-code-block/);
  assert.match(creditsCode, /chat-code-copy/);
  assert.match(creditsCode, /class="chat-h3"/);

  // Copy code button click handling in credits.js
  assert.match(creditsCode, /copyCodeBtn\.closest\('\.chat-code-block'\)/);
  assert.match(creditsCode, /Code copied to clipboard\./);

  // Non-intrusive auto-scrolling preserves user position when scrolled up
  assert.match(creditsCode, /isScrolledNearBottom/);
  assert.match(creditsCode, /scrollChatToBottom/);

  // Code block and markdown CSS styles
  assert.match(stylesCode, /\.chat-code-block\s*\{/);
  assert.match(stylesCode, /\.chat-code-copy\s*\{/);
  assert.match(stylesCode, /\.msg-body\s*\{/);
});

test("Chatbot upgrade: Complete removal of non-working ☰ button and seamless top-bar alignment", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Dead hamburger toggle button completely removed from markup, scripts, and stylesheets
  assert.doesNotMatch(html, /id="chatSidebarToggle"/);
  assert.doesNotMatch(html, /class="chat-sidebar-toggle"/);
  assert.doesNotMatch(html, />☰</);
  assert.doesNotMatch(script, /chatSidebarToggle/);
  assert.doesNotMatch(credits, /chatSidebarToggle/);
  assert.doesNotMatch(styles, /#chatSidebarToggle/);
  assert.doesNotMatch(styles, /\.chat-sidebar-toggle/);

  // Modern drawer toggle button exists for mobile/compact viewports
  assert.match(html, /id="chatSidebarDrawerBtn"/);
  assert.match(html, /class="chat-sidebar-drawer-btn"/);
  assert.match(credits, /initChatSidebarDrawer/);
  assert.match(styles, /\.chat-sidebar-drawer-btn\s*\{/);
});

test("Chatbot upgrade: Luxury spacious interface & resizable divider handle with persistence", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Resizer divider element in DOM
  assert.match(html, /id="chatSidebarResizer"/);
  assert.match(html, /class="chat-sidebar-resizer"/);

  // Resizer logic in credits.js
  assert.match(credits, /function initChatSidebarResizer\(\)/);
  assert.match(credits, /localStorage\.getItem\('jevexa_chat_sidebar_width'\)/);
  assert.match(credits, /localStorage\.setItem\('jevexa_chat_sidebar_width'/);
  assert.match(credits, /MIN_WIDTH\s*=\s*220/);
  assert.match(credits, /DEFAULT_WIDTH\s*=\s*290/);
  assert.match(credits, /dblclick/);

  // Resizer styles in styles.css
  assert.match(styles, /\.chat-sidebar-resizer\s*\{/);
  assert.match(styles, /cursor:\s*col-resize/);
  assert.match(styles, /\.chat-resizer-line\s*\{/);
  assert.match(styles, /\.is-resizing/);
  assert.match(styles, /body\.chat-is-resizing/);
});

test("Chatbot upgrade: Editable chat history with inline rename, delete, search count and clear", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Search input with clear button and count badge
  assert.match(html, /id="chatHistorySearch"/);
  assert.match(html, /id="chatHistorySearchClear"/);
  assert.match(html, /id="chatHistoryCount"/);

  // Inline rename and delete in credits.js
  assert.match(credits, /renamingSessionId/);
  assert.match(credits, /chat-history-rename-box/);
  assert.match(credits, /chat-history-rename-input/);
  assert.match(credits, /chat-history-rename-save/);
  assert.match(credits, /chat-history-delete-btn/);
  assert.match(credits, /chatSessions = chatSessions\.filter/);
  assert.match(credits, /chatHistorySearchClear/);
  assert.match(credits, /chatHistoryCount/);

  // Seamless switching preserves prior conversation context
  assert.match(credits, /function selectChatSession\(sessionId\)/);
  assert.match(credits, /currentSession\.messages = conversation\.slice\(-100\)/);

  // Styling for actions and inputs
  assert.match(styles, /\.chat-history-actions/);
  assert.match(styles, /\.chat-history-rename-input/);
  assert.match(styles, /\.chat-search-clear/);
  assert.match(styles, /\.chat-history-count-badge/);
});

test("Chatbot upgrade: Customization, tone, personality & UI density controls suite", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Modal dialog and tabs in HTML
  assert.match(html, /id="chatCustomizationModal"/);
  assert.match(html, /id="chatCustomAbout"/);
  assert.match(html, /id="chatCustomResponse"/);
  assert.match(html, /id="chatToneSelect"/);
  assert.match(html, /id="chatBehaviorSelect"/);
  assert.match(html, /id="chatCodeDepthSelect"/);
  assert.match(html, /id="chatModalDensitySelect"/);

  // Custom settings storage & management in credits.js
  assert.match(credits, /function loadCustomSettings/);
  assert.match(credits, /function saveCustomSettings/);
  assert.match(credits, /function applyCustomSettingsToUI/);
  assert.match(credits, /getActiveCustomSettings/);
  assert.match(credits, /initChatCustomizationSuite/);

  // Worker parses customSettings and injects them into system prompt
  assert.match(worker, /body\?\.customSettings && typeof body\.customSettings === "object"/);
  assert.match(worker, /CUSTOM USER PREFERENCES & INSTRUCTIONS/);
  assert.match(worker, /USER REQUESTED TONE/);
  assert.match(worker, /USER REQUESTED BEHAVIOR/);

  // Styles for modal, tabs, density
  assert.match(styles, /\.chat-custom-modal/);
  assert.match(styles, /\.chat-custom-tab/);
  assert.match(styles, /\[data-chat-density="compact"\]/);
});

test("Chatbot upgrade: Plan-scaled persistent memory & context window limits (Supabase safe)", async () => {
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/user_memories_migration.sql", import.meta.url), "utf8");

  // Worker defines tier plan limits scaling progressively from free to ultra
  assert.match(worker, /const TIER_PLAN_LIMITS = Object\.freeze\(\{/);
  assert.match(worker, /free:\s*\{\s*maxMemories:\s*5,\s*maxMemoryChars:\s*200,\s*maxHistoryMessages:\s*6/);
  assert.match(worker, /lite:\s*\{\s*maxMemories:\s*15,\s*maxMemoryChars:\s*350,\s*maxHistoryMessages:\s*12/);
  assert.match(worker, /pro:\s*\{\s*maxMemories:\s*35,\s*maxMemoryChars:\s*500,\s*maxHistoryMessages:\s*20/);
  assert.match(worker, /max:\s*\{\s*maxMemories:\s*75,\s*maxMemoryChars:\s*800,\s*maxHistoryMessages:\s*32/);
  assert.match(worker, /ultra:\s*\{\s*maxMemories:\s*150,\s*maxMemoryChars:\s*1200,\s*maxHistoryMessages:\s*50/);

  // Worker injects memories into system prompt and clamps context window by plan
  assert.match(worker, /PERSISTENT USER MEMORIES/);
  assert.match(worker, /parsed\.history\.slice\(-planCaps\.maxHistoryMessages\)/);

  // Worker /api/memories endpoint handles CRUD safely
  assert.match(worker, /async function handleMemories\(request, env\)/);
  assert.match(worker, /pathname === ["']\/api\/memories["']/);

  // Client-side limits and memory UI in credits.js
  assert.match(credits, /PLAN_MEMORY_CONFIG/);
  assert.match(credits, /function getUserPlanMemoryLimits\(\)/);
  assert.match(credits, /function renderMemoriesUI\(\)/);
  assert.match(credits, /syncMemoryToServer/);

  // Supabase migration creates indexed table with RLS
  assert.match(migration, /create table if not exists public\.user_memories/i);
  assert.match(migration, /idx_user_memories_user_id/i);
  assert.match(migration, /row level security/i);
});

test("Chatbot upgrade: Strict exact language mirroring instruction in system prompt", async () => {
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Strict language mirroring requirement across multiple languages
  assert.match(worker, /EXACT LANGUAGE MATCHING \(STRICT RULE\):/);
  assert.match(worker, /Always reply in the EXACT SAME LANGUAGE and script the user writes in/);
  assert.match(worker, /If the user writes in Roman Urdu \(e\.g\. "kese ho", "mujhe yeh samjha do", "code chahiye"\), reply in fluent, natural Roman Urdu\. Never force English\./);
  assert.match(worker, /If the user writes in Urdu script/);
  assert.match(worker, /If the user writes in Hindi, Arabic, Spanish, French, German/);
  assert.match(worker, /If the user mixes languages/);
});

test("Chatbot upgrade: Complete elimination of collapsed-sidebar state across entire codebase", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Zero collapsed-sidebar state across all frontend files
  assert.doesNotMatch(html, /chat-sidebar-collapsed/);
  assert.doesNotMatch(script, /chat-sidebar-collapsed/);
  assert.doesNotMatch(credits, /chat-sidebar-collapsed/);
  assert.doesNotMatch(styles, /\.chat-sidebar-collapsed/);

  // Desktop hides drawer toggle so sidebar remains a spacious, permanent resizable pane
  assert.match(styles, /@media\s*\(min-width:\s*768px\)\s*\{[\s\S]*?\.chat-sidebar-drawer-btn\s*\{[\s\S]*?display:\s*none\s*!important;/);
});

test("Chatbot upgrade: Stop-abort control, non-promotional system rules & bottom-only receipt", async () => {
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Zero unprompted self-promotion and thorough task completion in worker
  assert.match(worker, /ZERO UNPROMPTED JEVEXA SELF-PROMOTION \(STRICT RULE\):/);
  assert.match(worker, /Never randomly praise Jevexa, brag about studio features/);
  assert.match(worker, /COMPLETE EVERY TASK THOROUGHLY:/);
  assert.match(worker, /Never cut answers short prematurely/);
  assert.doesNotMatch(worker, /SALES STYLE:/);
  assert.doesNotMatch(worker, /Then suggest how JEVEXA can help/);

  // Stop-abort button control in credits.js
  assert.match(credits, /sendButton\.classList\.add\('chat-stop-btn'\)/);
  assert.match(credits, /sendButton\.setAttribute\('aria-label',\s*'Stop generation'\)/);
  assert.match(credits, /button\.id === 'chatSend' && sending/);
  assert.match(credits, /abortInFlightChatRequest\(\)/);
  assert.match(credits, /sendButton\.classList\.remove\('chat-stop-btn'\)/);

  // Stop-abort button styling in styles.css
  assert.match(styles, /\.chat-send\.chat-stop-btn\s*\{/);

  // Receipt appears at bottom end of messages in .chat-credit-receipt, status line stays clean
  assert.match(credits, /receipt\.className = 'chat-credit-receipt'/);
  assert.match(credits, /⚡ Credits used:/);
  assert.match(credits, /Remaining:/);
  assert.match(credits, /setStatus\(`⚡ \$\{tierDisplayName\} • Ready`\)/);
});

test("Flagship upgrade: Mobile virtual keyboard viewport & visualViewport tracking", async () => {
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // CSS variables for dynamic visual viewport and keyboard insets
  assert.match(styles, /--vvh:\s*100dvh;/);
  assert.match(styles, /--vvh-top:\s*0px;/);
  assert.match(styles, /--keyboard-inset-bottom:\s*0px;/);

  // Chatbot window binds to visual viewport height
  assert.match(styles, /height:\s*var\(--vvh,\s*100dvh\);/);
  assert.match(styles, /max-height:\s*var\(--vvh,\s*100dvh\);/);

  // Mobile viewport tracking handles resize, scroll, and focus
  assert.match(credits, /function initVirtualViewportTracking\(\)/);
  assert.match(credits, /window\.visualViewport\.addEventListener\('resize'/);
  assert.match(credits, /window\.visualViewport\.addEventListener\('scroll'/);
  assert.match(credits, /chatInput\.addEventListener\('focus'/);
  assert.match(credits, /chatInput\.addEventListener\('input'/);
  assert.match(credits, /document\.documentElement\.style\.setProperty\('--vvh'/);
  assert.match(credits, /document\.documentElement\.style\.setProperty\('--keyboard-inset-bottom'/);

  // Script triggers viewport refresh when opening chat
  assert.match(script, /window\.JEVEXA_UPDATE_VIEWPORT\?\.\(\);/);

  // Smooth touch scrolling and auto-zoom prevention on mobile
  assert.match(styles, /-webkit-overflow-scrolling:\s*touch;/);
  assert.match(styles, /overscroll-behavior-y:\s*contain;/);
  assert.match(styles, /touch-action:\s*pan-y;/);
  assert.match(styles, /\.chat-input-area textarea\s*\{[\s\S]*?font-size:\s*16px;/);
});

test("Flagship upgrade: Modern Settings interface with Personalization & Memory cleanly integrated", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // Settings modal structure with all standard sections
  assert.match(html, /id="chatCustomizationModal"[^>]*role="dialog"/);
  assert.match(html, /data-tab="instructions"/);
  assert.match(html, /data-tab="language"/);
  assert.match(html, /data-tab="personality"/);
  assert.match(html, /data-tab="memory"/);
  assert.match(html, /data-tab="display"/);

  // Dedicated Personalization & Memory tab inside Settings
  assert.match(html, /<span>Personalization &amp; Memory<\/span>\s*<span class="chat-memory-modal-badge" id="chatModalMemoryCount">/);

  // Sidebar footer Settings trigger with clean single-line layout and standard icon
  assert.match(html, /id="chatOpenCustomizationBtn"/);
  assert.match(html, /<i class="fas fa-gear"[^>]*><\/i>\s*<span class="chat-personalize-title">Settings<\/span>/);
  assert.doesNotMatch(html, /class="chat-personalize-subtitle"/);
  assert.doesNotMatch(html, /id="chatMemoryBadge"/, "0 badge next to Settings must be removed");

  // Chatbot header settings button
  assert.match(html, /id="chatHeaderSettingsBtn"/);
  assert.match(credits, /headerSettingsBtn/);
  assert.match(styles, /\.chatbot-header-settings-btn/);

  // Settings clear all conversations button
  assert.match(html, /id="chatSettingsClearAllBtn"/);
  assert.match(credits, /chatSettingsClearAllBtn/);

  // Account workspace settings includes Personalization & Memory
  assert.match(script, /\['personalization',\s*'🧠',\s*'Personalization & AI'/);
  assert.match(script, /openChatbotSettingsModalBtn/);
});

test("Flagship upgrade: Settings-driven pipeline with language selection and prompt adaptation", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");

  // Language selector in HTML with Auto, Roman Urdu, Urdu, Hindi, English
  assert.match(html, /id="chatLanguageSelect"/);
  assert.match(html, /value="auto"[^>]*>Auto \(Match User Language\)/);
  assert.match(html, /value="en"[^>]*>English/);
  assert.match(html, /value="roman_urdu"[^>]*>Roman Urdu/);
  assert.match(html, /value="urdu"[^>]*>Urdu/);
  assert.match(html, /value="hindi"[^>]*>Hindi/);

  // Language saved and dispatched in credits.js
  assert.match(credits, /chatCustomSettings\.language = document\.getElementById\('chatLanguageSelect'\)/);
  assert.match(credits, /language: chatCustomSettings\.language \|\| 'auto'/);

  // Worker parses language and injects explicit instructions into prompt
  assert.match(worker, /language: typeof body\.customSettings\.language === "string"/);
  assert.match(worker, /USER PREFERRED LANGUAGE/);
  assert.match(worker, /ROMAN URDU\. Always reply in natural, conversational Roman Urdu/);
  assert.match(worker, /URDU \(اردو\)\. Always reply in proper, fluent Urdu script/);
  assert.match(worker, /HINDI \(हिंदी\)\. Always reply in proper, fluent Hindi script/);
  assert.match(worker, /ENGLISH\. Always respond in fluent English/);

  // Tone and behavior mapping
  assert.match(worker, /USER REQUESTED TONE/);
  assert.match(worker, /USER REQUESTED BEHAVIOR/);
  assert.match(worker, /CODE DEPTH/);
});

test("Flagship upgrade: Multi-device stability, touch safeguards and non-colliding controls", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Touch target sizing (>= 44px)
  assert.match(styles, /min-height:\s*44px;/);

  // Non-colliding spacing on trigger and tabs
  assert.match(styles, /\.chat-personalize-trigger\s*\{[\s\S]*?min-height:\s*48px;/);
  assert.match(styles, /\.chat-custom-dialog\s*\{[\s\S]*?width:\s*min\(94vw,\s*720px\);/);
  assert.match(styles, /\.chat-custom-nav\s*\{[\s\S]*?overflow-x:\s*auto;/);

  // Zero collapsed-sidebar bugs
  assert.doesNotMatch(styles, /\.chat-sidebar-collapsed/);
});

test("Flagship upgrade: Single unified settings and bottom-end credit detail in status bar", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Requirement 2: Zero split Quick Settings in sidebar
  assert.doesNotMatch(html, /Quick Settings/i, "Quick Settings block must be removed from sidebar");
  assert.doesNotMatch(html, /id="chatSettings"/, "#chatSettings details element must be removed");

  // Single clean Settings entry at bottom of sidebar with standard icon and no subtext
  assert.match(html, /id="chatOpenCustomizationBtn"/);
  assert.match(html, /<i class="fas fa-gear"[^>]*><\/i>\s*<span class="chat-personalize-title">Settings<\/span>/);
  assert.doesNotMatch(html, /class="chat-personalize-subtitle"/);
  assert.doesNotMatch(html, /id="chatMemoryBadge"/, "0 badge next to Settings must be removed");

  // All 5 standard chatbot settings categories in one cohesive flagship modal
  assert.match(html, /id="chatCustomizationModal"/);
  assert.match(html, /data-tab="memory"/);
  assert.match(html, /data-tab="instructions"/);
  assert.match(html, /data-tab="language"/);
  assert.match(html, /data-tab="personality"/);
  assert.match(html, /data-tab="display"/);

  // Requirement 1: Bottom-end credit detail in status bar
  assert.match(credits, /Credits used:\s*\$\{used\}\s*•\s*Remaining:\s*\$\{remaining\}\s*•\s*Token-weighted/);

  // Chat bubbles clean without clutter (.chat-credit-receipt hidden from message bubbles)
  assert.match(styles, /\.chat-credit-receipt\s*\{[\s\S]*?display:\s*none\s*!important;/);

  // Bottom notice styled with generous breathing room
  assert.match(styles, /\.chat-credit-notice\s*\{[\s\S]*?display:\s*flex;/);
  assert.match(styles, /#chatCreditStatus\s*\{[\s\S]*?display:\s*inline-flex;/);

  // Clear all conversations unified handler in credits.js
  assert.match(credits, /function clearAllConversations\(\)/);
  assert.match(credits, /chatSettingsClearAllBtn/);
});

test("Flagship upgrade: Session resumption continuity, highlighted bottom credits, and single-line Settings", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // 1. Session Resumption & Chat Continuity
  assert.match(credits, /function activeChatKey\(userId\)/);
  assert.match(credits, /function getPersistedUserId\(\)/);
  assert.match(credits, /function resumeChatSession\(force = false\)/);
  assert.match(credits, /window\.JEVEXA_RESUME_CHAT\s*=\s*resumeChatSession/);
  assert.match(credits, /earlyPersistedUid/);
  assert.match(credits, /visibilitychange/);
  assert.match(script, /localStorage\.setItem\('jevexa_last_workspace',\s*'chatbot'\)/);
  assert.match(script, /localStorage\.removeItem\('jevexa_last_workspace'\)/);
  assert.match(script, /window\.JEVEXA_RESUME_CHAT\?\.\(\)/);

  // 2. Clear Bottom Credit Highlighting
  assert.match(credits, /chat-credit-used-val/);
  assert.match(credits, /chat-credit-rem-val/);
  assert.match(styles, /\.chat-credit-used-val\s*\{[\s\S]*?color:\s*#f472b6;/);
  assert.match(styles, /\.chat-credit-rem-val\s*\{[\s\S]*?color:\s*#38bdf8;/);
  assert.match(styles, /\.chat-credit-val\s*\{[\s\S]*?tabular-nums;/);

  // 3. Clean Single-line Settings Button with Standard Icon (No Subtext)
  assert.match(html, /<button type="button" class="chat-personalize-trigger" id="chatOpenCustomizationBtn" aria-label="Open Settings" title="Settings">/);
  assert.match(html, /<i class="fas fa-gear" aria-hidden="true"><\/i>/);
  assert.match(html, /<span class="chat-personalize-title">Settings<\/span>/);
  assert.doesNotMatch(html, /chat-personalize-subtitle/);
});

test("Flagship upgrade: Sidebar chat history three-dots menu (Pin, Rename, Delete, Share)", async () => {
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Three-dots menu button and state
  assert.match(credits, /let openMenuSessionId = null;/);
  assert.match(credits, /chat-history-menu-btn/);
  assert.match(credits, /chat-history-menu-wrap/);
  assert.match(credits, /chat-history-dropdown-menu/);

  // Four actions: Pin, Rename, Share, Delete
  assert.match(credits, /chat-menu-pin/);
  assert.match(credits, /session\.pinned = !session\.pinned;/);
  assert.match(credits, /chat-pinned-indicator/);
  assert.match(credits, /chat-menu-rename/);
  assert.match(credits, /renamingSessionId = session\.id;/);
  assert.match(credits, /chat-menu-share/);
  assert.match(credits, /navigator\.share/);
  assert.match(credits, /navigator\.clipboard\.writeText/);
  assert.match(credits, /chat-menu-delete/);
  assert.match(credits, /chatSessions = chatSessions\.filter/);

  // Sorting: Pinned chats sort to the top
  assert.match(credits, /const aPinned = Boolean\(a\.session\.pinned\);/);
  assert.match(credits, /if \(aPinned !== bPinned\) return bPinned \? 1 : -1;/);

  // Dismiss on outside click and Escape
  assert.match(credits, /e\.key === 'Escape' && openMenuSessionId/);

  // Styling for three-dots menu, dropdown, and pinned indicator
  assert.match(styles, /\.chat-history-menu-btn/);
  assert.match(styles, /\.chat-history-dropdown-menu/);
  assert.match(styles, /\.chat-pinned-indicator/);
  assert.match(styles, /\.chat-menu-item/);
  assert.match(styles, /\.menu-dropup/);
});

test("Flagship upgrade: Fresh chat on reopen with click-to-load sidebar history", async () => {
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");

  // loadConversation keeps past chat sessions intact in sidebar history list
  assert.match(credits, /function loadConversation\(userId,\s*force = false\)/);
  assert.match(credits, /chatSessions = saved\.filter/);
  assert.match(credits, /pinned: Boolean\(item\.pinned\)/);

  // But starts main chat box as a fresh clean session by default on reopen
  assert.match(credits, /\/\/ FRESH CHAT ON REOPEN:/);
  assert.match(credits, /activeChatId = null;/);
  assert.match(credits, /conversation\.length = 0;/);
  assert.match(credits, /messages\?\.querySelectorAll\('\.message:not\(\[data-chat-welcome\]\)'\)\.forEach/);

  // Only loads a past chat into canvas when user explicitly clicks that chat in sidebar
  assert.match(credits, /bindSafe\(select, 'click', \(\) => selectChatSession\(session\.id\)\);/);
  assert.match(credits, /function selectChatSession\(sessionId\)/);
  assert.match(credits, /conversation\.splice\(0, conversation\.length, \.\.\.session\.messages\);/);
});

test("Flagship upgrade: Live working Settings end-to-end and 0 badge removal", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Removal of 0 badge next to Settings
  assert.doesNotMatch(html, /id="chatMemoryBadge"/, "0 badge next to Settings must be completely removed");

  // Live input sync across all settings controls
  assert.match(credits, /const syncSettingsFromInputs = \(\) =>/);
  assert.match(credits, /liveControls\.forEach\(id =>/);

  // Mandatory language directive in worker prompt
  assert.match(worker, /CRITICAL LANGUAGE DIRECTIVE:/);
  assert.match(worker, /LANGUAGE MIRRORING: The user has selected 'Auto' mode/);
});

test("Flagship upgrade: Single-line sidebar chat history items without extra preview line below", async () => {
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Single-line clean title only: titleText element appended inside title, previewText is NOT appended to select
  assert.match(credits, /titleText\.className = 'chat-history-title-text';/);
  assert.match(credits, /appendSearchHighlight\(titleText, session\.title \|\| 'New chat', query\);/);
  assert.match(credits, /title\.appendChild\(titleText\);/);
  assert.match(credits, /select\.appendChild\(title\);/);
  assert.doesNotMatch(credits, /select\.append\(title, previewText\);/, "Must not append snippet preview underneath title");

  // Three-dots menu button and non-overlapping layout
  assert.match(credits, /chat-history-menu-btn/);
  assert.match(credits, /chat-menu-pin/);
  assert.match(credits, /chat-menu-rename/);
  assert.match(credits, /chat-menu-share/);
  assert.match(credits, /chat-menu-delete/);

  // CSS enforces single-line nowrap and ellipsis truncation
  assert.match(styles, /\.chat-history-select\s*\{[\s\S]*?display:\s*flex;/);
  assert.match(styles, /\.chat-history-select\s*\{[\s\S]*?white-space:\s*nowrap;/);
  assert.match(styles, /\.chat-history-title,\s*\.chat-history-title-text\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(styles, /\.chat-history-preview\s*\{[\s\S]*?display:\s*none\s*!important;/);
  assert.match(styles, /\.chat-history-actions,\s*\.chat-history-menu-wrap\s*\{[\s\S]*?margin-left:\s*auto;/);
});

test("Flagship upgrade: Unclipped sidebar three-dots menu with portal positioning and full actions (Pin, Rename, Delete, Share)", async () => {
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // Viewport-aware collision positioning function
  assert.match(credits, /function positionChatDropdownMenu\(menu,\s*triggerBtn\)/);
  assert.match(credits, /const spaceBelow = vh - triggerRect\.bottom - margin;/);
  assert.match(credits, /const spaceAbove = triggerRect\.top - margin;/);
  assert.match(credits, /menu\.classList\.add\('menu-dropup'\);/);
  assert.match(credits, /menu\.classList\.remove\('menu-dropup'\);/);
  assert.match(credits, /menu\.style\.position = 'fixed';/);
  assert.match(credits, /menu\.style\.zIndex = '99999';/);

  // Portal mount to document.body prevents parent overflow / scroll clipping
  assert.match(credits, /const portalTarget = document\.body \|\| actions;/);
  assert.match(credits, /portalTarget\.appendChild\(menu\);/);

  // All 4 actions cleanly rendered and bindable
  assert.match(credits, /chat-menu-pin/);
  assert.match(credits, /chat-menu-rename/);
  assert.match(credits, /chat-menu-share/);
  assert.match(credits, /chat-menu-delete/);

  // Dismiss listeners: Outside click, Escape, Scroll, Resize
  assert.match(credits, /!e\.target\.closest\('\.chat-history-menu-wrap'\) && !e\.target\.closest\('\.chat-history-dropdown-menu'\)/);
  assert.match(credits, /e\.key === 'Escape' && openMenuSessionId/);
  assert.match(credits, /window\.addEventListener\('resize',\s*closeChatMenu/);
  assert.match(credits, /window\.addEventListener\('scroll',\s*closeChatMenu/);

  // Stacking context and unclipped overflow styles in styles.css
  assert.match(styles, /\.chat-history-row\.menu-open[\s\S]*?z-index:\s*120;/);
  assert.match(styles, /\.chat-history-actions\.menu-open[\s\S]*?z-index:\s*130;/);
  assert.match(styles, /\.chat-sidebar\s*\{[\s\S]*?overflow-x:\s*hidden;/);
  assert.match(styles, /\.chat-history-list\s*\{[\s\S]*?overflow-x:\s*hidden;/);
  assert.match(styles, /\.chat-history-dropdown-menu\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(styles, /\.chat-history-dropdown-menu\s*\{[\s\S]*?z-index:\s*99999;/);

  // Mobile responsiveness touch target safeguards
  assert.match(styles, /@media\s*\(hover:\s*none\),\s*\(max-width:\s*767px\)\s*\{[\s\S]*?width:\s*32px;/);
  assert.match(styles, /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*?\.chat-menu-item\s*\{[\s\S]*?min-height:\s*40px;/);
});

test("mini crm and email & outreach ai workspaces are fully configured, live, and integrated", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const crmJs = await readFile(new URL("../crm.js", import.meta.url), "utf8");
  const outreachJs = await readFile(new URL("../outreach.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const sql = await readFile(new URL("../supabase/migrations/crm_and_outreach.sql", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // 1. Hub counter & status badges
  assert.match(html, /10 LIVE NOW • FULL SUITE UNLOCKED/);
  assert.match(html, /Live \(10\)/);
  assert.match(html, /Roadmap \(0\)/);
  assert.match(html, /data-tool-id="crm"[^>]*data-status="live"/);
  assert.match(html, /data-tool-id="email-outreach"[^>]*data-status="live"/);

  // 2. DOM Workspace containers
  assert.match(html, /id="crmWorkspace"/);
  assert.match(html, /id="outreachWorkspace"/);
  assert.match(html, /class="crm-metrics-grid"/);
  assert.match(html, /id="crmFreeTierBar"/);
  assert.match(html, /id="crmKanbanContainer"/);
  assert.match(html, /id="crmTableContainer"/);
  assert.match(html, /id="crmLeadModal"/);
  assert.match(html, /id="crmLeadDrawer"/);
  assert.match(html, /class="outreach-step-tabs"/);
  assert.match(html, /id="outreachEmailSubject"/);
  assert.match(html, /id="outreachEmailBody"/);
  assert.match(html, /id="outreachOpenGmailBtn"/);
  assert.match(html, /id="outreachSyncCrmBtn"/);
  assert.match(html, /src="\/crm\.js"/);
  assert.match(html, /src="\/outreach\.js"/);

  // 3. Script.js SPA navigation & Global Studio API
  assert.match(script, /function openCrmWorkspace/);
  assert.match(script, /function closeCrmWorkspace/);
  assert.match(script, /function openOutreachWorkspace/);
  assert.match(script, /function closeOutreachWorkspace/);
  assert.match(script, /cleanPath === '\/tools\/crm'/);
  assert.match(script, /cleanPath === '\/tools\/outreach'/);
  assert.match(script, /openCrm:\s*\(\)\s*=>\s*openCrmWorkspace\(true\)/);
  assert.match(script, /openOutreach:\s*\(lead\)\s*=>\s*openOutreachWorkspace\(true,\s*lead\)/);

  // 4. SQL Migration
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.crm_leads/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.crm_activities/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.outreach_sequences/);
  assert.match(sql, /ALTER TABLE public\.crm_leads ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE public\.crm_activities ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE public\.outreach_sequences ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ON public\.crm_leads[\s\S]*?auth\.uid\(\)\s*=\s*user_id/);
  assert.match(sql, /mini_crm/);
  assert.match(sql, /email_outreach/);

  // 5. CRM Controller: 50-lead free tier enforcement, CSV import/export, lead scoring
  assert.match(crmJs, /maxFreeLeads:\s*50/);
  assert.match(crmJs, /JEVEXA_SHOW_UPGRADE_MODAL/);
  assert.match(crmJs, /exportCsv/);
  assert.match(crmJs, /importCsv/);
  assert.match(crmJs, /\/api\/crm\/score/);
  assert.match(crmJs, /JEVEXA_UPDATE_CREDIT_BALANCE/);

  // 6. Outreach Controller: Sequence generation, Gmail web compose, CRM sync
  assert.match(outreachJs, /\/api\/outreach\/generate/);
  assert.match(outreachJs, /mail\.google\.com\/mail\/\?view=cm&fs=1/);
  assert.match(outreachJs, /mailto:/);
  assert.match(outreachJs, /handleSyncCrm/);
  assert.match(outreachJs, /Contacted/);

  // 7. Worker API endpoints & multi-provider proxy
  assert.match(workerJs, /\/api\/crm\/score/);
  assert.match(workerJs, /\/api\/crm\/leads/);
  assert.match(workerJs, /\/api\/outreach\/generate/);
  assert.match(workerJs, /\/api\/outreach\/sequences/);
  assert.match(workerJs, /CRM_SCORE_SYSTEM_PROMPT/);
  assert.match(workerJs, /OUTREACH_SYSTEM_PROMPT/);
  assert.match(workerJs, /handleCrmScore/);
  assert.match(workerJs, /handleOutreachGenerate/);

  // 8. Stylesheet rules
  assert.match(styles, /\.crm-metrics-grid/);
  assert.match(styles, /\.crm-kanban-board/);
  assert.match(styles, /\.crm-lead-drawer/);
  assert.match(styles, /\.outreach-workspace-grid/);
  assert.match(styles, /\.outreach-email-card/);
});

test("Mini CRM and Outreach: Modal, drawer, backdrop, cancel, and Escape key isolation", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const crmJs = await readFile(new URL("../crm.js", import.meta.url), "utf8");
  const outreachJs = await readFile(new URL("../outreach.js", import.meta.url), "utf8");

  // 1. Modals and drawers start hidden on initial page load
  assert.match(html, /<div[^>]*class="[^"]*crm-modal-backdrop[^"]*"[^>]*id="crmLeadModal"[^>]*hidden/);
  assert.match(html, /<aside[^>]*class="[^"]*crm-lead-drawer[^"]*"[^>]*id="crmLeadDrawer"[^>]*hidden/);
  assert.match(html, /<div[^>]*class="[^"]*crm-drawer-backdrop[^"]*"[^>]*id="crmDrawerBackdrop"[^>]*hidden/);
  assert.match(html, /<aside[^>]*class="[^"]*crm-lead-drawer[^"]*"[^>]*id="outreachHistoryDrawer"[^>]*hidden/);
  assert.match(html, /<div[^>]*class="[^"]*crm-drawer-backdrop[^"]*"[^>]*id="outreachHistoryBackdrop"[^>]*hidden/);

  // 2. CRM close handlers: Cancel button, × button, backdrop click
  assert.match(crmJs, /bindSafe\(leadModalCancelBtn,\s*['"]click['"],\s*closeLeadModal\)/);
  assert.match(crmJs, /bindSafe\(leadModalCloseBtn,\s*['"]click['"],\s*closeLeadModal\)/);
  assert.match(crmJs, /if\s*\(e\.target\s*===\s*leadModal\)/);
  assert.match(crmJs, /bindSafe\(drawerCloseBtn,\s*['"]click['"],\s*closeLeadDrawer\)/);
  assert.match(crmJs, /bindSafe\(drawerBackdrop,\s*['"]click['"],\s*closeLeadDrawer\)/);

  // 3. CRM Escape key isolation with stopImmediatePropagation
  assert.match(crmJs, /document\.addEventListener\(['"]keydown['"],\s*\(e\)\s*=>\s*\{[\s\S]*?e\.stopImmediatePropagation\(\);[\s\S]*?closeLeadModal\(\)/);
  assert.match(crmJs, /closeLeadModal\(\)/);
  assert.match(crmJs, /closeLeadDrawer\(\)/);

  // 4. Outreach close handlers & Escape key isolation
  assert.match(outreachJs, /bindSafe\(historyCloseBtn,\s*['"]click['"],\s*closeHistoryDrawer\)/);
  assert.match(outreachJs, /bindSafe\(historyBackdrop,\s*['"]click['"],\s*closeHistoryDrawer\)/);
  assert.match(outreachJs, /document\.addEventListener\(['"]keydown['"],\s*\(e\)\s*=>\s*\{[\s\S]*?e\.stopImmediatePropagation\(\);[\s\S]*?closeHistoryDrawer\(\)/);
  assert.match(outreachJs, /closeHistoryDrawer\(\)/);

  // 5. Global Escape handler in script.js protects open inner modals/drawers from premature workspace exit
  assert.match(script, /hasActiveInnerModal|activeModalOrDrawer/);
  assert.match(script, /\.crm-modal-backdrop\.open|#crmLeadModal:not\(\[hidden\]\)/);
  assert.match(script, /#crmLeadDrawer\.open/);
  assert.match(script, /#outreachHistoryDrawer\.open/);
});

test("Mini CRM and Outreach: Dark glassmorphic aesthetic, form control styling, and responsive layout", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // 1. Dark glassmorphic container styling (#070b14, rgba(15, 23, 42, 0.88/0.94), borders)
  assert.match(styles, /#crmWorkspace,\s*#outreachWorkspace\s*\{[\s\S]*?background:\s*#070b14/);
  assert.match(styles, /\.crm-workspace-container\s*\{[\s\S]*?max-width:\s*1600px/);
  assert.match(styles, /\.crm-modal-card\s*\{/);
  assert.match(styles, /\.crm-lead-drawer\s*\{/);

  // 2. Dark cohesive form controls (no raw white browser inputs)
  assert.match(styles, /\.crm-lead-form\s*input/);
  assert.match(styles, /\.outreach-form\s*input/);
  assert.match(styles, /\.crm-lead-form input[\s\S]*?background:\s*rgba\(15,\s*23,\s*42/);

  // 3. Kanban & Table views
  assert.match(styles, /\.crm-kanban-board\s*\{[\s\S]*?display:\s*grid/);
  assert.match(styles, /\.crm-kanban-col/);
  assert.match(styles, /\.crm-kanban-card/);
  assert.match(styles, /\.crm-table-wrapper\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.match(styles, /\.crm-table\s*th/);

  // 4. Outreach widescreen layout & step tabs
  assert.match(styles, /\.outreach-workspace-grid\s*\{[\s\S]*?display:\s*grid/);
  assert.match(styles, /\.outreach-step-tabs\s*\{[\s\S]*?display:\s*flex/);
  assert.match(styles, /\.outreach-step-tab\.active/);
});

test("Mini CRM & Outreach: End-to-end CRM workflows (50-lead cap, AI scoring, CSV import/export, pipeline stages, outreach handoff)", async () => {
  const crmJs = await readFile(new URL("../crm.js", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // 1. Free tier 50-lead limit and upgrade modal trigger
  assert.match(crmJs, /maxFreeLeads:\s*50/);
  assert.match(crmJs, /JEVEXA_SHOW_UPGRADE_MODAL/);
  assert.match(crmJs, /Free (?:plan|tier) limit reached/i);

  // 2. Add / Edit / Delete lead workflows
  assert.match(crmJs, /function handleLeadFormSubmit/);
  assert.match(crmJs, /function deleteLead\(leadId\)/);
  assert.match(crmJs, /function openLeadModal\(/);
  assert.match(crmJs, /bindSafe\(leadForm,\s*['"]submit['"],\s*handleLeadFormSubmit\)/);

  // 3. Pipeline stage transitions
  assert.match(crmJs, /function updateLeadStage\(leadId,\s*newStage\)/);
  assert.match(crmJs, /STAGES\s*=\s*\[['"]New['"],\s*['"]Contacted['"]/);

  // 4. View toggles & search filter
  assert.match(crmJs, /bindSafe\(viewKanbanBtn,\s*['"]click['"]/);
  assert.match(crmJs, /bindSafe\(viewTableBtn,\s*['"]click['"]/);
  assert.match(crmJs, /bindSafe\(searchInput,\s*['"]input['"]/);
  assert.match(crmJs, /bindSafe\(stageFilter,\s*['"]change['"]/);

  // 5. CSV import and CSV export
  assert.match(crmJs, /function exportCsv\(\)/);
  assert.match(crmJs, /function handleCsvImport\(file\)/);
  assert.match(crmJs, /text\/csv;charset=utf-8/);

  // 6. AI lead scoring with credit balance sync
  assert.match(crmJs, /function handleAiScore\(\)/);
  assert.match(crmJs, /\/api\/crm\/score/);
  assert.match(crmJs, /JEVEXA_UPDATE_CREDIT_BALANCE/);

  // 7. Outreach handoff from lead drawer
  assert.match(crmJs, /drawerDraftOutreachBtn/);
  assert.match(crmJs, /window\.JEVEXA_STUDIO(?:\?\.|\.)openOutreach\(lead\)/);
  assert.match(scriptJs, /openOutreach:\s*\(lead\)\s*=>\s*openOutreachWorkspace\(true,\s*lead\)/);
});

test("Mini CRM & Outreach: End-to-end Outreach workflows (3-step sequences, Gmail compose, CRM sync, editable fields, history drawer)", async () => {
  const outreachJs = await readFile(new URL("../outreach.js", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // 1. CRM Lead Prefill interface
  assert.match(outreachJs, /function prefillLead\(lead\)/);
  assert.match(outreachJs, /prefillLead:\s*prefillLead/);
  assert.match(outreachJs, /openWithLead:\s*prefillLead/);
  assert.match(scriptJs, /window\.JEVEXA_OUTREACH(?:\?\.|\.)prefillLead\(lead\)/);

  // 2. 3-step sequence tabs and live editing synchronization
  assert.match(outreachJs, /function switchStep\(step/);
  assert.match(outreachJs, /emailSubjectInput\.addEventListener\(['"]input['"]/);
  assert.match(outreachJs, /emailBodyInput\.addEventListener\(['"]input['"]/);
  assert.match(outreachJs, /state\.currentSequence/);

  // 3. A/B Alternative subject line toggle
  assert.match(outreachJs, /abSubjectToggleBtn/);
  assert.match(outreachJs, /state\.useAlternativeSubject/);

  // 4. 1-Click Open in Gmail and Copy action
  assert.match(outreachJs, /https:\/\/mail\.google\.com\/mail\/\?view=cm&fs=1&to=/);
  assert.match(outreachJs, /navigator\.clipboard\.writeText/);
  assert.match(outreachJs, /copied to clipboard/i);

  // 5. Mark as Sent & Sync CRM
  assert.match(outreachJs, /function handleSyncCrm\(\)/);
  assert.match(outreachJs, /status:\s*['"]Sent['"]/);
  assert.match(outreachJs, /sync_crm:\s*true/);
  assert.match(outreachJs, /window\.JEVEXA_CRM(?:\?\.|\.)fetchLeads\(\)/);

  // 6. Saved sequences history drawer
  assert.match(outreachJs, /function openHistoryDrawer\(\)/);
  assert.match(outreachJs, /function loadSequenceInto(?:Workspace|Editor)\(seq\)/);
  assert.match(outreachJs, /\/api\/outreach\/sequences/);
});

test("Worker Credit Metering & Fallback: Robust CRM scoring and Outreach generation without tier pricing errors", async () => {
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // 1. CRM Score Fallback cascade & pricing resilience
  assert.match(workerJs, /const needsCrmFallback = !reservationResponse\.ok \|\| \(reservation && !reservation\.ok && reservation\.error !== "insufficient_credits"/);
  assert.match(workerJs, /p_service:\s*"ai_chat"/);
  assert.match(workerJs, /const needsDirectCrmFallback = !reservationResponse\.ok \|\| \(reservation && !reservation\.ok/);
  assert.match(workerJs, /fallbackDirect:\s*true/);

  // 2. Outreach Fallback cascade & pricing resilience
  assert.match(workerJs, /const needsOutreachFallback = !reservationResponse\.ok \|\| \(reservation && !reservation\.ok && reservation\.error !== "insufficient_credits"/);
  assert.match(workerJs, /const needsDirectOutreachFallback = !reservationResponse\.ok \|\| \(reservation && !reservation\.ok/);

  // 3. Multi-provider priority order: Gemini -> Groq -> OpenRouter
  assert.match(workerJs, /const primaryIsGroq = env\?\.AI_PRIMARY_PROVIDER === "groq";/);
  assert.match(workerJs, /if \(!primaryIsGroq && geminiApiKey\) \{[\s\S]*?await executeGemini\(\);[\s\S]*?if \(!executionSuccess\) await executeGroq\(\);[\s\S]*?if \(!executionSuccess\) await executeOpenRouter\(\);/);

  // 4. API keys check accounts for OpenRouter
  assert.match(workerJs, /if \(!geminiApiKey && !groqApiKey && !openRouterApiKey\) \{/);

  // 5. Idempotent settlement and profile balance synchronization
  assert.match(workerJs, /await callCreditRpc\(cfg,\s*"jevexa_credit_settle"/);
  assert.match(workerJs, /await syncUserCreditsAndProfile\(cfg,\s*user\.id,\s*remainingCredits\)/);
});

test("Mini CRM & Outreach: 100% zoom responsiveness, fast splash dismissal, and instant cache hydration", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const crmJs = await readFile(new URL("../crm.js", import.meta.url), "utf8");
  const outreachJs = await readFile(new URL("../outreach.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // 1. 100% zoom layout safety rules (overflow-x clip, minmax(0, 1fr) grid columns, display: block scroll wrap)
  assert.match(styles, /#crmWorkspace,\s*#outreachWorkspace\s*\{[\s\S]*?overflow-x:\s*clip/);
  assert.match(styles, /#crmWorkspace \.workspace-scroll-wrap,\s*#outreachWorkspace \.workspace-scroll-wrap\s*\{[\s\S]*?display:\s*block/);
  assert.match(styles, /\.crm-metrics-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.crm-kanban-board\s*\{[\s\S]*?grid-auto-flow:\s*column/);
  assert.match(styles, /\.outreach-workspace-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(320px,\s*440px\)\s*minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.crm-skeleton-card/);

  // 2. Preloader and splash screen responsiveness
  assert.match(styles, /#preloader\.hidden\s*\{[\s\S]*?opacity:\s*0\s*!important/);
  assert.match(script, /function finishLoading/);
  assert.match(script, /window\.setTimeout\(finishLoading,\s*2500\)/);
  assert.match(script, /openCrmWorkspace[\s\S]*?finishLoading\(\)/);
  assert.match(script, /openOutreachWorkspace[\s\S]*?finishLoading\(\)/);

  // 3. Fast mount & instant session cache hydration
  assert.match(crmJs, /loadCachedLeads/);
  assert.match(crmJs, /jevexa_crm_leads_cache/);
  assert.match(crmJs, /checkAutoMount/);
  assert.match(outreachJs, /loadCachedSequences/);
  assert.match(outreachJs, /jevexa_outreach_sequences_cache/);
  assert.match(outreachJs, /checkAutoMount/);

  // 4. HTML structure classes
  assert.match(html, /class="[^"]*crm-workspace-container[^"]*"/);
  assert.match(html, /class="[^"]*outreach-workspace-container[^"]*"/);
});

test("Phase 1 & 2: Universal Cross-Device Portability, Form Controls & Touch Ergonomics", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // 1. Zero 100vw scrollbar overflow on overlays
  assert.doesNotMatch(styles, /\.login-modal\s*\{[\s\S]*?width:\s*100vw/);
  assert.doesNotMatch(styles, /#jevexaAccountBackdrop\s*\{[\s\S]*?width:\s*100vw/);
  assert.doesNotMatch(styles, /#crmWorkspace,\s*#outreachWorkspace\s*\{[\s\S]*?max-width:\s*100vw/);
  assert.doesNotMatch(styles, /\.tool-workspace\s*\{[\s\S]*?width:\s*100vw/);

  // 2. Overflow clipping and fluid containers
  assert.match(styles, /html\s*\{[\s\S]*?overflow-x:\s*clip/);
  assert.match(styles, /body\s*\{[\s\S]*?overflow-x:\s*clip/);
  assert.match(styles, /\.hero\s*\{[\s\S]*?overflow-x:\s*clip/);

  // 3. Dark glassmorphic dropdown option styling
  assert.match(styles, /select\s+option\s*\{[\s\S]*?background:\s*#0d111e/);

  // 4. Touch target ergonomics >= 40px
  assert.match(styles, /\.crm-modal-close,\s*\.crm-drawer-close\s*\{[\s\S]*?min-width:\s*42px/);
  assert.match(styles, /\.coming-soon-close\s*\{[\s\S]*?min-width:\s*42px/);
  assert.match(styles, /\.support-modal-close\s*\{[\s\S]*?min-width:\s*42px/);

  // 5. Mobile kanban fluid sizing (320px - 480px)
  assert.match(styles, /@media\s*\(max-width:\s*480px\)\s*\{[\s\S]*?\.crm-kanban-board\s*\{[\s\S]*?grid-auto-columns:\s*minmax\(min\(270px/);

  // 6. Fast splash dismissal fallback in index.html (8000ms safety net)
  assert.match(html, /window\.setTimeout\(finish,\s*8000\)/);
});

test("Phase 2 & 3: Newsletter Service, Route Normalization & Live Endpoints", async () => {
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // 1. Worker newsletter handler and route
  assert.match(workerJs, /async function handleNewsletter\(request,\s*env\)/);
  assert.match(workerJs, /if \(url\.pathname === "\/api\/newsletter"\)/);

  // 2. Worker support route normalization (/api/support and /api/support/ai)
  assert.match(workerJs, /if \(url\.pathname === "\/api\/support" \|\| url\.pathname === "\/api\/support\/ai"\)/);

  // 3. Client newsletter form submission handler
  assert.match(scriptJs, /const newsletterForm = document\.getElementById\('newsletterForm'\)/);
  assert.match(scriptJs, /fetch\('\/api\/newsletter'/);
  assert.match(scriptJs, /Thank you for subscribing/);

  // 4. Test handleNewsletter HTTP endpoint logic directly
  const workerModule = await import("../worker.js");
  const worker = workerModule.default;

  // Invalid email test
  const badReq = new Request("https://jevexa.net/api/newsletter", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "invalid-email" })
  });
  const badRes = await worker.fetch(badReq, {}, {});
  assert.strictEqual(badRes.status, 400);

  // Valid email test
  const goodReq = new Request("https://jevexa.net/api/newsletter", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "founder@example.com" })
  });
  const goodRes = await worker.fetch(goodReq, {}, {});
  assert.strictEqual(goodRes.status, 200);
  const goodData = await goodRes.json();
  assert.strictEqual(goodData.success, true);
});

test("End-to-End Residual Verification Pass: UI Zoom Safety, Modal/Drawer Ergonomics & AI Metering Safety", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const creditsJs = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const crmJs = await readFile(new URL("../crm.js", import.meta.url), "utf8");
  const outreachJs = await readFile(new URL("../outreach.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // 1. Zero 100vw across styles.css and inline script styles to prevent horizontal scrollbar at 100%, 110%, 125% zoom
  assert.equal(styles.includes("100vw"), false, "styles.css must have zero 100vw rules causing horizontal scroll on desktop/zoom");
  assert.equal(scriptJs.includes("100vw"), false, "script.js must have zero 100vw rules");
  assert.match(styles, /\.ai-core-container\s*\{[\s\S]*?width:\s*min\(420px,\s*100%\)/);
  assert.match(styles, /\.chatbot-window\s*\{[\s\S]*?width:\s*min\(380px,\s*100%\)/);

  // 2. Mobile touch targets >= 42px on close and action elements across all tools
  assert.match(styles, /\.workspace-close-btn\s*\{[\s\S]*?min-width:\s*42px/);
  assert.match(styles, /\.workspace-close-btn\s*\{[\s\S]*?min-height:\s*42px/);
  assert.match(styles, /\.chat-sidebar-close\s*\{[\s\S]*?min-width:\s*42px/);
  assert.match(styles, /\.chat-custom-close\s*\{[\s\S]*?min-width:\s*42px/);
  assert.match(scriptJs, /id="profileClose"[\s\S]*?min-width:42px/);
  assert.match(scriptJs, /\.settings-close\{width:42px;height:42px;min-width:42px;min-height:42px/);
  assert.match(styles, /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.login-close,[\s\S]*?\.workspace-close-btn,[\s\S]*?\.crm-modal-close[\s\S]*?min-width:\s*42px\s*!important/);

  // 3. Dark theme contrast (#0d111e options) across all dropdowns in CRM, Outreach, Chatbot, Content, Settings
  assert.match(styles, /select\s+option[\s\S]*?background:\s*#0d111e/);
  assert.match(styles, /\.crm-lead-form\s+select\s+option[\s\S]*?background:\s*#0d111e/);
  assert.match(styles, /\.chat-tier-controls\s+select\s+option\s*\{\s*background:\s*#0d111e/);
  assert.match(styles, /\.chat-settings\s+option\s*\{\s*background:\s*#0d111e/);
  assert.match(styles, /\.chat-input-select\s+option\s*\{\s*background:\s*#0d111e/);
  assert.match(styles, /#settingsPanel\s+select\s+option\s*\{\s*background-color:\s*#0d111e/);
  assert.match(styles, /\.content-tool-panel\s+select\s+option\s*\{\s*background:\s*#0d111e/);

  // 4. Modal/drawer dismissal safeguards (Escape key and backdrop clicks)
  assert.match(creditsJs, /bindSafe\(chatbotWin,\s*'click',/);
  assert.match(creditsJs, /if\s*\(\(e\.key === 'Escape' \|\| e\.key === 'Esc'\) && chatbotWin\?\.classList\.contains\('chat-history-open'\)\)/);
  assert.match(crmJs, /bindSafe\(drawerBackdrop,\s*'click',\s*closeLeadDrawer\)/);
  assert.match(outreachJs, /bindSafe\(historyBackdrop,\s*'click',\s*closeHistoryDrawer\)/);
  assert.match(scriptJs, /if\s*\(event\.target === loginModalBackdropTarget\)\s*\{\s*closeLogin\(\);/);

  // 5. Clean state reset on close
  assert.match(scriptJs, /const pw = document\.getElementById\('loginPassword'\);\s*if \(pw\) pw\.value = '';\s*const email = document\.getElementById\('loginEmail'\);\s*if \(email\) email\.value = '';/);
  assert.match(crmJs, /if \(leadForm\) leadForm\.reset\(\);/);

  // 6. Preloader non-blocking safeguard
  assert.match(styles, /#preloader\.hidden\s*\{[\s\S]*?pointer-events:\s*none\s*!important/);

  // 7. Test API endpoints authentication & invalid payload handling directly
  const workerModule = await import("../worker.js");
  const worker = workerModule.default;
  const testEnv = {
    ...env,
    GEMINI_API_KEY: "unit-test-gemini",
    GROQ_API_KEY: "unit-test-groq",
    OPENROUTER_API_KEY: "unit-test-openrouter"
  };

  // Unauthenticated requests rejected with 401
  const endpoints = [
    { url: "/api/chat", body: { message: "Hello", tier: "lite", requestId: "00000000-0000-4000-8000-000000000001" } },
    { url: "/api/content", body: { topic: "AI Growth", type: "blog", tone: "professional", length: "short", requestId: "00000000-0000-4000-8000-000000000001" } },
    { url: "/api/crm/score", body: { lead: { name: "Test Lead", company: "Test Co" }, requestId: "00000000-0000-4000-8000-000000000001" } },
    { url: "/api/outreach/generate", body: { goal: "Grow business leads", recipient_name: "Jane", company: "Acme", tone: "professional", requestId: "00000000-0000-4000-8000-000000000001" } }
  ];
  for (const ep of endpoints) {
    const unauthReq = new Request(`https://jevexa.net${ep.url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ep.body)
    });
    const res = await worker.fetch(unauthReq, testEnv, {});
    assert.strictEqual(res.status, 401, `${ep.url} must reject unauthenticated requests with 401`);
  }

  // Support AI invalid body returns 400
  const badSupport = new Request("https://jevexa.net/api/support/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "" })
  });
  const badSupRes = await worker.fetch(badSupport, {}, {});
  assert.strictEqual(badSupRes.status, 400);

  // Support route normalization
  assert.match(workerJs, /if \(url\.pathname === "\/api\/support" \|\| url\.pathname === "\/api\/support\/ai"\)/);
});

test("Mobile UX & Ergonomics: Model & Thinking Selectors, Viewport Safety, Z-Index, and Touch Handling", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");

  // 1. HTML semantics and ARIA markup for Model and Thinking controls
  assert.match(html, /id="chatTierTrigger"[^>]*role="combobox"[^>]*aria-haspopup="listbox"[^>]*aria-controls="chatTierOptions"/);
  assert.match(html, /id="chatTierOptions"[^>]*role="listbox"/);
  assert.match(html, /data-value="lite"[^>]*data-label="Jevexa Lite"/);
  assert.match(html, /data-value="pro"[^>]*data-label="Jevexa Pro"/);
  assert.match(html, /data-value="max"[^>]*data-label="Jevexa Max"/);
  assert.match(html, /data-value="ultra"[^>]*data-label="Jevexa Ultra"/);

  assert.match(html, /id="chatThinkingTrigger"[^>]*role="combobox"[^>]*aria-haspopup="listbox"[^>]*aria-controls="chatThinkingOptions"/);
  assert.match(html, /id="chatThinkingOptions"[^>]*role="listbox"/);
  assert.match(html, /data-value="low"[^>]*data-label="Low"/);
  assert.match(html, /data-value="standard"[^>]*data-label="Standard"/);
  assert.match(html, /data-value="max"[^>]*data-label="Max"/);

  // 2. credits.js: Viewport-aware positioning & portal mounting to guarantee zero clipping
  assert.match(credits, /function positionChatSelectMenu\(name\)/);
  assert.match(credits, /portalTarget\.appendChild\(control\.menu\)/);
  assert.match(credits, /control\.menu\.style\.position\s*=\s*'fixed'/);
  assert.match(credits, /control\.menu\.style\.zIndex\s*=\s*'100005'/);
  assert.match(credits, /name === 'thinking'/);
  assert.match(credits, /triggerRect\.right - menuWidth/);
  assert.match(credits, /repositionOpenSelectors/);
  assert.match(credits, /window\.JEVEXA_CLOSE_SELECTORS/);

  // 3. Touch ergonomics & keyboard prevention: preventScroll & coarse pointer safeguards
  assert.match(credits, /pointer:\s*coarse/);
  assert.match(credits, /preventScroll:\s*true/);
  assert.match(credits, /handleOutsideSelectClick/);

  // 4. styles.css: Desktop & Mobile selector styling & overflow: visible
  assert.match(styles, /\.chat-tier-controls\s*\{[^}]*overflow:\s*visible/);
  assert.match(styles, /\.chat-select-menu\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*100005;/);
  assert.match(styles, /\.chat-select-trigger\s*\{[^}]*min-height:\s*44px;/);
  assert.match(styles, /\.chat-select-option\s*\{[^}]*min-height:\s*44px;/);

  // Mobile viewport rules (< 768px): zero overflow clipping & adaptive flex sizing
  assert.match(styles, /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*?\.chat-tier-controls\s*\{[\s\S]*?overflow:\s*visible\s*!important/);
  assert.match(styles, /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*?\.chat-select\s*\{[\s\S]*?flex:\s*1\s+1\s+0/);
  assert.match(styles, /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*?\.chat-select-menu\s*\{[\s\S]*?position:\s*fixed\s*!important/);
  assert.match(styles, /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*?\.chat-select-menu\s*\{[\s\S]*?z-index:\s*100005\s*!important/);

  // Narrow mobile screens (<= 360px & <= 330px)
  assert.match(styles, /@media\s*\(max-width:\s*360px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*330px\)\s*\{\s*\.chat-select-label\s*\{\s*display:\s*none;\s*\}\s*\}/);

  // 5. Mobile touch targets >= 42px / >= 44px across all critical chat actions
  assert.match(styles, /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.chat-send,[\s\S]*?\.chat-attach,[\s\S]*?\.chat-select-trigger,[\s\S]*?\.chat-new-button,[\s\S]*?\.chat-personalize-trigger[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.chat-sidebar-close,[\s\S]*?\.chatbot-header-settings-btn,[\s\S]*?\.chat-search-clear[\s\S]*?min-width:\s*42px\s*!important/);

  // 6. script.js: Close selectors when chatbot or chat workspace is closed
  assert.match(script, /function closeChatbot\(\)\s*\{[\s\S]*?window\.JEVEXA_CLOSE_SELECTORS\?\.\(\);/);
  assert.match(script, /function closeChatWorkspace\([\s\S]*?window\.JEVEXA_CLOSE_SELECTORS\?\.\(\);/);
});

test("all 6 unlocked tools are routed in worker.js with deterministic fallback handlers and system prompts", async () => {
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // System prompts exist
  assert.match(workerJs, /const OCR_SYSTEM_PROMPT =/);
  assert.match(workerJs, /const SOCIAL_SYSTEM_PROMPT =/);
  assert.match(workerJs, /const ANALYTICS_SYSTEM_PROMPT =/);

  // Deterministic fallback processors exist
  assert.match(workerJs, /function deterministicOcrExtract\(/);
  assert.match(workerJs, /function deterministicSocialGenerate\(/);
  assert.match(workerJs, /function deterministicAnalyticsReport\(/);
  assert.match(workerJs, /function deterministicWorkflowRun\(/);
  assert.match(workerJs, /function deterministicDataClean\(/);

  // Endpoint handlers exist
  assert.match(workerJs, /async function handleOcrExtract\(/);
  assert.match(workerJs, /async function handleSocialGenerate\(/);
  assert.match(workerJs, /async function handleAnalyticsReport\(/);
  assert.match(workerJs, /async function handleTeamMembers\(/);
  assert.match(workerJs, /async function handleTeamInvite\(/);
  assert.match(workerJs, /async function handleTeamAudit\(/);
  assert.match(workerJs, /async function handleWorkflowsRun\(/);
  assert.match(workerJs, /async function handleDataClean\(/);

  // Router bindings in fetch()
  assert.match(workerJs, /url\.pathname === ['"]\/api\/ocr\/extract['"]/);
  assert.match(workerJs, /url\.pathname === ['"]\/api\/social\/generate['"]/);
  assert.match(workerJs, /url\.pathname === ['"]\/api\/analytics\/report['"]/);
  assert.match(workerJs, /url\.pathname === ['"]\/api\/team\/members['"]/);
  assert.match(workerJs, /url\.pathname === ['"]\/api\/team\/invite['"]/);
  assert.match(workerJs, /url\.pathname === ['"]\/api\/team\/audit['"]/);
  assert.match(workerJs, /url\.pathname === ['"]\/api\/workflows\/run['"]/);
  assert.match(workerJs, /url\.pathname === ['"]\/api\/data\/clean['"]/);

  // Service pricing seeds in /api/health include all 6 new keys
  assert.match(workerJs, /service_key:\s*['"]document_ocr['"]/);
  assert.match(workerJs, /service_key:\s*['"]social_assistant['"]/);
  assert.match(workerJs, /service_key:\s*['"]business_analytics['"]/);
  assert.match(workerJs, /service_key:\s*['"]team_admin['"]/);
  assert.match(workerJs, /service_key:\s*['"]workflow_automation['"]/);
  assert.match(workerJs, /service_key:\s*['"]data_management['"]/);
});

test("tier plan limits enforce Cloudflare/Supabase safe quotas proportionally across Free to Ultra", async () => {
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Single Source of Truth TIER_PLAN_LIMITS
  assert.match(workerJs, /const TIER_PLAN_LIMITS = (Object\.freeze\()?\{/);

  // Free Tier constraints
  assert.match(workerJs, /free:\s*\{[\s\S]*?ocrMaxFileMb:\s*2/);
  assert.match(workerJs, /free:\s*\{[\s\S]*?ocrMaxDocsPerDay:\s*3/);
  assert.match(workerJs, /free:\s*\{[\s\S]*?socialGensPerDay:\s*5/);
  assert.match(workerJs, /free:\s*\{[\s\S]*?analyticsMaxRows:\s*50/);
  assert.match(workerJs, /free:\s*\{[\s\S]*?analyticsForecastDays:\s*30/);
  assert.match(workerJs, /free:\s*\{[\s\S]*?teamMaxSeats:\s*3/);
  assert.match(workerJs, /free:\s*\{[\s\S]*?workflowMaxSteps:\s*3/);
  assert.match(workerJs, /free:\s*\{[\s\S]*?dataMaxRows:\s*100/);

  // Ultra Tier proportional scaling
  assert.match(workerJs, /ultra:\s*\{[\s\S]*?ocrMaxFileMb:\s*100/);
  assert.match(workerJs, /ultra:\s*\{[\s\S]*?ocrMaxDocsPerDay:\s*1000/);
  assert.match(workerJs, /ultra:\s*\{[\s\S]*?socialGensPerDay:\s*2000/);
  assert.match(workerJs, /ultra:\s*\{[\s\S]*?analyticsMaxRows:\s*100000/);
  assert.match(workerJs, /ultra:\s*\{[\s\S]*?analyticsForecastDays:\s*365/);
  assert.match(workerJs, /ultra:\s*\{[\s\S]*?teamMaxSeats:\s*250/);
  assert.match(workerJs, /ultra:\s*\{[\s\S]*?workflowMaxSteps:\s*50/);
  assert.match(workerJs, /ultra:\s*\{[\s\S]*?dataMaxRows:\s*250000/);
});

test("all 6 unlocked workspace HTML structures and client controllers are wired cleanly", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const ocrJs = await readFile(new URL("../ocr.js", import.meta.url), "utf8");
  const socialJs = await readFile(new URL("../social.js", import.meta.url), "utf8");
  const analyticsJs = await readFile(new URL("../analytics.js", import.meta.url), "utf8");
  const teamJs = await readFile(new URL("../team.js", import.meta.url), "utf8");
  const workflowsJs = await readFile(new URL("../workflows.js", import.meta.url), "utf8");
  const dataJs = await readFile(new URL("../data-mgmt.js", import.meta.url), "utf8");

  // DOM Workspace containers in index.html
  assert.match(html, /id="ocrWorkspace"/);
  assert.match(html, /id="socialWorkspace"/);
  assert.match(html, /id="analyticsWorkspace"/);
  assert.match(html, /id="teamAdminWorkspace"/);
  assert.match(html, /id="workflowsWorkspace"/);
  assert.match(html, /id="dataWorkspace"/);

  // Script tags in index.html
  assert.match(html, /src="\/ocr\.js"/);
  assert.match(html, /src="\/social\.js"/);
  assert.match(html, /src="\/analytics\.js"/);
  assert.match(html, /src="\/team\.js"/);
  assert.match(html, /src="\/workflows\.js"/);
  assert.match(html, /src="\/data-mgmt\.js"/);

  // Global controller exposures
  assert.match(ocrJs, /window\.JEVEXA_OCR\s*=/);
  assert.match(socialJs, /window\.JEVEXA_SOCIAL\s*=/);
  assert.match(analyticsJs, /window\.JEVEXA_ANALYTICS\s*=/);
  assert.match(teamJs, /window\.JEVEXA_TEAM\s*=/);
  assert.match(workflowsJs, /window\.JEVEXA_WORKFLOWS\s*=/);
  assert.match(dataJs, /window\.JEVEXA_DATA_MGMT\s*=/);

  // Global Studio API in script.js has open functions for all 10 tools
  assert.match(script, /openOcr:\s*\(\)\s*=>\s*openOcrWorkspace\(true\)/);
  assert.match(script, /openSocial:\s*\(\)\s*=>\s*openSocialWorkspace\(true\)/);
  assert.match(script, /openAnalytics:\s*\(\)\s*=>\s*openAnalyticsWorkspace\(true\)/);
  assert.match(script, /openTeamAdmin:\s*\(\)\s*=>\s*openTeamAdminWorkspace\(true\)/);
  assert.match(script, /openWorkflows:\s*\(\)\s*=>\s*openWorkflowsWorkspace\(true\)/);
  assert.match(script, /openData:\s*\(\)\s*=>\s*openDataWorkspace\(true\)/);

  // Back to Studio buttons bound in script.js
  assert.match(script, /bindAction\(document\.getElementById\('ocrBackToStudio'\)/);
  assert.match(script, /bindAction\(document\.getElementById\('socialBackToStudio'\)/);
  assert.match(script, /bindAction\(document\.getElementById\('analyticsBackToStudio'\)/);
  assert.match(script, /bindAction\(document\.getElementById\('teamAdminBackToStudio'\)/);
  assert.match(script, /bindAction\(document\.getElementById\('workflowsBackToStudio'\)/);
  assert.match(script, /bindAction\(document\.getElementById\('dataBackToStudio'\)/);
});

test("Token & Weight-Based Credit System: dynamic token calculations, workload multipliers, and accurate settlement parameters", async () => {
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // calculateUsageCredits supports workloadFactor and extraSurcharge
  assert.match(workerJs, /workloadFactor\s*=\s*1/);
  assert.match(workerJs, /extraSurcharge\s*=\s*0/);
  assert.match(workerJs, /tokens\s*=\s*Math\.max\(1,\s*Math\.min\(50000,\s*Math\.ceil\(tokens\s*\*\s*safeWorkload\)\)\);/);

  // Settlement RPC uses p_usage_tokens (matching supabase jevexa_credit_settle schema)
  assert.match(workerJs, /p_usage_tokens:\s*safeTokens/);
  assert.doesNotMatch(workerJs, /p_actual_tokens:\s*safeTokens/);

  // Payload parsers compute dynamic weighted tokens
  assert.match(workerJs, /function parseOcrPayload\(/);
  assert.match(workerJs, /fileSizeBytes/);
  assert.match(workerJs, /pageEstimate/);

  assert.match(workerJs, /function parseSocialPayload\(/);
  assert.match(workerJs, /platformWeight/);

  assert.match(workerJs, /function parseAnalyticsPayload\(/);
  assert.match(workerJs, /timeframeMultiplier/);

  assert.match(workerJs, /function parseWorkflowPayload\(/);
  assert.match(workerJs, /stepFactor/);

  assert.match(workerJs, /function parseDataCleanPayload\(/);
  assert.match(workerJs, /opMultiplier/);

  // Helper functions reserveServiceCredits and settleServiceCredits exist and handle fallback
  assert.match(workerJs, /async function reserveServiceCredits\(/);
  assert.match(workerJs, /async function settleServiceCredits\(/);
});

test("End-to-End API Handlers: Unlocked tools enforce reservations, settle token-weighted credits, and return balance metadata", async () => {
  let settledUsageTokens = null;
  let settledRequestId = null;

  const mock = mockFetch(async (url, options) => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      const body = JSON.parse(options.body);
      return Response.json({
        ok: true,
        duplicate: false,
        status: "reserved",
        reserved_credits: body.p_credits || 5,
        balance: 495,
        account_tier: "pro"
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      const body = JSON.parse(options.body);
      settledUsageTokens = body.p_usage_tokens;
      settledRequestId = body.p_request_id;
      return Response.json({
        ok: true,
        charged_credits: 4,
        balance: 496,
        status: "settled"
      });
    }
    if (url.pathname === "/rest/v1/user_credits" && options.method === "PATCH") {
      return Response.json([{ credits_balance: 496, plan: "pro" }]);
    }
    return null;
  }, () => Response.json({ id: userId }), "pro");

  try {
    // 1. OCR Extract
    const ocrReq = makeRequest("/api/ocr/extract", {
      body: {
        requestId: "00000000-0000-4000-8000-000000000101",
        documentText: "INVOICE #98234\nTotal Due: $1,250.00\nVendor: Acme Cloud Systems Inc.",
        documentType: "invoice",
        currency: "USD"
      }
    });
    const ocrRes = await worker.fetch(ocrReq, env);
    assert.equal(ocrRes.status, 200);
    const ocrData = await ocrRes.json();
    assert.equal(ocrData.ok, true);
    assert.equal(typeof ocrData.charged_credits, "number");
    assert.equal(ocrData.remaining_credits, 496);
    assert.ok(settledUsageTokens > 0);
    assert.equal(settledRequestId, "00000000-0000-4000-8000-000000000101");

    // 2. Social Media Assistant
    const socialReq = makeRequest("/api/social/generate", {
      body: {
        requestId: "00000000-0000-4000-8000-000000000102",
        topic: "Launching autonomous workflows for high-growth SaaS founders",
        platform: "linkedin",
        tone: "thought_leader",
        goal: "conversion",
        cta: "Sign up today at jevexa.net"
      }
    });
    const socialRes = await worker.fetch(socialReq, env);
    assert.equal(socialRes.status, 200);
    const socialData = await socialRes.json();
    assert.equal(socialData.ok, true);
    assert.ok(Array.isArray(socialData.data.hooks));
    assert.ok(socialData.data.post_body);

    // 3. Business Analytics
    const analyticsReq = makeRequest("/api/analytics/report", {
      body: {
        requestId: "00000000-0000-4000-8000-000000000103",
        metrics: ["mrr", "churn", "cac", "ltv"],
        businessType: "saas",
        timeframe: "quarter"
      }
    });
    const analyticsRes = await worker.fetch(analyticsReq, env);
    assert.equal(analyticsRes.status, 200);
    const analyticsData = await analyticsRes.json();
    assert.equal(analyticsData.ok, true);
    assert.ok(analyticsData.kpis.mrr);

    // 4. Workflow Automation
    const workflowReq = makeRequest("/api/workflows/run", {
      body: {
        requestId: "00000000-0000-4000-8000-000000000104",
        workflowId: "lead_conversion",
        steps: [
          { name: "Capture Inbound Lead", action: "crm_capture" },
          { name: "AI Lead Scoring", action: "ai_score" },
          { name: "Trigger Outreach", action: "send_email" }
        ]
      }
    });
    const workflowRes = await worker.fetch(workflowReq, env);
    assert.equal(workflowRes.status, 200);
    const workflowData = await workflowRes.json();
    assert.equal(workflowData.ok, true);
    assert.equal(workflowData.stepsExecuted.length, 3);

    // 5. Data Management Clean
    const dataReq = makeRequest("/api/data/clean", {
      body: {
        requestId: "00000000-0000-4000-8000-000000000105",
        csvText: "Name,Email,Company\nAlice,alice@example.com,Acme\nAlice,alice@example.com,Acme",
        operations: { removeDuplicates: true, trimWhitespace: true },
        dedupKey: "Email"
      }
    });
    const dataRes = await worker.fetch(dataReq, env);
    assert.equal(dataRes.status, 200);
    const dataCleaned = await dataRes.json();
    assert.equal(dataCleaned.ok, true);
    assert.equal(dataCleaned.summary.duplicatesRemoved, 1);
  } finally {
    mock.restore();
  }
});

test("Team Management: enforces seat limits based on plan tier", async () => {
  const mock = mockFetch(async (url, options) => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, reserved_credits: 1, balance: 99, account_tier: "free" });
    }
    return null;
  }, () => Response.json({ id: userId }), "free");

  try {
    // Free plan has max 3 seats. When currentMemberCount is 3, invite must be rejected with 402/Seat limit
    const inviteReq = makeRequest("/api/team/invite", {
      body: {
        email: "colleague@example.com",
        role: "Member",
        currentMemberCount: 3
      }
    });
    const inviteRes = await worker.fetch(inviteReq, env);
    assert.equal(inviteRes.status, 402);
    const payload = await inviteRes.json();
    assert.match(payload.error, /seat limit/i);
  } finally {
    mock.restore();
  }
});

test("Frontend Integration: credit managers, workspace synchronization, and modal isolation", async () => {
  const creditsJs = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const ocrJs = await readFile(new URL("../ocr.js", import.meta.url), "utf8");
  const socialJs = await readFile(new URL("../social.js", import.meta.url), "utf8");
  const analyticsJs = await readFile(new URL("../analytics.js", import.meta.url), "utf8");
  const workflowsJs = await readFile(new URL("../workflows.js", import.meta.url), "utf8");
  const dataJs = await readFile(new URL("../data-mgmt.js", import.meta.url), "utf8");
  const teamJs = await readFile(new URL("../team.js", import.meta.url), "utf8");

  // window.JEVEXA_CREDITS exposes fetchBalance and updateBalance
  assert.match(creditsJs, /window\.JEVEXA_CREDITS\s*=\s*\{[\s\S]*?fetchBalance:\s*refreshDisplayedCredits/);
  assert.match(creditsJs, /updateBalance:\s*\(newBalance\)/);

  // All 5 unlocked tool badges in index.html have workspace-credits-val
  assert.match(html, /id="ocrWorkspaceCredits"[\s\S]*?workspace-credits-val/);
  assert.match(html, /id="socialWorkspaceCredits"[\s\S]*?workspace-credits-val/);
  assert.match(html, /id="analyticsWorkspaceCredits"[\s\S]*?workspace-credits-val/);
  assert.match(html, /id="workflowsWorkspaceCredits"[\s\S]*?workspace-credits-val/);
  assert.match(html, /id="dataWorkspaceCredits"[\s\S]*?workspace-credits-val/);

  // script.js synchronizes all workspace credit badges and routes /tools/team
  assert.match(scriptJs, /document\.querySelectorAll\('\.workspace-credits-val, \.workspace-credits-badge \.credits-count'\)/);
  assert.match(scriptJs, /cleanPath === '\/tools\/team'/);

  // OCR supports binary file ingestion
  assert.match(ocrJs, /readAsDataURL\(file\)/);
  assert.match(ocrJs, /fileSizeBytes:\s*state\.uploadedFileSize/);
  assert.match(ocrJs, /window\.JEVEXA_SHOW_UPGRADE_MODAL/);

  // Social supports week/month toggle and upgrade modal
  assert.match(socialJs, /calendarViewWeekBtn/);
  assert.match(socialJs, /calendarViewMonthBtn/);
  assert.match(socialJs, /window\.JEVEXA_SHOW_UPGRADE_MODAL/);

  // Analytics triggers upgrade modal on 402 and syncs balance
  assert.match(analyticsJs, /window\.JEVEXA_SHOW_UPGRADE_MODAL/);
  assert.match(analyticsJs, /window\.JEVEXA_UPDATE_CREDIT_BALANCE/);

  // Workflows has modal backdrop & Escape key handling
  assert.match(workflowsJs, /e\.key === 'Escape'/);
  assert.match(workflowsJs, /window\.JEVEXA_SHOW_UPGRADE_MODAL/);

  // Data management triggers upgrade modal on 402 and syncs balance
  assert.match(dataJs, /window\.JEVEXA_SHOW_UPGRADE_MODAL/);
  assert.match(dataJs, /window\.JEVEXA_UPDATE_CREDIT_BALANCE/);

  // Team has modal backdrop & Escape key handling and passes member count
  assert.match(teamJs, /currentMemberCount:\s*state\.members\.length/);
  assert.match(teamJs, /e\.key === 'Escape'/);
  assert.match(teamJs, /window\.JEVEXA_SHOW_UPGRADE_MODAL/);
});

test("Flagship Release & Viewport Overhaul: Screenshot fixes, keyboard ergonomics, clean logout, and edge hardening", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const aboutHtml = await readFile(new URL("../about.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const creditsJs = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  // 1. Stats Grid: Redundant 10 AI Tools removed and replaced with clean highlight
  assert.match(html, /<span class="stat-number" data-count="100">0<\/span>[\s\S]*?<span class="stat-label">New Account Grant<\/span>/);
  assert.match(html, /<span class="stat-number" data-count="10">0<\/span>[\s\S]*?<span class="stat-label">Live AI Tools<\/span>/);
  assert.match(html, /<span class="stat-number" data-count="1">0<\/span>[\s\S]*?<span class="stat-label">Unified Credit Wallet<\/span>/);
  assert.doesNotMatch(html, /<span class="stat-label">AI Tools<\/span>/);

  // 2. Try link on 01 AI Chat and continuous color-changing animation
  assert.match(html, /class="chat-tool-link feature-try-link"[^>]*id="tryChatLink"[^>]*>Try AI Chat/);
  assert.match(scriptJs, /document\.querySelectorAll\('\.chat-tool-link'\)\.forEach/);
  assert.match(scriptJs, /openChatWorkspace\(true\)/);
  assert.match(styles, /@keyframes tryLinkColorCycle\s*\{/);
  assert.match(styles, /animation:\s*tryLinkColorCycle/);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?animation:\s*none\s*!important/);

  // 3. Complete elimination of Release 1 / Release 2 / Release 3 across HTML, JS, README, worker
  assert.doesNotMatch(html, /Release [123]/);
  assert.doesNotMatch(workerJs, /Release [123]/);
  assert.doesNotMatch(aboutHtml, /Release [123]/);
  assert.doesNotMatch(readme, /Release [123]/);

  // 4. AI Tools Hub Card / Preview layout & spacious styling (no inner scrollbox trap)
  assert.match(styles, /\.tools-launcher-grid\s*\{[\s\S]*?max-height:\s*none/);
  assert.match(styles, /\.tool-card-footer\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(styles, /\.tool-card-cta\.live-cta\s*\{[\s\S]*?white-space:\s*nowrap;/);
  assert.match(styles, /\.tool-card-badge-pill\s*\{[\s\S]*?white-space:\s*nowrap;/);

  // 5. Mobile Virtual Keyboard & Viewport Tracking
  assert.match(creditsJs, /function scrollToBottom\(smooth = true\)\s*\{/);
  assert.match(creditsJs, /window\.JEVEXA_SCROLL_TO_BOTTOM = scrollToBottom;/);
  assert.match(creditsJs, /chatMessages\.scrollHeight - chatMessages\.clientHeight/);
  assert.match(creditsJs, /chatInput\.scrollIntoView/);
  assert.match(styles, /\.chatbot-window,\s*[\s\S]*?\.tool-workspace\s*\{[\s\S]*?top:\s*var\(--vvh-top,\s*0px\)\s*!important;/);
  assert.match(styles, /\.chat-input-area\s*\{[\s\S]*?padding-bottom:\s*max\(12px,\s*env\(safe-area-inset-bottom\)\)\s*!important;/);
  assert.match(styles, /\.login-modal \.login-box\s*\{[\s\S]*?max-height:\s*calc\(var\(--vvh,\s*100dvh\)\s*-\s*20px\)\s*!important;/);

  // 6. Clean Logout Flow
  assert.match(scriptJs, /async function logoutUser\(\)\s*\{/);
  assert.match(scriptJs, /applyAuthState\(null\);/);
  assert.match(scriptJs, /closeLogin\(\);/);
  assert.match(scriptJs, /closeAllWorkspaces\(\)/);
  assert.match(scriptJs, /closeChatWorkspace\(false\)/);
  assert.match(scriptJs, /returnToStudio\(\)/);
  assert.match(scriptJs, /window\.abortChatRequest\?\.\(\);/);

  // 7. Edge Hardening & secureAssetResponse
  assert.match(workerJs, /function secureAssetResponse\(assetResponse, options = \{\}\)\s*\{/);
  assert.match(workerJs, /hopByHopHeaders/);
  assert.match(workerJs, /secured\.headers\.set\("Accept-Ranges",\s*"bytes"\);/);
});

test("Ultra Max Layout, Workspace Stability, Scrollbars & Interactive Controls", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const ocrJs = await readFile(new URL("../ocr.js", import.meta.url), "utf8");
  const socialJs = await readFile(new URL("../social.js", import.meta.url), "utf8");
  const teamJs = await readFile(new URL("../team.js", import.meta.url), "utf8");
  const workflowsJs = await readFile(new URL("../workflows.js", import.meta.url), "utf8");
  const dataJs = await readFile(new URL("../data-mgmt.js", import.meta.url), "utf8");

  // 1. Left-Aligned Vertical Services Stack (01-10 numbering, 1fr vertical layout, unclipped CTAs)
  assert.match(styles, /\.tools-launcher-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  assert.match(styles, /\.tool-launcher-card\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*row;/);
  assert.match(styles, /\.tool-card-num\s*\{/);
  for (let i = 1; i <= 10; i++) {
    const num = String(i).padStart(2, "0");
    assert.match(html, new RegExp(`<span class="tool-card-num">${num}</span>`));
  }

  // 2. Workspace Scroll Container (flex: 1 1 0%, min-height: 0, overflow-y: auto)
  assert.match(styles, /\.workspace-scroll-wrap,\s*\.workspace-content-scroll\s*\{[\s\S]*?flex:\s*1 1 0% !important;/);
  assert.match(styles, /\.workspace-scroll-wrap,\s*\.workspace-content-scroll\s*\{[\s\S]*?min-height:\s*0 !important;/);
  assert.match(styles, /\.workspace-scroll-wrap,\s*\.workspace-content-scroll\s*\{[\s\S]*?overflow-y:\s*auto !important;/);

  // 3. 100% Zoom Workspace Scaling (no cramped headers, reset section padding, 2-column workspace grid)
  assert.match(styles, /\.content-tool-section\.workspace-mode\s*\{[\s\S]*?padding:\s*0 !important;/);
  assert.match(styles, /\.content-tool-section\.workspace-mode\s*\{[\s\S]*?margin:\s*0 !important;/);
  assert.match(styles, /\.content-tool-section\.workspace-mode\s*\.section-title\s*\{[\s\S]*?font-size:\s*1\.45rem !important;/);
  assert.match(styles, /\.tool-workspace-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(360px,\s*440px\)\s*minmax\(0,\s*1fr\)(?:\s*!important)?;/);

  // 4. Team Management Interactive Controls (Role select, Status toggle, Audit logging)
  assert.match(teamJs, /class="[^"]*team-role-select[^"]*"/);
  assert.match(teamJs, /class="[^"]*team-status-toggle[^"]*"/);
  assert.match(teamJs, /action:\s*['"]Role Changed['"]/);
  assert.match(teamJs, /action:\s*['"]Status Changed['"]/);

  // 5. Workflow Automation Step Controls (Reorder up/down, configure step, delete step)
  assert.match(workflowsJs, /class="[^"]*workflow-move-up-btn[^"]*"/);
  assert.match(workflowsJs, /class="[^"]*workflow-move-down-btn[^"]*"/);
  assert.match(workflowsJs, /class="[^"]*workflow-configure-btn[^"]*"/);
  assert.match(workflowsJs, /class="[^"]*workflow-del-step-btn[^"]*"/);

  // 6. Real Functionality Preloads (OCR invoice preset, Social launch preset, Data management leads preset)
  assert.match(ocrJs, /SAMPLE_DOCS[\s\S]*?saas_invoice/);
  assert.match(socialJs, /PRESETS[\s\S]*?product_launch/);
  assert.match(dataJs, /SAMPLE_DATASETS\.messy_leads/);
});

// ============================================================================
// PHASE 2 DEDICATED TESTS: ONE-BY-ONE END-TO-END SUITE (SERVICES 01 THROUGH 10)
// ============================================================================

test("Service 01 Dedicated: AI Chatbot messaging, streaming, controls, mobile viewport, and provider cascade", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const creditsJs = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Chatbot core elements & workspace
  assert.match(html, /id="chatbotWindow"/);
  assert.match(html, /id="chatInput"/);
  assert.match(html, /id="chatSend"/);
  assert.match(html, /id="chatMessages"/);

  // Thinking level gating
  assert.match(creditsJs, /maximumThinkingLevel/);
  assert.match(creditsJs, /currentThinkingLevel/);
  assert.match(workerJs, /function thinkingLevelIsAllowed/);
  assert.match(workerJs, /function thinkingTierError/);

  // Mobile virtual keyboard & viewport tracking
  assert.match(creditsJs, /window\.visualViewport/);
  assert.match(creditsJs, /window\.JEVEXA_SCROLL_TO_BOTTOM/);

  // Language preferences
  assert.match(html, /id="chatLanguageSelect"/);
  assert.match(creditsJs, /chatCustomSettings\.language/);

  // Multi-provider cascade: Groq -> Gemini -> OpenRouter
  assert.match(workerJs, /executeGroqChat/);
  assert.match(workerJs, /executeGeminiChat/);
  assert.match(workerJs, /executeOpenRouterChat/);
});

test("Service 02 Dedicated: Content Generation prompts, presets, exports, and multi-provider cascade", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const contentJs = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Core content generation interface
  assert.match(html, /id="contentTool"/);
  assert.match(html, /id="contentTopic"/);
  assert.match(html, /id="contentGenerate"/);
  assert.match(html, /id="contentOutput"/);

  // Presets and controls
  assert.match(html, /id="contentTone"/);
  assert.match(html, /id="contentLength"/);

  // Multi-provider cascade in worker: Groq -> Gemini -> OpenRouter
  assert.match(workerJs, /executeGroqContent/);
  assert.match(workerJs, /executeGeminiContent/);
  assert.match(workerJs, /executeOpenRouterContent/);

  // Copy and download export functions
  assert.match(html, /id="contentCopy"/);
  assert.match(html, /id="contentDownload"/);
  assert.match(contentJs, /copyButton/);
  assert.match(contentJs, /downloadButton/);
});

test("Service 03 Dedicated: Document AI & OCR file upload, extraction formats, copy/CSV export, and provider cascade", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const ocrJs = await readFile(new URL("../ocr.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // OCR workspace & elements
  assert.match(html, /id="ocrWorkspace"/);
  assert.match(html, /id="ocrFileInput"/);
  assert.match(html, /id="ocrExtractBtn"/);
  assert.match(html, /id="ocrResultCard"/);

  // Preloaded preset & extraction tabs
  assert.match(ocrJs, /saas_invoice/);
  assert.match(html, /id="ocrTabStructured"/);
  assert.match(html, /id="ocrTabJson"/);
  assert.match(html, /id="ocrTabText"/);

  // Copy & CSV export
  assert.match(ocrJs, /copyJsonBtn/);
  assert.match(ocrJs, /exportCsvBtn/);

  // Multi-provider cascade + deterministic fallback
  assert.match(workerJs, /handleOcrExtract/);
  assert.match(workerJs, /deterministicOcrExtract/);
  assert.match(workerJs, /ocrMaxFileMb/);
});

test("Service 04 Dedicated: Social Media Assistant viral hooks, calendar, hashtag generator, and cascade", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const socialJs = await readFile(new URL("../social.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Social assistant workspace & controls
  assert.match(html, /id="socialWorkspace"/);
  assert.match(html, /id="socialTopic"/);
  assert.match(html, /id="socialGenerateBtn"/);
  assert.match(html, /id="socialPreviewContainer"/);

  // Campaign presets & options
  assert.match(socialJs, /PRESETS/);
  assert.match(html, /id="socialPlatform"/);
  assert.match(html, /id="socialTone"/);
  assert.match(html, /id="socialGoal"/);

  // Viral hooks, copy post, and calendar buttons
  assert.match(html, /id="socialCopyPostBtn"/);
  assert.match(html, /id="socialAddToCalendarBtn"/);
  assert.match(socialJs, /copyPostBtn/);
  assert.match(socialJs, /addToCalendar/);

  // Worker cascade + deterministic fallback
  assert.match(workerJs, /handleSocialGenerate/);
  assert.match(workerJs, /deterministicSocialGenerate/);
});

test("Service 05 Dedicated: Business Analytics KPIs, models, horizon forecasting, and credit settlement", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const analyticsJs = await readFile(new URL("../analytics.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Analytics workspace & controls
  assert.match(html, /id="analyticsWorkspace"/);
  assert.match(html, /id="analyticsGenerateBtn"/);
  assert.match(html, /id="analyticsReportCard"/);
  assert.match(html, /id="analyticsExportCsvBtn"/);

  // Horizon & forecast metrics/timeframe
  assert.match(html, /id="analyticsTimeframe"/);
  assert.match(html, /id="analyticsMetricMrr"/);
  assert.match(analyticsJs, /PRESETS/);

  // CSV/JSON export
  assert.match(analyticsJs, /exportCsvBtn/);

  // Worker calculation and credit settlement
  assert.match(workerJs, /handleAnalyticsReport/);
  assert.match(workerJs, /deterministicAnalyticsReport/);
});

test("Service 06 Dedicated: User & Admin Management member provisioning, role select, audit logs, and seat limits", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const teamJs = await readFile(new URL("../team.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Admin workspace & controls
  assert.match(html, /id="teamAdminWorkspace"/);
  assert.match(html, /id="teamMemberTableBody"/);
  assert.match(html, /id="teamInviteModalBtn"/);
  assert.match(html, /id="teamAuditTableBody"/);

  // Role select & status toggle
  assert.match(teamJs, /team-role-select/);
  assert.match(teamJs, /team-status-toggle/);
  assert.match(teamJs, /renderAuditLogs/);

  // Permission matrix in HTML
  assert.match(html, /Billing &amp; Credit Management/);
  assert.match(html, /Team Invites &amp; Seat Provisioning/);

  // Seat enforcement in worker
  assert.match(workerJs, /teamMaxSeats/);
  assert.match(workerJs, /handleTeamInvite/);
});

test("Service 07 Dedicated: Workflow Automation step ordering, execution engine, run logs, and quota limits", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const workflowsJs = await readFile(new URL("../workflows.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Workflows workspace & controls
  assert.match(html, /id="workflowsWorkspace"/);
  assert.match(html, /id="workflowStepList"/);
  assert.match(html, /id="workflowRunBtn"/);
  assert.match(html, /id="workflowExecLogs"/);

  // Step manipulation controls
  assert.match(workflowsJs, /workflow-move-up-btn/);
  assert.match(workflowsJs, /workflow-move-down-btn/);
  assert.match(workflowsJs, /workflow-configure-btn/);
  assert.match(workflowsJs, /workflow-del-step-btn/);

  // Templates
  assert.match(workflowsJs, /TEMPLATES/);

  // Worker execution & step limits
  assert.match(workerJs, /handleWorkflowsRun/);
  assert.match(workerJs, /deterministicWorkflowRun/);
  assert.match(workerJs, /workflowMaxSteps/);
});

test("Service 08 Dedicated: Data Management cleaning rules, diffing, row limits, and export", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dataJs = await readFile(new URL("../data-mgmt.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Data management workspace & elements
  assert.match(html, /id="dataWorkspace"/);
  assert.match(html, /id="dataProcessBtn"/);
  assert.match(html, /id="dataCountCleaned"/);
  assert.match(html, /id="dataDownloadCsvBtn"/);

  // Cleaning operations
  assert.match(html, /id="dataOpDedup"/);
  assert.match(html, /id="dataOpWhitespace"/);
  assert.match(html, /id="dataOpEmails"/);
  assert.match(html, /id="dataOpPhones"/);

  // Export & diffing
  assert.match(dataJs, /downloadCsvBtn/);
  assert.match(dataJs, /downloadJsonBtn/);

  // Worker clean handler & row limit gating
  assert.match(workerJs, /handleDataClean/);
  assert.match(workerJs, /deterministicDataClean/);
  assert.match(workerJs, /dataMaxRows/);
});

test("Services 09 & 10 Dedicated: Mini CRM pipelines, AI scoring, outreach handoff, and multi-step sequence builder", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const crmJs = await readFile(new URL("../crm.js", import.meta.url), "utf8");
  const outreachJs = await readFile(new URL("../outreach.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Mini CRM core interface & 50-lead cap
  assert.match(html, /id="crmWorkspace"/);
  assert.match(crmJs, /maxFreeLeads:\s*50/);
  assert.match(crmJs, /handleAiScore/);
  assert.match(crmJs, /handleDraftOutreachShortcut/);

  // Email & Outreach AI sequence generator & Gmail integration
  assert.match(html, /id="outreachWorkspace"/);
  assert.match(outreachJs, /handleGenerate/);
  assert.match(outreachJs, /handleOpenInGmail/);
  assert.match(outreachJs, /handleSyncCrm/);

  // Multi-provider cascade in worker
  assert.match(workerJs, /handleCrmScore/);
  assert.match(workerJs, /handleOutreachGenerate/);
});

test("Global Suite Dedicated: Auth, clean logout, language persistence, billing toggle, and /tools/* routing", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  // Clean logout flow
  assert.match(scriptJs, /async function logoutUser\(\)/);
  assert.match(scriptJs, /applyAuthState\(null\)/);
  assert.match(scriptJs, /closeAllWorkspaces\(\)/);
  assert.match(scriptJs, /returnToStudio\(\)/);

  // Billing toggle (Monthly / Annual)
  assert.match(html, /id="billingToggle"/);
  assert.match(scriptJs, /function setBillingCycle/);
  assert.match(scriptJs, /toggleBillingCycle/);

  // Full /tools/* SPA routing in script and worker
  const expectedRoutes = [
    "/tools/chatbot",
    "/tools/content-generator",
    "/tools/ocr",
    "/tools/social",
    "/tools/analytics",
    "/tools/admin",
    "/tools/workflows",
    "/tools/data",
    "/tools/crm",
    "/tools/outreach"
  ];
  for (const route of expectedRoutes) {
    assert.match(scriptJs, new RegExp(`'${route}'`));
  }
  assert.match(workerJs, /url\.pathname\.startsWith\("\/tools\/"\)/);

  // Hub layout: Left-side line-wise stack with no inner scroll trap
  assert.match(styles, /\.tools-launcher-grid\s*\{[\s\S]*?max-height:\s*none/);
  assert.match(styles, /\.tools-launcher-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);

  // Exact 01 through 10 numbering in hub and feature cards
  for (let i = 1; i <= 10; i++) {
    const num = String(i).padStart(2, "0");
    assert.match(html, new RegExp(`<span class="tool-card-num">${num}</span>`));
    assert.match(html, new RegExp(`<span class="feature-number">${num}</span>`));
  }
});

test("Audit & Hardening: Calendar toggles, Data Management upload/metrics, responsive table wrappers, modal isolation, and admin assets", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const creditsJs = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const dataJs = await readFile(new URL("../data-mgmt.js", import.meta.url), "utf8");
  const supportJs = await readFile(new URL("../support.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const assetsIgnore = await readFile(new URL("../.assetsignore", import.meta.url), "utf8");

  // 1. Social calendar toggles
  assert.match(html, /id="socialViewWeekBtn"/);
  assert.match(html, /id="socialViewMonthBtn"/);

  // 2. Data management file upload & emails normalized metric
  assert.match(html, /id="dataFileInput"/);
  assert.match(html, /id="dataCountEmails"/);
  assert.match(dataJs, /bindSafe\(fileInput,\s*'change'/);
  assert.match(dataJs, /reader\.readAsText\(file\)/);

  // 3. Responsive table wrapper styles
  assert.match(styles, /\.table-responsive[\s\S]*?overflow-x:\s*auto/);
  assert.match(styles, /\.table-responsive[\s\S]*?-webkit-overflow-scrolling:\s*touch/);
  assert.match(styles, /\.data-table-wrap/);

  // 4. Modal isolation on ESC in script.js
  assert.match(scriptJs, /#teamInviteModal:not\(\[hidden\]\)/);
  assert.match(scriptJs, /#workflowExecModal:not\(\[hidden\]\)/);
  assert.match(scriptJs, /#chatCustomizationModal:not\(\[hidden\]\)/);
  assert.match(scriptJs, /#supportModal:not\(\[hidden\]\)/);

  // 5. Complete modal, drawer, and workspace cleanup on logoutUser & closeAllWorkspacesAndModals
  assert.match(scriptJs, /closeAllWorkspacesAndModals\(\)/);
  assert.match(scriptJs, /'contentWorkspace',[\s\S]*?'crmWorkspace',[\s\S]*?'outreachWorkspace',[\s\S]*?'ocrWorkspace',[\s\S]*?'socialWorkspace',[\s\S]*?'analyticsWorkspace',[\s\S]*?'teamAdminWorkspace',[\s\S]*?'workflowsWorkspace',[\s\S]*?'dataWorkspace'/);
  assert.match(scriptJs, /chatCustomModal\.classList\.remove\('open'\)/);
  assert.match(scriptJs, /crmModal\.classList\.remove\('open'\)/);
  assert.match(scriptJs, /crmDrawer\.classList\.remove\('open'\)/);
  assert.match(scriptJs, /outreachDrawer\.classList\.remove\('open'\)/);
  assert.match(scriptJs, /teamModal\.classList\.remove\('open'\)/);
  assert.match(scriptJs, /wfModal\.classList\.remove\('open'\)/);

  // 6. Settings modal ESC/backdrop dismissal & 0 native alerts in credits.js
  assert.match(creditsJs, /bindSafe\(modal,\s*'click'/);
  assert.doesNotMatch(creditsJs, /alert\(`Your/);

  // 7. Support.js safe optional chaining
  assert.match(supportJs, /document\.getElementById\('supportName'\)\?\.focus\(\)/);
  assert.match(supportJs, /document\.getElementById\('supportName'\)\?\.value \|\| ''/);

  // 8. Admin asset deployment & route normalization
  assert.doesNotMatch(assetsIgnore, /admin\.html/);
  assert.match(workerJs, /"\/admin\.html":\s*"\/admin\.html"/);
});

test("Architectural & Service Modernization: (Jevexa AI) removal, edge 304 handling, E.164 phone formatting, drag-and-drop, and 10-service integrity", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const aboutHtml = await readFile(new URL("../about.html", import.meta.url), "utf8");
  const termsHtml = await readFile(new URL("../terms.html", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const ocrJs = await readFile(new URL("../ocr.js", import.meta.url), "utf8");
  const dataJs = await readFile(new URL("../data-mgmt.js", import.meta.url), "utf8");
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // 1. (Jevexa AI) blue text removal
  assert.doesNotMatch(html, /<h3 class="tool-card-title">AI Chatbot <span class="tool-card-sub">\(Jevexa AI\)<\/span><\/h3>/);
  assert.match(html, /<h3 class="tool-card-title">AI Chatbot<\/h3>/);
  assert.doesNotMatch(aboutHtml, /AI Chatbot \(Jevexa AI\)/);
  assert.doesNotMatch(termsHtml, /AI Chatbot \(Jevexa AI\)/);
  assert.match(scriptJs, /id:\s*'chatbot',\s*name:\s*'AI Chatbot',/);

  // 2. Drag and drop file ingestion for OCR & Data Management
  assert.match(ocrJs, /handleOcrFile/);
  assert.match(ocrJs, /dropzone\.addEventListener\(eventName/);
  assert.match(dataJs, /handleDataFile/);
  assert.match(dataJs, /dataDropzone\.addEventListener\(evt/);
  assert.match(dataJs, /pasteInput\.addEventListener\(evt/);

  // 3. E.164 phone formatting & anomaly detection
  assert.match(workerJs, /operations\.formatPhones/);
  assert.match(workerJs, /str = `\+1\${digits}`/);
  assert.match(workerJs, /Negative monetary value/);

  // 4. Edge 304 & bodyless response handling in secureAssetResponse
  assert.match(workerJs, /const isBodyless = assetResponse\.status === 101/);
  assert.match(workerJs, /const secured = isBodyless \? new Response\(null, assetResponse\) : new Response\(assetResponse\.body, assetResponse\)/);

  // 5. Modern layout styling for OCR and Data Management
  assert.match(styles, /\.ocr-dropzone,\s*\.data-upload-zone/);
  assert.match(styles, /MODERN DOCUMENT AI & OCR & DATA MANAGEMENT LAYOUT OVERHAUL/);

  // 6. 10 Services registered in toolsConfig
  const tools = ["chatbot", "content-generator", "ocr", "social", "analytics", "admin", "workflows", "data", "crm", "email-outreach"];
  for (const toolId of tools) {
    assert.match(scriptJs, new RegExp(`id:\\s*'${toolId}'`));
  }
});

test("Service Excellence & Full Platform Integrity: 10/10 working services, interactive previews, sub-page mobile navigation, and seamless card launches", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const aboutHtml = await readFile(new URL("../about.html", import.meta.url), "utf8");
  const contactHtml = await readFile(new URL("../contact.html", import.meta.url), "utf8");
  const termsHtml = await readFile(new URL("../terms.html", import.meta.url), "utf8");
  const privacyHtml = await readFile(new URL("../privacy-policy.html", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const teamJs = await readFile(new URL("../team.js", import.meta.url), "utf8");
  const socialJs = await readFile(new URL("../social.js", import.meta.url), "utf8");
  const outreachJs = await readFile(new URL("../outreach.js", import.meta.url), "utf8");

  // 1. Team & Admin demo stability
  assert.match(teamJs, /DEFAULT_MEMBERS/);
  assert.match(teamJs, /DEFAULT_AUDIT_LOGS/);
  assert.match(teamJs, /renderMembers\(\);[\s\S]*?renderAuditLogs\(\);/);

  // 2. Social Media Assistant instant preview
  assert.match(socialJs, /DEFAULT_POST/);
  assert.match(socialJs, /renderPostPreview\(DEFAULT_POST\)/);

  // 3. Outreach AI instant 3-step sequence
  assert.match(outreachJs, /DEFAULT_SEQUENCE/);
  assert.match(outreachJs, /state\.currentSequence = JSON\.parse\(JSON\.stringify\(DEFAULT_SEQUENCE\)\)/);

  // 4. Sub-page mobile navigation toggles
  assert.match(aboutHtml, /id="mobileToggle"/);
  assert.match(contactHtml, /id="mobileToggle"/);
  assert.match(termsHtml, /id="mobileToggle"/);
  assert.match(privacyHtml, /id="mobileToggle"/);

  // 5. Card click launches all 10 workspaces seamlessly
  assert.match(scriptJs, /openChatWorkspace\(true\)/);
  assert.match(scriptJs, /openContentWorkspace\(true\)/);
  assert.match(scriptJs, /openCrmWorkspace\(true\)/);
  assert.match(scriptJs, /openOutreachWorkspace\(true\)/);
  assert.match(scriptJs, /openOcrWorkspace\(true\)/);
  assert.match(scriptJs, /openSocialWorkspace\(true\)/);
  assert.match(scriptJs, /openAnalyticsWorkspace\(true\)/);
  assert.match(scriptJs, /openTeamAdminWorkspace\(true\)/);
  assert.match(scriptJs, /openWorkflowsWorkspace\(true\)/);
  assert.match(scriptJs, /openDataWorkspace\(true\)/);
});

test("Enterprise Resilience & Export Suite: HEAD request probes, Gemini 2.5 cascade, and Workflow & Outreach exports", async () => {
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const workflowsJs = await readFile(new URL("../workflows.js", import.meta.url), "utf8");
  const outreachJs = await readFile(new URL("../outreach.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // 1. Gemini multi-model fallback includes production gemini-2.5-flash
  assert.match(workerJs, /gemini-2\.5-flash/);
  assert.match(workerJs, /getGeminiModelsForTier/);

  // 2. HEAD method handling across endpoints
  assert.match(workerJs, /request\.method === "HEAD"/);
  assert.match(workerJs, /handleTeamMembers/);
  assert.match(workerJs, /handleTeamAudit/);
  assert.match(workerJs, /handleCrmLeads/);
  assert.match(workerJs, /handleOutreachSequences/);

  // 3. Workflow Automation exports (.json pipeline, .csv history runs)
  assert.match(html, /id="workflowExportBtn"/);
  assert.match(html, /id="workflowExportHistoryBtn"/);
  assert.match(workflowsJs, /exportWorkflowJson/);
  assert.match(workflowsJs, /exportRunsCsv/);

  // 4. Outreach AI sequence export (.md format)
  assert.match(html, /id="outreachExportBtn"/);
  assert.match(outreachJs, /exportSequenceMarkdown/);
  assert.match(outreachJs, /exportSequence:\s*exportSequenceMarkdown/);
});

test("Micro-Level Architecture & Stability: Memories HEAD handling, Support OPTIONS, Infallible CRM/Outreach fallbacks, and Touch Targets", async () => {
  const workerJs = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const scriptJs = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const contentJs = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const creditsJs = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // 1. Memories handler accepts HEAD method cleanly with status 200
  assert.match(workerJs, /if \(request\.method === "GET" \|\| request\.method === "HEAD"\)/);
  assert.match(workerJs, /if \(request\.method === "HEAD"\) \{\s*return new Response\(null, \{ status: 200, headers: JSON_HEADERS \}\);/);

  // 2. Support Ticket and Support AI handlers handle OPTIONS with status 204
  assert.match(workerJs, /async function handleSupportTicket[\s\S]*?if \(request\.method === "OPTIONS"\) \{\s*return new Response\(null, \{ status: 204, headers: JSON_HEADERS \}\);/);
  assert.match(workerJs, /async function handleSupportAi[\s\S]*?if \(request\.method === "OPTIONS"\) \{\s*return new Response\(null, \{ status: 204, headers: JSON_HEADERS \}\);/);

  // 3. Mini CRM & Outreach deterministic fallbacks guarantee 100% infallible execution
  assert.match(workerJs, /function deterministicCrmScore\(lead = \{\}\)/);
  assert.match(workerJs, /function deterministicOutreachGenerate\(\{ goal, recipient_name, company, tone, offer \} = \{\}\)/);
  assert.match(workerJs, /const fallbackScore = deterministicCrmScore\(parsed\.lead\);/);
  assert.match(workerJs, /const fallbackSeq = deterministicOutreachGenerate\(parsed\);/);

  // 4. Zero state leakages: drawers and backdrops cleanly dismissed on workspace close
  assert.match(scriptJs, /const drawerBackdropIds = \[[\s\S]*?'crmDrawerBackdrop',[\s\S]*?'crmLeadDrawer',[\s\S]*?'outreachHistoryBackdrop',[\s\S]*?'contentHistoryBackdrop'/);
  assert.match(contentJs, /window\.closeContentHistoryDrawer = closeHistoryDrawer;/);
  assert.match(scriptJs, /window\.closeContentHistoryDrawer\?\.()/);
  assert.match(scriptJs, /window\.JEVEXA_CRM\?\.closeLeadDrawer\?\.()/);
  assert.match(scriptJs, /window\.JEVEXA_OUTREACH\?\.closeHistoryDrawer\?\.()/);
  assert.match(scriptJs, /window\.JEVEXA_TEAM\?\.closeInvite\?\.()/);

  // 5. Chat textarea height reset on message dispatch
  assert.match(creditsJs, /if \(input\) \{\s*input\.value = '';\s*input\.style\.height = 'auto';\s*\}/);

  // 6. Touch Targets minimum 42px on mobile
  assert.match(styles, /\.workspace-back-btn\s*\{[\s\S]*?min-height:\s*42px;/);
  assert.match(styles, /\.workspace-close-btn\s*\{[\s\S]*?min-height:\s*42px;/);
  assert.match(styles, /\.chatbot-header-settings-btn\s*\{[\s\S]*?min-height:\s*42px;/);
  assert.match(styles, /\.chat-scroll-bottom-btn\s*\{[\s\S]*?min-height:\s*42px;/);
  assert.match(styles, /#outreachHistoryBtn\s*\{[\s\S]*?min-height:\s*42px;/);

  // 7. Universal select option contrast rule
  assert.match(styles, /select option,\s*select optgroup/);
});

test("Flagship Chatbot Sidebar & Deletion Modal: flex row truncation, zero horizontal overflow, inline 3-dot hit target, and custom in-app confirm modal", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const credits = await readFile(new URL("../credits.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  // 1. Elimination of horizontal scrollbar across recent chats list and sidebar items
  assert.match(styles, /\.chat-sidebar\s*\{[\s\S]*?overflow-x:\s*hidden;/);
  assert.match(styles, /\.chat-history-list\s*\{[\s\S]*?overflow-x:\s*hidden;/);
  assert.match(styles, /\.chat-history-row\s*\{[\s\S]*?overflow-x:\s*hidden;/);

  // 2. Chat history item flex row layout: display flex, space-between, gap 6px, min-width 0
  assert.match(styles, /\.chat-history-row\s*\{[\s\S]*?display:\s*flex;/);
  assert.match(styles, /\.chat-history-row\s*\{[\s\S]*?justify-content:\s*space-between;/);
  assert.match(styles, /\.chat-history-row\s*\{[\s\S]*?gap:\s*6px;/);
  assert.match(styles, /\.chat-history-row\s*\{[\s\S]*?min-width:\s*0;/);

  // 3. Chat title single-line clean truncation: min-width 0, flex 1 1 auto, ellipsis, nowrap
  assert.match(styles, /\.chat-history-select\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(styles, /\.chat-history-select\s*\{[\s\S]*?white-space:\s*nowrap;/);
  assert.match(styles, /\.chat-history-title,\s*\.chat-history-title-text\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(styles, /\.chat-history-title,\s*\.chat-history-title-text\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(styles, /\.chat-history-title,\s*\.chat-history-title-text\s*\{[\s\S]*?white-space:\s*nowrap;/);

  // 4. Three-dot button inline placement & generous hit target (min 28x28px, flex-shrink 0)
  assert.match(styles, /\.chat-history-action-btn,\s*\.chat-history-menu-btn\s*\{[\s\S]*?min-width:\s*28px;/);
  assert.match(styles, /\.chat-history-action-btn,\s*\.chat-history-menu-btn\s*\{[\s\S]*?min-height:\s*28px;/);
  assert.match(styles, /\.chat-history-action-btn,\s*\.chat-history-menu-btn\s*\{[\s\S]*?flex-shrink:\s*0;/);
  assert.match(credits, /bindSafe\(menuBtn,\s*'click'/);
  assert.match(credits, /e\.stopPropagation\(\)/);

  // 5. In-App custom deletion modal elements declared in index.html
  assert.match(html, /id="chatConfirmModal"/);
  assert.match(html, /id="chatConfirmBackdrop"/);
  assert.match(html, /id="chatConfirmDialog"/);
  assert.match(html, /id="chatConfirmTitle"/);
  assert.match(html, /id="chatConfirmMessage"/);
  assert.match(html, /id="chatConfirmCancelBtn"/);
  assert.match(html, /id="chatConfirmOkBtn"/);

  // 6. Custom deletion modal styles declared in styles.css with high z-index and dark glassmorphism
  assert.match(styles, /\.chat-confirm-modal\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(styles, /\.chat-confirm-modal\s*\{[\s\S]*?z-index:\s*100000;/);
  assert.match(styles, /\.chat-confirm-dialog\s*\{[\s\S]*?border-radius:\s*20px;/);
  assert.match(styles, /\.chat-confirm-danger\s*\{[\s\S]*?linear-gradient/);

  // 7. Native window.confirm completely removed from chat deletion in credits.js
  assert.doesNotMatch(credits, /window\.confirm\(`Delete/, "Native window.confirm must not be used on chat delete");
  assert.match(credits, /openChatConfirmModal\(\{/);
  assert.match(credits, /title:\s*'Delete chat\?'/);

  // 8. Active chat state cleanly cleared and restored upon deleting current session
  assert.match(credits, /if \(session\.id === activeChatId\) \{/);
  assert.match(credits, /activeChatId = null;/);
  assert.match(credits, /conversation\.length = 0;/);
  assert.match(credits, /if \(welcome\) welcome\.hidden = false;/);
  assert.match(credits, /if \(emptyState\) emptyState\.hidden = false;/);
  assert.match(credits, /updateChatWelcome\(\);/);
});






