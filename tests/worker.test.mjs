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
  assert.match(html, /data-count="2">0<\/span>[\s\S]*?Live AI Tools/);
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
    assert.equal(body.model, "meta-llama/llama-3.1-8b-instruct:free");
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
  assert.ok(html.indexOf('<script src="credits.js"></script>') < html.indexOf('<script src="content.js"></script>'));
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
  assert.match(html, /<h3>Release 1<\/h3>[\s\S]*?<h3>Release 2<\/h3>[\s\S]*?<h3>Release 3<\/h3>/);
  assert.match(html, /id="heroFeatureOrbit"/);
  assert.match(html, /10 AI Tools • One Credit Wallet/);
  assert.match(html, /100 welcome credits included\. No payment info needed to start\./);
  assert.match(html, /For students &amp; solo starters/);
  assert.match(html, /For freelancers &amp; small shops/);
  assert.match(html, /For growing small businesses/);
  assert.match(html, /AI Chat and Content Generation are live now; the other eight tools roll out in three releases\./);
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
  assert.match(workerSource, /There are 10 tools planned across three releases/);
  assert.doesNotMatch(html, /class="stars"/);
  assert.equal((html.match(/class="feature-card glass tilt-card"/g) || []).length, 10);
  assert.equal((html.match(/class="service-chip live"/g) || []).length, 2);
  assert.equal((html.match(/class="service-chip soon"/g) || []).length, 8);
  assert.equal((html.match(/class="feature-stage-heading"/g) || []).length, 3);
  for (const tool of [
    "AI Chat", "Content Generation", "Email &amp; Outreach AI", "Mini CRM",
    "Document AI &amp; OCR", "Social Media Assistant", "Business Analytics",
    "User &amp; Admin Management", "Workflow Automation", "Data Management"
  ]) {
    assert.ok(html.includes(tool), `Missing staged tool card: ${tool}`);
  }
  assert.match(html, /AI Chat and Content Generation are live now; the other eight tools roll out in three releases\./);
  assert.match(html, /<strong>2<\/strong>[\s\S]*?Live AI tools/);
  assert.match(html, /<strong>8<\/strong>[\s\S]*?Coming Soon/);
  assert.match(html, /data-pricing-plan="starter"/);
  assert.match(html, /data-pricing-plan="pro"/);
  assert.match(html, /data-pricing-plan="business"/);
  assert.match(html, /data-pricing-plan="ultra"/);
  assert.match(html, /data-original-monthly/);
  assert.match(html, /data-annual-price/);
  assert.match(html, /Credit packages are one-time purchases, not subscriptions/);
  assert.match(script, /monthlyPrice: 49, annualEligible: true/);
  assert.match(html, /Start free with 100 credits/);
  assert.match(html, /src="assets\/logo\.svg" alt="JEVEXA AI"/);
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
      assert.equal(providerBody.model, "meta-llama/llama-3.1-8b-instruct:free");
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
      assert.equal(providerBody.model, "google/gemini-2.0-flash-exp:free");
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
    assert.equal(unsupported.status, 400);
    assert.match((await unsupported.json()).error, /Images only on Lite/i);
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
      assert.equal(request.model, "meta-llama/llama-3.3-70b-instruct:free");
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

test("chat fails closed when the database still has token-metered pricing", async () => {
  const mock = mockFetch(
    url => assert.fail(`Unexpected request to ${url.pathname}`),
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
    assert.equal(quote.status, 503);
    const chat = await worker.fetch(makeRequest(), env);
    assert.equal(chat.status, 503);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_quote"), false);
    assert.equal(mock.calls.some(call => call.url.pathname === "/rest/v1/rpc/jevexa_credit_reserve"), false);
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

test("credit quote database errors fail closed and never call the AI provider", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_quote") {
      return Response.json({ message: "function unavailable" }, { status: 404 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest("/api/credits/quote"), env);
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.code, "credit_pricing_unavailable");
    assert.match(payload.error, /credit pricing could not be confirmed/i);
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

test("invalid nonpositive database pricing quotes fail closed", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_quote") return Response.json(0);
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest("/api/credits/quote"), env);
    assert.equal(response.status, 503);
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
  assert.match(html, /Ultra AI chat · 8 credits per message/);
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
    { q: "What does chat cost per message on Lite and Pro?", expect: [/Lite/i, /Pro/i, /1 credit/i, /2 credits/i] },
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

  // 2 Live Tools
  assert.match(html, /data-tool-id="chatbot"\s+data-status="live"/);
  assert.match(html, /data-tool-id="content-generator"\s+data-status="live"/);

  // 8 Coming Soon Tools
  const comingSoonIds = ["email-outreach", "crm", "ocr", "social", "analytics", "admin", "workflows", "data"];
  for (const id of comingSoonIds) {
    assert.match(html, new RegExp(`data-tool-id="${id}"\\s+data-status="coming_soon"`));
  }

  // Scalable toolsConfig in script.js
  assert.match(script, /const toolsConfig\s*=\s*\[/);
  assert.match(script, /window\.JEVEXA_TOOLS_CONFIG\s*=\s*toolsConfig/);
  assert.match(script, /status:\s*['"]live['"]/);
  assert.match(script, /status:\s*['"]coming_soon['"]/);
  assert.match(script, /route:\s*['"]\/tools\/chatbot['"]/);
  assert.match(script, /route:\s*['"]\/tools\/content-generator['"]/);

  // Coming Soon alert/toast text
  assert.match(script, /🔒 Coming Soon! This AI tool is currently under development and will be unlocked soon\./);
  assert.match(html, /id="comingSoonModal"/);
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
