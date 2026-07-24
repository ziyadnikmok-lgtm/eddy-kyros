'use strict';
const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

function getKey() {
  const k = process.env.SERVER_ENCRYPTION_KEY || '';
  if (k.length < 32) throw new Error('SERVER_ENCRYPTION_KEY must be at least 32 chars');
  return Buffer.from(k.slice(0, 64), 'hex').length === 32 ? Buffer.from(k.slice(0, 64), 'hex') : Buffer.from(k.slice(0, 32));
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + enc.toString('hex') + ':' + tag.toString('hex');
}

function decrypt(data) {
  const [ivHex, encHex, tagHex] = data.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

// GET /api/user/keys
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT service_name, created_at FROM user_api_keys WHERE user_id = ?').all(req.session.userId);
  res.json(rows.map(r => ({ service: r.service_name, createdAt: r.created_at })));
});

// POST /api/user/keys
router.post('/', requireAuth, (req, res) => {
  const { service, key } = req.body || {};
  if (!service || !key) return res.status(400).json({ error: 'service and key required' });
  const encrypted = encrypt(key);
  db.prepare('INSERT INTO user_api_keys (id, user_id, service_name, encrypted_key) VALUES (?,?,?,?) ON CONFLICT(user_id, service_name) DO UPDATE SET encrypted_key=excluded.encrypted_key, created_at=datetime("now")').run(uuidv4(), req.session.userId, service, encrypted);
  res.json({ message: 'Key saved' });
});

// DELETE /api/user/keys/:service
router.delete('/:service', requireAuth, (req, res) => {
  db.prepare('DELETE FROM user_api_keys WHERE user_id = ? AND service_name = ?').run(req.session.userId, req.params.service);
  res.json({ message: 'Key deleted' });
});

// Internal helper: get decrypted key for a user+service
function getUserKey(userId, service) {
  const row = db.prepare('SELECT encrypted_key FROM user_api_keys WHERE user_id = ? AND service_name = ?').get(userId, service);
  if (!row) return null;
  try { return decrypt(row.encrypted_key); } catch { return null; }
}

module.exports = { router, getUserKey };
