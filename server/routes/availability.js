const express = require('express');
const { checkPostAvailability } = require('../services/instagramAvailabilityService');

const router = express.Router();

router.post('/check', async (req, res, next) => {
  try {
    const { url } = req.body || {};
    const data = await checkPostAvailability(url);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

