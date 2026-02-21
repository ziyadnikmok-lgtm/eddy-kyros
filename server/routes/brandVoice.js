// server/routes/brandVoice.js

const express = require('express');
const brandVoiceManager = require('../services/brandVoiceManager');

const router = express.Router();

/**
 * GET /api/brand-voice
 * Get the current brand voice profile.
 */
router.get('/', (_req, res, next) => {
  try {
    const voice = brandVoiceManager.getBrandVoice();
    res.json({ success: true, data: voice });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/brand-voice
 * Update the brand voice profile (partial update).
 * Body: { writingStyleDescription?, vocabularyPreferences?, emojiFrequency?, forbiddenWords? }
 */
router.patch('/', (req, res, next) => {
  try {
    const voice = brandVoiceManager.updateBrandVoice(req.body);
    res.json({ success: true, data: voice });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
