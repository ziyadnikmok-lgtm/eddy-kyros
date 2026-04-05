'use strict';
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAdmin } = require('../middleware/requireAuth');
const { logAdminAction } = require('../services/adminAuditLogger');
const apiKeyManager = require('../services/apiKeyManager');
const galleryManager = require('../services/galleryManager');
const videoHistory = require('../services/videoHistoryStore');
const batchGenerator = require('../services/batchGenerator');
const { runWithUser } = require('../userContext');
const log = require('../utils/logger');

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

function getUserContentSnapshot(userId, limit = 12) {
  const recentRunRows = db.prepare(`
    SELECT
      id,
      feature,
      provider,
      model,
      status,
      error_code,
      error_message,
      output_count,
      COALESCE(finished_at, started_at) AS created_at
    FROM generation_runs
    WHERE user_id = ?
    ORDER BY datetime(COALESCE(finished_at, started_at)) DESC
    LIMIT ?
  `);

  const recentRunTotal = db.prepare(`
    SELECT COUNT(*) AS total
    FROM generation_runs
    WHERE user_id = ?
  `);

  const recentRunByFeature = db.prepare(`
    SELECT feature, COUNT(*) AS count
    FROM generation_runs
    WHERE user_id = ?
    GROUP BY feature
    ORDER BY count DESC, feature ASC
  `);

  const recentRunCount30d = db.prepare(`
    SELECT COUNT(*) AS count
    FROM generation_runs
    WHERE user_id = ? AND datetime(started_at) >= datetime('now', '-30 days')
  `);

  function buildRunFallback() {
    const runs = recentRunRows.all(userId, limit);
    return {
      mode: 'runs-fallback',
      note: 'Showing the selected user run history from the shared database backup.',
      items: runs.map((run) => ({
        id: run.id,
        mediaType: run.feature === 'video' ? 'video' : 'image',
        createdAt: run.created_at,
        prompt: [run.feature, run.model].filter(Boolean).join(' · ') || 'Generation run',
        source: run.feature || run.provider || 'generate',
        aspectRatio: null,
        status: run.status || 'completed',
        previewUrl: null,
        metadata: {
          model: run.model || null,
          provider: run.provider || null,
          outputCount: run.output_count || 0,
          error: run.error_message || run.error_code || null,
          isRunFallback: true,
        },
      })),
      total: recentRunTotal.get(userId)?.total || 0,
      count30d: recentRunCount30d.get(userId)?.count || 0,
      byFeature: recentRunByFeature.all(userId).map((item) => ({ feature: item.feature, count: item.count })),
    };
  }

  // In Electron/local mode the gallery and video history live in one shared app-data folder.
  // When an admin opens another user's profile there, showing that shared media would leak
  // the current admin's own library. Fall back to the selected user's run history instead.
  if (process.env.ELECTRON_USER_DATA && getUserId() && getUserId() !== userId) {
    return buildRunFallback();
  }

  return runWithUser(userId, () => {
    const images = (galleryManager.list().images || []).map((image) => ({
      id: image.id,
      mediaType: 'image',
      createdAt: image.createdAt,
      prompt: image.prompt || '',
      source: image.source || 'generate',
      aspectRatio: image.aspectRatio || null,
      status: 'completed',
      previewUrl: `/api/admin/users/${userId}/library/image/${image.id}`,
      metadata: {
        fileSize: image.fileSize || null,
        filename: image.filename || null,
      },
    }));

    const videos = (videoHistory.list() || []).map((video) => ({
      id: video.id,
      mediaType: 'video',
      createdAt: video.createdAt,
      prompt: video.prompt || '',
      source: video.provider || 'video',
      aspectRatio: video.aspectRatio || null,
      status: video.status || 'processing',
      previewUrl: video.localPath ? `/api/admin/users/${userId}/library/video/${video.id}` : null,
      metadata: {
        model: video.model || null,
        duration: video.duration || null,
        error: video.error || null,
      },
    }));

    const allItems = [...images, ...videos].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const byFeature = new Map();

    for (const item of allItems) {
      const feature = item.mediaType === 'video'
        ? 'video'
        : (item.source || 'generate');
      byFeature.set(feature, (byFeature.get(feature) || 0) + 1);
    }

    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const count30d = allItems.filter((item) => {
      const time = new Date(item.createdAt).getTime();
      return Number.isFinite(time) && time >= cutoff;
    }).length;

    return {
      mode: 'library',
      note: null,
      items: allItems.slice(0, limit),
      total: allItems.length,
      count30d,
      byFeature: [...byFeature.entries()]
        .map(([feature, count]) => ({ feature, count }))
        .sort((a, b) => b.count - a.count || a.feature.localeCompare(b.feature)),
    };
  });
}

function getUserKeySummary(userId) {
  return runWithUser(userId, () => {
    const providerKeys = apiKeyManager.listKeys();
    const extras = [
      apiKeyManager.getApifyKeyInfo()?.hasApifyKey ? { service: 'apify' } : null,
      apiKeyManager.getWavespeedKeyInfo()?.hasWavespeedKey ? { service: 'wavespeed' } : null,
      apiKeyManager.getInstagramSessionInfo()?.hasInstagramSession ? { service: 'instagram-session' } : null,
      apiKeyManager.getInstagramLoginInfo()?.hasInstagramLogin ? { service: 'instagram-login' } : null,
    ].filter(Boolean);

    return {
      count: providerKeys.length + extras.length,
      items: [
        ...providerKeys.map((item) => ({ service: item.name || 'gemini', maskedKey: item.maskedKey || '', createdAt: item.createdAt || null })),
        ...extras,
      ],
    };
  });
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

// POST /api/admin/bootstrap  — secret in body, not query param (query params appear in logs/history)
router.post('/bootstrap', (req, res) => {
  const secret = process.env.BOOTSTRAP_SECRET;
  if (!secret || req.body?.secret !== secret) return res.status(403).json({ error: 'Forbidden' });
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
  const content = getUserContentSnapshot(req.params.id, 16);
  const keySummary = getUserKeySummary(req.params.id);

  let generationByFeature = db.prepare(`
    SELECT feature, COUNT(*) AS count
    FROM generation_runs
    WHERE user_id = ?
    GROUP BY feature
    ORDER BY count DESC, feature ASC
  `).all(req.params.id);
  if (!generationByFeature.length && content.byFeature.length) generationByFeature = content.byFeature;

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
      connected_key_count: keySummary.count,
      connected_keys: keySummary.items,
      generation_count_total: user.generation_count_total || content.total,
      generation_count_30d: user.generation_count_30d || content.count30d,
      subscription,
      generationByFeature,
      recentRuns,
      billingHistory,
      supportNotes: getSupportNotes(req.params.id, 25),
      recentLibraryItems: content.items,
      recentLibraryMode: content.mode || 'library',
      recentLibraryNote: content.note || null,
    },
  });
});

// GET /api/admin/users/:id/library/image/:imageId
router.get('/users/:id/library/image/:imageId', requireAdmin, (req, res) => {
  return runWithUser(req.params.id, () => {
    const { filePath, mimeType } = galleryManager.getFilePath(req.params.imageId);
    res.type(mimeType);
    return res.sendFile(filePath);
  });
});

// GET /api/admin/users/:id/library/video/:videoId
router.get('/users/:id/library/video/:videoId', requireAdmin, (req, res) => {
  return runWithUser(req.params.id, () => {
    const entry = videoHistory.get(req.params.videoId);
    if (!entry.localPath || !fs.existsSync(entry.localPath)) {
      return res.status(404).json({ error: 'Video file missing' });
    }
    return res.sendFile(entry.localPath);
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

// GET /api/admin/system  — live server health snapshot
router.get('/system', requireAdmin, (req, res) => {
  const mem = process.memoryUsage();
  const queue = (() => { try { return batchGenerator.queueStatus(); } catch { return null; } })();
  const runningJobs = (() => { try { return batchGenerator.listJobs('running').length; } catch { return 0; } })();
  const pendingJobs = (() => { try { return batchGenerator.listJobs('pending').length; } catch { return 0; } })();
  const failedJobs24h = db.prepare(`SELECT COUNT(*) AS c FROM generation_runs WHERE status='failed' AND datetime(started_at) >= datetime('now','-1 day')`).get()?.c || 0;
  const totalJobsToday = db.prepare(`SELECT COUNT(*) AS c FROM generation_runs WHERE datetime(started_at) >= datetime('now','-1 day')`).get()?.c || 0;
  const activeSessions = db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE datetime(expire) > datetime('now')`).get()?.c || 0;
  const newUsersToday = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE date(created_at) = date('now')`).get()?.c || 0;
  const lockedAccounts = db.prepare(`SELECT COUNT(*) AS c FROM login_lockouts WHERE locked_until > datetime('now')`).get()?.c || 0;
  res.json({
    uptime: process.uptime(),
    memory: { heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024), heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024), rssMb: Math.round(mem.rss / 1024 / 1024) },
    queue: queue || { queueDepth: 0, activeWorkers: 0 },
    jobs: { running: runningJobs, pending: pendingJobs, failedLast24h: failedJobs24h, totalToday: totalJobsToday },
    sessions: { active: activeSessions },
    accounts: { newToday: newUsersToday, lockedOut: lockedAccounts },
    nodeVersion: process.version,
    env: process.env.NODE_ENV || 'production',
  });
});

// GET /api/admin/analytics/retention  — 8-week user retention cohort grid
router.get('/analytics/retention', requireAdmin, (req, res) => {
  // For each of the last 8 signup-weeks, count how many users were active in each subsequent week
  const cohorts = db.prepare(`
    WITH cohort_weeks AS (
      SELECT
        strftime('%Y-W%W', created_at) AS cohort_week,
        id AS user_id,
        created_at
      FROM users
      WHERE datetime(created_at) >= datetime('now', '-56 days')
    ),
    activity AS (
      SELECT DISTINCT
        user_id,
        strftime('%Y-W%W', created_at) AS active_week
      FROM usage_events
      WHERE user_id IS NOT NULL AND datetime(created_at) >= datetime('now', '-56 days')
    )
    SELECT
      c.cohort_week,
      COUNT(DISTINCT c.user_id) AS cohort_size,
      COUNT(DISTINCT CASE WHEN a.active_week = c.cohort_week THEN c.user_id END) AS w0,
      COUNT(DISTINCT CASE WHEN a.active_week = strftime('%Y-W%W', datetime(c.created_at, '+7 days')) THEN c.user_id END) AS w1,
      COUNT(DISTINCT CASE WHEN a.active_week = strftime('%Y-W%W', datetime(c.created_at, '+14 days')) THEN c.user_id END) AS w2,
      COUNT(DISTINCT CASE WHEN a.active_week = strftime('%Y-W%W', datetime(c.created_at, '+21 days')) THEN c.user_id END) AS w3,
      COUNT(DISTINCT CASE WHEN a.active_week = strftime('%Y-W%W', datetime(c.created_at, '+28 days')) THEN c.user_id END) AS w4
    FROM cohort_weeks c
    LEFT JOIN activity a ON a.user_id = c.user_id
    GROUP BY c.cohort_week
    ORDER BY c.cohort_week DESC
    LIMIT 8
  `).all();
  res.json({ cohorts });
});

// GET /api/admin/analytics/feature-trend — per-feature daily counts for last 14d
router.get('/analytics/feature-trend', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT
      date(started_at) AS day,
      feature,
      COUNT(*) AS runs,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failures
    FROM generation_runs
    WHERE datetime(started_at) >= datetime('now', '-14 days')
    GROUP BY date(started_at), feature
    ORDER BY day ASC, runs DESC
  `).all();
  res.json({ rows });
});

// GET /api/admin/analytics/signups-by-day — 30-day signup trend with source breakdown
router.get('/analytics/signups-by-day', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS signups, SUM(CASE WHEN verified=1 THEN 1 ELSE 0 END) AS verified
    FROM users
    WHERE datetime(created_at) >= datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all();
  res.json({ rows });
});

// GET /api/admin/users/export.csv — download all users as CSV
router.get('/users/export.csv', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    WITH ls AS (
      SELECT s1.user_id, s1.plan, s1.status
      FROM subscriptions s1
      INNER JOIN (SELECT user_id, MAX(datetime(created_at)) AS mc FROM subscriptions GROUP BY user_id) x
        ON x.user_id = s1.user_id AND datetime(s1.created_at) = x.mc
    )
    SELECT u.id, u.email, u.name, u.verified, u.is_admin, u.is_banned, u.created_at,
      COALESCE(ls.plan,'free') AS plan, COALESCE(ls.status,'active') AS sub_status,
      (SELECT COUNT(*) FROM generation_runs gr WHERE gr.user_id=u.id) AS total_runs,
      (SELECT MAX(started_at) FROM generation_runs gr WHERE gr.user_id=u.id) AS last_run_at,
      (SELECT MAX(created_at) FROM usage_events ue WHERE ue.user_id=u.id) AS last_active_at
    FROM users u
    LEFT JOIN ls ON ls.user_id = u.id
    ORDER BY datetime(u.created_at) DESC
  `).all();

  const header = 'id,email,name,verified,is_admin,is_banned,created_at,plan,sub_status,total_runs,last_run_at,last_active_at\n';
  const csvRows = rows.map((r) => [r.id, r.email, r.name || '', r.verified, r.is_admin, r.is_banned, r.created_at, r.plan, r.sub_status, r.total_runs, r.last_run_at || '', r.last_active_at || '']
    .map((v) => `"${String(v).replace(/"/g, '""')}"`)
    .join(','));

  log.info('admin_users_exported', { adminId: req.session?.userId, count: rows.length });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="users-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(header + csvRows.join('\n'));
});

// POST /api/admin/users/:id/force-reset  — generate a password reset token and return the link
router.post('/users/:id/force-reset', requireAdmin, (req, res) => {
  const user = getUserSummaryById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const token = crypto.randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2h
  db.prepare('UPDATE users SET reset_token=?, reset_token_expiry=? WHERE id=?').run(token, expiry, req.params.id);
  logAdminAction({ adminUserId: req.session?.userId, targetUserId: req.params.id, actionType: 'force_reset', before: null, after: { token: token.slice(0, 8) + '...' }, note: 'Admin-initiated password reset' });
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  res.json({ ok: true, resetToken: token, resetLink: `${appUrl}/reset-password?token=${token}`, expiresAt: expiry });
});

// GET /api/admin/db-download — download a copy of the production SQLite database (admin only)
router.get('/db-download', requireAdmin, (req, res) => {
  const projectRoot = path.join(__dirname, '..', '..');
  const WEB_DATA_ROOT = process.env.WEB_DATA_ROOT
    || (process.env.ELECTRON_USER_DATA ? path.join(process.env.ELECTRON_USER_DATA, 'data') : null)
    || path.join(projectRoot, 'userdata');
  const dbPath = path.join(WEB_DATA_ROOT, 'saas.db');

  if (!fs.existsSync(dbPath)) {
    return res.status(404).json({ error: 'Database file not found at: ' + dbPath });
  }

  log.info('admin_db_downloaded', { adminId: req.session?.userId });
  const filename = `saas-backup-${new Date().toISOString().slice(0, 10)}.db`;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(dbPath);
});

// GET /api/admin/users/:id/delete — hard delete a user account and all their data
router.delete('/users/:id', requireAdmin, (req, res) => {
  const user = getUserSummaryById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.is_admin) return res.status(400).json({ error: 'Cannot delete admin accounts' });
  logAdminAction({ adminUserId: req.session?.userId, targetUserId: req.params.id, actionType: 'delete_user', before: { email: user.email }, after: null, note: req.body?.note || null });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  log.warn('admin_user_deleted', { adminId: req.session?.userId, targetId: req.params.id, email: user.email });
  res.json({ ok: true, deleted: req.params.id });
});

// GET /api/admin/users/:id/library/all — full library (no limit)
router.get('/users/:id/library/all', requireAdmin, (req, res) => {
  const content = getUserContentSnapshot(req.params.id, 10000);
  res.json({ ok: true, items: content.items, total: content.total || content.items.length, mode: content.mode });
});

// POST /api/admin/users/:id/messages — send admin message to user
router.post('/users/:id/messages', requireAdmin, (req, res) => {
  const { subject = '', body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required' });
  const user = getUserSummaryById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const id = uuidv4();
  db.prepare(`
    INSERT INTO admin_messages (id, user_id, admin_user_id, subject, body)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.params.id, req.session?.userId || null, subject.trim(), body.trim());
  logAdminAction({ adminUserId: req.session?.userId, targetUserId: req.params.id, actionType: 'send_message', after: { subject, body }, note: null });
  log.info('admin_message_sent', { adminId: req.session?.userId, targetId: req.params.id });
  res.json({ ok: true, id });
});

// GET /api/admin/users/:id/messages — list messages sent to a user (admin view)
router.get('/users/:id/messages', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.subject, m.body, m.created_at, m.read_at, u.email AS admin_email
    FROM admin_messages m
    LEFT JOIN users u ON u.id = m.admin_user_id
    WHERE m.user_id = ?
    ORDER BY datetime(m.created_at) DESC
    LIMIT 50
  `).all(req.params.id);
  res.json({ ok: true, messages: rows });
});

module.exports = router;
