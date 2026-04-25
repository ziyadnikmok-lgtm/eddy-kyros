'use strict';
const express = require('express');
const { getStats, getAllReferrals, markPaid, ensureReferralCode } = require('../services/referralService');
const router = express.Router();

const requireAuth = (req, res, next) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.session?.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  next();
};

// GET /api/referral/stats — user's referral dashboard data
router.get('/stats', requireAuth, (req, res) => {
  try {
    const stats = getStats(req.session.userId);
    res.json({ ok: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/referral/request-payout — user flags they want payout
router.post('/request-payout', requireAuth, (req, res) => {
  const db = require('../db');
  const pending = db.prepare(
    "SELECT COALESCE(SUM(amount_usd),0) as t FROM referral_commissions WHERE referrer_id = ? AND status = 'pending'"
  ).get(req.session.userId)?.t ?? 0;

  if (pending < 20) {
    return res.status(400).json({ error: `Minimum payout is $20. You have $${(+pending).toFixed(2)} pending.` });
  }

  const { wallet, method } = req.body || {};
  if (!wallet) return res.status(400).json({ error: 'Wallet address required' });

  db.prepare(
    "UPDATE referral_commissions SET notes = ? WHERE referrer_id = ? AND status = 'pending'"
  ).run(`Payout requested via ${method || 'crypto'} to: ${wallet}`, req.session.userId);

  res.json({ ok: true, message: 'Payout request recorded. We\'ll process it within 48 hours.' });
});

// ── Admin ──────────────────────────────────────────────────────────────────────
router.get('/admin/all', requireAdmin, (_req, res) => {
  res.json({ ok: true, commissions: getAllReferrals() });
});

router.post('/admin/mark-paid/:id', requireAdmin, (req, res) => {
  const ok = markPaid(req.params.id, req.body?.notes);
  if (!ok) return res.status(404).json({ error: 'Commission not found or already paid' });
  res.json({ ok: true });
});

module.exports = router;
