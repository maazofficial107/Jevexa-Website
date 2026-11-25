import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../worker.js";

test("Security: /api/analytics/fetch-url blocks private, loopback, and metadata SSRF destinations", async () => {
  const blockedUrls = [
    "http://127.0.0.1:8787/admin",
    "http://localhost:3000",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/internal",
    "http://192.168.1.1/",
    "http://172.16.0.10/",
    "http://[::1]:8080/",
    "ftp://example.com/data.csv",
    "https://user:pass@example.com/"
  ];

  for (const url of blockedUrls) {
    const req = new Request("https://jevexa.net/api/analytics/fetch-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const res = await worker.fetch(req, {}, {});
    assert.equal(res.status, 400, `Expected 400 SSRF block for ${url}`);
    const payload = await res.json();
    assert.match(payload.error, /Blocked|Invalid/i);
  }
});

test("Worker hardening: /api/health rejects non-GET/HEAD methods cleanly", async () => {
  const postReq = new Request("https://jevexa.net/api/health", { method: "POST" });
  const res = await worker.fetch(postReq, {}, {});
  assert.equal(res.status, 405);
});

test("Full Suite UI & Reset Contracts: zero native confirm/prompt dialogs, initialized guards, and logout resets", async () => {
  const files = {
    scriptJs: await readFile(new URL("../script.js", import.meta.url), "utf8"),
    creditsJs: await readFile(new URL("../credits.js", import.meta.url), "utf8"),
    contentJs: await readFile(new URL("../content.js", import.meta.url), "utf8"),
    ocrJs: await readFile(new URL("../ocr.js", import.meta.url), "utf8"),
    socialJs: await readFile(new URL("../social.js", import.meta.url), "utf8"),
    analyticsJs: await readFile(new URL("../analytics.js", import.meta.url), "utf8"),
    teamJs: await readFile(new URL("../team.js", import.meta.url), "utf8"),
    workflowsJs: await readFile(new URL("../workflows.js", import.meta.url), "utf8"),
    dataJs: await readFile(new URL("../data-mgmt.js", import.meta.url), "utf8"),
    crmJs: await readFile(new URL("../crm.js", import.meta.url), "utf8"),
    outreachJs: await readFile(new URL("../outreach.js", import.meta.url), "utf8"),
    adminHtml: await readFile(new URL("../admin.html", import.meta.url), "utf8"),
    stylesCss: await readFile(new URL("../styles.css", import.meta.url), "utf8")
  };

  // Zero blocking browser confirm() or prompt() calls across interactive controllers
  for (const [name, src] of Object.entries(files)) {
    if (name.endsWith("Js")) {
      assert.doesNotMatch(src, /\b(?:window\.)?(?:confirm|prompt)\s*\(/, `${name} must use in-app confirmation/inline edit UI`);
    }
  }

  // Re-initialization guards on tool modules
  for (const name of ["ocrJs", "socialJs", "analyticsJs", "teamJs", "workflowsJs", "dataJs"]) {
    assert.match(files[name], /if\s*\(initialized\)\s*return;/, `${name} must guard init() against duplicate bindings`);
  }

  // All workspaces expose logout reset handlers and script.js invokes them
  for (const hook of [
    "JEVEXA_CLEAR_ACCOUNT_STATE",
    "JEVEXA_CONTENT?.resetOnLogout",
    "JEVEXA_OCR?.resetOnLogout",
    "JEVEXA_SOCIAL?.resetOnLogout",
    "JEVEXA_ANALYTICS?.resetOnLogout",
    "JEVEXA_TEAM?.resetOnLogout",
    "JEVEXA_WORKFLOWS?.resetOnLogout",
    "JEVEXA_DATA_MGMT?.resetOnLogout",
    "JEVEXA_CRM?.resetOnLogout",
    "JEVEXA_OUTREACH?.resetOnLogout"
  ]) {
    assert.ok(files.scriptJs.includes(hook), `script.js logoutUser must call ${hook}`);
  }

  // Sub-page & admin hardening
  assert.match(files.adminHtml, /<meta\s+name="robots"\s+content="noindex,\s*nofollow">/i);
  assert.match(files.stylesCss, /\.btn-sm\s*\{/);
  assert.match(files.stylesCss, /\.btn-xs\s*\{/);
  assert.match(files.stylesCss, /overflow-x:\s*clip\s*!important;/);
});
