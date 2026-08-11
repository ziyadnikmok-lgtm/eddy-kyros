const rateLimit = require('express-rate-limit');

// Auth endpoints: stricter limit to prevent brute-force / credential stuffing
const authLimiter = rateLimit({
  windowMs: 15 * 60_000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many attempts — please try again in 15 minutes' } },
});

const readLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many requests — try again shortly' } },
});

const generateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many generation requests — try again shortly' } },
});

const batchLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many batch requests — try again shortly' } },
});

const cloneLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many clone requests — try again shortly' } },
});

// Key mutation limiter — only applies to state-changing methods (POST/PUT/DELETE)
// Prevents brute-force key injection or rapid key cycling attacks
const _keyMutateRateLimiter = rateLimit({
  windowMs: 15 * 60_000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many key changes — please wait 15 minutes' } },
});

function keyMutateLimiter(req, res, next) {
  const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (mutatingMethods.includes(req.method)) {
    return _keyMutateRateLimiter(req, res, next);
  }
  return next();
}

module.exports = { authLimiter, readLimiter, generateLimiter, batchLimiter, cloneLimiter, keyMutateLimiter };
