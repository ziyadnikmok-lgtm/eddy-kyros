'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

// GET /api/notifications — get unread admin messages for current user
router.get('/', requireAuth, (req, res) => {
  const userId = req.session?.userId;
  const rows = db.prepare(`
    SELECT m.id, m.subject, m.body, m.created_at, m.read_at, u.email AS admin_email
    FROM admin_messages m
    LEFT JOIN users u ON u.id = m.admin_user_id
    WHERE m.user_id = ?
    ORDER BY datetime(m.created_at) DESC
    LIMIT 50
  `).all(userId);
  const unread = rows.filter((r) => !r.read_at).length;
  res.json({ ok: true, messages: rows, unread });
});

// POST /api/notifications/read-all — mark all admin messages as read
router.post('/read-all', requireAuth, (req, res) => {
  const userId = req.session?.userId;
  db.prepare(`
    UPDATE admin_messages SET read_at = datetime('now')
    WHERE user_id = ? AND read_at IS NULL
  `).run(userId);
  res.json({ ok: true });
});

// POST /api/notifications/:id/read — mark single message as read
router.post('/:id/read', requireAuth, (req, res) => {
  const userId = req.session?.userId;
  db.prepare(`
    UPDATE admin_messages SET read_at = datetime('now')
    WHERE id = ? AND user_id = ? AND read_at IS NULL
  `).run(req.params.id, userId);
  res.json({ ok: true });
});

module.exports = router;
