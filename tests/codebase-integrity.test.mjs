import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Codebase Integrity: index.html workspaces and structure for all 10 services', () => {
  const indexHtml = fs.readFileSync('index.html', 'utf8');

  const services = [
    { id: 'chatbot', name: '01: AI Chatbot', selector: 'chatbotWindow' },
    { id: 'content', name: '02: Content Engine', selector: 'contentWorkspace' },
    { id: 'ocr', name: '03: Document AI & OCR', selector: 'ocrWorkspace' },
    { id: 'social', name: '04: Social Media Assistant', selector: 'socialWorkspace' },
    { id: 'analytics', name: '05: Business Analytics', selector: 'analyticsWorkspace' },
    { id: 'admin', name: '06: User & Admin Management', selector: 'teamAdminWorkspace' },
    { id: 'workflows', name: '07: Workflow Automation', selector: 'workflowsWorkspace' },
    { id: 'data', name: '08: Data Management', selector: 'dataWorkspace' },
    { id: 'crm', name: '09: Mini CRM', selector: 'crmWorkspace' },
    { id: 'outreach', name: '10: Email & Outreach AI', selector: 'outreachWorkspace' }
  ];

  for (const s of services) {
    assert.ok(
      indexHtml.includes(`id="${s.selector}"`),
      `Workspace container id="${s.selector}" for ${s.name} must exist in index.html`
    );
  }
});

test('Codebase Integrity: styles.css syntax and balanced braces', () => {
  const css = fs.readFileSync('styles.css', 'utf8');
  let openBraces = 0;
  let line = 1;
  const errors = [];

  for (let i = 0; i < css.length; i++) {
    if (css[i] === '\n') line++;
    if (css[i] === '{') openBraces++;
    if (css[i] === '}') {
      openBraces--;
      if (openBraces < 0) {
        errors.push(`Extra closing brace at line ${line}`);
        openBraces = 0;
      }
    }
  }
  if (openBraces > 0) {
    errors.push(`Unclosed braces at end of file: ${openBraces}`);
  }

  assert.deepEqual(errors, [], `styles.css must have zero brace syntax errors: ${errors.join(', ')}`);
});

test('Codebase Integrity: premium.css syntax and balanced braces', () => {
  const css = fs.readFileSync('premium.css', 'utf8');
  let openBraces = 0;
  let line = 1;
  const errors = [];

  for (let i = 0; i < css.length; i++) {
    if (css[i] === '\n') line++;
    if (css[i] === '{') openBraces++;
    if (css[i] === '}') {
      openBraces--;
      if (openBraces < 0) {
        errors.push(`Extra closing brace at line ${line}`);
        openBraces = 0;
      }
    }
  }
  if (openBraces > 0) {
    errors.push(`Unclosed braces at end of file: ${openBraces}`);
  }

  assert.deepEqual(errors, [], `premium.css must have zero brace syntax errors`);
});

test('Codebase Integrity: HTML data-jevexa-action attributes handled in client scripts', () => {
  const indexHtml = fs.readFileSync('index.html', 'utf8');
  const actionRegex = /data-jevexa-action=["']([^"']+)["']/g;
  const htmlActions = new Set();
  let match;
  while ((match = actionRegex.exec(indexHtml)) !== null) {
    htmlActions.add(match[1]);
  }

  const allJsFiles = [
    'script.js', 'credits.js', 'content.js', 'crm.js', 'outreach.js',
    'ocr.js', 'social.js', 'analytics.js', 'team.js', 'workflows.js',
    'data-mgmt.js', 'support.js', 'premium.js'
  ];

  const jsContentCombined = allJsFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');

  for (const action of htmlActions) {
    assert.ok(
      jsContentCombined.includes(action),
      `Action "${action}" from index.html must be referenced in client JS`
    );
  }
});

test('Codebase Integrity: All client API endpoints are handled in worker.js', () => {
  const workerContent = fs.readFileSync('worker.js', 'utf8');
  const endpointRegex = /fetch\(['"`](\/api\/[^'"`?${]+)/g;

  const clientFiles = [
    'script.js', 'credits.js', 'content.js', 'crm.js', 'outreach.js',
    'ocr.js', 'social.js', 'analytics.js', 'team.js', 'workflows.js',
    'data-mgmt.js', 'support.js', 'premium.js'
  ];

  const endpoints = new Set();
  let match;
  for (const f of clientFiles) {
    const content = fs.readFileSync(f, 'utf8');
    while ((match = endpointRegex.exec(content)) !== null) {
      endpoints.add(match[1].replace(/\/$/, ''));
    }
  }

  for (const ep of endpoints) {
    assert.ok(
      workerContent.includes(ep),
      `Client API endpoint "${ep}" must be routed in worker.js`
    );
  }
});
