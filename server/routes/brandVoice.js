const express = require('express');
const brandVoiceManager = require('../services/brandVoiceManager');

const router = express.Router();

router.get('/', (_req, res, next) => {
  try {
    const voice = brandVoiceManager.getBrandVoice();
    res.json({ success: true, data: voice });
  } catch (err) {
    next(err);
  }
});

router.patch('/', (req, res, next) => {
  try {
    const voice = brandVoiceManager.updateBrandVoice(req.body);
    res.json({ success: true, data: voice });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
