'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const log = require('../utils/logger');
const { requireAuth } = require('../middleware/requireAuth');
const { logUsageEvent } = require('../services/eventLogger');

// Max 5 invoice attempts per user per 15 minutes
const invoiceRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.session?.userId || ipKeyGenerator(req.ip),
  handler: (_req, res) => res.status(429).json({ error: 'Too many payment attempts. Try again in 15 minutes.' }),
  standardHeaders: true,
  legacyHeaders: false,
});

const router = express.Router();

const PLANS = {
  pro: {
    name: 'Kyros Creator',
    cycles: {
      monthly: { label: '1 Month', amount: '19.99', currency: 'USD', durationDays: 30 },
      quarterly: { label: '3 Months', amount: '44.99', currency: 'USD', durationDays: 90 },
    },
  },
  unlimited: {
    name: 'Founder Lifetime',
    cycles: {
      lifetime: { label: 'Lifetime', amount: '149.00', currency: 'USD', durationDays: null },
    },
  },
};

function getPlanCycle(plan, cycle) {
  const planConfig = PLANS[plan];
  if (!planConfig) return null;
  const fallbackCycle = plan === 'pro' ? 'monthly' : 'lifetime';
  const cycleKey = cycle || fallbackCycle;
  // reject unknown cycle keys to prevent injection
  if (!['monthly', 'quarterly', 'lifetime'].includes(cycleKey)) return null;
  const cycleConfig = planConfig.cycles[cycleKey];
  if (!cycleConfig) return null;
  return { planKey: plan, cycleKey, planConfig, cycleConfig };
}

// POST /api/billing/create-invoice
router.post('/create-invoice', requireAuth, invoiceRateLimit, async (req, res) => {
  const plan = typeof req.body?.plan === 'string' ? req.body.plan.slice(0, 32) : '';
  const cycle = typeof req.body?.cycle === 'string' ? req.body.cycle.slice(0, 32) : '';
  if (!['pro', 'unlimited'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan.' });
  }
  const selected = getPlanCycle(plan, cycle);
  if (!selected) {
    return res.status(400).json({ error: 'Invalid plan or cycle.' });
  }
  const apiKey = process.env.HELEKET_API_KEY;
  const merchantId = process.env.HELEKET_MERCHANT_ID;
  if (!apiKey || apiKey === 'placeholder_set_by_admin') return res.status(503).json({ error: 'Payment system not configured' });
  const orderId = `${selected.planKey}__${selected.cycleKey}__${req.session.userId.slice(0, 8)}__${Date.now()}`;
  const appUrl = process.env.APP_URL || 'http://localhost:3001';
  const payload = {
    merchant_id: merchantId,
    amount: selected.cycleConfig.amount,
    currency: selected.cycleConfig.currency,
    order_id: orderId,
    order_name: `Kyros Studio ${selected.planConfig.name} ${selected.cycleConfig.label}`,
    url_return: `${appUrl}/billing?status=success&tg=1`,
    url_callback: `${appUrl}/api/billing/webhook`,
    customer_email: db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId)?.email,
  };
  try {
    const resp = await fetch('https://api.heleket.com/v1/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(502).json({ error: data.message || 'Payment gateway error' });
    // Save pending subscription
    db.prepare('INSERT INTO subscriptions (id, user_id, plan, status, heleket_order_id) VALUES (?,?,?,?,?)').run(uuidv4(), req.session.userId, plan, 'pending', orderId);
    logUsageEvent({
      userId: req.session.userId,
      eventType: 'billing.invoice_created',
      entityType: 'subscription',
      entityId: orderId,
      source: 'billing',
      payload: {
        plan: selected.planKey,
        cycle: selected.cycleKey,
        amount: selected.cycleConfig.amount,
        currency: selected.cycleConfig.currency,
      },
    });
    res.json({ url: data.url || data.payment_url, orderId });
  } catch (e) {
    res.status(502).json({ error: 'Failed to reach payment gateway: ' + e.message });
  }
});

// GET /api/billing/status
router.get('/status', requireAuth, (req, res) => {
  const sub = db.prepare('SELECT plan, status, expires_at, created_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.session.userId);
  res.json(sub || { plan: 'free', status: 'active' });
});

// POST /api/billing/webhook (Heleket calls this)
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-heleket-signature'] || req.headers['x-signature'] || '';
  const apiKey = process.env.HELEKET_API_KEY || '';
  // Verify HMAC-SHA256 signature — reject if missing or wrong
  const expected = crypto.createHmac('sha256', apiKey).update(req.body).digest('hex');
  const sigBuf = Buffer.from(sig || '', 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  if (!sig || !valid) {
    log.warn('billing_webhook_bad_signature', { sig: sig ? 'present' : 'missing' });
    return res.status(403).json({ error: 'Invalid signature' });
  }
  let body;
  try { body = JSON.parse(req.body.toString()); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  const { order_id, status } = body;
  if (status === 'paid' || status === 'completed') {
    const sub = db.prepare('SELECT id, plan, user_id FROM subscriptions WHERE heleket_order_id = ?').get(order_id);
    if (sub) {
      const [, cycleKey] = String(order_id || '').split('__');
      const selected = getPlanCycle(sub.plan, cycleKey);
      const expires = selected?.cycleConfig?.durationDays
        ? new Date(Date.now() + selected.cycleConfig.durationDays * 24 * 3600 * 1000).toISOString()
        : null;
      db.prepare('UPDATE subscriptions SET status = ?, expires_at = ? WHERE id = ?').run('active', expires, sub.id);
      logUsageEvent({
        userId: sub.user_id,
        eventType: 'billing.subscription_activated',
        entityType: 'subscription',
        entityId: sub.id,
        source: 'billing',
        payload: { plan: sub.plan, cycle: cycleKey || null, orderId: order_id, expiresAt: expires },
      });
      log.info('billing_subscription_activated', { userId: sub.user_id, plan: sub.plan, cycle: cycleKey || null, orderId: order_id });
    }
  }
  res.json({ ok: true });
});

module.exports = router;
