import https from 'node:https';

const urls = [
  // Root and Landing
  'https://jevexa.net/',
  // All 10 Service Workspaces
  'https://jevexa.net/tools/chatbot',
  'https://jevexa.net/tools/content',
  'https://jevexa.net/tools/ocr',
  'https://jevexa.net/tools/social',
  'https://jevexa.net/tools/analytics',
  'https://jevexa.net/tools/admin',
  'https://jevexa.net/tools/workflows',
  'https://jevexa.net/tools/data',
  'https://jevexa.net/tools/crm',
  'https://jevexa.net/tools/outreach',
  // Canonical Clean Subpages
  'https://jevexa.net/about',
  'https://jevexa.net/contact',
  'https://jevexa.net/privacy-policy',
  'https://jevexa.net/terms',
  'https://jevexa.net/admin',
  // CSS Assets
  'https://jevexa.net/styles.css',
  'https://jevexa.net/premium.css',
  // Client Controllers for all 10 Services
  'https://jevexa.net/script.js',
  'https://jevexa.net/credits.js',
  'https://jevexa.net/content.js',
  'https://jevexa.net/crm.js',
  'https://jevexa.net/outreach.js',
  'https://jevexa.net/ocr.js',
  'https://jevexa.net/social.js',
  'https://jevexa.net/analytics.js',
  'https://jevexa.net/team.js',
  'https://jevexa.net/workflows.js',
  'https://jevexa.net/data-mgmt.js',
  'https://jevexa.net/support.js',
  'https://jevexa.net/premium.js',
  // Dynamic Worker Endpoints
  'https://jevexa.net/config.js',
  'https://jevexa.net/api/health'
];

async function checkUrl(url, options = {}, maxRedirects = 3) {
  const method = options.method || 'GET';
  const customHeaders = options.headers || {};
  return new Promise((resolve) => {
    const req = https.request(url, {
      method,
      headers: {
        'User-Agent': 'JevexaLiveVerification/2.0',
        ...customHeaders
      }
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(checkUrl(nextUrl, options, maxRedirects - 1));
      }

      let data = '';
      res.on('data', chunk => { if (data.length < 5000) data += chunk; });
      res.on('end', () => {
        resolve({
          url,
          method,
          status: res.statusCode,
          contentType: res.headers['content-type'] || 'none',
          etag: res.headers['etag'] || null,
          data,
          bytes: data.length
        });
      });
    });
    req.on('error', (err) => {
      resolve({ url, method, status: 'ERROR', error: err.message, data: '' });
    });
    req.end();
  });
}

async function verifyLive() {
  console.log('=== Checking Live Status of jevexa.net across All 10 Services & Assets ===');
  let allOk = true;

  // 1. GET Requests across all endpoints and assets
  console.log('\n--- 1. GET Requests: Core Routes, 10 Workspaces & Client Scripts ---');
  let stylesEtag = null;
  for (const url of urls) {
    const res = await checkUrl(url);
    const pass = res.status === 200 || res.status === 304;
    if (!pass) allOk = false;
    if (url.endsWith('styles.css') && res.etag) {
      stylesEtag = res.etag;
    }
    console.log(`${pass ? '✅' : '❌'} ${res.status} [${res.contentType}] ${url}`);
  }

  // 2. HEAD Requests
  console.log('\n--- 2. HEAD Requests: Verification Probes ---');
  const headUrls = [
    'https://jevexa.net/',
    'https://jevexa.net/config.js',
    'https://jevexa.net/api/health',
    'https://jevexa.net/tools/chatbot',
    'https://jevexa.net/about',
    'https://jevexa.net/styles.css'
  ];
  for (const hUrl of headUrls) {
    const res = await checkUrl(hUrl, { method: 'HEAD' });
    const pass = res.status === 200 && res.bytes === 0;
    if (!pass) allOk = false;
    console.log(`${pass ? '✅' : '❌'} HEAD ${res.status} [${res.contentType}] ${hUrl} (Body: ${res.bytes}b)`);
  }

  // 3. CORS Preflight OPTIONS
  console.log('\n--- 3. CORS Preflight & Health Payload Integrity ---');
  const optRes = await checkUrl('https://jevexa.net/api/health', { method: 'OPTIONS' });
  const optPass = optRes.status === 204 || optRes.status === 200;
  if (!optPass) allOk = false;
  console.log(`${optPass ? '✅' : '❌'} OPTIONS ${optRes.status} https://jevexa.net/api/health`);

  // 4. Conditional Request 304
  if (stylesEtag) {
    const condRes = await checkUrl('https://jevexa.net/styles.css', {
      headers: { 'If-None-Match': stylesEtag }
    });
    const condPass = condRes.status === 304 || condRes.status === 200;
    if (!condPass) allOk = false;
    console.log(`${condPass ? '✅' : '❌'} CONDITIONAL ${condRes.status} https://jevexa.net/styles.css`);
  }

  // 5. Payload Validation
  const healthRes = await checkUrl('https://jevexa.net/api/health');
  let healthOk = false;
  try {
    const parsed = JSON.parse(healthRes.data);
    healthOk = parsed.ok === true && parsed.service === 'jevexa-worker';
  } catch (_) {}
  if (!healthOk) allOk = false;
  console.log(`${healthOk ? '✅' : '❌'} Health Payload Integrity: ${healthOk ? 'Valid' : 'Invalid'}`);

  const configRes = await checkUrl('https://jevexa.net/config.js');
  const configOk = configRes.data.includes('window.JEVEXA_SUPABASE_CONFIG');
  if (!configOk) allOk = false;
  console.log(`${configOk ? '✅' : '❌'} Config Script Content: ${configOk ? 'Valid' : 'Invalid'}`);

  console.log('\n==========================================================================');
  console.log(allOk ? 'ALL LIVE ENDPOINTS, WORKSPACES, HEAD & ASSETS VERIFIED (200 OK)!' : 'SOME CHECKS RETURNED NON-200');
  process.exit(allOk ? 0 : 1);
}

verifyLive();
