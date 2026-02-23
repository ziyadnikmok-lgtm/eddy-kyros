// server/services/igAutoLogin.js
// Puppeteer-based Instagram auto-login to extract fresh sessionid cookie.
// Supports accounts with TOTP-based 2FA via stored secret.

const path = require('node:path');
const fs = require('node:fs');
const { AppError } = require('../middleware/errorHandler');
const apiKeyManager = require('./apiKeyManager');

const LOGIN_TIMEOUT_MS = 90_000;
const LOGIN_URL = 'https://www.instagram.com/accounts/login/';
const DEBUG_DIR = path.join(__dirname, '..', 'data', 'ig-debug');

/**
 * Generate a 6-digit TOTP code from a base32 secret.
 */
function generateTOTP(base32Secret) {
  const { TOTP } = require('otpauth');
  const totp = new TOTP({
    secret: base32Secret,
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  });
  return totp.generate();
}

/**
 * Find visible buttons whose text contains any of the given strings.
 * Replaces deprecated page.$x() XPath calls.
 */
async function findButtonsByText(page, texts) {
  const handles = await page.$$('button, [role="button"]');
  const matches = [];
  for (const h of handles) {
    const txt = await page.evaluate((el) => el.textContent.trim(), h);
    if (texts.some((t) => txt.toLowerCase().includes(t.toLowerCase()))) {
      matches.push(h);
    }
  }
  return matches;
}

/** Save a debug screenshot + HTML dump. */
async function debugSnapshot(page, label) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const ts = Date.now();
    await page.screenshot({ path: path.join(DEBUG_DIR, `${label}-${ts}.png`), fullPage: true });
    const html = await page.content();
    fs.writeFileSync(path.join(DEBUG_DIR, `${label}-${ts}.html`), html, 'utf8');
    console.log(`[ig-auto-login] debug snapshot saved: ${label}-${ts}`);
  } catch (e) {
    console.warn(`[ig-auto-login] failed to save debug snapshot: ${e.message}`);
  }
}

/**
 * Launch headless Chromium, log into Instagram with stored burner credentials,
 * handle 2FA if a TOTP secret is stored, extract the sessionid cookie,
 * and save it via apiKeyManager.
 *
 * @returns {{ success: true, maskedValue: string, updatedAt: string }}
 */
async function refreshInstagramSession() {
  const creds = apiKeyManager.getInstagramLogin();
  if (!creds) {
    throw new AppError(
      'No Instagram login credentials stored. Save burner credentials first.',
      400,
      'NO_IG_CREDENTIALS'
    );
  }

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    throw new AppError(
      'Puppeteer is not installed. Run: npm install puppeteer',
      500,
      'PUPPETEER_MISSING'
    );
  }

  let browser = null;
  try {
    console.log('[ig-auto-login] launching headless browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
      ],
      timeout: LOGIN_TIMEOUT_MS,
    });

    const page = await browser.newPage();

    // Anti-detection: remove webdriver flag
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Overwrite the plugins length
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      // Overwrite languages
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      // Chrome runtime
      globalThis.chrome = { runtime: {} };
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    // Set English language preference to get predictable button text
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Navigate to login page
    console.log('[ig-auto-login] navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // --- Dismiss cookie consent overlays (Instagram/Meta uses various selectors) ---
    console.log('[ig-auto-login] checking for cookie consent...');
    const cookieSelectors = [
      // Meta's cookie banner buttons
      'button[class*="aOOlW"]',
      'button._a9--._ap36._a9_0',
      // Text-based fallbacks
    ];
    for (const sel of cookieSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          console.log(`[ig-auto-login] clicked cookie button: ${sel}`);
          await sleep(1000);
          break;
        }
      } catch { /* try next */ }
    }
    // Text-based cookie consent: "Allow" / "Accept" / "Cookie"
    try {
      const textBtns = await findButtonsByText(page, ['Allow', 'Accept', 'Cookie', 'Decline', 'Only allow']);
      if (textBtns.length) {
        // Prefer "Allow all" / "Accept all" — pick the one with "all" or the first one
        let target = textBtns[0];
        for (const btn of textBtns) {
          const txt = await page.evaluate((el) => el.textContent, btn);
          if (/allow.*all|accept.*all/i.test(txt)) { target = btn; break; }
        }
        const btnText = await page.evaluate((el) => el.textContent.trim(), target);
        await target.click();
        console.log(`[ig-auto-login] clicked cookie text button: "${btnText}"`);
        await sleep(1500);
      }
    } catch { /* no text buttons found */ }

    // Take a debug snapshot before looking for the form
    await debugSnapshot(page, 'pre-login');

    // Wait for login form — IG uses name="email" + name="pass" (not "username"/"password")
    console.log('[ig-auto-login] waiting for login form...');
    const USERNAME_SELECTORS = [
      'input[name="username"]',
      'input[name="email"]',
      'input[aria-label*="username" i]',
      'input[aria-label*="phone" i]',
      'input[aria-label*="email" i]',
    ];
    const PASSWORD_SELECTORS = [
      'input[name="password"]',
      'input[name="pass"]',
      'input[type="password"]',
    ];

    let usernameInput = null;
    for (const sel of USERNAME_SELECTORS) {
      try {
        await page.waitForSelector(sel, { visible: true, timeout: 8000 });
        usernameInput = await page.$(sel);
        if (usernameInput) {
          console.log(`[ig-auto-login] found username input: ${sel}`);
          break;
        }
      } catch { /* try next selector */ }
    }

    if (!usernameInput) {
      await debugSnapshot(page, 'form-not-found');
      const pageUrl = page.url();
      throw new AppError(
        `Could not find login form. Check debug screenshots in server/data/ig-debug/. Final URL: ${pageUrl}`,
        502,
        'IG_LOGIN_FORM_ERROR'
      );
    }

    let passwordInput = null;
    for (const sel of PASSWORD_SELECTORS) {
      passwordInput = await page.$(sel);
      if (passwordInput) {
        console.log(`[ig-auto-login] found password input: ${sel}`);
        break;
      }
    }
    if (!passwordInput) {
      await debugSnapshot(page, 'no-password-field');
      throw new AppError('Found username field but not password field', 502, 'IG_LOGIN_FORM_ERROR');
    }

    // Type credentials with human-like delays
    console.log('[ig-auto-login] typing credentials...');
    await usernameInput.click({ clickCount: 3 }); // select all
    await usernameInput.type(creds.username, { delay: 50 + Math.random() * 30 });
    await sleep(300);
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(creds.password, { delay: 50 + Math.random() * 30 });
    await sleep(500);

    // Click login button — IG sometimes uses <button type="submit">, sometimes <div role="button" aria-label="Log In">
    console.log('[ig-auto-login] submitting credentials...');
    const LOGIN_BTN_SELECTORS = [
      'button[type="submit"]',
      'button[aria-label="Log In"]',
      'button[aria-label="Log in"]',
      '[role="button"][aria-label="Log In"]',
      '[role="button"][aria-label="Log in"]',
    ];
    let loginButton = null;
    for (const sel of LOGIN_BTN_SELECTORS) {
      loginButton = await page.$(sel);
      if (loginButton) {
        console.log(`[ig-auto-login] found login button: ${sel}`);
        break;
      }
    }
    // Text fallback: any button or div[role=button] containing "Log in" / "Sign in"
    if (!loginButton) {
      const allClickables = await page.$$('button, [role="button"]');
      for (const el of allClickables) {
        const txt = await page.evaluate((e) => e.textContent.trim(), el);
        if (/^log\s*in$/i.test(txt) || /^sign\s*in$/i.test(txt) || /^anmelden$/i.test(txt)) {
          loginButton = el;
          console.log(`[ig-auto-login] found login button via text: "${txt}"`);
          break;
        }
      }
    }
    if (!loginButton) {
      await debugSnapshot(page, 'no-submit-btn');
      throw new AppError('Could not find login submit button', 502, 'IG_LOGIN_FORM_ERROR');
    }
    await loginButton.click();

    // Wait for navigation — could land on feed, challenge page, 2FA page, or error
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {
      // Navigation might not trigger for SPA — wait a bit
    });
    await sleep(3000);

    // Check for common error states
    let pageContent = await page.content();
    let pageUrl = page.url();
    console.log(`[ig-auto-login] post-login URL: ${pageUrl}`);

    if (pageContent.includes('incorrect') || pageContent.includes('wrong password') || pageContent.includes('didn\'t match')) {
      throw new AppError('Instagram login failed: incorrect username or password', 401, 'IG_BAD_CREDENTIALS');
    }

    // --- 2FA handling ---
    const is2faPage = pageContent.includes('two_factor') ||
      pageContent.includes('verificationCode') ||
      pageContent.includes('two-factor') ||
      pageContent.includes('Security Code') ||
      pageContent.includes('security code') ||
      pageUrl.includes('two_factor');

    if (is2faPage) {
      if (!creds.twoFaSecret) {
        await debugSnapshot(page, '2fa-no-secret');
        throw new AppError(
          'Instagram requires 2FA but no TOTP secret is stored. Add your 2FA secret to the burner credentials.',
          403,
          'IG_2FA_REQUIRED'
        );
      }

      console.log('[ig-auto-login] 2FA page detected, generating TOTP code...');
      await debugSnapshot(page, '2fa-page');
      const totpCode = generateTOTP(creds.twoFaSecret);
      console.log(`[ig-auto-login] TOTP code generated (${totpCode.length} digits)`);

      // Find the 2FA input field — IG uses name="verificationCode" or a generic input
      const codeInput = await page.$('input[name="verificationCode"]')
        || await page.$('input[name="security_code"]')
        || await page.$('input[type="number"]')
        || await page.$('input[aria-label*="code" i]')
        || await page.$('input[placeholder*="code" i]');

      if (!codeInput) {
        await debugSnapshot(page, '2fa-no-input');
        throw new AppError(
          'Found 2FA page but could not locate the code input field. Check debug screenshots.',
          502,
          'IG_2FA_INPUT_NOT_FOUND'
        );
      }

      await codeInput.click({ clickCount: 3 });
      await codeInput.type(totpCode, { delay: 40 + Math.random() * 20 });
      await sleep(500);

      // Submit 2FA — click the confirm/next button
      const confirmBtns = await findButtonsByText(page, ['Confirm', 'Next', 'Verify', 'Submit']);
      const confirmBtn = await page.$('button[type="button"]:not([aria-label])')
        || await page.$('button[type="submit"]');

      if (confirmBtns.length) {
        await confirmBtns[0].click();
      } else if (confirmBtn) {
        await confirmBtn.click();
      } else {
        // Try pressing Enter as fallback
        await codeInput.press('Enter');
      }

      // Wait for post-2FA navigation
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await sleep(3000);

      // Re-check page state after 2FA
      pageContent = await page.content();
      pageUrl = page.url();

      if (pageContent.includes('incorrect') || pageContent.includes('didn\'t match') || pageContent.includes('invalid')) {
        await debugSnapshot(page, '2fa-rejected');
        throw new AppError(
          'Instagram 2FA code was rejected. The TOTP secret may be incorrect or out of sync.',
          401,
          'IG_2FA_INVALID'
        );
      }
      console.log('[ig-auto-login] 2FA completed successfully');
    }

    // Check for challenge/checkpoint (after potential 2FA)
    if (pageUrl.includes('challenge') || pageUrl.includes('checkpoint')) {
      await debugSnapshot(page, 'challenge');
      throw new AppError(
        'Instagram requires a security challenge (captcha). Complete it manually in a browser first, then try again.',
        403,
        'IG_CHALLENGE_REQUIRED'
      );
    }

    // "Save Your Login Info?" dialog — click "Save info" to persist the session
    try {
      const saveInfoBtns = await findButtonsByText(page, ['Save Info', 'Save info', 'Save your login info', 'Save Your Login Info']);
      if (saveInfoBtns.length) {
        await saveInfoBtns[0].click();
        console.log('[ig-auto-login] clicked "Save Info" on login info dialog');
        await sleep(2000);
      } else {
        // Fallback: some variants don't show Save Info text — try Not Now
        const notNowBtns = await findButtonsByText(page, ['Not Now', 'not now', 'Not now']);
        if (notNowBtns.length) {
          await notNowBtns[0].click();
          console.log('[ig-auto-login] no Save Info found, dismissed with Not Now');
          await sleep(1500);
        }
      }
    } catch { /* no dialog */ }

    // "Turn on Notifications?" dialog — dismiss with Not Now
    try {
      const notNowBtns = await findButtonsByText(page, ['Not Now', 'not now', 'Not now']);
      if (notNowBtns.length) {
        await notNowBtns[0].click();
        console.log('[ig-auto-login] dismissed notifications dialog (Not Now)');
        await sleep(1500);
      }
    } catch { /* no dialog */ }

    // Warm up the session — IG issues a "cold" cookie that needs real browsing
    // activity before it's fully activated. Browse the feed + explore page.
    console.log('[ig-auto-login] warming up session (feed)...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    await sleep(3000);

    // Dismiss any remaining dialogs on the feed page
    try {
      const notNowBtns = await findButtonsByText(page, ['Not Now', 'not now', 'Not now']);
      if (notNowBtns.length) {
        await notNowBtns[0].click();
        await sleep(1000);
      }
    } catch { /* ignore */ }

    // Scroll down a bit and visit explore to mimic real usage
    await page.evaluate(() => globalThis.scrollBy(0, 400));
    await sleep(1500);
    console.log('[ig-auto-login] warming up session (explore)...');
    await page.goto('https://www.instagram.com/explore/', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await sleep(2000);

    // Now extract cookies — session should be fully active
    console.log('[ig-auto-login] extracting cookies...');
    const cookies = await page.cookies('https://www.instagram.com');
    const sessionCookie = cookies.find((c) => c.name === 'sessionid');
    pageUrl = page.url();

    if (!sessionCookie || !sessionCookie.value) {
      await debugSnapshot(page, 'no-session-cookie');
      console.warn(`[ig-auto-login] no sessionid cookie found. Final URL: ${pageUrl}`);
      throw new AppError(
        'Login appeared to succeed but no sessionid cookie was found. The account may need manual verification.',
        502,
        'IG_NO_SESSION_COOKIE'
      );
    }

    // Verify the session by hitting IG's web graphql endpoint (not the v1 mobile API
    // which rejects desktop User-Agents with "useragent mismatch").
    console.log('[ig-auto-login] verifying session validity...');
    let sessionValid = false;
    try {
      const verifyResp = await page.evaluate(async () => {
        // Use the web-compatible endpoint — works with desktop UA + web app ID
        const resp = await fetch('https://www.instagram.com/api/v1/web/accounts/current_user/', {
          credentials: 'include',
          headers: {
            'Accept': '*/*',
            'X-IG-App-ID': '936619743392459',
            'X-IG-WWW-Claim': '0',
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        return { status: resp.status, ok: resp.ok, text: await resp.text().catch(() => '') };
      });
      sessionValid = verifyResp.ok && (verifyResp.text.includes('"username"') || verifyResp.text.includes('user'));
      if (!sessionValid && verifyResp.status === 200) {
        // Some IG responses are OK but don't contain "username" text — check for user object
        sessionValid = verifyResp.text.includes('"pk"') || verifyResp.text.includes('"full_name"');
      }
      console.log(`[ig-auto-login] session verify: HTTP ${verifyResp.status}, valid=${sessionValid}`);
      if (!sessionValid) {
        console.log(`[ig-auto-login] verify response preview: ${verifyResp.text.substring(0, 200)}`);
      }
    } catch (e) {
      console.warn(`[ig-auto-login] session verify failed: ${e.message}`);
      // If verification call itself fails but we have a cookie and navigated to feed,
      // treat the session as likely valid — Apify will validate it during actual scraping
      if (pageUrl.includes('instagram.com') && !pageUrl.includes('login') && !pageUrl.includes('challenge')) {
        sessionValid = true;
        console.log('[ig-auto-login] verification call failed but page state looks logged-in — treating as valid');
      }
    }

    // Save the fresh session
    console.log('[ig-auto-login] session cookie extracted, saving...');
    const result = apiKeyManager.setInstagramSessionId(sessionCookie.value);
    console.log(`[ig-auto-login] session saved successfully: ${result.maskedValue}`);
    await debugSnapshot(page, 'success');

    return {
      success: true,
      maskedValue: result.maskedValue,
      updatedAt: result.updatedAt,
      verified: sessionValid,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error(`[ig-auto-login] unexpected error: ${err.message}`);
    throw new AppError(
      `Instagram auto-login failed: ${err.message}`,
      502,
      'IG_AUTO_LOGIN_ERROR'
    );
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* best-effort */ }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { refreshInstagramSession };
