'use strict';
const express = require('express');
const fs = require('node:fs');
const { AppError } = require('../middleware/errorHandler');
const { requireAdmin } = require('../middleware/requireAuth');
const apiKeyManager = require('../services/apiKeyManager');
const { startSession, getSession } = require('../services/xReplyService');

const router = express.Router();

// All x-reply endpoints are admin-only
router.use(requireAdmin);

// POST /api/x-reply/start
router.post('/start', async (req, res) => {
  const { cookies, accounts, imageFolder, tone, attachImageChance } = req.body;
  const userId = req.session.userId;

  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
    throw new AppError('X cookies are required to start a session', 400, 'MISSING_COOKIES');
  }

  if (!accounts || !Array.isArray(accounts) || accounts.filter((a) => a.trim()).length === 0) {
    throw new AppError('At least one target account is required', 400, 'MISSING_ACCOUNTS');
  }

  if (imageFolder && imageFolder.trim()) {
    if (!fs.existsSync(imageFolder.trim())) {
      throw new AppError(`Image folder not found: ${imageFolder}`, 400, 'INVALID_FOLDER');
    }
  }

  const apiKey = apiKeyManager.getActiveKeyOrNull();

  const cleanAccounts = accounts.map((a) => a.replace(/^@/, '').trim()).filter(Boolean);

  startSession(userId, {
    cookies,
    accounts: cleanAccounts,
    imageFolder: imageFolder?.trim() || null,
    geminiApiKey: apiKey,
    tone: tone?.trim() || 'engaging and friendly',
    attachImageChance: typeof attachImageChance === 'number' ? attachImageChance : 0.5,
  });

  res.json({ data: { ok: true } });
});

// POST /api/x-reply/stop
router.post('/stop', (req, res) => {
  const session = getSession(req.session.userId);
  if (session && session.status === 'running') {
    session.stop();
  }
  res.json({ data: { ok: true } });
});

// GET /api/x-reply/status
router.get('/status', (req, res) => {
  const session = getSession(req.session.userId);
  if (!session) {
    return res.json({
      data: {
        status: 'idle',
        repliesCount: 0,
        maxReplies: 15,
        elapsedMs: 0,
        maxMs: 3600000,
        log: [],
        startedAt: null,
        stoppedAt: null,
      },
    });
  }
  res.json({ data: session.getState() });
});

module.exports = router;
