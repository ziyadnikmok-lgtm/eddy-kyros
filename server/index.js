const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const dotenvPath = process.env.DOTENV_CONFIG_PATH || path.join(__dirname, '..', '.env');
require('dotenv').config({ path: dotenvPath });

if ((!process.env.ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET.length < 32)
  && process.env.SERVER_ENCRYPTION_KEY
  && process.env.SERVER_ENCRYPTION_KEY.length >= 32) {
  process.env.ENCRYPTION_SECRET = process.env.SERVER_ENCRYPTION_KEY;
}

if (!process.env.ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET.length < 32) {
  const secret = crypto.randomBytes(32).toString('hex');
  process.env.ENCRYPTION_SECRET = secret;
  try {
    if (fs.existsSync(dotenvPath)) {
      let envContent = fs.readFileSync(dotenvPath, 'utf8');
      if (/^ENCRYPTION_SECRET=\s*$/m.test(envContent)) {
        envContent = envContent.replace(/^ENCRYPTION_SECRET=\s*$/m, `ENCRYPTION_SECRET=${secret}`);
      } else if (!envContent.includes('ENCRYPTION_SECRET=')) {
        envContent += `\nENCRYPTION_SECRET=${secret}\n`;
      }
      fs.writeFileSync(dotenvPath, envContent);
    } else {
      fs.writeFileSync(dotenvPath, `ENCRYPTION_SECRET=${secret}\n`);
    }
  } catch {}
}

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  const secret = crypto.randomBytes(32).toString('hex');
  process.env.SESSION_SECRET = secret;
  try {
    if (fs.existsSync(dotenvPath)) {
      let envContent = fs.readFileSync(dotenvPath, 'utf8');
      if (/^SESSION_SECRET=\s*$/m.test(envContent)) {
        envContent = envContent.replace(/^SESSION_SECRET=\s*$/m, `SESSION_SECRET=${secret}`);
      } else if (!envContent.includes('SESSION_SECRET=')) {
        envContent += `\nSESSION_SECRET=${secret}\n`;
      }
      fs.writeFileSync(dotenvPath, envContent);
    } else {
      fs.appendFileSync(dotenvPath, `\nSESSION_SECRET=${secret}\n`);
    }
  } catch {}
}

process.on('unhandledRejection', (reason) => {
  console.error('[ERROR] Unhandled promise rejection:', reason?.stack || reason?.message || reason);
  // Log but don't crash — batch jobs and other async work shouldn't kill the server
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  // Uncaught exceptions are truly fatal — exit for Docker to restart
  process.exit(1);
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { errorHandler, AppError } = require('./middleware/errorHandler');
const compressionMiddleware = require('./middleware/compression');
const keysRouter = require('./routes/keys');
const generateRouter = require('./routes/generate');
const charactersRouter = require('./routes/characters');
const poseRemixRouter = require('./routes/poseRemix');
const eddyVisionRouter = require('./routes/eddyVision');
const batchRouter = require('./routes/batch');
const tweakRouter = require('./routes/tweak');
const reformatRouter = require('./routes/reformat');
const imagesRouter = require('./routes/images');
const galleryRouter = require('./routes/gallery');
const sceneRouter = require('./routes/scene');
const sceneMemoryRouter = require('./routes/sceneMemory');
const outfitsRouter = require('./routes/outfits');
const carouselRoute = require('./routes/carousel');
const reelRoute = require('./routes/reel');
const reelCopyRoute = require('./routes/reelCopy');
const postCloneRoute = require('./routes/postClone');
const profileCloneRoute = require('./routes/profileClone');
const pinterestRoute = require('./routes/pinterest');
// Search, for the browse tab. Separate file from the single-pin scraper above -- different
// upstream and a different failure mode, so a change at one end cannot break the other.
const pinterestFeedRoute = require('./routes/pinterestFeed');
const instagramFramesRoute = require('./routes/instagramFrames');
const instagramReelRoute = require('./routes/instagramReel');
const availabilityRoute = require('./routes/availability');
const templatesRouter = require('./routes/templates');
const styleLibraryRouter = require('./routes/styleLibrary');
const captionTemplatesRouter = require('./routes/captionTemplates');
const videoRouter = require('./routes/video');
const backgroundsRouter = require('./routes/backgrounds');
const videoEditRouter = require('./routes/videoEdit');
const photoMatchRouter = require('./routes/photoMatch');
const nanoBypassRouter = require('./routes/nanoBypass');
const outfitSwapRouter = require('./routes/outfitSwap');
const seedreamEditRouter = require('./routes/seedreamEdit');
const jobsRouter = require('./routes/jobs');
const seedanceOmniRouter = require('./routes/seedanceOmni');
const authRouter = require('./routes/authRoutes');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const { router: userKeysRouter } = require('./routes/userKeys');
const billingRouter = require('./routes/billing');
const adminRouter = require('./routes/admin');
const referralRouter = require('./routes/referral');
const libraryRouter = require('./routes/library');
const notificationsRouter = require('./routes/notifications');
const { requireAuth } = require('./middleware/requireAuth');
const imageStore = require('./services/imageStore');
const batchGenerator = require('./services/batchGenerator');
const { handleJobDone } = require('./services/jobMailer');
batchGenerator.on('done', handleJobDone);
const log = require('./utils/logger');
const cfg = require('./config');
const { authLimiter, readLimiter, generateLimiter, batchLimiter, cloneLimiter } = require('./middleware/rateLimiter');

// ── Startup security checks ─────────────────────────────────────────────
// If the known-publicly-leaked secret is still in use, warn loudly.
// Compared as a hash: the literal is a real (already-public) secret, and carrying it in
// source trips every credential scanner — including this repo's own push guard, which then
// gets bypassed out of habit. The check is identical, the file is clean.
const KNOWN_LEAKED_FINGERPRINT = 'e2a790bc91ce9d75ac37a72c79d52b376316b9c367b1c1d454a89f033540e93e';
if (process.env.ENCRYPTION_SECRET &&
    require('crypto').createHash('sha256').update(process.env.ENCRYPTION_SECRET).digest('hex') === KNOWN_LEAKED_FINGERPRINT) {
  console.error('┌─────────────────────────────────────────────────────────────────┐');
  console.error('│  ⚠️  SECURITY WARNING: ENCRYPTION_SECRET is a known leaked value. │');
  console.error('│  Rotate it immediately: generate a new 64-char hex secret and    │');
  console.error('│  replace ENCRYPTION_SECRET in your .env, then delete keys.enc.   │');
  console.error('└─────────────────────────────────────────────────────────────────┘');
}

const app = express();

app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Vite/React needs these
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'blob:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      fontSrc: ["'self'", 'data:', 'https:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const PORT = cfg.PORT;
const HOST = cfg.HOST;

// ── CORS ─────────────────────────────────────────────────────────────────
// Allowlist is explicit — no wildcard tenant subdomains.
// Add your production domain to APP_URL in .env.
const _allowedCorsOrigins = new Set();
(function buildCorsAllowlist() {
  // Always allow localhost dev origins
  _allowedCorsOrigins.add('http://localhost:3001');
  _allowedCorsOrigins.add('http://localhost:5173');
  _allowedCorsOrigins.add('http://127.0.0.1:3001');
  _allowedCorsOrigins.add('http://127.0.0.1:5173');
  // Explicit production domain (if set)
  if (process.env.APP_URL) {
    try { _allowedCorsOrigins.add(new URL(process.env.APP_URL).origin); } catch {}
  }
  // Extra comma-separated origins via env (e.g. EXTRA_CORS_ORIGINS=https://a.com,https://b.com)
  if (process.env.EXTRA_CORS_ORIGINS) {
    for (const o of process.env.EXTRA_CORS_ORIGINS.split(',')) {
      const trimmed = o.trim();
      if (trimmed) _allowedCorsOrigins.add(trimmed);
    }
  }
})();

app.use(
  cors({
    origin: (origin, callback) => {
      // No origin = same-origin / Electron / curl — allow
      if (!origin) return callback(null, true);
      if (_allowedCorsOrigins.has(origin)) return callback(null, true);
      // Allow any localhost port during local dev
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
      return callback(new AppError('Not allowed by CORS', 403, 'CORS_ERROR'));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: cfg.JSON_BODY_LIMIT }));
app.use(cookieParser());

// Session middleware (SaaS)
try {
  app.use(session({
    store: new SqliteStore({ client: require('./db') }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: !!process.env.APP_URL?.startsWith('https') && HOST !== 'localhost' && HOST !== '127.0.0.1',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }));
  console.log('[session] middleware initialized OK');
} catch (e) {
  console.error('[session] FAILED TO INIT:', e.message, e.stack);
  process.exit(1);
}
app.use(compressionMiddleware(cfg.COMPRESSION_MIN_BYTES));
// Apply authLimiter only to mutation endpoints (login, register, forgot-password, reset-password)
// Read-only status/me checks are excluded — they're called on every page load and don't need brute-force protection
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
// ── Desktop: sign in without a login screen ───────────────────────────────────
// db.js already seeds a default account (kyros@studio.app) on first boot, so the users table
// is never empty. An earlier version of this waited for an empty table and therefore never
// ran — a packaged build still showed the login screen.
//
// On the desktop build there is one person at the machine, so pick the account that install
// belongs to: the owner, else an admin, else the oldest row. Nothing is bypassed — requireAuth
// still runs and data is still scoped by user id.
//
// Only ever on a local install. A hosted deployment binds a public interface and sets APP_URL;
// neither is true of the desktop app or of someone running `npm start` on their own machine.
//
// Gating on ELECTRON_USER_DATA alone was too narrow: it is set by Electron only, so anyone
// running from source got a login screen for an account they had no password to.
function isLocalInstall() {
  if (process.env.ELECTRON_USER_DATA) return true;              // packaged desktop app
  const host = process.env.HOST || '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const published = /^https/i.test(process.env.APP_URL || '') || /^https/i.test(process.env.REMOTE_URL || '');
  return loopback && !published;                                 // running it yourself
}

function pickLocalAccount() {
  if (!isLocalInstall()) return null;
  try {
    const db = require('./db');
    const user = db.prepare(`SELECT id, email, is_admin, is_owner FROM users
      ORDER BY is_owner DESC, is_admin DESC, rowid ASC LIMIT 1`).get();
    if (user) log.info('desktop_local_account', { email: user.email });
    else log.warn('desktop_local_account_none');
    return user || null;
  } catch (err) {
    log.warn('desktop_local_account_failed', { message: err.message });
    return null;
  }
}

let _autoLoginUser;      // undefined = not looked up, null = no such account
app.use((req, res, next) => {
  const targetEmail = process.env.KYROS_AUTO_LOGIN_EMAIL;
  if (req.session?.userId || !req.session) return next();
  // Only page loads and API calls need a session; skip static assets.
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/.test(req.path)) return next();
  try {
    if (_autoLoginUser === undefined) {
      if (targetEmail) {
        const db = require('./db');
        _autoLoginUser = db.prepare(
          'SELECT id, email, is_admin, is_owner FROM users WHERE LOWER(email) = LOWER(?)'
        ).get(targetEmail.trim()) || null;
        log[_autoLoginUser ? 'info' : 'warn'](
          _autoLoginUser ? 'auto_login_enabled' : 'auto_login_no_such_user',
          { email: targetEmail.trim() },
        );
      } else {
        _autoLoginUser = null;
      }
      // Nothing configured, or configured for an account this machine does not have:
      // on a fresh desktop install, make the local one.
      if (!_autoLoginUser) _autoLoginUser = pickLocalAccount();
    }
    const user = _autoLoginUser;
    if (!user) return next();
    req.session.regenerate((err) => {
      if (err) return next();
      req.session.userId  = user.id;
      req.session.isAdmin = !!user.is_admin;
      req.session.isOwner = !!user.is_owner;
      req.session.save(() => next());
    });
  } catch (_) { next(); }
});

/**
 * Every API mount goes through here so the boot banner cannot lie.
 *
 * It used to print a hand-typed list of endpoints. By 2026-08-18 that list still advertised
 * /api/story, /api/auto, /api/niches, /api/brand-voice, /api/prompt-knowledge and
 * /api/profile-analyzer — every one of them deleted — and named an image model that does not
 * exist. A list nobody can forget to update is worth more than a prettier one.
 */
const MOUNTS = [];
function mount(prefix, ...handlers) {
  MOUNTS.push(prefix);
  app.use(prefix, ...handlers);
}

mount('/api/auth', authRouter);

// One-time admin bootstrap — no auth required, protected by BOOTSTRAP_SECRET env var
// Secret must be sent in POST body, not query param (query params appear in logs/history)
app.post('/api/bootstrap-admin', (req, res) => {
  const secret = process.env.BOOTSTRAP_SECRET;
  if (!secret || req.body?.secret !== secret) return res.status(403).json({ error: 'Forbidden' });
  const email = process.env.SEED_ADMIN_EMAIL;
  if (!email) return res.status(400).json({ error: 'SEED_ADMIN_EMAIL not set' });
  const db = require('./db');
  const result = db.prepare('UPDATE users SET is_admin=1, verified=1 WHERE email=?').run(email.toLowerCase());
  res.json({ ok: true, changes: result.changes, email });
});

// ── Desktop auto-login ────────────────────────────────────────────────────────
// Set KYROS_AUTO_LOGIN_EMAIL in the Electron userData .env to skip the login
// screen and run as that account.
//
// This does NOT remove auth, and must not. Every route below requireAuth is
// scoped by user id and this database is multi-tenant, so an unauthenticated
// session would either show someone else's content or strand yours under a
// different id. Signing in as one named account keeps that scoping intact.
//
// Never set KYROS_AUTO_LOGIN_EMAIL on a server other people can reach: it hands
// that account to anyone who opens the page.
//
// Re-establishes the session whenever there isn't one, rather than once per
// launch as before — a cookie that expires mid-session used to drop you back to
// the login screen with no way back except a restart.
// Auth always enforced (removed NODE_ENV gate)
app.use(requireAuth);
mount('/api/user/keys', userKeysRouter);
mount('/api/billing', billingRouter);
mount('/api/admin', adminRouter);
mount('/api/referral', referralRouter);
mount('/api/notifications', notificationsRouter);

app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  req.id = crypto.randomUUID();
  const start = Date.now();
  const requestPath = req.originalUrl || req.url || req.path;
  log.info('req_start', { userId: req.session?.userId || null, rid: req.id, method: req.method, path: requestPath });
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    log.info('req_end', {
      userId: req.session?.userId || null,
      rid: req.id,
      method: req.method,
      path: requestPath,
      status: res.statusCode,
      durationMs,
      slow: durationMs > cfg.SLOW_REQUEST_THRESHOLD_MS,
    });
  });
  next();
});

app.get('/api/logs', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
  const logBuffer = require('./utils/logBuffer');
  const n = Math.min(parseInt(req.query.n || '200', 10), 500);
  res.json({
    success: true,
    lines: logBuffer.getLines(n, {
      userId: req.session.userId,
      excludePaths: ['/api/logs', '/api/logs?n=200'],
    }),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: require('../package.json').version,
      uptime: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      imageStore: imageStore.stats(),
      batchJobs: batchGenerator.jobStats(),
    },
  });
});

app.post('/api/app-usage', (req, res) => {
  try {
    const { logUsageEvent } = require('./services/eventLogger');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const licenseId = String(body.licenseId || '').slice(0, 80);
    const event = String(body.event || 'app_event').slice(0, 80);
    logUsageEvent({
      userId: null,
      eventType: `desktop.${event}`,
      entityType: 'desktop_license',
      entityId: licenseId || null,
      source: 'desktop-app',
      payload: {
        licenseId,
        customerEmail: String(body.customerEmail || '').trim().toLowerCase().slice(0, 254),
        plan: String(body.plan || '').slice(0, 40),
        appVersion: String(body.appVersion || '').slice(0, 40),
        platform: String(body.platform || '').slice(0, 40),
        packaged: !!body.packaged,
        daysLeft: Number(body.daysLeft) || null,
        machineFingerprint: String(body.machineFingerprint || '').slice(0, 80),
      },
    });
  } catch {}
  res.json({ ok: true });
});

app.post('/api/app-license/activate', (req, res) => {
  try {
    const { activateDesktopLicense } = require('./services/desktopLicenseRegistry');
    const result = activateDesktopLicense({
      keyStr: req.body?.key,
      customerEmail: req.body?.customerEmail,
      machineFingerprint: req.body?.machineFingerprint,
    });
    return res.status(result.valid ? 200 : 403).json(result);
  } catch (err) {
    log.error('desktop_license_activate_error', { error: err.message });
    return res.status(500).json({ valid: false, reason: 'Activation server error. Try again.' });
  }
});

mount('/api/keys', readLimiter, keysRouter);
mount('/api/characters', readLimiter, charactersRouter);
mount('/api/pose-remix', poseRemixRouter);
mount('/api/eddy', eddyVisionRouter);
mount('/api/batch', batchLimiter, batchRouter);
mount('/api/tweak', generateLimiter, tweakRouter);
mount('/api/reformat', generateLimiter, reformatRouter);
mount('/api/images', imagesRouter);
mount('/api/gallery', galleryRouter);
// The durable generation queue. Not behind generateLimiter: enqueuing is a disk write, and
// rate-limiting the QUEUE would throttle exactly the mechanism that exists to absorb bursts.
mount('/api/jobs', jobsRouter);
mount('/api/library', libraryRouter);
mount('/api/scene', generateLimiter, sceneRouter);
mount('/api/scene-memory', sceneMemoryRouter);
mount('/api/outfits', outfitsRouter);
mount('/api/generate', generateLimiter, generateRouter);
mount('/api/carousel', batchLimiter, carouselRoute);
mount('/api/reel', generateLimiter, reelRoute);
mount('/api/reel-copy', cloneLimiter, reelCopyRoute);
mount('/api/post-clone', cloneLimiter, postCloneRoute);
mount('/api/profile-clone', cloneLimiter, profileCloneRoute);
/**
 * THE IMAGE PROXY IS NOT A GENERATION.
 *
 * This whole router sat behind generateLimiter (60/min) -- including `GET /proxy`, which streams
 * one Pinterest thumbnail. The browse grid renders a proxied <img> per tile, so a page of pins
 * spends the entire generation budget on pictures: measured 2026-08-10, one minute served 71 x 200
 * then 114 x 429. The user then ticked 20 pins, and their downloads hit the exhausted bucket and
 * were skipped as "could not be downloaded" -- 20 sent, 11 arrived. Pinterest was never the
 * problem; we rate-limited ourselves.
 *
 * GET /proxy takes the read budget (300/min) like every other read. The POST scrape endpoints,
 * which drive a third-party downloader, keep the generation limiter.
 */
app.use('/api/pinterest', (req, res, next) => (
  req.method === 'GET' && req.path === '/proxy'
    ? readLimiter(req, res, next)
    : generateLimiter(req, res, next)
), pinterestRoute);
// NOT behind generateLimiter: that budget exists for paid generations, and browsing a grid
// must not eat it. Pinterest's own rate limit is the real ceiling and is surfaced as 429.
mount('/api/pinterest-feed', pinterestFeedRoute);
mount('/api/instagram-frames', readLimiter, instagramFramesRoute);
mount('/api/instagram-reel', instagramReelRoute);
mount('/api/availability', availabilityRoute);
mount('/api/templates', templatesRouter);
mount('/api/style-library', styleLibraryRouter);
mount('/api/caption-templates', captionTemplatesRouter);
mount('/api/video', generateLimiter, videoRouter);
mount('/api/backgrounds', backgroundsRouter);
mount('/api/video-edit', generateLimiter, videoEditRouter);
mount('/api/photo-match', generateLimiter, photoMatchRouter);
mount('/api/nano-bypass', generateLimiter, nanoBypassRouter);
mount('/api/outfit-swap', generateLimiter, outfitSwapRouter);
mount('/api/seedream', generateLimiter, seedreamEditRouter);
mount('/api/seedance-omni', generateLimiter, seedanceOmniRouter);

const { CLIENT_DIST } = require('./paths');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, {
    maxAge: '7d',
    etag: true,
    // Don't serve index.html via static — let catch-all handle it with no-cache headers
    index: false,
    setHeaders(res, filePath) {
      // HTML files should not be cached aggressively
      if (filePath.endsWith('.html')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.set('Pragma', 'no-cache');
      }
    },
  }));
  app.get('*splat', (_req, res) => {
    // Prevent browser AND CDN edge caching of index.html
    // Surrogate-Control is the Fastly/Railway CDN override
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Surrogate-Control', 'no-store');
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

app.use((req, _res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.path}`, 404, 'NOT_FOUND'));
});

app.use(errorHandler);

(function validateConfig() {
  const warnings = [];
  if (!process.env.GEMINI_API_KEY && !process.env.API_KEY) {
    warnings.push('No GEMINI_API_KEY or API_KEY in env — add keys via /api/keys before generating');
  }
  if (!process.env.APIFY_TOKEN) {
    warnings.push('No APIFY_TOKEN in env — Instagram scraping features will require key via UI');
  }
  for (const w of warnings) {
    log.warn('config_warning', { message: w });
  }
})();

function cleanStaleTempFiles() {
  const { TEMP_DIR } = require('./paths');
  const tempDirs = [
    TEMP_DIR,
    path.join(os.tmpdir(), 'ai-content-studio-reels'),
  ];
  let cleaned = 0;
  for (const dir of tempDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        try {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) continue;
          if (Date.now() - stat.mtimeMs > cfg.STALE_TEMP_FILE_AGE_MS) {
            fs.unlinkSync(fullPath);
            cleaned++;
          }
        } catch (err) {
          log.warn('temp_cleanup_file_error', { file, error: err.message });
        }
      }
    } catch (err) {
      log.warn('temp_cleanup_dir_error', { dir, error: err.message });
    }
  }
  if (cleaned > 0) {
    log.info('temp_cleanup', { cleaned });
  }
}
cleanStaleTempFiles();
// Periodic cleanup every 30 minutes
const _tempCleanupTimer = setInterval(cleanStaleTempFiles, 30 * 60 * 1000);
if (_tempCleanupTimer.unref) _tempCleanupTimer.unref();

// M1: the Instagram-reel ingest writes up to ~200MB per run into getTempDir()/instagram-reel/<runId>/
// and never deletes it; cleanStaleTempFiles() above only unlinks FILES (it `continue`s on
// directories), so these run subdirs leak unboundedly. Sweep whole stale run DIRS on startup,
// mirroring instagramFrames.js's cleanupDir (fs.rmSync recursive+force). mtime-based, 24h TTL —
// a run still in progress (fresh mtime) survives. Best-effort: each rmSync is wrapped so one bad
// dir can't abort the sweep, and the whole sweep is wrapped so it can never crash startup.
function cleanStaleReelRunDirs() {
  const REEL_RUN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — do not delete recent (possibly running) runs
  try {
    const { getTempDir } = require('./paths');
    const reelRoot = path.join(getTempDir(), 'instagram-reel');
    if (!fs.existsSync(reelRoot)) return;
    let cleaned = 0;
    for (const entry of fs.readdirSync(reelRoot)) {
      const runDir = path.join(reelRoot, entry);
      try {
        const stat = fs.statSync(runDir);
        if (!stat.isDirectory()) continue;
        if (Date.now() - stat.mtimeMs > REEL_RUN_TTL_MS) {
          fs.rmSync(runDir, { recursive: true, force: true });
          cleaned++;
        }
      } catch (err) {
        // One unreadable/locked run must not abort the rest of the sweep.
        log.warn('reel_run_cleanup_dir_error', { runDir, error: err.message });
      }
    }
    if (cleaned > 0) log.info('reel_run_cleanup', { cleaned });
  } catch (err) {
    // Never let cleanup crash startup.
    log.warn('reel_run_cleanup_error', { error: err.message });
  }
}
cleanStaleReelRunDirs();

// One-time faststart migration: Seedance/Muapi videos were saved with the MP4 `moov` atom at the
// END of the file (not faststart), so a browser <video preload="metadata"> shows BLACK until the
// whole file downloads. Re-mux every existing video to faststart (lossless `-c copy` container
// remux) so already-downloaded clips preview instantly. Runs in the BACKGROUND (setImmediate) so
// it never blocks server startup; each file is wrapped so one failure can't abort the sweep, and
// ensureFaststart leaves the original untouched on any error (never an empty/broken video).
function migrateVideosToFaststart() {
  setImmediate(async () => {
    try {
      const { getUploadsDir } = require('./paths');
      const { ensureFaststart } = require('./services/videoFaststart');
      const videosDir = path.join(getUploadsDir(), 'videos');
      if (!fs.existsSync(videosDir)) return;
      let fixed = 0;
      for (const entry of fs.readdirSync(videosDir)) {
        if (!entry.toLowerCase().endsWith('.mp4')) continue;
        const filePath = path.join(videosDir, entry);
        try {
          if (await ensureFaststart(filePath)) fixed++;
        } catch (err) {
          // One bad/locked video must not abort the rest of the migration.
          log.warn('faststart_migration_file_error', { file: entry, error: err.message });
        }
      }
      if (fixed > 0) log.info('faststart_migration', { fixed });
    } catch (err) {
      // Never let the migration crash startup.
      log.warn('faststart_migration_error', { error: err.message });
    }
  });
}
migrateVideosToFaststart();

// Chases in-flight Muapi renders to completion regardless of what the UI is doing, and
// recovers anything left 'processing' by a previous run. Video delivery must not depend on a
// page component staying mounted.
require('./services/videoReconciler').startVideoReconciler();
// Same job for images. A Seedream render used to be awaited inside one HTTP request, so closing
// the app mid-render lost a picture Muapi had already made and already charged for. This picks
// those up from the queue on boot and finishes them.
require('./services/generationReconciler').startGenerationReconciler();

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('==============================================');
  console.log('  Kyros Studio — server');
  console.log('==============================================');
  console.log(`  Running at http://${HOST}:${PORT}`);
  console.log(`  ${MOUNTS.length} API mounts:`);
  // Three to a row, sorted — long enough to be useful, short enough to read.
  const sorted = [...MOUNTS].sort();
  for (let i = 0; i < sorted.length; i += 3) {
    console.log('    ' + sorted.slice(i, i + 3).map((m) => m.padEnd(24)).join('').trimEnd());
  }
  console.log('==============================================');
  console.log('');
});

function gracefulShutdown(signal) {
  log.info('shutdown_start', { signal });

  server.close(() => {
    log.info('shutdown_complete', { signal });
    process.exit(0);
  });

  setTimeout(() => {
    log.error('shutdown_forced', { signal, reason: `Drain exceeded ${cfg.SHUTDOWN_TIMEOUT_MS}ms` });
    process.exit(1);
  }, cfg.SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
