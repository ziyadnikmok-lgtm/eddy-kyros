#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');

const privateKey = process.env.KYROS_LICENSE_PRIVATE_KEY;
if (!privateKey) {
  console.error('Set KYROS_LICENSE_PRIVATE_KEY to the Ed25519 private key before generating paid tokens.');
  process.exit(1);
}

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const idx = args.indexOf(name);
  return idx === -1 ? fallback : args[idx + 1];
}

const plan = arg('--plan', 'pro');
const days = Number.parseInt(arg('--days', '30'), 10);
const issuedTo = arg('--to', 'customer');
const maxSeats = Number.parseInt(arg('--seats', '1'), 10);

if (!Number.isSafeInteger(days) || days <= 0) throw new Error('--days must be a positive number');
if (!Number.isSafeInteger(maxSeats) || maxSeats <= 0) throw new Error('--seats must be a positive number');
if (plan === 'free' || plan === 'trial') throw new Error('Kyros app tokens are paid-only. Use --plan pro, agency, or owner.');

const issuedAt = Date.now();
const expiresAt = issuedAt + days * 24 * 60 * 60 * 1000;
const id = crypto.randomBytes(4).toString('hex').toUpperCase();
const payload = JSON.stringify({ app: 'kyros-studio', type: 'paid', plan, maxSeats, issuedTo, issuedAt, expiresAt, id });
const payloadB64 = Buffer.from(payload).toString('base64url');
const sig = crypto.sign(null, Buffer.from(payloadB64), privateKey).toString('hex').toUpperCase();
const prefix = `${days >= 365 ? '1Y' : '30'}${plan === 'agency' ? 'AG' : plan === 'owner' ? 'OW' : 'PR'}`;
const key = `KYROS2-${prefix}-${sig}-${payloadB64}`;

console.log('');
console.log('Kyros Studio paid access token');
console.log(`Plan: ${plan}`);
console.log(`Seats: ${maxSeats}`);
console.log(`Issued to: ${issuedTo}`);
console.log(`Expires: ${new Date(expiresAt).toISOString().slice(0, 10)} (${days} days)`);
console.log(`ID: ${id}`);
console.log(`Token: ${key}`);
console.log('');
