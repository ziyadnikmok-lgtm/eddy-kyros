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
const batchRouter = require('./routes/batch');
const tweakRouter = require('./routes/tweak');
const reformatRouter = require('./routes/reformat');
const imagesRouter = require('./routes/images');
const nichesRouter = require('./routes/niches');
const brandVoiceRouter = require('./routes/brandVoice');
const storyRouter = require('./routes/story');
const galleryRouter = require('./routes/gallery');
const sceneRouter = require('./routes/scene');
const sceneMemoryRouter = require('./routes/sceneMemory');
const outfitsRouter = require('./routes/outfits');
const autoRoute = require('./routes/auto');
const carouselRoute = require('./routes/carousel');
const reelRoute = require('./routes/reel');
const reelCopyRoute = require('./routes/reelCopy');
const postCloneRoute = require('./routes/postClone');
const profileCloneRoute = require('./routes/profileClone');
const pinterestRoute = require('./routes/pinterest');
const promptKnowledgeRoute = require('./routes/promptKnowledge');
const availabilityRoute = require('./routes/availability');
const templatesRouter = require('./routes/templates');
const styleLibraryRouter = require('./routes/styleLibrary');
const profileAnalyzerRouter = require('./routes/profileAnalyzer');
const captionTemplatesRouter = require('./routes/captionTemplates');
const videoRouter = require('./routes/video');
const nsfwGenerateRouter = require('./routes/nsfwGenerate');
const loraPresetsRouter = require('./routes/loraPresets');
const loraDatasetsRouter = require('./routes/loraDatasets');
const backgroundsRouter = require('./routes/backgrounds');
const videoComposeRouter = require('./routes/videoCompose');
const photoMatchRouter = require('./routes/photoMatch');
const nanoBypassRouter = require('./routes/nanoBypass');
const authRouter = require('./routes/authRoutes');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const { router: userKeysRouter } = require('./routes/userKeys');
const billingRouter = require('./routes/billing');
const adminRouter = require('./routes/admin');
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
const KNOWN_LEAKED_ENCRYPTION_SECRET = 'b5386590d0f8a051299126e60f946622cb3bb7f68deba412f944af9a138489a4';
if (process.env.ENCRYPTION_SECRET === KNOWN_LEAKED_ENCRYPTION_SECRET) {
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
app.use('/api/auth', authLimiter, authRouter);

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

// Auth always enforced (removed NODE_ENV gate)
app.use(requireAuth);
app.use('/api/user/keys', userKeysRouter);
app.use('/api/billing', billingRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationsRouter);

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

app.use('/api/keys', readLimiter, keysRouter);
app.use('/api/characters', readLimiter, charactersRouter);
app.use('/api/batch', batchLimiter, batchRouter);
app.use('/api/tweak', generateLimiter, tweakRouter);
app.use('/api/reformat', generateLimiter, reformatRouter);
app.use('/api/images', imagesRouter);
app.use('/api/niches', nichesRouter);
app.use('/api/brand-voice', brandVoiceRouter);
app.use('/api/story', storyRouter);
app.use('/api/gallery', galleryRouter);
app.use('/api/library', libraryRouter);
app.use('/api/scene', generateLimiter, sceneRouter);
app.use('/api/scene-memory', sceneMemoryRouter);
app.use('/api/outfits', outfitsRouter);
app.use('/api/generate', generateLimiter, generateRouter);
app.use('/api/auto', batchLimiter, autoRoute);
app.use('/api/carousel', batchLimiter, carouselRoute);
app.use('/api/reel', generateLimiter, reelRoute);
app.use('/api/reel-copy', cloneLimiter, reelCopyRoute);
app.use('/api/post-clone', cloneLimiter, postCloneRoute);
app.use('/api/profile-clone', cloneLimiter, profileCloneRoute);
app.use('/api/pinterest', generateLimiter, pinterestRoute);
app.use('/api/prompt-knowledge', promptKnowledgeRoute);
app.use('/api/availability', availabilityRoute);
app.use('/api/templates', templatesRouter);
app.use('/api/style-library', styleLibraryRouter);
app.use('/api/profile-analyzer', profileAnalyzerRouter);
app.use('/api/caption-templates', captionTemplatesRouter);
app.use('/api/video', generateLimiter, videoRouter);
app.use('/api/nsfw-generate', generateLimiter, nsfwGenerateRouter);
app.use('/api/lora-presets', loraPresetsRouter);
app.use('/api/lora-datasets', generateLimiter, loraDatasetsRouter);
app.use('/api/backgrounds', backgroundsRouter);
app.use('/api/video-compose', generateLimiter, videoComposeRouter);
app.use('/api/photo-match', generateLimiter, photoMatchRouter);
app.use('/api/nano-bypass', generateLimiter, nanoBypassRouter);

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

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('==============================================');
  console.log('  AI Content Generation Studio — Phase 8');
  console.log('  Image Models: gemini-3-pro-image-preview, gemini-3.1-flash-image-preview');
  console.log('==============================================');
  console.log(`  Server running at http://${HOST}:${PORT}`);
  console.log('');
  console.log('  Endpoints:');
  console.log('    /api/health          /api/keys');
  console.log('    /api/characters      /api/generate');
  console.log('    /api/batch           /api/tweak');
  console.log('    /api/images          /api/gallery');
  console.log('    /api/scene           /api/niches');
  console.log('    /api/brand-voice     /api/story');
  console.log('    /api/auto            /api/carousel');
  console.log('    /api/reel            /api/reel-copy');
  console.log('    /api/post-clone      /api/profile-clone');
  console.log('    /api/prompt-knowledge');
  console.log('    /api/availability');
  console.log('    /api/style-library');
  console.log('    /api/profile-analyzer');
  console.log('    /api/caption-templates');
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
