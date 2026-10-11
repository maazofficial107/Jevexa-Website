import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import worker from "../worker.js";

function readLocalVars(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    values.set(match[1], value);
  }
  return values;
}

function responseHeaders(key, bearer = key) {
  return {
    apikey: key,
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json"
  };
}

async function api(path, { key, bearer = key, method = "GET", body, headers = {} }) {
  return fetch(`${supabaseUrl}${path}`, {
    method,
    headers: { ...responseHeaders(key, bearer), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function readJson(response) {
  return response.json().catch(() => null);
}

const lines = await readFile(".dev.vars", "utf8");
const vars = readLocalVars(lines);
const supabaseUrl = (vars.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const anonKey = vars.get("SUPABASE_ANON_KEY");
const serviceKey = vars.get("SUPABASE_SERVICE_ROLE_KEY");
const geminiApiKey = vars.get("GEMINI_API_KEY");
const EXPECTED_STAGING_PROJECT_HOST = "qibnzlmgewlwzdrihcrs.supabase.co";
let projectUrl;
try {
  projectUrl = new URL(supabaseUrl);
} catch {
  throw new Error("Staging test stopped: SUPABASE_URL is missing or invalid.");
}
assert.equal(process.env.JEVEXA_STAGING_CONFIRM, "jevexa-staging",
  "Set JEVEXA_STAGING_CONFIRM=jevexa-staging only after confirming this is the staging project.");
assert.equal(projectUrl.protocol, "https:", "Staging URL must use HTTPS.");
assert.equal(projectUrl.hostname, EXPECTED_STAGING_PROJECT_HOST,
  "Refusing to run outside the verified jevexa-staging project.");
assert.ok(anonKey && serviceKey, "Staging anon and service-role keys must be present in .dev.vars.");

const results = [];
let createdUsers = [];
const reservations = new Map();
let operationUserId = null;

function passed(name) {
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

function makeTestCredentials() {
  const suffix = randomUUID();
  return {
    email: `jevexa-credit-${suffix}@example.com`,
    password: randomBytes(36).toString("base64url")
  };
}

async function createTestUser(excludedUserIds = new Set()) {
  const listResponse = await api("/auth/v1/admin/users?page=1&per_page=1000", { key: serviceKey });
  const userList = await readJson(listResponse);
  assert.equal(listResponse.ok, true, `Could not list staging Auth test users (HTTP ${listResponse.status}).`);
  const candidates = (userList?.users || []).filter(user =>
    user.user_metadata?.jevexa_staging_credit_test === true
      && !excludedUserIds.has(user.id)
      && typeof user.email === "string"
      && user.email.startsWith("jevexa-credit-")
  );

  for (const candidate of candidates) {
    const credentials = { email: candidate.email, password: randomBytes(36).toString("base64url") };
    const reset = await api(`/auth/v1/admin/users/${candidate.id}`, {
      key: serviceKey,
      method: "PUT",
      body: { password: credentials.password, email_confirm: true }
    });
    if (!reset.ok) continue;
    const login = await api("/auth/v1/token?grant_type=password", {
      key: anonKey,
      method: "POST",
      body: credentials
    });
    const session = await readJson(login);
    if (!login.ok || !session?.access_token) continue;
    const user = { id: candidate.id, token: session.access_token, ...credentials };
    const wallets = await getRows(
      `/rest/v1/user_credits?select=balance&user_id=eq.${user.id}`,
      user.token,
      anonKey
    );
    if (wallets.length !== 1 || wallets[0].balance !== 100) continue;
    const [grants, existingReservations] = await Promise.all([
      getRows(
        `/rest/v1/credit_transactions?select=id&user_id=eq.${user.id}&reference=eq.${encodeURIComponent(`signup:${user.id}`)}`,
        user.token,
        anonKey
      ),
      getRows(
        `/rest/v1/credit_reservations?select=id&user_id=eq.${user.id}`,
        user.token,
        anonKey
      )
    ]);
    if (grants.length === 1 && existingReservations.length === 0) {
      createdUsers.push({ id: user.id, email: user.email });
      return user;
    }
  }

  const credentials = makeTestCredentials();
  const response = await api("/auth/v1/admin/users", {
    key: serviceKey,
    method: "POST",
    body: {
      email: credentials.email,
      password: credentials.password,
      email_confirm: true,
      user_metadata: { jevexa_staging_credit_test: true }
    }
  });
  const payload = await readJson(response);
  assert.equal(response.ok, true, `Staging test-user creation failed (HTTP ${response.status}).`);
  assert.ok(payload?.id, "Staging Auth API did not return a new test-user ID.");
  createdUsers.push({ id: payload.id, email: credentials.email });

  const login = await api("/auth/v1/token?grant_type=password", {
    key: anonKey,
    method: "POST",
    body: credentials
  });
  const session = await readJson(login);
  assert.equal(login.ok, true, `Staging test-user login failed (HTTP ${login.status}).`);
  assert.ok(session?.access_token, "Staging Auth API did not return a test session.");
  return { id: payload.id, token: session.access_token, ...credentials };
}

async function getRows(path, bearer = serviceKey, key = serviceKey) {
  const response = await api(path, { key, bearer });
  assert.equal(response.ok, true, `Staging read failed (HTTP ${response.status}).`);
  const rows = await readJson(response);
  assert.ok(Array.isArray(rows), "Expected a row list from Supabase REST.");
  return rows;
}

async function callRpc(name, args, bearer = serviceKey, key = serviceKey) {
  const response = await api(`/rest/v1/rpc/${name}`, {
    key,
    bearer,
    method: "POST",
    body: args
  });
  return { response, payload: await readJson(response) };
}

async function releaseOutstandingReservations() {
  for (const [requestId, status] of reservations) {
    if (status !== "reserved") continue;
    const { response, payload } = await callRpc("jevexa_credit_release", {
      p_user_id: operationUserId,
      p_request_id: requestId
    });
    if (response.ok && payload?.ok === true) reservations.set(requestId, "released");
  }
}

try {
  const pricingRows = await getRows(
    "/rest/v1/jevexa_service_pricing?select=service_key,integration_status,credits_per_1000_tokens,enabled"
  );
  const aiChat = pricingRows.find(row => row.service_key === "ai_chat");
  const unavailable = pricingRows.filter(row => row.service_key !== "ai_chat");
  assert.equal(pricingRows.length, 12, "Expected the 12 configured JEVEXA service entries.");
  assert.equal(aiChat?.enabled, true, "The staging AI chat service must be enabled.");
  assert.ok(["available", "partial"].includes(aiChat?.integration_status));
  assert.equal(aiChat.credits_per_1000_tokens, 1,
    "The staged reservation scenario requires the configured 1-credit-per-1,000-token rate.");
  assert.equal(unavailable.length, 11);
  assert.ok(unavailable.every(row => row.enabled === false && row.integration_status === "unavailable"),
    "All 11 unimplemented services must remain disabled.");
  passed("staging project pricing and 11 disabled integrations");
  const billingPermissionProbe = await api("/rest/v1/billing_orders?select=id&limit=0", {
    key: serviceKey
  });
  assert.equal(
    billingPermissionProbe.ok,
    true,
    `Safepay staging billing-order SELECT permission failed (HTTP ${billingPermissionProbe.status}).`
  );
  console.log(
    `READ_ONLY_SAFEPAY_BILLING_ORDER_SELECT=${billingPermissionProbe.ok}; http_status=${billingPermissionProbe.status}`
  );
  if (process.argv.includes("--preflight-only")) {
    console.log("READ_ONLY_PREFLIGHT=passed; no staging data was changed");
    process.exit(0);
  }

  const userA = await createTestUser();
  const userB = await createTestUser(new Set([userA.id]));
  assert.notEqual(userA.id, userB.id);
  passed("prepared two isolated, confirmed staging-only test users");

  for (const user of [userA, userB]) {
    const wallets = await getRows(
      `/rest/v1/user_credits?select=user_id,balance,monthly_allowance&user_id=eq.${user.id}`,
      user.token,
      anonKey
    );
    const grants = await getRows(
      `/rest/v1/credit_transactions?select=id,amount,type,reference&user_id=eq.${user.id}&reference=eq.${encodeURIComponent(`signup:${user.id}`)}`,
      user.token,
      anonKey
    );
    assert.equal(wallets.length, 1, "New Auth user must receive exactly one wallet.");
    assert.equal(wallets[0].balance, 100, "New Auth user must receive 100 signup credits.");
    assert.equal(grants.length, 1, "New Auth user must receive exactly one welcome ledger entry.");
    assert.equal(grants[0].amount, 100);
    assert.equal(grants[0].type, "welcome");
  }
  passed("signup trigger provisions exactly one 100-credit wallet and welcome entry");

  const duplicateResponse = await api("/auth/v1/admin/users", {
    key: serviceKey,
    method: "POST",
    body: {
      email: userA.email,
      password: userA.password,
      email_confirm: true,
      user_metadata: { jevexa_staging_credit_test: true }
    }
  });
  assert.equal(duplicateResponse.ok, false, "Auth must reject duplicate signup for an existing email.");
  const usersByEmail = await getRows(
    `/rest/v1/user_credits?select=user_id,balance&user_id=eq.${userA.id}`,
    userA.token,
    anonKey
  );
  const duplicateGrants = await getRows(
    `/rest/v1/credit_transactions?select=id&user_id=eq.${userA.id}&reference=eq.${encodeURIComponent(`signup:${userA.id}`)}`,
    userA.token,
    anonKey
  );
  assert.equal(usersByEmail.length, 1);
  assert.equal(duplicateGrants.length, 1);
  passed("duplicate signup retry does not duplicate the wallet or welcome grant");

  for (const [user, other] of [[userA, userB], [userB, userA]]) {
    const ownWallet = await getRows(
      `/rest/v1/user_credits?select=user_id&user_id=eq.${user.id}`,
      user.token,
      anonKey
    );
    const otherWallet = await getRows(
      `/rest/v1/user_credits?select=user_id&user_id=eq.${other.id}`,
      user.token,
      anonKey
    );
    const ownLedger = await getRows(
      `/rest/v1/credit_transactions?select=user_id&user_id=eq.${user.id}`,
      user.token,
      anonKey
    );
    const otherLedger = await getRows(
      `/rest/v1/credit_transactions?select=user_id&user_id=eq.${other.id}`,
      user.token,
      anonKey
    );
    assert.equal(ownWallet.length, 1);
    assert.equal(otherWallet.length, 0);
    assert.ok(ownLedger.length >= 1);
    assert.equal(otherLedger.length, 0);
  }
  passed("RLS isolates balances and ledgers between both staging users");

  const walletBeforeWrite = await getRows(
    `/rest/v1/user_credits?select=balance&user_id=eq.${userA.id}`,
    userA.token,
    anonKey
  );
  const writeProbe = await api(`/rest/v1/user_credits?user_id=eq.${userA.id}`, {
    key: anonKey,
    bearer: userA.token,
    method: "PATCH",
    body: { balance: walletBeforeWrite[0].balance },
    headers: { Prefer: "return=representation" }
  });
  const writeRows = await readJson(writeProbe);
  assert.equal(writeProbe.ok && Array.isArray(writeRows) && writeRows.length > 0, false,
    "Authenticated browser must not be able to update a wallet.");
  const walletAfterWrite = await getRows(
    `/rest/v1/user_credits?select=balance&user_id=eq.${userA.id}`,
    userA.token,
    anonKey
  );
  assert.equal(walletAfterWrite[0].balance, walletBeforeWrite[0].balance);

  const clientRpcChecks = await Promise.all([
    callRpc("jevexa_credit_quote", {
      p_service: "ai_chat",
      p_estimated_tokens: 1000
    }, userA.token, anonKey),
    callRpc("jevexa_credit_reserve", {
      p_user_id: userA.id,
      p_request_id: randomUUID(),
      p_service: "ai_chat",
      p_estimated_tokens: 1000
    }, userA.token, anonKey),
    callRpc("jevexa_credit_settle", {
      p_user_id: userA.id,
      p_request_id: randomUUID(),
      p_usage_tokens: 1000
    }, userA.token, anonKey),
    callRpc("jevexa_credit_release", {
      p_user_id: userA.id,
      p_request_id: randomUUID()
    }, userA.token, anonKey),
    callRpc("jevexa_credit_adjust", {
      p_user_id: randomUUID(),
      p_request_id: randomUUID(),
      p_amount: 1,
      p_type: "grant",
      p_description: "Staging permission probe",
      p_service: null
    }, userA.token, anonKey)
  ]);
  assert.ok(
    clientRpcChecks.every(result => !result.response.ok),
    "Authenticated browser must not execute any privileged credit RPC."
  );
  passed("browser wallet writes and all five privileged credit RPCs are denied");

  operationUserId = userA.id;
  const requestIds = [randomUUID(), randomUUID(), randomUUID()];
  const outcomes = await Promise.all(requestIds.map(async requestId => {
    const result = await callRpc("jevexa_credit_reserve", {
      p_user_id: userA.id,
      p_request_id: requestId,
      p_service: "ai_chat",
      p_estimated_tokens: 50000
    });
    return { requestId, ...result };
  }));
  for (const outcome of outcomes) {
    if (outcome.response.ok && outcome.payload?.ok === true && outcome.payload.status === "reserved") {
      reservations.set(outcome.requestId, "reserved");
      assert.equal(outcome.payload.reserved_credits, 50);
    }
  }
  const succeeded = outcomes.filter(outcome => outcome.response.ok && outcome.payload?.ok === true);
  const insufficient = outcomes.filter(outcome =>
    outcome.response.ok && outcome.payload?.ok === false && outcome.payload.error === "insufficient_credits"
  );
  assert.equal(succeeded.length, 2, "Exactly two concurrent 50-credit reservations should succeed.");
  assert.equal(insufficient.length, 1, "The third concurrent reservation must be insufficient.");
  assert.equal((await getRows(
    `/rest/v1/user_credits?select=balance&user_id=eq.${userA.id}`,
    userA.token,
    anonKey
  ))[0].balance, 0);
  passed("three concurrent reservations serialize; exactly two succeed and one is insufficient");

  const [toSettle, toRelease] = succeeded;
  const settlement = await callRpc("jevexa_credit_settle", {
    p_user_id: userA.id,
    p_request_id: toSettle.requestId,
    p_usage_tokens: 1000
  });
  assert.equal(settlement.response.ok, true);
  assert.equal(settlement.payload?.ok, true);
  assert.equal(settlement.payload.charged_credits, 1);
  reservations.set(toSettle.requestId, "settled");

  const duplicateReserve = await callRpc("jevexa_credit_reserve", {
    p_user_id: userA.id,
    p_request_id: toSettle.requestId,
    p_service: "ai_chat",
    p_estimated_tokens: 50000
  });
  assert.equal(duplicateReserve.payload?.duplicate, true);
  assert.equal(duplicateReserve.payload.status, "settled");

  const duplicateSettlement = await callRpc("jevexa_credit_settle", {
    p_user_id: userA.id,
    p_request_id: toSettle.requestId,
    p_usage_tokens: 1000
  });
  assert.equal(duplicateSettlement.payload?.duplicate, true);
  assert.equal(duplicateSettlement.payload.charged_credits, 1);

  const release = await callRpc("jevexa_credit_release", {
    p_user_id: userA.id,
    p_request_id: toRelease.requestId
  });
  assert.equal(release.payload?.ok, true);
  reservations.set(toRelease.requestId, "released");
  const duplicateRelease = await callRpc("jevexa_credit_release", {
    p_user_id: userA.id,
    p_request_id: toRelease.requestId
  });
  assert.equal(duplicateRelease.payload?.duplicate, true);
  assert.equal((await getRows(
    `/rest/v1/user_credits?select=balance&user_id=eq.${userA.id}`,
    userA.token,
    anonKey
  ))[0].balance, 99);
  passed("token-based settlement, duplicate request handling, and idempotent release");

  const duplicateRequestId = randomUUID();
  const duplicateOutcomes = await Promise.all([
    callRpc("jevexa_credit_reserve", {
      p_user_id: userB.id,
      p_request_id: duplicateRequestId,
      p_service: "ai_chat",
      p_estimated_tokens: 50000
    }),
    callRpc("jevexa_credit_reserve", {
      p_user_id: userB.id,
      p_request_id: duplicateRequestId,
      p_service: "ai_chat",
      p_estimated_tokens: 50000
    })
  ]);
  if (duplicateOutcomes.some(outcome =>
    outcome.response.ok && outcome.payload?.ok === true && outcome.payload.status === "reserved"
  )) {
    reservations.set(duplicateRequestId, "reserved");
  }
  assert.ok(duplicateOutcomes.every(outcome => outcome.response.ok && outcome.payload?.ok === true));
  assert.equal(duplicateOutcomes.filter(outcome => outcome.payload.duplicate === false).length, 1);
  assert.equal(duplicateOutcomes.filter(outcome => outcome.payload.duplicate === true).length, 1);
  assert.equal(duplicateOutcomes.find(outcome => outcome.payload.duplicate === false).payload.reserved_credits, 50);
  const duplicateUserBalance = await getRows(
    `/rest/v1/user_credits?select=balance&user_id=eq.${userB.id}`,
    userB.token,
    anonKey
  );
  assert.equal(duplicateUserBalance[0].balance, 50);
  const duplicateRequestRelease = await callRpc("jevexa_credit_release", {
    p_user_id: userB.id,
    p_request_id: duplicateRequestId
  });
  assert.equal(duplicateRequestRelease.response.ok, true);
  assert.equal(duplicateRequestRelease.payload?.ok, true);
  reservations.set(duplicateRequestId, "released");
  assert.equal((await getRows(
    `/rest/v1/user_credits?select=balance&user_id=eq.${userB.id}`,
    userB.token,
    anonKey
  ))[0].balance, 100);
  passed("simultaneous identical requests reserve once and release once");

  const otherReservations = await getRows(
    `/rest/v1/credit_reservations?select=user_id&user_id=eq.${userA.id}`,
    userB.token,
    anonKey
  );
  assert.equal(otherReservations.length, 0);

  const usageRows = await getRows(
    `/rest/v1/credit_transactions?select=id,amount,request_id,metadata&user_id=eq.${userA.id}&request_id=eq.${toSettle.requestId}`,
    userA.token,
    anonKey
  );
  assert.equal(usageRows.length, 1);
  assert.equal(usageRows[0].amount, -1);
  assert.equal(usageRows[0].metadata?.total_tokens, 1000);

  for (const method of ["PATCH", "DELETE"]) {
    const response = await api(`/rest/v1/credit_transactions?id=eq.${usageRows[0].id}`, {
      key: serviceKey,
      method,
      ...(method === "PATCH"
        ? { body: { amount: usageRows[0].amount }, headers: { Prefer: "return=representation" } }
        : {})
    });
    const body = await response.text();
    assert.equal(response.ok, false, `Ledger ${method} must be denied or rejected by its immutability trigger.`);
    const error = JSON.parse(body);
    assert.ok(
      (error.code === "42501" && /permission denied for table credit_transactions/i.test(error.message))
        || /credit ledger entries cannot be changed or deleted/i.test(error.message),
      `Ledger ${method} was rejected for an unexpected reason.`
    );
  }
  const ledgerAfter = await getRows(
    `/rest/v1/credit_transactions?select=id,amount,request_id&user_id=eq.${userA.id}&request_id=eq.${toSettle.requestId}`,
    userA.token,
    anonKey
  );
  assert.equal(ledgerAfter.length, 1);
  assert.equal(ledgerAfter[0].amount, -1);
  passed("service-role REST cannot update or delete the ledger; SQL trigger behavior is covered by the consolidated SQL check");

  const [finalWalletA, finalWalletB] = await Promise.all([
    getRows(`/rest/v1/user_credits?select=balance&user_id=eq.${userA.id}`, userA.token, anonKey),
    getRows(`/rest/v1/user_credits?select=balance&user_id=eq.${userB.id}`, userB.token, anonKey)
  ]);
  assert.equal(finalWalletA[0].balance, 99);
  assert.equal(finalWalletB[0].balance, 100);
  passed("final balances and usage-history ledger agree");

  const refundRequestId = randomUUID();
  const refundArgs = {
    p_user_id: userA.id,
    p_request_id: refundRequestId,
    p_amount: 1,
    p_type: "refund",
    p_description: "Staging idempotent refund regression",
    p_service: "ai_chat"
  };
  const [refund, duplicateRefund] = await Promise.all([
    callRpc("jevexa_credit_adjust", refundArgs),
    callRpc("jevexa_credit_adjust", refundArgs)
  ]);
  assert.equal(refund.response.ok, true);
  assert.equal(refund.payload?.ok, true);
  assert.equal(duplicateRefund.response.ok, true);
  assert.equal(duplicateRefund.payload?.ok, true);
  assert.equal([refund, duplicateRefund].filter(result => result.payload.duplicate === false).length, 1);
  assert.equal([refund, duplicateRefund].filter(result => result.payload.duplicate === true).length, 1);
  const refundLedger = await getRows(
    `/rest/v1/credit_transactions?select=amount,type,request_id&user_id=eq.${userA.id}&request_id=eq.${refundRequestId}`,
    userA.token,
    anonKey
  );
  assert.equal(refundLedger.length, 1);
  assert.equal(refundLedger[0].amount, 1);
  assert.equal(refundLedger[0].type, "refund");
  assert.equal((await getRows(
    `/rest/v1/user_credits?select=balance&user_id=eq.${userA.id}`,
    userA.token,
    anonKey
  ))[0].balance, 100);
  passed("concurrent duplicate refunds grant credits and write ledger exactly once");

  if (geminiApiKey) {
    const liveRequestId = randomUUID();
    const liveResponse = await worker.fetch(new Request("https://jevexa-staging.test/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userB.token}`,
        "Idempotency-Key": liveRequestId
      },
      body: JSON.stringify({ message: "Reply with exactly the word OK." })
    }), {
      SUPABASE_URL: supabaseUrl,
      SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      GEMINI_API_KEY: geminiApiKey
    });
    const livePayload = await readJson(liveResponse);
    assert.equal(
      liveResponse.status,
      200,
      `Live staging Gemini Worker request failed (HTTP ${liveResponse.status}).`
    );
    assert.equal(typeof livePayload?.reply, "string");
    assert.ok(livePayload.reply.trim().length > 0);
    assert.ok(Number.isInteger(livePayload.totalTokens) && livePayload.totalTokens > 0);
    assert.ok(Number.isInteger(livePayload.creditsCharged) && livePayload.creditsCharged > 0);
    assert.ok(Number.isInteger(livePayload.creditsRemaining) && livePayload.creditsRemaining >= 0);
    assert.equal(livePayload.usageEstimated, false);
    const liveLedger = await getRows(
      `/rest/v1/credit_transactions?select=amount,request_id,metadata&user_id=eq.${userB.id}&request_id=eq.${liveRequestId}`,
      userB.token,
      anonKey
    );
    assert.equal(liveLedger.length, 1);
    assert.equal(liveLedger[0].amount, -livePayload.creditsCharged);
    assert.equal(liveLedger[0].metadata?.total_tokens, livePayload.totalTokens);
    passed("real Gemini Worker request used measured tokens and settled staging credits");
  } else {
    console.log("SKIP real Gemini Worker request: GEMINI_API_KEY is not configured.");
  }
} finally {
  await releaseOutstandingReservations();
  if (createdUsers.length) {
    console.log(`NOTE ${createdUsers.length} staging test users and their audit rows were retained; no test data was deleted.`);
  }
}

console.log(`STAGING_INTEGRATION_RESULTS=${results.filter(result => result.passed).length}/${results.length}`);
