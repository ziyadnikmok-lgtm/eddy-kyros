'use strict';
const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');

const SESSION_MAX_MS = 60 * 60 * 1000; // 1 hour
const SESSION_MAX_REPLIES = 15;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class XReplySession extends EventEmitter {
  constructor({ userId, cookies, accounts, imageFolder, geminiApiKey, tone, attachImageChance }) {
    super();
    this.userId = userId;
    this.cookies = cookies; // Array of {name, value, domain, ...}
    this.accounts = accounts; // Array of handles (with or without @)
    this.imageFolder = imageFolder || null;
    this.geminiApiKey = geminiApiKey;
    this.tone = tone || 'engaging and friendly';
    this.attachImageChance = typeof attachImageChance === 'number' ? attachImageChance : 0.5;

    this.status = 'idle';
    this.startedAt = null;
    this.stoppedAt = null;
    this.repliesCount = 0;
    this.log = [];
    this.browser = null;
    this._stopRequested = false;
  }

  _log(level, message) {
    const entry = { time: new Date().toISOString(), level, message };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    this.emit('log', entry);
    console.log(`[x-reply:${this.userId}] [${level}] ${message}`);
  }

  getState() {
    const elapsed = this.startedAt ? Date.now() - this.startedAt : 0;
    return {
      status: this.status,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      repliesCount: this.repliesCount,
      maxReplies: SESSION_MAX_REPLIES,
      elapsedMs: elapsed,
      maxMs: SESSION_MAX_MS,
      log: this.log.slice(-150),
    };
  }

  stop() {
    this._stopRequested = true;
    this._log('info', 'Stop requested by user');
  }

  async run() {
    this.status = 'running';
    this.startedAt = Date.now();
    this._log('info', `Session started — ${this.accounts.length} account(s), max ${SESSION_MAX_REPLIES} replies over 1 hour`);

    let puppeteer;
    try {
      puppeteer = require('puppeteer');
    } catch {
      this.status = 'error';
      this._log('error', 'Puppeteer not installed. Run: npm install puppeteer');
      return;
    }

    try {
      this._log('info', 'Launching headless browser...');
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1280,900',
        ],
      });

      const page = await this.browser.newPage();

      // Anti-detection
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        globalThis.chrome = { runtime: {} };
      });

      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      );
      await page.setViewport({ width: 1280, height: 900 });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

      // Inject cookies
      this._log('info', `Injecting ${this.cookies.length} cookie(s)...`);
      for (const cookie of this.cookies) {
        try {
          await page.setCookie({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain || '.x.com',
            path: cookie.path || '/',
            secure: cookie.secure !== false,
            httpOnly: !!cookie.httpOnly,
            sameSite: cookie.sameSite || 'None',
          });
        } catch (e) {
          this._log('warn', `Skipped cookie "${cookie.name}": ${e.message}`);
        }
      }

      // Verify login
      this._log('info', 'Verifying X/Twitter login...');
      await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(3000);

      const pageUrl = page.url();
      if (pageUrl.includes('/login') || pageUrl.includes('/i/flow') || pageUrl.includes('twitter.com/login')) {
        this.status = 'error';
        this._log('error', 'Cookies invalid or expired — redirected to login. Please update your X cookies and try again.');
        return;
      }
      this._log('info', 'Logged in successfully!');

      // Load images from folder
      let imageFiles = [];
      if (this.imageFolder) {
        try {
          const files = fs.readdirSync(this.imageFolder);
          imageFiles = files
            .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
            .map((f) => path.join(this.imageFolder, f));
          this._log('info', `Found ${imageFiles.length} image(s) in folder`);
        } catch (e) {
          this._log('warn', `Could not read image folder: ${e.message}`);
        }
      }

      // Main loop over accounts
      for (const rawAccount of this.accounts) {
        if (this._shouldStop()) break;

        const handle = rawAccount.replace(/^@/, '').trim();
        if (!handle) continue;

        this._log('info', `Visiting @${handle}...`);

        try {
          await page.goto(`https://x.com/${handle}`, { waitUntil: 'networkidle2', timeout: 30000 });
          await sleep(2000 + Math.random() * 1500);

          const tweetLinks = await this._getTweetLinks(page, handle);
          this._log('info', `Found ${tweetLinks.length} tweet(s) from @${handle}`);

          for (const tweetUrl of tweetLinks) {
            if (this._shouldStop()) break;

            try {
              await this._replyToTweet(page, tweetUrl, imageFiles);
              this.repliesCount++;
              this._log('info', `✓ Reply ${this.repliesCount}/${SESSION_MAX_REPLIES} posted`);

              if (this.repliesCount >= SESSION_MAX_REPLIES) {
                this._log('info', 'Reached max 15 replies. Session complete!');
                break;
              }

              // Human-like delay between replies
              const waitSec = 35 + Math.floor(Math.random() * 65);
              this._log('info', `Waiting ${waitSec}s before next reply...`);
              await this._sleepInterruptible(waitSec * 1000);
            } catch (e) {
              this._log('warn', `Could not reply to tweet: ${e.message}`);
              await sleep(6000);
            }
          }
        } catch (e) {
          this._log('warn', `Error with @${handle}: ${e.message}`);
          await sleep(4000);
        }
      }

      if (!this._stopRequested && this.repliesCount < SESSION_MAX_REPLIES) {
        this._log('info', `All accounts processed — ${this.repliesCount} total replies sent`);
      }

      this.status = this._stopRequested ? 'stopped' : 'done';
      this.stoppedAt = Date.now();
      this._log('info', `Session ended — ${this.repliesCount} replies sent`);
    } catch (err) {
      this.status = 'error';
      this.stoppedAt = Date.now();
      this._log('error', `Session failed: ${err.message}`);
    } finally {
      if (this.browser) {
        try { await this.browser.close(); } catch {}
        this.browser = null;
      }
    }
  }

  _shouldStop() {
    if (this._stopRequested) return true;
    if (this.startedAt && Date.now() - this.startedAt >= SESSION_MAX_MS) {
      this._log('info', '1-hour session limit reached');
      this.status = 'done';
      this.stoppedAt = Date.now();
      return true;
    }
    return false;
  }

  async _sleepInterruptible(ms) {
    const chunk = 1000;
    let elapsed = 0;
    while (elapsed < ms && !this._stopRequested) {
      await sleep(Math.min(chunk, ms - elapsed));
      elapsed += chunk;
    }
  }

  async _getTweetLinks(page, handle) {
    // Scroll a bit to load the timeline
    await page.evaluate(() => window.scrollBy(0, 600));
    await sleep(1500);

    const links = await page.evaluate((h) => {
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      const urls = [];
      for (const article of articles) {
        const timeEl = article.querySelector('time');
        if (timeEl) {
          const a = timeEl.closest('a');
          if (a && a.href && a.href.includes(`/${h}/status/`)) {
            urls.push(a.href);
          }
        }
      }
      return [...new Set(urls)].slice(0, 6);
    }, handle);

    return links;
  }

  async _replyToTweet(page, tweetUrl, imageFiles) {
    this._log('info', `Opening tweet...`);
    await page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2500 + Math.random() * 1000);

    // Extract tweet text from the first article on the page
    const tweetText = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      for (const article of articles) {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        if (textEl) return textEl.innerText || textEl.textContent || '';
      }
      return '';
    });

    if (!tweetText || tweetText.trim().length < 3) {
      throw new Error('Could not read tweet text (possibly media-only or private tweet)');
    }

    this._log('info', `Tweet: "${tweetText.substring(0, 100).replace(/\n/g, ' ')}..."`);

    // Generate AI reply
    const replyText = await this._generateReply(tweetText.trim());
    this._log('info', `AI reply: "${replyText}"`);

    // Click the reply button on the tweet
    const replyBtn = await page.$('[data-testid="reply"]');
    if (!replyBtn) throw new Error('Reply button not found on tweet');
    await replyBtn.click();
    await sleep(1500);

    // Wait for the reply compose box
    const replyBox = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
    if (!replyBox) throw new Error('Reply compose box did not open');
    await replyBox.click();
    await sleep(400);

    // Type the reply human-style
    await page.keyboard.type(replyText, { delay: 25 + Math.random() * 20 });
    await sleep(800);

    // Optionally attach an image
    if (imageFiles.length > 0 && Math.random() < this.attachImageChance) {
      try {
        const imgPath = imageFiles[Math.floor(Math.random() * imageFiles.length)];
        this._log('info', `Attaching image: ${path.basename(imgPath)}`);

        const fileInput = await page.$('[data-testid="fileInput"]');
        if (fileInput) {
          await fileInput.uploadFile(imgPath);
          await sleep(3500); // Wait for upload to complete
          this._log('info', 'Image attached');
        } else {
          this._log('warn', 'File input not found — skipping image attachment');
        }
      } catch (e) {
        this._log('warn', `Image attach failed: ${e.message}`);
      }
    }

    // Submit
    const submitBtn = await page.$('[data-testid="tweetButtonInline"]');
    if (!submitBtn) throw new Error('Submit button not found in reply composer');

    await submitBtn.click();
    await sleep(3000);

    // Sanity check — if redirected to login, session expired
    const finalUrl = page.url();
    if (finalUrl.includes('/login') || finalUrl.includes('/i/flow')) {
      throw new Error('Session expired after posting reply');
    }
  }

  async _generateReply(tweetText) {
    const { GoogleGenAI } = require('@google/genai');
    const genAI = new GoogleGenAI({ apiKey: this.geminiApiKey });

    const prompt = `You are a social media expert who writes genuine, human-sounding replies on X (Twitter).

Generate a short reply to this tweet. Tone: ${this.tone}.

Tweet:
"${tweetText}"

Rules:
- Under 220 characters
- Sound like a real person, NOT a bot
- Be relevant and specific to what they said
- No generic openers like "Great post!", "Love this!", "So true!"
- Max 1-2 emojis (or none if not fitting)
- No hashtags unless the tweet is clearly about a trending topic
- Be engaging — ask a question, share a quick thought, or add something interesting

Reply (just the text, no quotes):`;

    const response = await genAI.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const raw = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return raw.trim().replace(/^["']|["']$/g, '').trim();
  }
}

// Per-user session store
const sessions = new Map();

function startSession(userId, config) {
  // Stop any existing session
  const existing = sessions.get(userId);
  if (existing && existing.status === 'running') {
    existing.stop();
  }

  const session = new XReplySession({ userId, ...config });
  sessions.set(userId, session);

  // Fire and forget
  session.run().catch((err) => {
    console.error(`[x-reply] unhandled error for user ${userId}:`, err.message);
  });

  return session;
}

function getSession(userId) {
  return sessions.get(userId) || null;
}

module.exports = { startSession, getSession };
