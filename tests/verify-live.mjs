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

async function checkUrl(url, maxRedirects = 3) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'JevexaLiveVerification/2.0' } }, (res) => {
      // Follow redirect if 301, 302, 307, 308
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(checkUrl(nextUrl, maxRedirects - 1));
      }

      let data = '';
      res.on('data', chunk => { if (data.length < 500) data += chunk; });
      res.on('end', () => {
        resolve({
          url,
          status: res.statusCode,
          contentType: res.headers['content-type'] || 'none',
          bytes: data.length
        });
      });
    }).on('error', (err) => {
      resolve({ url, status: 'ERROR', error: err.message });
    });
  });
}

async function verifyLive() {
  console.log('=== Checking Live Status of jevexa.net across All 10 Services & Assets ===');
  let allOk = true;
  for (const url of urls) {
    const res = await checkUrl(url);
    const pass = res.status === 200 || res.status === 304;
    if (!pass) allOk = false;
    console.log(`${pass ? '✅' : '❌'} ${res.status} [${res.contentType}] ${url}`);
  }
  console.log('==========================================================================');
  console.log(allOk ? 'ALL LIVE ENDPOINTS, WORKSPACES, AND ASSETS VERIFIED (200 OK)!' : 'SOME CHECKS RETURNED NON-200');
  process.exit(allOk ? 0 : 1);
}

verifyLive();
