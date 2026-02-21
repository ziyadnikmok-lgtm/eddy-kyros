const express = require('express');
const postCloneRoute = require('./postClone');

const router = express.Router();

/**
 * POST /api/profile-clone
 * Body: { profileUrl, characterId, postLimit, mode: "exact" | "creative", apifyApiKey? }
 */
router.post('/', async (req, res, next) => {
  try {
    const { profileUrl, characterId, postLimit = 5, mode = 'exact', apifyApiKey } = req.body || {};
    const data = await postCloneRoute.handleClone({
      url: profileUrl,
      characterId,
      mode: (typeof mode === 'string' ? mode.trim().toLowerCase() : 'exact') || 'exact',
      apifyApiKey,
      postLimit: Math.max(1, Math.min(20, Number(postLimit) || 5)),
      profileMode: true,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

