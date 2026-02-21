// server/middleware/rateLimiter.js
// Rate limiters for expensive endpoints. All windows are per-IP.

const rateLimit = require('express-rate-limit');

/** Image generation — 30 req / min */
const generateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many generation requests — try again shortly' } },
});

/** Batch / carousel / auto — 10 req / min */
const batchLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many batch requests — try again shortly' } },
});

/** Clone / reel copy — 10 req / min */
const cloneLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many clone requests — try again shortly' } },
});

module.exports = { generateLimiter, batchLimiter, cloneLimiter };
