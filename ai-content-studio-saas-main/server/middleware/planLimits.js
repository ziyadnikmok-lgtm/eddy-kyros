'use strict';
/**
 * Plan-based generation limits — only enforced when HOSTED=true in env.
 * Electron / local builds are unlimited regardless of plan.
 *
 * Limits are per rolling 24-hour window counted from generation_runs.
 * Free:      20 images / 24h
 * Pro:       200 images / 24h
 * Unlimited: no cap
 */
const db = require('../db');
const { AppError } = require('./errorHandler');

const PLAN_LIMITS = {
  free: 20,
  pro: 200,
  unlimited: Infinity,
};

function getCurrentPlan(userId) {
  const row = db.prepare(`
    SELECT s1.plan, s1.status
    FROM subscriptions s1
    INNER JOIN (
      SELECT user_id, MAX(datetime(created_at)) AS mc
      FROM subscriptions GROUP BY user_id
    ) x ON x.user_id = s1.user_id AND datetime(s1.created_at) = x.mc
    WHERE s1.user_id = ?
  `).get(userId);
  if (!row || row.status !== 'active') return 'free';
  return row.plan || 'free';
}

function getUsageLast24h(userId) {
  const row = db.prepare(`
    SELECT SUM(output_count) AS total
    FROM generation_runs
    WHERE user_id = ? AND status IN ('completed','partial')
      AND datetime(started_at) >= datetime('now', '-1 day')
  `).get(userId);
  return row?.total || 0;
}

/**
 * Express middleware — checks if the user is within their plan limit.
 * Pass `{ cost }` as options to specify how many images this request produces (default 1).
 */
function requirePlanCapacity(options = {}) {
  return (req, res, next) => {
    // Only enforce on hosted deployments
    if (!process.env.HOSTED) return next();

    const userId = req.session?.userId;
    if (!userId) return next(); // auth middleware handles unauth

    try {
      const plan = getCurrentPlan(userId);
      const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
      if (!isFinite(limit)) return next(); // unlimited plan

      const used = getUsageLast24h(userId);
      const cost = typeof options.cost === 'number' ? options.cost : (parseInt(req.body?.count) || 1);

      if (used + cost > limit) {
        throw new AppError(
          `Daily generation limit reached (${used}/${limit} images used). Upgrade your plan for more.`,
          429,
          'PLAN_LIMIT_EXCEEDED',
        );
      }

      // Attach to req for logging
      req._planInfo = { plan, used, limit };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requirePlanCapacity, getCurrentPlan, getUsageLast24h, PLAN_LIMITS };
