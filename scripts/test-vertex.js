'use strict';
const ELECTRON_USER_DATA = 'C:\\Users\\asusg\\AppData\\Roaming\\ai-content-studio';
process.env.ELECTRON_USER_DATA = ELECTRON_USER_DATA;
require('dotenv').config({ path: ELECTRON_USER_DATA + '\\.env' });

delete require.cache[require.resolve('../server/services/apiKeyManager')];
delete require.cache[require.resolve('../server/paths')];
delete require.cache[require.resolve('../server/userContext')];

const { GoogleAuth } = require('google-auth-library');
const apiKeyManager = require('../server/services/apiKeyManager');

async function main() {
  const creds = apiKeyManager.getVertexCredentials();
  if (!creds) { console.error('NO CREDS FOUND'); process.exit(1); }
  console.log('SA email:', creds.client_email);
  console.log('Project:', creds.project_id);

  // Get OAuth token
  const auth = new GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/generative-language', 'https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  const token = tokenResp.token || tokenResp;
  console.log('Token obtained:', token ? token.slice(0, 30) + '...' : 'NONE');

  // Make a minimal text generation request (cheap, fast)
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Say hello in one word.' }] }],
  };

  console.log('\nCalling API (no x-goog-user-project)...');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log('Status:', res.status);
  console.log('Response:', JSON.stringify(data, null, 2));

  if (!res.ok) {
    // Try WITH x-goog-user-project
    console.log('\nRetrying WITH x-goog-user-project:', creds.project_id);
    const res2 = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-goog-user-project': creds.project_id,
      },
      body: JSON.stringify(body),
    });
    const data2 = await res2.json();
    console.log('Status:', res2.status);
    console.log('Response:', JSON.stringify(data2, null, 2));
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
