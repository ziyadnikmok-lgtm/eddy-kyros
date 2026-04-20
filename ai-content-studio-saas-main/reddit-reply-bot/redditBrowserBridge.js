'use strict';

const path = require('node:path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(base, variance) {
  return base + Math.floor(Math.random() * variance);
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}

function normalizeCookieDomain(domain) {
  const raw = String(domain || '').trim().toLowerCase();
  if (!raw) return '.reddit.com';
  const bare = raw.replace(/^\./, '');
  if (bare.endsWith('reddit.com')) return '.reddit.com';
  return '.reddit.com';
}

function normalizeSameSite(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'lax') return 'Lax';
  if (raw === 'strict') return 'Strict';
  if (raw === 'none' || raw === 'unspecified' || raw === 'no_restriction') return 'None';
  return undefined;
}

function toOldRedditUrl(url) {
  return String(url || '')
    .replace(/^https?:\/\/(www\.|new\.)?reddit\.com/i, 'https://old.reddit.com')
    .replace(/\/+$/, '');
}

async function launchBrowser(emit) {
  const { chromium } = require('playwright');
  const visibleBrowser = envFlag('REDDIT_REPLY_VISIBLE_BROWSER');
  const launchOptions = {
    headless: !visibleBrowser,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  };

  const customPath = normalizeWhitespace(process.env.REDDIT_REPLY_BROWSER_PATH || '');
  if (customPath) launchOptions.executablePath = customPath;

  if (emit) {
    emit('info', visibleBrowser ? 'Debug mode: browser window visible' : 'Background mode: browser hidden');
  }

  return chromium.launch(launchOptions);
}

async function injectCookies(context, cookies, emit) {
  const normalizedCookies = cookies.map((cookie) => {
    const entry = {
      name: cookie.name,
      value: String(cookie.value ?? ''),
      domain: normalizeCookieDomain(cookie.domain),
      path: cookie.path || '/',
      httpOnly: !!cookie.httpOnly,
      secure: cookie.secure !== false,
    };

    const sameSite = normalizeSameSite(cookie.sameSite);
    if (sameSite) entry.sameSite = sameSite;

    const expires = Number(cookie.expires ?? cookie.expirationDate);
    if (Number.isFinite(expires) && expires > 0) entry.expires = Math.floor(expires);

    return entry;
  }).filter((cookie) => cookie.name && cookie.value);

  if (normalizedCookies.length) {
    await context.addCookies(normalizedCookies);
  }

  if (emit) emit('info', `Cookie import: ${normalizedCookies.length} applied`);
}

async function verifyLogin(page, emit) {
  await page.goto('https://old.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(jitter(1800, 1400));

  const state = await page.evaluate(() => {
    const userLink = document.querySelector('#header-bottom-right .user a, span.user a');
    const loginInput = document.querySelector('form.login-form, input[name="user"], input[name="username"]');
    return {
      username: String(userLink?.textContent || '').replace(/^u\//i, '').replace(/^\/u\//i, '').trim(),
      needsLogin: !!loginInput || /\/login/i.test(window.location.pathname),
    };
  });

  if (state.needsLogin || !state.username) {
    throw new Error('Cookies invalid or expired for Reddit');
  }

  if (emit) emit('info', `Logged in successfully as u/${state.username}`);
  return state.username;
}

async function findCommentPermalink(page, ownUsername, replyText) {
  const snippet = normalizeWhitespace(replyText).toLowerCase().slice(0, 48);

  return page.evaluate(({ username, snippetText }) => {
    const comments = Array.from(document.querySelectorAll('.comment, .thing.comment'));
    for (const comment of comments) {
      const author = String(comment.querySelector('.author')?.textContent || '').trim().toLowerCase();
      const body = String(comment.querySelector('.md')?.innerText || comment.querySelector('.md')?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (!author || author !== username || !body.includes(snippetText.slice(0, 24))) continue;

      const permalink = comment.querySelector('a.bylink, .buttons a.bylink, a[data-event-action="permalink"]')?.href;
      if (permalink) return permalink;
    }
    return null;
  }, { username: String(ownUsername || '').trim().toLowerCase(), snippetText: snippet }).catch(() => null);
}

async function readVisibleError(page) {
  return page.evaluate(() => {
    const selectors = [
      '.status.error',
      '.error',
      '.infobar.error',
      '.usertext .status',
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = String(element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    return '';
  }).catch(() => '');
}

async function postReplyToPost(page, postUrl, replyText, ownUsername, emit) {
  const targetUrl = `${toOldRedditUrl(postUrl)}?sort=new`;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(jitter(1800, 1400));

  const blockedState = await page.evaluate(() => ({
    locked: /comments are locked/i.test(document.body?.innerText || ''),
    archived: /archived and no longer accepting/i.test(document.body?.innerText || ''),
    needsLogin: !!document.querySelector('form.login-form, input[name="user"], input[name="username"]'),
  })).catch(() => ({ locked: false, archived: false, needsLogin: false }));

  if (blockedState.needsLogin) throw new Error('Reddit session expired');
  if (blockedState.locked) throw new Error('Comments are locked');
  if (blockedState.archived) throw new Error('Post is archived');

  const textarea = page.locator('form.usertext textarea[name="text"], textarea[name="text"], .commentarea textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);

  if (!(await textarea.isVisible().catch(() => false))) {
    throw new Error('Top-level comment form not found');
  }

  await textarea.click();
  await textarea.fill('');
  for (const char of replyText) {
    await textarea.type(char, { delay: jitter(20, 35) });
  }

  await sleep(jitter(400, 300));

  const form = textarea.locator('xpath=ancestor::form[1]');
  const submit = form.locator('button[type="submit"], input[type="submit"], button.save').first();
  await submit.waitFor({ state: 'visible', timeout: 8000 }).catch(() => null);

  if (!(await submit.isVisible().catch(() => false))) {
    throw new Error('Submit button not found');
  }

  await submit.click();
  await sleep(jitter(2600, 1500));

  const errorText = await readVisibleError(page);
  if (errorText && /too much|try again|wait|ratelimit|error/i.test(errorText)) {
    throw new Error(errorText);
  }

  let replyUrl = await findCommentPermalink(page, ownUsername, replyText);
  if (!replyUrl) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(jitter(1800, 1200));
    replyUrl = await findCommentPermalink(page, ownUsername, replyText);
  }

  return replyUrl || targetUrl;
}

class RedditBrowserBridge {
  constructor(accountId, emit) {
    this.accountId = accountId;
    this.emit = emit;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.closed = false;
    this.ownUsername = null;
  }

  async start(cookies) {
    this.browser = await launchBrowser(this.emit);
    this.context = await this.browser.newContext({
      viewport: { width: 1400, height: 960 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      locale: 'en-US',
    });
    this.page = await this.context.newPage();

    await injectCookies(this.context, cookies, this.emit);
    this.ownUsername = await verifyLogin(this.page, this.emit);

    this.browser.on('disconnected', () => {
      this.closed = true;
    });
    this.page.on('close', () => {
      this.closed = true;
    });
  }

  async postReply(postUrl, replyText) {
    if (this.closed || !this.page) throw new Error('Browser session is closed');
    const replyUrl = await postReplyToPost(this.page, postUrl, replyText, this.ownUsername, this.emit);
    return { replyUrl };
  }

  close() {
    this.closed = true;
    try { this.context?.close(); } catch {}
    try { this.browser?.close(); } catch {}
  }
}

module.exports = { RedditBrowserBridge };
