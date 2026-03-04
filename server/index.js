const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const dotenvPath = process.env.DOTENV_CONFIG_PATH || path.join(__dirname, '..', '.env');
require('dotenv').config({ path: dotenvPath });

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

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason?.stack || reason?.message || reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  process.exit(1);
});

const express = require('express');
const cors = require('cors');
const { errorHandler, AppError } = require('./middleware/errorHandler');
const compressionMiddleware = require('./middleware/compression');
const keysRouter = require('./routes/keys');
const generateRouter = require('./routes/generate');
const charactersRouter = require('./routes/characters');
const batchRouter = require('./routes/batch');
const tweakRouter = require('./routes/tweak');
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
const promptKnowledgeRoute = require('./routes/promptKnowledge');
const availabilityRoute = require('./routes/availability');
const templatesRouter = require('./routes/templates');
const styleLibraryRouter = require('./routes/styleLibrary');
const profileAnalyzerRouter = require('./routes/profileAnalyzer');
const captionTemplatesRouter = require('./routes/captionTemplates');
const videoRouter = require('./routes/video');
const imageStore = require('./services/imageStore');
const batchGenerator = require('./services/batchGenerator');
const log = require('./utils/logger');
const cfg = require('./config');
const { generateLimiter, batchLimiter, cloneLimiter } = require('./middleware/rateLimiter');

const app = express();

app.set('trust proxy', 1);

const PORT = cfg.PORT;
const HOST = cfg.HOST;

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
        /^https?:\/\/(www\.)?creationpanel1337\.xyz$/.test(origin) ||
        /^https?:\/\/[a-z0-9-]+\.traefik\.me(:\d+)?$/.test(origin)
      ) {
        callback(null, true);
      } else {
        callback(new AppError('Not allowed by CORS', 403, 'CORS_ERROR'));
      }
    },
  })
);

app.use(express.json({ limit: cfg.JSON_BODY_LIMIT }));
app.use(compressionMiddleware(cfg.COMPRESSION_MIN_BYTES));

app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  req.id = crypto.randomUUID();
  const start = Date.now();
  const requestPath = req.originalUrl || req.url || req.path;
  log.info('req_start', { rid: req.id, method: req.method, path: requestPath });
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    log.info('req_end', {
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

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      uptime: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      imageStore: imageStore.stats(),
      batchJobs: batchGenerator.jobStats(),
    },
  });
});

app.use('/api/keys', generateLimiter, keysRouter);
app.use('/api/characters', generateLimiter, charactersRouter);
app.use('/api/batch', batchLimiter, batchRouter);
app.use('/api/tweak', generateLimiter, tweakRouter);
app.use('/api/images', imagesRouter);
app.use('/api/niches', nichesRouter);
app.use('/api/brand-voice', brandVoiceRouter);
app.use('/api/story', storyRouter);
app.use('/api/gallery', galleryRouter);
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
app.use('/api/prompt-knowledge', promptKnowledgeRoute);
app.use('/api/availability', availabilityRoute);
app.use('/api/templates', templatesRouter);
app.use('/api/style-library', styleLibraryRouter);
app.use('/api/profile-analyzer', profileAnalyzerRouter);
app.use('/api/caption-templates', captionTemplatesRouter);
app.use('/api/video', generateLimiter, videoRouter);

const { CLIENT_DIST } = require('./paths');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*splat', (_req, res) => {
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

(function cleanStaleTempFiles() {
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
          if (Date.now() - stat.mtimeMs > cfg.STALE_TEMP_FILE_AGE_MS) {
            fs.unlinkSync(fullPath);
            cleaned++;
          }
        } catch {}
      }
    } catch {}
  }
  if (cleaned > 0) {
    log.info('temp_cleanup', { cleaned });
  }
})();

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
