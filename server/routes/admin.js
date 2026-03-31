'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAdmin } = require('../middleware/requireAuth');
const { logAdminAction } = require('../services/adminAuditLogger');

const router = express.Router();
const PLAN_PRICES = {
  free: 0,
  pro: 19,
  unlimited: 49,
};

function getCurrentSubscription(userId) {
  return db.prepare(`
    SELECT plan, status, expires_at, created_at
    FROM subscriptions
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).get(userId) || { plan: 'free', status: 'active', expires_at: null, created_at: null };
}

function getUserSummaryById(userId) {
  return db.prepare(`
    SELECT
      u.id,
      u.email,
      u.name,
      u.is_admin,
      u.is_banned,
      u.verified,
      u.created_at,
      (
        SELECT MAX(created_at)
        FROM usage_events ue
        WHERE ue.user_id = u.id
      ) AS last_active_at,
      (
        SELECT COUNT(*)
        FROM generation_runs gr
        WHERE gr.user_id = u.id
      ) AS generation_count_total,
      (
        SELECT COUNT(*)
        FROM generation_runs gr
        WHERE gr.user_id = u.id AND datetime(gr.started_at) >= datetime('now', '-30 days')
      ) AS generation_count_30d,
      (
        SELECT MAX(started_at)
        FROM generation_runs gr
        WHERE gr.user_id = u.id
      ) AS last_generation_at,
      (
        SELECT COUNT(*)
        FROM user_api_keys k
        WHERE k.user_id = u.id
      ) AS connected_key_count
    FROM users u
    WHERE u.id = ?
  `).get(userId);
}

function getSupportNotes(userId, limit = 20) {
  return db.prepare(`
    SELECT
      n.id,
      n.body,
      n.created_at,
      admin.email AS admin_email
    FROM support_notes n
    LEFT JOIN users admin ON admin.id = n.admin_user_id
    WHERE n.user_id = ?
    ORDER BY datetime(n.created_at) DESC
    LIMIT ?
  `).all(userId, limit);
}

function performAdminAction({ adminUserId, targetId, type, plan, note }) {
  const target = getUserSummaryById(targetId);
  if (!target) return { error: 'User not found', status: 404 };

  const before = { ...target, subscription: getCurrentSubscription(targetId) };

  switch (type) {
    case 'ban':
      db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(targetId);
      break;
    case 'unban':
      db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').run(targetId);
      break;
    case 'grant_admin':
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(targetId);
      break;
    case 'revoke_admin':
      db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(targetId);
      break;
    case 'change_plan':
      if (!['free', 'pro', 'unlimited'].includes(plan)) {
        return { error: 'Invalid plan', status: 400 };
      }
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, plan, status)
        VALUES (lower(hex(randomblob(16))), ?, ?, 'active')
      `).run(targetId, plan);
      break;
    default:
      return { error: 'Invalid action type', status: 400 };
  }

  const after = { ...getUserSummaryById(targetId), subscription: getCurrentSubscription(targetId) };
  logAdminAction({
    adminUserId,
    targetUserId: targetId,
    actionType: type,
    before,
    after,
    note: typeof note === 'string' ? note.trim() : null,
  });

  return { user: after };
}

// GET /api/admin/bootstrap?secret=XXX
router.get('/bootstrap', (req, res) => {
  const secret = process.env.BOOTSTRAP_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });
  const email = process.env.SEED_ADMIN_EMAIL;
  if (!email) return res.status(400).json({ error: 'SEED_ADMIN_EMAIL not set' });
  const result = db.prepare('UPDATE users SET is_admin=1, verified=1 WHERE email=?').run(email.toLowerCase());
  res.json({ ok: true, changes: result.changes, email });
});

// GET /api/admin/overview
router.get('/overview', requireAdmin, (req, res) => {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS users,
      SUM(CASE WHEN is_admin = 1 THEN 1 ELSE 0 END) AS admins,
      SUM(CASE WHEN is_banned = 1 THEN 1 ELSE 0 END) AS bannedUsers,
      SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verifiedUsers
    FROM users
  `).get();

  const paidUsers = db.prepare(`
    SELECT COUNT(*) AS paidUsers
    FROM (
      SELECT user_id, plan, status, MAX(datetime(created_at)) AS created_at
      FROM subscriptions
      GROUP BY user_id
    )
    WHERE plan IN ('pro', 'unlimited') AND status = 'active'
  `).get();

  const activity = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE datetime(created_at) >= datetime('now', '-1 day')) AS signups24h,
      (SELECT COUNT(DISTINCT user_id) FROM usage_events WHERE user_id IS NOT NULL AND datetime(created_at) >= datetime('now', '-1 day')) AS activeUsers24h,
      (SELECT COUNT(DISTINCT user_id) FROM usage_events WHERE user_id IS NOT NULL AND datetime(created_at) >= datetime('now', '-7 days')) AS activeUsers7d,
      (SELECT COUNT(*) FROM generation_runs WHERE datetime(started_at) >= datetime('now', '-1 day')) AS generations24h,
      (SELECT COUNT(*) FROM generation_runs WHERE status = 'failed' AND datetime(started_at) >= datetime('now', '-1 day')) AS generationFailures24h
  `).get();

  const billing = db.prepare(`
    SELECT
      SUM(CASE WHEN plan = 'free' AND status = 'active' THEN 1 ELSE 0 END) AS free,
      SUM(CASE WHEN plan = 'pro' AND status = 'active' THEN 1 ELSE 0 END) AS pro,
      SUM(CASE WHEN plan = 'unlimited' AND status = 'active' THEN 1 ELSE 0 END) AS unlimited,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM (
      SELECT s1.*
      FROM subscriptions s1
      INNER JOIN (
        SELECT user_id, MAX(datetime(created_at)) AS max_created
        FROM subscriptions
        GROUP BY user_id
      ) latest
        ON latest.user_id = s1.user_id
       AND datetime(s1.created_at) = latest.max_created
    )
  `).get() || { free: 0, pro: 0, unlimited: 0, pending: 0 };

  const recentSignups = db.prepare(`
    SELECT id, email, name, created_at
    FROM users
    ORDER BY datetime(created_at) DESC
    LIMIT 8
  `).all();

  const recentFailures = db.prepare(`
    SELECT gr.id, gr.user_id, u.email, gr.feature, gr.model, gr.error_code, gr.started_at
    FROM generation_runs gr
    LEFT JOIN users u ON u.id = gr.user_id
    WHERE gr.status = 'failed'
    ORDER BY datetime(gr.started_at) DESC
    LIMIT 8
  `).all();

  res.json({
    totals: {
      users: totals?.users || 0,
      paidUsers: paidUsers?.paidUsers || 0,
      admins: totals?.admins || 0,
      bannedUsers: totals?.bannedUsers || 0,
      verifiedUsers: totals?.verifiedUsers || 0,
    },
    activity: {
      signups24h: activity?.signups24h || 0,
      activeUsers24h: activity?.activeUsers24h || 0,
      activeUsers7d: activity?.activeUsers7d || 0,
      generations24h: activity?.generations24h || 0,
      generationFailures24h: activity?.generationFailures24h || 0,
    },
    billing,
    recentSignups,
    recentFailures,
  });
});

// GET /api/admin/analytics
router.get('/analytics', requireAdmin, (req, res) => {
  const requestedDays = Math.max(parseInt(req.query.days || '14', 10), 7);
  const days = Math.min(requestedDays, 90);

  const daily = db.prepare(`
    WITH RECURSIVE dates(day, idx) AS (
      SELECT date('now', ?), 0
      UNION ALL
      SELECT date(day, '+1 day'), idx + 1
      FROM dates
      WHERE idx + 1 < ?
    )
    SELECT
      dates.day,
      COALESCE((
        SELECT COUNT(*)
        FROM users u
        WHERE date(u.created_at) = dates.day
      ), 0) AS signups,
      COALESCE((
        SELECT COUNT(DISTINCT ue.user_id)
        FROM usage_events ue
        WHERE ue.user_id IS NOT NULL AND date(ue.created_at) = dates.day
      ), 0) AS activeUsers,
      COALESCE((
        SELECT COUNT(*)
        FROM generation_runs gr
        WHERE date(gr.started_at) = dates.day
      ), 0) AS generations,
      COALESCE((
        SELECT COUNT(*)
        FROM generation_runs gr
        WHERE gr.status = 'failed' AND date(gr.started_at) = dates.day
      ), 0) AS failures
    FROM dates
    ORDER BY dates.day ASC
  `).all(`-${days - 1} days`, days);

  const featureBreakdown = db.prepare(`
    SELECT
      feature,
      COUNT(*) AS totalRuns,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedRuns,
      COUNT(DISTINCT user_id) AS uniqueUsers
    FROM generation_runs
    WHERE datetime(started_at) >= datetime('now', '-30 days')
    GROUP BY feature
    ORDER BY totalRuns DESC, feature ASC
  `).all();

  const topUsers = db.prepare(`
    SELECT
      u.id,
      u.email,
      COUNT(*) AS totalRuns,
      SUM(CASE WHEN gr.status = 'failed' THEN 1 ELSE 0 END) AS failedRuns,
      MAX(gr.started_at) AS lastRunAt
    FROM generation_runs gr
    INNER JOIN users u ON u.id = gr.user_id
    WHERE datetime(gr.started_at) >= datetime('now', '-30 days')
    GROUP BY u.id, u.email
    ORDER BY totalRuns DESC, lastRunAt DESC
    LIMIT 10
  `).all();

  const failureReasons = db.prepare(`
    SELECT
      COALESCE(error_code, 'UNKNOWN') AS errorCode,
      COUNT(*) AS count
    FROM generation_runs
    WHERE status = 'failed' AND datetime(started_at) >= datetime('now', '-30 days')
    GROUP BY COALESCE(error_code, 'UNKNOWN')
    ORDER BY count DESC, errorCode ASC
    LIMIT 10
  `).all();

  const funnel = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS totalUsers,
      (SELECT COUNT(DISTINCT user_id) FROM usage_events WHERE event_type = 'auth.logged_in') AS loggedInUsers,
      (SELECT COUNT(DISTINCT user_id) FROM generation_runs) AS generatedUsers,
      (SELECT COUNT(*) FROM (
        SELECT s1.user_id, s1.plan, s1.status
        FROM subscriptions s1
        INNER JOIN (
          SELECT user_id, MAX(datetime(created_at)) AS max_created
          FROM subscriptions
          GROUP BY user_id
        ) latest
          ON latest.user_id = s1.user_id
         AND datetime(s1.created_at) = latest.max_created
        WHERE s1.plan IN ('pro', 'unlimited') AND s1.status = 'active'
      )) AS paidUsers
  `).get();

  const revenueEstimate = db.prepare(`
    SELECT s1.plan, COUNT(*) AS count
    FROM subscriptions s1
    INNER JOIN (
      SELECT user_id, MAX(datetime(created_at)) AS max_created
      FROM subscriptions
      GROUP BY user_id
    ) latest
      ON latest.user_id = s1.user_id
     AND datetime(s1.created_at) = latest.max_created
    WHERE s1.status = 'active'
    GROUP BY s1.plan
  `).all().reduce((acc, row) => {
    acc.planCounts[row.plan] = row.count;
    acc.estimatedMrrUsd += (PLAN_PRICES[row.plan] || 0) * row.count;
    return acc;
  }, { estimatedMrrUsd: 0, planCounts: { free: 0, pro: 0, unlimited: 0 } });

  res.json({
    days,
    daily,
    featureBreakdown,
    topUsers,
    failureReasons,
    funnel,
    revenueEstimate,
  });
});

// GET /api/admin/users
router.get('/users', requireAdmin, (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
  const offset = (page - 1) * limit;
  const query = String(req.query.query || '').trim().toLowerCase();
  const plan = String(req.query.plan || '').trim().toLowerCase();
  const role = String(req.query.role || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim().toLowerCase();

  const clauses = [];
  const params = [];

  if (query) {
    clauses.push('(LOWER(u.email) LIKE ? OR LOWER(u.name) LIKE ?)');
    params.push(`%${query}%`, `%${query}%`);
  }
  if (role === 'admin') clauses.push('u.is_admin = 1');
  if (role === 'member') clauses.push('u.is_admin = 0');
  if (status === 'banned') clauses.push('u.is_banned = 1');
  if (status === 'active') clauses.push('u.is_banned = 0');
  if (status === 'verified') clauses.push('u.verified = 1');
  if (status === 'unverified') clauses.push('u.verified = 0');
  if (plan) clauses.push('COALESCE(ls.plan, \'free\') = ?');
  if (plan) params.push(plan);

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const users = db.prepare(`
    WITH latest_subscriptions AS (
      SELECT s1.user_id, s1.plan, s1.status, s1.expires_at
      FROM subscriptions s1
      INNER JOIN (
        SELECT user_id, MAX(datetime(created_at)) AS max_created
        FROM subscriptions
        GROUP BY user_id
      ) latest
        ON latest.user_id = s1.user_id
       AND datetime(s1.created_at) = latest.max_created
    )
    SELECT
      u.id,
      u.email,
      u.name,
      u.is_admin,
      u.is_banned,
      u.verified,
      u.created_at,
      COALESCE(ls.plan, 'free') AS plan,
      COALESCE(ls.status, 'active') AS subscription_status,
      (
        SELECT MAX(created_at)
        FROM usage_events ue
        WHERE ue.user_id = u.id
      ) AS last_active_at,
      (
        SELECT COUNT(*)
        FROM generation_runs gr
        WHERE gr.user_id = u.id AND datetime(gr.started_at) >= datetime('now', '-30 days')
      ) AS generation_count_30d,
      (
        SELECT MAX(started_at)
        FROM generation_runs gr
        WHERE gr.user_id = u.id
      ) AS last_generation_at
    FROM users u
    LEFT JOIN latest_subscriptions ls ON ls.user_id = u.id
    ${whereSql}
    ORDER BY datetime(u.created_at) DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`
    WITH latest_subscriptions AS (
      SELECT s1.user_id, s1.plan, s1.status
      FROM subscriptions s1
      INNER JOIN (
        SELECT user_id, MAX(datetime(created_at)) AS max_created
        FROM subscriptions
        GROUP BY user_id
      ) latest
        ON latest.user_id = s1.user_id
       AND datetime(s1.created_at) = latest.max_created
    )
    SELECT COUNT(*) AS total
    FROM users u
    LEFT JOIN latest_subscriptions ls ON ls.user_id = u.id
    ${whereSql}
  `).get(...params);

  res.json({
    items: users,
    pagination: {
      page,
      limit,
      total: total?.total || 0,
      totalPages: Math.max(Math.ceil((total?.total || 0) / limit), 1),
    },
  });
});

// GET /api/admin/users/:id
router.get('/users/:id', requireAdmin, (req, res) => {
  const user = getUserSummaryById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const subscription = getCurrentSubscription(req.params.id);

  const generationByFeature = db.prepare(`
    SELECT feature, COUNT(*) AS count
    FROM generation_runs
    WHERE user_id = ?
    GROUP BY feature
    ORDER BY count DESC, feature ASC
  `).all(req.params.id);

  const recentRuns = db.prepare(`
    SELECT id, feature, provider, model, status, error_code, error_message, output_count, started_at, finished_at
    FROM generation_runs
    WHERE user_id = ?
    ORDER BY datetime(started_at) DESC
    LIMIT 12
  `).all(req.params.id);

  const billingHistory = db.prepare(`
    SELECT id, plan, status, heleket_order_id, expires_at, created_at
    FROM subscriptions
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 12
  `).all(req.params.id);

  res.json({
    user: {
      ...user,
      subscription,
      generationByFeature,
      recentRuns,
      billingHistory,
      supportNotes: getSupportNotes(req.params.id, 25),
    },
  });
});

// GET /api/admin/users/:id/activity
router.get('/users/:id/activity', requireAdmin, (req, res) => {
  const usageEvents = db.prepare(`
    SELECT id, 'usage_event' AS type, event_type AS label, source, payload_json AS details, created_at
    FROM usage_events
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 50
  `).all(req.params.id);

  const generationRuns = db.prepare(`
    SELECT id, 'generation_run' AS type, feature || ':' || status AS label, provider AS source,
           json_object('model', model, 'errorCode', error_code, 'errorMessage', error_message, 'outputCount', output_count) AS details,
           COALESCE(finished_at, started_at) AS created_at
    FROM generation_runs
    WHERE user_id = ?
    ORDER BY datetime(COALESCE(finished_at, started_at)) DESC
    LIMIT 50
  `).all(req.params.id);

  const adminActions = db.prepare(`
    SELECT a.id, 'admin_action' AS type, a.action_type AS label, admin.email AS source,
           json_object('note', a.note, 'before', a.before_json, 'after', a.after_json) AS details,
           a.created_at
    FROM admin_audit_logs a
    LEFT JOIN users admin ON admin.id = a.admin_user_id
    WHERE a.target_user_id = ?
    ORDER BY datetime(a.created_at) DESC
    LIMIT 50
  `).all(req.params.id);

  const items = [...usageEvents, ...generationRuns, ...adminActions]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 100);

  res.json({ items });
});

// GET /api/admin/audit-logs
router.get('/audit-logs', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
  const items = db.prepare(`
    SELECT
      a.id,
      a.action_type,
      a.note,
      a.before_json,
      a.after_json,
      a.created_at,
      admin.email AS admin_email,
      target.email AS target_email
    FROM admin_audit_logs a
    LEFT JOIN users admin ON admin.id = a.admin_user_id
    LEFT JOIN users target ON target.id = a.target_user_id
    ORDER BY datetime(a.created_at) DESC
    LIMIT ?
  `).all(limit);
  res.json({ items });
});

// GET /api/admin/users/:id/support-notes
router.get('/users/:id/support-notes', requireAdmin, (req, res) => {
  const target = getUserSummaryById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  res.json({ items: getSupportNotes(req.params.id, 50) });
});

// POST /api/admin/users/:id/support-notes
router.post('/users/:id/support-notes', requireAdmin, (req, res) => {
  const target = getUserSummaryById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'Note body is required' });
  if (body.length > 2000) return res.status(400).json({ error: 'Note is too long' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO support_notes (id, user_id, admin_user_id, body)
    VALUES (?, ?, ?, ?)
  `).run(id, req.params.id, req.session.userId, body);

  logAdminAction({
    adminUserId: req.session.userId,
    targetUserId: req.params.id,
    actionType: 'support_note_added',
    before: null,
    after: { noteId: id, body },
    note: body.slice(0, 200),
  });

  res.status(201).json({ ok: true, item: getSupportNotes(req.params.id, 1)[0] || null });
});

// POST /api/admin/users/:id/action
router.post('/users/:id/action', requireAdmin, (req, res) => {
  const { type, plan, note } = req.body || {};
  const result = performAdminAction({
    adminUserId: req.session.userId,
    targetId: req.params.id,
    type,
    plan,
    note,
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, user: result.user });
});

// PATCH /api/admin/users/:id
router.patch('/users/:id', requireAdmin, (req, res) => {
  const { plan, is_banned, is_admin, note } = req.body || {};
  if (plan !== undefined) {
    const result = performAdminAction({ adminUserId: req.session.userId, targetId: req.params.id, type: 'change_plan', plan, note });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.json({ ok: true, user: result.user });
  }
  if (is_banned !== undefined) {
    const result = performAdminAction({ adminUserId: req.session.userId, targetId: req.params.id, type: is_banned ? 'ban' : 'unban', note });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.json({ ok: true, user: result.user });
  }
  if (is_admin !== undefined) {
    const result = performAdminAction({ adminUserId: req.session.userId, targetId: req.params.id, type: is_admin ? 'grant_admin' : 'revoke_admin', note });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.json({ ok: true, user: result.user });
  }
  return res.status(400).json({ error: 'No supported fields supplied' });
});

module.exports = router;
