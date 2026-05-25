const { _electron: electron } = require('playwright');

const email = process.env.KYROS_LOGIN_EMAIL || 'rekyx2@gmail.com';
const password = process.env.KYROS_LOGIN_PASSWORD || 'Kyros1234';

(async () => {
  const app = await electron.launch({
    args: ['.'],
    cwd: require('node:path').join(__dirname, '..'),
    env: {
      ...process.env,
      KYROS_FORCE_LOCAL: '1',
      REMOTE_URL: '',
    },
  });

  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const loginResult = await window.evaluate(async ({ email, password }) => {
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

  const target = new URL('/gallery', window.url()).toString();
  await window.goto(target);
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(1000);
  await window.bringToFront();

  // Keep the app open after automation finishes.
  await new Promise(() => {});
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
