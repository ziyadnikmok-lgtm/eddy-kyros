'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAIBkoWCq2TCMU+P/+gyOGPLGmTRO3g4zWZDDhootN55c=
-----END PUBLIC KEY-----`;

function getLicenseFile(app) {
  return path.join(app.getPath('userData'), 'license.json');
}

function getMachineFingerprint() {
  const raw = [os.hostname(), os.platform(), os.arch(), os.userInfo().username].join('::');
  return crypto.createHash('sha256').update(`kyros-studio::${raw}`).digest('hex');
}

function publicLicenseInfo(info) {
  if (!info) return null;
  return {
    valid: !!info.valid,
    reason: info.reason || '',
    id: info.id || '',
    plan: info.plan || '',
    type: info.type || '',
    maxSeats: info.maxSeats || 1,
    expiresAt: info.expiresAt || null,
    expiresDate: info.expiresDate || '',
    daysLeft: info.daysLeft || 0,
    machineLocked: info.machineLocked !== false,
    ownerDev: !!info.ownerDev,
  };
}

function validateKey(keyStr) {
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

    const now = Date.now();
    if (!payload.expiresAt || now > payload.expiresAt) {
      return { valid: false, reason: `Token expired on ${new Date(payload.expiresAt).toLocaleDateString()}` };
    }

    const daysLeft = Math.ceil((payload.expiresAt - now) / (24 * 60 * 60 * 1000));
    return {
      valid: true,
      type: payload.type || 'paid',
      plan: payload.plan || 'pro',
      maxSeats: payload.maxSeats || 1,
      daysLeft,
      expiresAt: payload.expiresAt,
      expiresDate: new Date(payload.expiresAt).toLocaleDateString(),
      id: payload.id,
      issuedTo: payload.issuedTo || '',
      keyStr: raw,
    };
  } catch {
    return { valid: false, reason: 'Invalid access token format' };
  }
}

function saveLicense(app, info) {
  const file = getLicenseFile(app);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    keyStr: info.keyStr,
    id: info.id,
    plan: info.plan,
    type: info.type,
    expiresAt: info.expiresAt,
    activatedAt: Date.now(),
    machineFingerprint: getMachineFingerprint(),
  }, null, 2));
}

function loadSavedLicense(app) {
  try {
    const file = getLicenseFile(app);
    if (!fs.existsSync(file)) return null;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!saved?.keyStr) return null;

    if (saved.machineFingerprint && saved.machineFingerprint !== getMachineFingerprint()) {
      return { valid: false, reason: 'Token is locked to a different machine. Contact support to transfer it.', machineMismatch: true };
    }

    return validateKey(saved.keyStr);
  } catch {
    return null;
  }
}

function clearLicense(app) {
  try { fs.unlinkSync(getLicenseFile(app)); } catch {}
}

module.exports = {
  clearLicense,
  getMachineFingerprint,
  loadSavedLicense,
  publicLicenseInfo,
  saveLicense,
  validateKey,
};
