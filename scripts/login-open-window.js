const { chromium } = require('playwright');

const email = process.env.KYROS_LOGIN_EMAIL || 'rekyx2@gmail.com';
const password = process.env.KYROS_LOGIN_PASSWORD || 'Kyros1234';

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());
  const page = pages.find((p) => /127\.0\.0\.1|localhost/.test(p.url())) || pages[0];
  if (!page) throw new Error('No Electron page found');

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const loginResult = await page.evaluate(async ({ email, password }) => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, keepSignedIn: true }),
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  }, { email, password });

  if (!loginResult.ok) {
    throw new Error(`Login failed ${loginResult.status}: ${loginResult.body}`);
  }

  await page.goto(new URL('/gallery', page.url()).toString());
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.bringToFront();
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
