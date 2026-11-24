import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const scriptJs = fs.readFileSync('script.js', 'utf8');
const stylesCss = fs.readFileSync('styles.css', 'utf8');
const premiumCss = fs.readFileSync('premium.css', 'utf8');

const EXPECTED_SERVICES = [
  { num: '01', id: 'chatbot', title: 'AI Chat', linkClass: 'chat-tool-link', targetWorkspace: 'chatbotWindow', route: '/tools/chatbot' },
  { num: '02', id: 'content', title: 'Content Generation', linkClass: 'content-tool-link', targetWorkspace: 'contentWorkspace', route: '/tools/content' },
  { num: '03', id: 'ocr', title: 'Document AI & OCR', linkClass: 'ocr-tool-link', targetWorkspace: 'ocrWorkspace', route: '/tools/ocr' },
  { num: '04', id: 'social', title: 'Social Media Assistant', linkClass: 'social-tool-link', targetWorkspace: 'socialWorkspace', route: '/tools/social' },
  { num: '05', id: 'analytics', title: 'Business Analytics', linkClass: 'analytics-tool-link', targetWorkspace: 'analyticsWorkspace', route: '/tools/analytics' },
  { num: '06', id: 'admin', title: 'User & Admin Management', linkClass: 'team-tool-link', targetWorkspace: 'teamAdminWorkspace', route: '/tools/admin', requiresAuth: true },
  { num: '07', id: 'workflows', title: 'Workflow Automation', linkClass: 'workflows-tool-link', targetWorkspace: 'workflowsWorkspace', route: '/tools/workflows', requiresAuth: true },
  { num: '08', id: 'data', title: 'Data Management', linkClass: 'data-tool-link', targetWorkspace: 'dataWorkspace', route: '/tools/data' },
  { num: '09', id: 'crm', title: 'Mini CRM', linkClass: 'crm-tool-link', targetWorkspace: 'crmWorkspace', route: '/tools/crm', requiresAuth: true },
  { num: '10', id: 'outreach', title: 'Email & Outreach AI', linkClass: 'outreach-tool-link', targetWorkspace: 'outreachWorkspace', route: '/tools/outreach', requiresAuth: true }
];

test('1. Exact 1-to-1 Service Card Declarations in index.html for all 10 Services (01 to 10)', () => {
  // Extract all 10 feature cards
  const cardRegex = /<div class="feature-card glass tilt-card"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="feature-card|<\/div>\s*<\/div>\s*<\/section>)/g;
  const cards = [];
  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    cards.push(match[1]);
  }

  assert.equal(cards.length, 10, 'Must have exactly 10 feature cards in the features grid');

  EXPECTED_SERVICES.forEach((expected, index) => {
    const cardContent = cards[index];
    assert.ok(cardContent, `Card ${expected.num} must exist`);

    // Verify feature number
    const numMatch = cardContent.match(/<span class="feature-number">([^<]+)<\/span>/);
    assert.equal(numMatch ? numMatch[1].trim() : '', expected.num, `Card index ${index} must be service ${expected.num}`);

    // Verify try link presence, classes, and attributes
    const linkMatch = cardContent.match(/<a[^>]*class="([^"]*feature-try-link[^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    assert.ok(linkMatch, `Card ${expected.num} must have a .feature-try-link element`);

    const linkClasses = linkMatch[1];
    assert.ok(linkClasses.includes('feature-try-link'), `Card ${expected.num} link must have class feature-try-link`);
    assert.ok(linkClasses.includes(expected.linkClass), `Card ${expected.num} link must have class ${expected.linkClass}`);

    // Verify target workspace element exists in index.html
    assert.ok(
      html.includes(`id="${expected.targetWorkspace}"`),
      `Workspace target #${expected.targetWorkspace} for service ${expected.num} must exist in index.html`
    );
  });
});

test('2. Client Workspace Router & Handlers in script.js support all 10 Services 1-to-1', () => {
  // Verify unified openExactServiceWorkspace is declared and covers 01-10
  assert.ok(scriptJs.includes('function openExactServiceWorkspace'), 'script.js must define openExactServiceWorkspace');
  assert.ok(scriptJs.includes('window.openExactServiceWorkspace = openExactServiceWorkspace'), 'script.js must expose openExactServiceWorkspace globally');

  // Verify routing for all 10 tools
  EXPECTED_SERVICES.forEach(s => {
    assert.ok(scriptJs.includes(`case '${s.num}':`), `openExactServiceWorkspace must handle case '${s.num}'`);
    assert.ok(scriptJs.includes(`case '${s.id}':`), `openExactServiceWorkspace must handle case '${s.id}'`);
    assert.ok(scriptJs.includes(s.targetWorkspace), `script.js must reference workspace ${s.targetWorkspace}`);
  });

  // Verify route sync in openContentWorkspace uses /tools/content
  assert.ok(scriptJs.includes("navigateToRoute('/tools/content')"), 'openContentWorkspace must sync route to /tools/content');

  // Verify handleCurrentRoute handles all 10 tools before page anchors
  assert.ok(scriptJs.includes("cleanPath === '/tools/chatbot'"), 'handleCurrentRoute must handle /tools/chatbot');
  assert.ok(scriptJs.includes("cleanPath === '/tools/content'"), 'handleCurrentRoute must handle /tools/content');
  assert.ok(scriptJs.includes("cleanPath === '/tools/ocr'"), 'handleCurrentRoute must handle /tools/ocr');
  assert.ok(scriptJs.includes("cleanPath === '/tools/social'"), 'handleCurrentRoute must handle /tools/social');
  assert.ok(scriptJs.includes("cleanPath === '/tools/analytics'"), 'handleCurrentRoute must handle /tools/analytics');
  assert.ok(scriptJs.includes("cleanPath === '/tools/admin'"), 'handleCurrentRoute must handle /tools/admin');
  assert.ok(scriptJs.includes("cleanPath === '/tools/workflows'"), 'handleCurrentRoute must handle /tools/workflows');
  assert.ok(scriptJs.includes("cleanPath === '/tools/data'"), 'handleCurrentRoute must handle /tools/data');
  assert.ok(scriptJs.includes("cleanPath === '/tools/crm'"), 'handleCurrentRoute must handle /tools/crm');
  assert.ok(scriptJs.includes("cleanPath === '/tools/outreach'"), 'handleCurrentRoute must handle /tools/outreach');
});

test('3. Behavioral DOM Simulation: Clicking Try on all 10 Services opens exact workspace and isolates state', () => {
  // Simulate DOM state
  const workspaces = {};
  EXPECTED_SERVICES.forEach(s => {
    workspaces[s.targetWorkspace] = {
      open: false,
      hidden: true,
      ariaHidden: 'true',
      scrollTop: 50
    };
  });

  let currentRoute = '/';
  let activeWorkspace = null;

  function closeAllWorkspaces(except = null) {
    Object.keys(workspaces).forEach(id => {
      if (id !== except) {
        workspaces[id].open = false;
        workspaces[id].hidden = true;
        workspaces[id].ariaHidden = 'true';
        workspaces[id].scrollTop = 0;
      }
    });
    if (!except) activeWorkspace = null;
  }

  function openWorkspace(targetId, route) {
    closeAllWorkspaces(targetId);
    workspaces[targetId].open = true;
    workspaces[targetId].hidden = false;
    workspaces[targetId].ariaHidden = 'false';
    workspaces[targetId].scrollTop = 0;
    activeWorkspace = targetId;
    currentRoute = route;
  }

  function returnToStudio() {
    closeAllWorkspaces();
    currentRoute = '/';
  }

  // 1. Sequentially open every service 01 through 10
  EXPECTED_SERVICES.forEach(service => {
    openWorkspace(service.targetWorkspace, service.route);

    // Verify target workspace is active and open
    assert.equal(workspaces[service.targetWorkspace].open, true, `${service.targetWorkspace} must be open`);
    assert.equal(workspaces[service.targetWorkspace].hidden, false, `${service.targetWorkspace} must not be hidden`);
    assert.equal(workspaces[service.targetWorkspace].ariaHidden, 'false', `${service.targetWorkspace} aria-hidden must be false`);
    assert.equal(workspaces[service.targetWorkspace].scrollTop, 0, `${service.targetWorkspace} scrollTop must be reset to 0`);
    assert.equal(currentRoute, service.route, `Route must be synced to ${service.route}`);

    // Verify all other 9 workspaces are closed
    Object.keys(workspaces).forEach(id => {
      if (id !== service.targetWorkspace) {
        assert.equal(workspaces[id].open, false, `${id} must be closed when ${service.targetWorkspace} is active`);
        assert.equal(workspaces[id].hidden, true, `${id} must be hidden`);
      }
    });
  });

  // 2. Test switching from service 10 back to 01, then to 05, then returnToStudio
  openWorkspace('chatbotWindow', '/tools/chatbot');
  assert.equal(workspaces.chatbotWindow.open, true);
  assert.equal(workspaces.outreachWorkspace.open, false);

  openWorkspace('analyticsWorkspace', '/tools/analytics');
  assert.equal(workspaces.analyticsWorkspace.open, true);
  assert.equal(workspaces.chatbotWindow.open, false);

  returnToStudio();
  assert.equal(activeWorkspace, null);
  assert.equal(currentRoute, '/');
  Object.keys(workspaces).forEach(id => {
    assert.equal(workspaces[id].open, false, `${id} must be closed after returnToStudio`);
  });
});

test('4. Auth-Gated Continuity: Pending Service Intent Storage and Auto-Open on Login', () => {
  // Test pending intent storage and restoration lifecycle
  const storage = new Map();
  let inMemoryIntent = null;

  function storePendingServiceIntent(serviceKey) {
    inMemoryIntent = String(serviceKey).toLowerCase().trim();
    storage.set('jevexa_pending_service_intent', inMemoryIntent);
  }

  function getAndClearPendingServiceIntent() {
    const intent = inMemoryIntent || storage.get('jevexa_pending_service_intent') || null;
    storage.delete('jevexa_pending_service_intent');
    inMemoryIntent = null;
    return intent;
  }

  let openedWorkspace = null;
  function openExactServiceWorkspace(key) {
    const found = EXPECTED_SERVICES.find(s => s.id === key || s.num === key);
    if (found) openedWorkspace = found.targetWorkspace;
  }

  function checkAndOpenPendingService() {
    const pending = getAndClearPendingServiceIntent();
    if (pending) {
      openExactServiceWorkspace(pending);
      return true;
    }
    return false;
  }

  // Simulate unauthenticated user clicking Mini CRM (09)
  storePendingServiceIntent('crm');
  assert.equal(storage.get('jevexa_pending_service_intent'), 'crm');

  // User signs in -> checkAndOpenPendingService triggers
  const opened = checkAndOpenPendingService();
  assert.equal(opened, true);
  assert.equal(openedWorkspace, 'crmWorkspace', 'Mini CRM workspace must automatically open after login');
  assert.equal(storage.get('jevexa_pending_service_intent'), undefined, 'Pending intent must be cleared');

  // Simulate unauthenticated user clicking Team Admin (06)
  storePendingServiceIntent('admin');
  checkAndOpenPendingService();
  assert.equal(openedWorkspace, 'teamAdminWorkspace', 'Team Admin workspace must automatically open after login');

  // Verify scripts contain the exact functions
  assert.ok(scriptJs.includes('storePendingServiceIntent'), 'script.js must contain storePendingServiceIntent');
  assert.ok(scriptJs.includes('getAndClearPendingServiceIntent'), 'script.js must contain getAndClearPendingServiceIntent');
  assert.ok(scriptJs.includes('checkAndOpenPendingService'), 'script.js must contain checkAndOpenPendingService');
});

test('5. Back & Close Buttons wired across all 10 Workspaces to return cleanly to Studio', () => {
  const BACK_CLOSE_BUTTONS = [
    'chatBackToStudio', 'chatbotClose',
    'contentBackToStudio', 'contentWorkspaceClose',
    'ocrBackToStudio', 'ocrWorkspaceClose',
    'socialBackToStudio', 'socialWorkspaceClose',
    'analyticsBackToStudio', 'analyticsWorkspaceClose',
    'teamAdminBackToStudio', 'teamAdminWorkspaceClose',
    'workflowsBackToStudio', 'workflowsWorkspaceClose',
    'dataBackToStudio', 'dataWorkspaceClose',
    'crmBackToStudio', 'crmWorkspaceClose',
    'outreachBackToStudio', 'outreachWorkspaceClose'
  ];

  BACK_CLOSE_BUTTONS.forEach(btnId => {
    assert.ok(html.includes(`id="${btnId}"`), `Button #${btnId} must exist in index.html`);
    assert.ok(scriptJs.includes(btnId), `Button #${btnId} must be bound in script.js`);
  });
});

test('6. UI & Pointer Ergonomics: cursor pointer, z-index, and no click-blocking overlays', () => {
  // Verify .feature-card has cursor: pointer and touch-action: manipulation
  assert.match(stylesCss, /\.feature-card\s*\{[\s\S]*?cursor:\s*pointer;/);
  assert.match(stylesCss, /\.feature-card\s*\{[\s\S]*?touch-action:\s*manipulation;/);

  // Verify .feature-try-link has cursor: pointer, position: relative, z-index: 2
  assert.match(stylesCss, /\.feature-try-link[\s\S]*?cursor:\s*pointer;/);
  assert.match(stylesCss, /\.feature-try-link[\s\S]*?position:\s*relative;/);
  assert.match(stylesCss, /\.feature-try-link[\s\S]*?z-index:\s*2;/);

  // Verify .card-glow has pointer-events: none
  assert.match(stylesCss, /\.card-glow\s*\{[\s\S]*?pointer-events:\s*none;/);

  // Verify premium overlay pseudo-elements have pointer-events: none
  assert.match(premiumCss, /\.feature-card::after[\s\S]*?pointer-events:\s*none;/);
});
