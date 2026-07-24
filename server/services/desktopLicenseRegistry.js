'use strict';

const crypto = require('node:crypto');
const db = require('../db');

const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAckfonQ2HSDFr7YdIxzL/C+4vKuPOcAhcJUjTh3qGj1U=
-----END PUBLIC KEY-----`;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function validateSignedLicense(keyStr) {
  try {
    const raw = String(keyStr || '').trim();
    if (!raw.startsWith('KYROS2-')) return { valid: false, reason: 'Invalid access token format' };
    const parts = raw.split('-');
    if (parts.length < 4) return { valid: false, reason: 'Invalid access token format' };
    const sigHex = parts[2];
    const payloadB64 = parts.slice(3).join('-');
    if (!/^[0-9a-f]{128}$/i.test(sigHex)) return { valid: false, reason: 'Invalid token signature' };

    const verified = crypto.verify(null, Buffer.from(payloadB64), LICENSE_PUBLIC_KEY, Buffer.from(sigHex, 'hex'));
    if (!verified) return { valid: false, reason: 'Invalid token. Check it and try again.' };

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.app !== 'kyros-studio') return { valid: false, reason: 'This token is not for Kyros Studio' };
    if (payload.type === 'trial' || payload.plan === 'trial' || payload.plan === 'free') {
      return { valid: false, reason: 'Free trial tokens are disabled. Use a paid token.' };
    }
    if (!payload.expiresAt || Date.now() > payload.expiresAt) {
      return { valid: false, reason: `Token expired on ${new Date(payload.expiresAt).toLocaleDateString()}` };
    }
    return {
      valid: true,
      id: String(payload.id || '').slice(0, 80),
      plan: String(payload.plan || 'pro').slice(0, 40),
      type: String(payload.type || 'paid').slice(0, 40),
      expiresAt: Number(payload.expiresAt) || null,
      maxSeats: Number(payload.maxSeats) || 1,
    };
  } catch {
    return { valid: false, reason: 'Invalid access token format' };
  }
}

function activateDesktopLicense({ keyStr, customerEmail, machineFingerprint }) {
  const license = validateSignedLicense(keyStr);
  if (!license.valid) return license;

  const email = normalizeEmail(customerEmail);
  if (!isValidEmail(email)) return { valid: false, reason: 'Enter a valid customer email before activating.' };

  const machine = String(machineFingerprint || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(machine)) return { valid: false, reason: 'Invalid machine fingerprint.' };

  const existing = db.prepare('SELECT customer_email, machine_fingerprint FROM desktop_license_activations WHERE license_id = ?').get(license.id);
  if (existing) {
    if (existing.customer_email !== email) {
      return { valid: false, reason: 'This token is already activated for another customer email.' };
    }
    if (existing.machine_fingerprint !== machine) {
      return { valid: false, reason: 'This token is already activated on another machine.' };
    }
    db.prepare('UPDATE desktop_license_activations SET last_seen_at = datetime(\'now\') WHERE license_id = ?').run(license.id);
    return { valid: true, licenseId: license.id, plan: license.plan, expiresAt: license.expiresAt };
  }

  db.prepare(`
    INSERT INTO desktop_license_activations (license_id, customer_email, machine_fingerprint, plan, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(license.id, email, machine, license.plan, license.expiresAt);
  return { valid: true, licenseId: license.id, plan: license.plan, expiresAt: license.expiresAt };
}

module.exports = {
  activateDesktopLicense,
  validateSignedLicense,
};
