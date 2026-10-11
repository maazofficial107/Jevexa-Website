import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import worker from "../worker.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const userId = "9f6d10a8-e03a-4f6b-8aa2-5b7da1c42fb1";
const env = {
  GEMINI_API_KEY: "unit-test",
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_ANON_KEY: "unit-test",
  SUPABASE_SERVICE_ROLE_KEY: "unit-test"
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

function mockFetch(handler, authHandler) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname === "/auth/v1/user") {
      return authHandler ? authHandler(url, options, calls) : Response.json({ id: userId });
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
    assert.equal(mock.calls.some(call => call.url.hostname === "generativelanguage.googleapis.com"), false);
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
    assert.equal(mock.calls.some(call => call.url.hostname === "generativelanguage.googleapis.com"), false);
  } finally {
    mock.restore();
  }
});

test("browser Supabase configuration needs only public environment values", async () => {
  const response = await worker.fetch(makeRequest("/config.js"), {
    SUPABASE_URL: "https://staging-project.supabase.co",
    SUPABASE_ANON_KEY: "staging-publishable-key"
  });
  const script = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /application\/javascript/);
  assert.match(response.headers.get("Cache-Control"), /no-store/);
  assert.match(script, /https:\/\/staging-project\.supabase\.co/);
  assert.match(script, /staging-publishable-key/);
  assert.doesNotMatch(script, /service.?role|private.?key/i);
  assert.match(script, /"safepaySandboxEnabled":false/);
});

test("Safepay sandbox configuration is restricted to the verified staging project", async () => {
  const stagingResponse = await worker.fetch(makeRequest("/config.js"), {
    SUPABASE_URL: "https://qibnzlmgewlwzdrihcrs.supabase.co",
    SUPABASE_ANON_KEY: "staging-publishable-key",
    JEVEXA_ENVIRONMENT: "staging",
    SAFEPAY_API_KEY: "sandbox-public-key",
    SAFEPAY_SECRET_KEY: "sandbox-secret",
    SAFEPAY_WEBHOOK_SECRET: "sandbox-webhook-secret"
  });
  const productionResponse = await worker.fetch(makeRequest("/config.js"), {
    SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
    SUPABASE_ANON_KEY: "production-publishable-key",
    JEVEXA_ENVIRONMENT: "staging",
    SAFEPAY_API_KEY: "sandbox-public-key",
    SAFEPAY_SECRET_KEY: "sandbox-secret",
    SAFEPAY_WEBHOOK_SECRET: "sandbox-webhook-secret"
  });
  assert.match(await stagingResponse.text(), /"safepaySandboxEnabled":true/);
  assert.match(await productionResponse.text(), /"safepaySandboxEnabled":false/);
});

test("browser Supabase configuration fails closed if staging settings are missing", async () => {
  const response = await worker.fetch(makeRequest("/config.js"), {});
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Supabase browser configuration/i);
});

test("frontend explains missing Supabase configuration instead of failing silently", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  assert.match(html, /id="appConfigError"[^>]*role="alert"/);
  assert.match(script, /getElementById\('appConfigError'\)/);
  assert.match(script, /Configure this Worker with the correct environment URL and publishable key/);
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

test("homepage status cards do not advertise fabricated activity or live availability", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /New Account Grant/);
  assert.match(html, /Implemented Chat Route/);
  assert.match(html, /Platform Status[\s\S]*?Preview/);
  assert.match(html, /AI Chat[\s\S]*?Gemini route/);
  assert.match(html, /Service Catalog[\s\S]*?Limited availability/);
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

test("credit schema keeps pricing server-controlled and ledger adjustments idempotent", async () => {
  const sql = await readFile(new URL("../supabase/credit_system_migration.sql", import.meta.url), "utf8");
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
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Orbitron:wght@/);
  assert.match(html, /unpkg\.com\/aos@2\.3\.1\/dist\/aos\.css/);
  assert.match(html, /unpkg\.com\/aos@2\.3\.1\/dist\/aos\.js/);
  assert.match(html, /placeholder="john@company\.com"/);
  assert.doesNotMatch(html, /\\@/);
});

test("public copy does not promise unavailable services or fabricate customer ratings", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const publicCopy = `${html}\n${script}`;
  assert.doesNotMatch(publicCopy, /300\+ integrations|SOC2-ready|14-day free trial|Teams cut outreach time by|Most launch first automation in/);
  assert.doesNotMatch(publicCopy, /Full white-label is on|we offer full <strong>RPA|Voice AI & Call Agents<\/strong> can answer/);
  assert.doesNotMatch(html, /class="stars"/);
  assert.match(html, /AI chat is the only connected service today/);
  assert.match(html, /Roadmap concept only/);
  assert.match(workerSource, /staging sandbox/);
});

test("admin page never queries contact records using the browser Supabase client", async () => {
  const admin = await readFile(new URL("../admin.html", import.meta.url), "utf8");
  assert.ok(admin.includes("fetch('/api/admin/contacts'"));
  assert.equal(admin.includes(".from('Contacts')"), false);
  assert.ok(admin.includes("cell.textContent = String(value)"));
});

test("insufficient credits stop before contacting Gemini", async () => {
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
    assert.equal(mock.calls.some(call => call.url.hostname === "generativelanguage.googleapis.com"), false);
  } finally {
    mock.restore();
  }
});

test("malformed reservation responses fail closed before contacting Gemini", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") return Response.json({ ok: true });
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    assert.equal(response.status, 503);
    assert.equal(mock.calls.some(call => call.url.hostname === "generativelanguage.googleapis.com"), false);
  } finally {
    mock.restore();
  }
});

test("successful Gemini usage settles server-priced credits exactly once", async () => {
  const mock = mockFetch((url, options) => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      const args = JSON.parse(options.body);
      assert.equal(args.p_user_id, userId);
      assert.equal(args.p_service, "ai_chat");
      assert.equal(args.p_request_id, requestId);
      assert.equal("p_credits" in args, false);
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 97 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Hello from Gemini." }] } }],
        usageMetadata: { totalTokenCount: 1100 }
      });
    }
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_settle") {
      const args = JSON.parse(options.body);
      assert.equal(args.p_user_id, userId);
      assert.equal(args.p_request_id, requestId);
      assert.equal(args.p_usage_tokens, 1100);
      return Response.json({ ok: true, charged_credits: 2, balance: 98 });
    }
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest(), env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.reply, "Hello from Gemini.");
    assert.equal(payload.creditsCharged, 2);
    assert.equal(payload.creditsRemaining, 98);
    assert.equal(payload.usageEstimated, false);
    assert.equal(mock.calls.filter(call => call.url.hostname === "generativelanguage.googleapis.com").length, 1);
  } finally {
    mock.restore();
  }
});

test("provider failure releases its reservation and does not settle a charge", async () => {
  let released = false;
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_reserve") {
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 2, balance: 98 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
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
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 2, balance: 98 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
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
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 2, balance: 98 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
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

test("replayed settled request IDs never call Gemini a second time", async () => {
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
    assert.equal(mock.calls.some(call => call.url.hostname === "generativelanguage.googleapis.com"), false);
  } finally {
    mock.restore();
  }
});

test("pricing quote is authenticated and comes from the database function", async () => {
  const mock = mockFetch(url => {
    if (url.pathname === "/rest/v1/rpc/jevexa_credit_quote") return Response.json(4);
    assert.fail(`Unexpected request to ${url.pathname}`);
  });
  try {
    const response = await worker.fetch(makeRequest("/api/credits/quote"), env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.estimatedCredits, 4);
    assert.equal(typeof payload.estimatedTokens, "number");
  } finally {
    mock.restore();
  }
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
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 2, balance: 98 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
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
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 2, balance: 98 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") throw new TypeError("network connection lost");
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
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 97 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Generated response." }] } }],
        usageMetadata: { totalTokenCount: 1200 }
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
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Generated response." }] } }],
        usageMetadata: { totalTokenCount: 1200 }
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
      return Response.json({ ok: true, duplicate: false, status: "reserved", reserved_credits: 3, balance: 97 });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Generated response." }] } }],
        usageMetadata: { totalTokenCount: 1200 }
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
