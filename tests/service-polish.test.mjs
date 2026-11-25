import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../worker.js";

const readAsset = (relPath) => readFile(new URL(`../${relPath}`, import.meta.url), "utf8");

test("Visual Polish: dark workspace controls, OCR card, Analytics panels, and custom scrollbar tokens", async () => {
    const css = await readAsset("styles.css");

    // Undefined variable fix for Content history drawer
    assert.match(css, /--text-heading:\s*#/);
    assert.match(css, /--text-body:\s*#/);

    // Unified dark workspace input/textarea/select styling & light-theme opt-out
    assert.match(css, /\.tool-workspace,\s*[\s\S]*?color-scheme:\s*dark;/);
    assert.match(css, /html\[data-jevexa-theme="light"\]\s+\.tool-workspace[\s\S]*?color-scheme:\s*light;/);
    assert.match(css, /\.tool-workspace textarea\s*\{/);
    assert.match(css, /\.tool-workspace input\[type="date"\]::-webkit-calendar-picker-indicator/);

    // Explicit styling for OCR result card, Analytics panels, and RBAC matrix
    for (const selector of [
        ".ocr-result-card",
        ".ocr-meta-grid",
        ".ocr-table-wrap",
        ".ocr-totals-box",
        ".analytics-chart-box",
        ".report-section",
        ".forecast-scenarios-box",
        ".analytics-action-pill",
        ".rbac-matrix-table",
        ".content-history-item"
    ]) {
        assert.ok(css.includes(selector), `styles.css must style ${selector}`);
    }
});

test("Copy & UI Context Cleanup across index.html and outreach.js", async () => {
    const html = await readAsset("index.html");
    const outreachJs = await readAsset("outreach.js");

    // Outdated "two tools / three releases / Verification pending" claims removed
    assert.doesNotMatch(html, /The other eight AI tools will roll out across three releases/i);
    assert.doesNotMatch(html, /The other eight tools are planned across three releases/i);
    assert.doesNotMatch(html, /<span>Verification pending<\/span>/i);
    assert.doesNotMatch(html, /Requires configured provider access/i);

    // OCR preview defaults match Apex Cloud Computing Inc. ($757.75)
    assert.match(html, /<h3 id="ocrVendorName"[^>]*>Apex Cloud Computing Inc\.<\/h3>/);
    assert.match(html, /<strong id="ocrTotal">\$757\.75<\/strong>/);

    // Outreach clean placeholder signature
    assert.ok(outreachJs.includes("[Your Name]"));
    assert.doesNotMatch(outreachJs, /Jevexa AI Automation Studio/);
});

test("Service 01 & 02: Attachment empty-file guard and whitespace brief validation", async () => {
    const creditsJs = await readAsset("credits.js");
    const contentJs = await readAsset("content.js");

    assert.match(creditsJs, /if\s*\(!file\.size\)/);
    assert.match(contentJs, /const trimmedTopic = topicInput\.value\.trim\(\);\s*if\s*\(!trimmedTopic\)/);
});

test("Service 03: Document OCR binary upload, multi-currency symbols, and Gemini Vision inlineData", async () => {
    const ocrJs = await readAsset("ocr.js");
    const workerJs = await readAsset("worker.js");

    // Client-side fixes
    assert.doesNotMatch(ocrJs, /\[Uploaded Binary File:/);
    assert.match(ocrJs, /if\s*\(file\.size === 0\)/);
    assert.match(ocrJs, /function getCurrencySymbol\(/);
    assert.match(ocrJs, /PKR/);
    assert.match(ocrJs, /CA\$/);
    assert.match(ocrJs, /if\s*\(!text && state\.uploadedFileData\)/);

    // Worker Gemini Vision inlineData wiring & payload validation
    assert.match(workerJs, /inlineData:\s*parsed\.inlineFilePart/);
    assert.match(workerJs, /readRequestJson\(request,\s*5242880\)/);

    const invalidOcrReq = new Request("https://jevexa.net/api/ocr/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            requestId: "11111111-1111-4111-8111-111111111111",
            documentText: "",
            fileData: ""
        })
    });
    const res = await worker.fetch(invalidOcrReq, {}, {});
    assert.equal(res.status, 400);
});

test("Service 04: Social Assistant Threads/Facebook support and calendar empty-post validation", async () => {
    const socialJs = await readAsset("social.js");
    const workerJs = await readAsset("worker.js");

    assert.match(socialJs, /normPlatform === 'threads'/);
    assert.match(socialJs, /normPlatform === 'facebook'/);
    assert.match(socialJs, /const content = postBodyEl \? postBodyEl\.value\.trim\(\) : '';/);

    assert.match(workerJs, /normPlatform === "threads"/);
    assert.match(workerJs, /normPlatform === "facebook"/);
});

test("Service 05, 06, 07, 08: Fetch lock reset, Team PATCH/DELETE validation, Workflow logout key, Data row/export guards", async () => {
    const analyticsJs = await readAsset("analytics.js");
    const teamJs = await readAsset("team.js");
    const workflowsJs = await readAsset("workflows.js");
    const dataJs = await readAsset("data-mgmt.js");
    const workerJs = await readAsset("worker.js");

    // Service 05: finally resets isFetchingUrl & empty file rejected
    assert.match(analyticsJs, /finally\s*\{[\s\S]*?state\.isFetchingUrl\s*=\s*false;/);
    assert.match(analyticsJs, /if\s*\(file\.size === 0\)/);

    // Service 06: role/status/remove sync + worker PATCH validation
    assert.match(teamJs, /async function syncTeamMemberMutation/);
    assert.match(teamJs, /syncTeamMemberMutation\('PATCH'/);
    assert.match(teamJs, /syncTeamMemberMutation\('DELETE'/);
    assert.match(workerJs, /method === "PATCH"[\s\S]*?Member id or email is required/);

    // Service 07: clean logout storage key
    assert.match(workflowsJs, /localStorage\.removeItem\(WORKFLOW_RUNS_STORAGE_KEY\)/);
    assert.doesNotMatch(workflowsJs, /localStorage\.removeItem\(RUNS_STORAGE_KEY\)/);

    // Service 08: header-only and empty export guards
    assert.match(dataJs, /if\s*\(!looksLikeJson && nonEmptyLines\.length < 2\)/);
    assert.match(dataJs, /function ensureCleanedRecordsForExport\(/);
});

test("Service 09 & 10: CRM CSV guards, session cache sync, and Outreach UUID-safe CRM sync", async () => {
    const crmJs = await readAsset("crm.js");
    const outreachJs = await readAsset("outreach.js");

    assert.match(crmJs, /async function handleCsvImport\(file\)[\s\S]*?if\s*\(file\.size === 0\)/);
    assert.match(crmJs, /file\.size > 5 \* 1024 \* 1024/);
    assert.match(crmJs, /sessionStorage\.setItem\('jevexa_crm_leads_cache'/);

    assert.match(outreachJs, /uuidPattern\.test\(state\.currentSequenceId\)/);
    assert.match(outreachJs, /fetch\('\/api\/crm\/leads'/);
});
