'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const COMMISSION_RATE = 0.20;

const PLAN_PRICES = {
  pro:       19,
  unlimited: 49,
};

function generateCode() {
  return require('crypto').randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
}

function ensureReferralCode(userId) {
  const user = db.prepare('SELECT referral_code FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  if (user.referral_code) return user.referral_code;
  let code;
  let attempts = 0;
  do {
    code = generateCode();
    attempts++;
  } while (db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code) && attempts < 10);
  db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(code, userId);
  return code;
}

function getUserByReferralCode(code) {
  return db.prepare('SELECT id, name FROM users WHERE referral_code = ?').get(code?.toUpperCase());
}

function recordReferral(newUserId, referralCode) {
  if (!referralCode) return;
  const referrer = getUserByReferralCode(referralCode);
  if (!referrer || referrer.id === newUserId) return;
  db.prepare('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL')
    .run(referrer.id, newUserId);
}

function createCommission(refereeId, plan) {
  const referee = db.prepare('SELECT referred_by FROM users WHERE id = ?').get(refereeId);
  if (!referee?.referred_by) return null;
  const price = PLAN_PRICES[plan];
  if (!price) return null;
  const amount = parseFloat((price * COMMISSION_RATE).toFixed(2));
  const existing = db.prepare(
    'SELECT id FROM referral_commissions WHERE referee_id = ? AND plan = ? AND status != ?'
  ).get(refereeId, plan, 'refunded');
  if (existing) return null;
  const id = uuidv4();
  db.prepare(
    'INSERT INTO referral_commissions (id, referrer_id, referee_id, plan, amount_usd, status) VALUES (?,?,?,?,?,?)'
  ).run(id, referee.referred_by, refereeId, plan, amount, 'pending');
  return { id, referrerId: referee.referred_by, amount };
}

function getStats(userId) {
  const code = ensureReferralCode(userId);
  const totalSignups = db.prepare('SELECT COUNT(*) as n FROM users WHERE referred_by = ?').get(userId)?.n ?? 0;
  const conversions  = db.prepare('SELECT COUNT(DISTINCT referee_id) as n FROM referral_commissions WHERE referrer_id = ?').get(userId)?.n ?? 0;
  const pending      = db.prepare('SELECT COALESCE(SUM(amount_usd),0) as t FROM referral_commissions WHERE referrer_id = ? AND status = ?').get(userId, 'pending')?.t ?? 0;
  const paid         = db.prepare('SELECT COALESCE(SUM(amount_usd),0) as t FROM referral_commissions WHERE referrer_id = ? AND status = ?').get(userId, 'paid')?.t ?? 0;
  const commissions  = db.prepare(
    `SELECT rc.id, rc.amount_usd, rc.plan, rc.status, rc.created_at, rc.paid_at,
            u.name as referee_name, u.email as referee_email
     FROM referral_commissions rc
     JOIN users u ON u.id = rc.referee_id
     WHERE rc.referrer_id = ?
     ORDER BY rc.created_at DESC LIMIT 50`
  ).all(userId);
  return { code, totalSignups, conversions, pending: +pending.toFixed(2), paid: +paid.toFixed(2), commissions };
}

// Admin helpers
function getAllReferrals() {
  return db.prepare(
    `SELECT rc.id, rc.amount_usd, rc.plan, rc.status, rc.created_at, rc.paid_at, rc.notes,
            r.name as referrer_name, r.email as referrer_email,
            e.name as referee_name,  e.email as referee_email
     FROM referral_commissions rc
     JOIN users r ON r.id = rc.referrer_id
     JOIN users e ON e.id = rc.referee_id
     ORDER BY rc.created_at DESC`
  ).all();
}

function markPaid(commissionId, notes) {
  const result = db.prepare(
    "UPDATE referral_commissions SET status = 'paid', paid_at = datetime('now'), notes = ? WHERE id = ? AND status = 'pending'"
  ).run(notes || null, commissionId);
  return result.changes > 0;
}

module.exports = { ensureReferralCode, getUserByReferralCode, recordReferral, createCommission, getStats, getAllReferrals, markPaid };
