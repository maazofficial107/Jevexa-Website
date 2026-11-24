import https from 'node:https';

const urls = [
  'https://jevexa.net/',
  'https://jevexa.net/tools/chatbot',
  'https://jevexa.net/tools/ocr',
  'https://jevexa.net/tools/social',
  'https://jevexa.net/tools/analytics',
  'https://jevexa.net/tools/admin',
  'https://jevexa.net/tools/workflows',
  'https://jevexa.net/tools/data',
  'https://jevexa.net/tools/outreach',
  'https://jevexa.net/credits.js',
  'https://jevexa.net/ocr.js',
  'https://jevexa.net/social.js',
  'https://jevexa.net/analytics.js',
  'https://jevexa.net/team.js',
  'https://jevexa.net/workflows.js',
  'https://jevexa.net/data-mgmt.js',
  'https://jevexa.net/outreach.js',
  'https://jevexa.net/api/health',
  'https://jevexa.net/config.js'
];

async function checkUrl(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'JevexaLiveVerification/1.0' } }, (res) => {
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
  console.log('=== Checking Live Status of jevexa.net ===');
  let allOk = true;
  for (const url of urls) {
    const res = await checkUrl(url);
    const pass = res.status === 200 || res.status === 304;
    if (!pass) allOk = false;
    console.log(`${pass ? '✅' : '❌'} ${res.status} [${res.contentType}] ${url}`);
  }
  console.log('==========================================');
  console.log(allOk ? 'ALL LIVE ENDPOINTS AND ASSETS VERIFIED (200 OK)!' : 'SOME CHECKS RETURNED NON-200');
  process.exit(allOk ? 0 : 1);
}

verifyLive();
