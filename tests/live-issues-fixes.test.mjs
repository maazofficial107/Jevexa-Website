import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../worker.js";

const readAsset = (relPath) => readFile(new URL(`../${relPath}`, import.meta.url), "utf8");

const env = {
  SUPABASE_URL: "https://byopcuspgnhwsrmsxqvm.supabase.co",
  SUPABASE_ANON_KEY: "unit-anon",
  SUPABASE_SERVICE_ROLE_KEY: "unit-service",
  JEVEXA_ENVIRONMENT: "production"
};

test("Issue 1: Document AI & OCR browse files trigger, external file input, and multi-format support", async () => {
  const html = await readAsset("index.html");
  const ocrJs = await readAsset("ocr.js");
  const css = await readAsset("styles.css");

  // #ocrFileInput must live outside #ocrDropzone so fileInput.click() never bubbles back to dropzone
  const dropzoneIdx = html.indexOf('id="ocrDropzone"');
  const fileInputIdx = html.indexOf('id="ocrFileInput"');
  const textInputIdx = html.indexOf('id="ocrTextInput"');
  assert.ok(dropzoneIdx !== -1 && fileInputIdx !== -1 && textInputIdx !== -1);
  assert.ok(fileInputIdx > dropzoneIdx && fileInputIdx < textInputIdx);
  const betweenDropAndInput = html.slice(dropzoneIdx, fileInputIdx);
  assert.ok(betweenDropAndInput.includes("</div>"), "#ocrDropzone must close before #ocrFileInput");

  // Explicit browse button and attached file badge with clear button
  assert.match(html, /<button[^>]*id="ocrBrowseBtn"[^>]*type="button"|<button[^>]*type="button"[^>]*id="ocrBrowseBtn"/);
  assert.match(html, /id="ocrFileBadge"/);
  assert.match(html, /id="ocrClearFileBtn"/);

  // Supports all 8 formats and avoids JEVEXA_SAFE_INTERACTION preventDefault interference on dropzone click
  for (const ext of [".pdf", ".png", ".jpg", ".webp", ".txt", ".csv", ".json", ".md"]) {
    assert.ok(ocrJs.includes(ext), `ocr.js must support ${ext}`);
    assert.ok(html.includes(ext), `index.html accept attribute must include ${ext}`);
  }
  assert.match(ocrJs, /fileInput\.addEventListener\('click',\s*\(e\)\s*=>\s*\{\s*e\.stopPropagation\(\);/);
  assert.match(ocrJs, /browseBtn\.addEventListener\('click'/);
  assert.match(ocrJs, /dropzone\.addEventListener\('click'/);
  assert.match(ocrJs, /if\s*\(textInput\s*&&\s*state\.textIsAutoLoaded\)\s*\{\s*textInput\.value\s*=\s*'';/);
  assert.match(css, /\.ocr-browse-text\s*\{/);
  assert.match(css, /\.ocr-file-badge\s*\{/);
});

test("Issue 2: User & Admin Management client state, seat availability, and worker team persistence lifecycle", async () => {
  const html = await readAsset("index.html");
  const teamJs = await readAsset("team.js");

  assert.match(html, /id="teamInviteForm"[^>]*novalidate/);
  assert.match(html, /id="teamInviteError"/);
  assert.match(html, /id="teamAdminStatus"/);
  assert.match(html, /id="teamRoleSummary"/);

  // Default guest roster must leave an open seat on Free plan (maxSeats: 3)
  const defaultMembersMatch = teamJs.match(/const DEFAULT_MEMBERS = \[([\s\S]*?)\];/);
  assert.ok(defaultMembersMatch, "DEFAULT_MEMBERS must exist in team.js");
  const defaultCount = (defaultMembersMatch[1].match(/id:\s*'/g) || []).length;
  assert.ok(defaultCount >= 1 && defaultCount < 3, `DEFAULT_MEMBERS should have < 3 members so Free plan has open seat(s), got ${defaultCount}`);

  assert.match(teamJs, /setInviteError\(/);
  assert.match(teamJs, /setAdminStatus\(/);
  assert.match(teamJs, /if\s*\(res\.error\s*&&\s*res\.status\s*&&\s*res\.status\s*>=\s*400\)/);

  // Real Worker lifecycle test with metadata fallback persistence (when team_members table returns 404)
  let storedUserMeta = {};
  const ownerUser = {
    id: "9f6d10a8-e03a-4f6b-8aa2-5b7da1c42fb1",
    email: "owner@jevexa.net",
    user_metadata: storedUserMeta
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") {
      return Response.json({ ...ownerUser, user_metadata: storedUserMeta });
    }
    if (url.pathname === "/rest/v1/user_credits") {
      return Response.json([{ plan: "free", balance: 100 }]);
    }
    if (url.pathname.startsWith("/rest/v1/team_members")) {
      return Response.json({ message: "relation does not exist" }, { status: 404 });
    }
    if (url.pathname === `/auth/v1/admin/users/${ownerUser.id}` && options.method === "PUT") {
      const body = JSON.parse(options.body);
      storedUserMeta = body.user_metadata || {};
      return Response.json({ id: ownerUser.id, user_metadata: storedUserMeta });
    }
    return new Response("Not Found", { status: 404 });
  };

  try {
    const authHeaders = {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token"
    };

    // 1. Invite member
    const inviteRes = await worker.fetch(new Request("https://jevexa.net/api/team/invite", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ email: "alex@partner.io", role: "Admin", currentMemberCount: 1 })
    }), env);
    assert.equal(inviteRes.status, 200);
    const inviteData = await inviteRes.json();
    assert.equal(inviteData.ok, true);
    assert.equal(inviteData.member.email, "alex@partner.io");
    assert.equal(inviteData.member.role, "Admin");
    const memberId = inviteData.member.id;

    // 2. Duplicate invite must return 409
    const dupRes = await worker.fetch(new Request("https://jevexa.net/api/team/invite", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ email: "alex@partner.io", role: "Member", currentMemberCount: 2 })
    }), env);
    assert.equal(dupRes.status, 409);

    // 3. GET /api/team/members returns persisted owner + invited member
    const listRes = await worker.fetch(new Request("https://jevexa.net/api/team/members", {
      method: "GET",
      headers: authHeaders
    }), env);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.members.length, 2);
    assert.equal(listData.members[1].email, "alex@partner.io");

    // 4. PATCH role + status
    const patchRes = await worker.fetch(new Request("https://jevexa.net/api/team/members", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ id: memberId, email: "alex@partner.io", role: "Viewer", status: "Suspended" })
    }), env);
    assert.equal(patchRes.status, 200);
    const patchData = await patchRes.json();
    assert.equal(patchData.member.role, "Viewer");
    assert.equal(patchData.member.status, "Suspended");

    // 5. GET /api/team/audit returns real recorded events
    const auditRes = await worker.fetch(new Request("https://jevexa.net/api/team/audit", {
      method: "GET",
      headers: authHeaders
    }), env);
    assert.equal(auditRes.status, 200);
    const auditData = await auditRes.json();
    assert.ok(auditData.logs.length >= 2);
    assert.ok(auditData.logs.some(l => l.action === "Member Invited" && l.details.includes("alex@partner.io")));

    // 6. DELETE /api/team/members removes member cleanly (no url ReferenceError)
    const delRes = await worker.fetch(new Request(`https://jevexa.net/api/team/members?id=${encodeURIComponent(memberId)}&email=alex%40partner.io`, {
      method: "DELETE",
      headers: authHeaders
    }), env);
    assert.equal(delRes.status, 200);

    const afterDelRes = await worker.fetch(new Request("https://jevexa.net/api/team/members", {
      method: "GET",
      headers: authHeaders
    }), env);
    const afterDelData = await afterDelRes.json();
    assert.equal(afterDelData.members.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Issue 3: Workflow Automation + Add Step persistence, action type editing, and Run/Export integration", async () => {
  const workflowsJs = await readAsset("workflows.js");

  assert.match(workflowsJs, /const WORKFLOW_STATE_STORAGE_KEY = 'jevexa_workflow_state_cache'/);
  assert.match(workflowsJs, /const STEP_ACTION_LABELS = \{/);
  assert.match(workflowsJs, /function commitPendingStepEdit\(\)/);
  assert.match(workflowsJs, /edit-step-action/);
  assert.match(workflowsJs, /saveCachedWorkflowState\(\)/);
  assert.match(workflowsJs, /loadCachedWorkflowState\(\)/);
});

test("Issue 4: Workspace back navigation preserves prior scroll position without unwanted jump down", async () => {
  const scriptJs = await readAsset("script.js");

  assert.match(scriptJs, /function captureStudioScroll\(/);
  assert.match(scriptJs, /window\.__jevexaSavedStudioScrollY/);
  assert.match(scriptJs, /window\.scrollTo\(\{\s*top:\s*restoreY,\s*left:\s*0,\s*behavior:\s*'instant'\s*\}\)/);
  assert.match(scriptJs, /chatbotToggle\?\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.match(scriptJs, /chatbotToggle\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
});
