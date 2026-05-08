'use strict';
/**
 * Plan-based generation limits — enforced on hosted web deployments.
 * Electron / local builds stay unlimited regardless of plan.
 *
 * Free trial is capped across the hosted app.
 * Free:      10 generations total
 * Pro:       unlimited
 * Unlimited: no cap
 */
const db = require('../db');
const { v4: uuidv4 } = require('uuid');
const { AppError } = require('./errorHandler');

const PLAN_LIMITS = {
  free: 10,
  pro: Infinity,
  unlimited: Infinity,
};

function isHostedRuntime() {
  if (process.env.HOSTED) return true;
  if (process.env.ELECTRON_USER_DATA) return false;
  return process.env.NODE_ENV === 'production';
}

function getCurrentPlan(userId) {
  const row = db.prepare(`
    SELECT s1.plan, s1.status, s1.expires_at
    FROM subscriptions s1
    INNER JOIN (
      SELECT user_id, MAX(datetime(created_at)) AS mc
      FROM subscriptions GROUP BY user_id
    ) x ON x.user_id = s1.user_id AND datetime(s1.created_at) = x.mc
    WHERE s1.user_id = ?
  `).get(userId);
  if (!row || row.status !== 'active') return 'free';
  // Treat subscription as expired if expires_at is set and in the past
  if (row.expires_at && new Date(row.expires_at) < new Date()) return 'free';
  return row.plan || 'free';
}

function getUsageLast24h(userId) {
  const row = db.prepare(`
    SELECT SUM(output_count) AS total
    FROM generation_runs
    WHERE user_id = ? AND status IN ('succeeded','completed','partial')
      AND datetime(started_at) >= datetime('now', '-1 day')
  `).get(userId);
  return row?.total || 0;
}

function getReservedFreeTrialUsage(userId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total
    FROM usage_events
    WHERE user_id = ? AND event_type = 'trial.generation_reserved'
  `).get(userId);
  return row?.total || 0;
}

function getSuccessfulGenerationUsage(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      CASE
        WHEN COALESCE(output_count, 0) > 0 THEN output_count
        ELSE 1
      END
    ), 0) AS total
    FROM generation_runs
    WHERE user_id = ?
      AND status IN ('succeeded', 'completed', 'partial')
  `).get(userId);
  return row?.total || 0;
}

function getFreeTrialUsage(userId) {
  if (!userId) return 0;
  return Math.max(
    getReservedFreeTrialUsage(userId),
    getSuccessfulGenerationUsage(userId),
  );
}

function inferGenerationCost(req, options = {}) {
  if (typeof options.cost === 'number' && Number.isFinite(options.cost) && options.cost > 0) {
    return Math.max(1, Math.floor(options.cost));
  }

  if (typeof options.costResolver === 'function') {
    try {
      const resolved = options.costResolver(req);
      if (typeof resolved === 'number' && Number.isFinite(resolved) && resolved > 0) {
        return Math.max(1, Math.floor(resolved));
      }
    } catch {
      // fall through to body inference
    }
  }

  const body = req.body || {};
  if (Number.isInteger(body.count) && body.count > 0) return body.count;
  if (Number.isInteger(body.slideCount) && body.slideCount > 0) return body.slideCount;
  if (Number.isInteger(body.pollCount) && body.pollCount > 0) return body.pollCount * 2;
  if (Number.isInteger(body.postLimit) && body.postLimit > 0) return body.postLimit;
  return 1;
}

function reserveFreeTrialUsage(userId, cost, source = 'generation') {
  const insertEvent = db.prepare(`
    INSERT INTO usage_events (id, user_id, event_type, entity_type, entity_id, source, payload_json)
    VALUES (?, ?, 'trial.generation_reserved', 'trial', ?, ?, ?)
  `);
  const ids = [];

  const tx = db.transaction(() => {
    for (let index = 0; index < cost; index += 1) {
      const id = uuidv4();
      ids.push(id);
      insertEvent.run(
        id,
        userId,
        `slot-${Date.now()}-${index}`,
        source,
        JSON.stringify({ cost: 1 }),
      );
    }
  });

  tx();
  return ids;
}

function releaseFreeTrialUsage(reservationIds = []) {
  if (!Array.isArray(reservationIds) || reservationIds.length === 0) return 0;
  const deleteEvent = db.prepare(`
    DELETE FROM usage_events
    WHERE id = ? AND event_type = 'trial.generation_reserved'
  `);
  const tx = db.transaction(() => {
    let removed = 0;
    for (const id of reservationIds) {
      removed += deleteEvent.run(id).changes || 0;
    }
    return removed;
  });
  return tx();
}

/**
 * Express middleware — checks if the user is within their plan limit.
 * Pass `{ cost }` as options to specify how many images this request produces (default 1).
 */
function requirePlanCapacity(options = {}) {
  return (req, res, next) => {
    if (!isHostedRuntime()) return next();

    const userId = req.session?.userId;
    if (!userId) return next(); // auth middleware handles unauth

    try {
      const plan = getCurrentPlan(userId);
      const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
      if (!isFinite(limit)) return next(); // unlimited plan

      const used = plan === 'free' ? getFreeTrialUsage(userId) : getUsageLast24h(userId);
      const cost = inferGenerationCost(req, options);

      if (used + cost > limit) {
        throw new AppError(
          plan === 'free'
            ? `Free trial limit reached (${used}/${limit} generations used). Upgrade to keep creating.`
            : `Daily generation limit reached (${used}/${limit} images used). Upgrade your plan for more.`,
          429,
          'PLAN_LIMIT_EXCEEDED',
        );
      }

      if (plan === 'free') {
        const reservationIds = reserveFreeTrialUsage(userId, cost, req.path || req.originalUrl || 'generation');
        res.once('finish', () => {
          if (res.statusCode >= 400) {
            try { releaseFreeTrialUsage(reservationIds); } catch { /* best effort refund */ }
          }
        });
      }

      // Attach to req for logging
      req._planInfo = { plan, used, limit };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  requirePlanCapacity,
  getCurrentPlan,
  getUsageLast24h,
  getFreeTrialUsage,
  getReservedFreeTrialUsage,
  getSuccessfulGenerationUsage,
  reserveFreeTrialUsage,
  releaseFreeTrialUsage,
  PLAN_LIMITS,
  isHostedRuntime,
};
