// server/routes/images.js

const express = require('express');
const imageStore = require('../services/imageStore');

const router = express.Router();

/**
 * GET /api/images
 * List all stored image metadata (no base64 data — lightweight).
 */
router.get('/', (_req, res, next) => {
  try {
    const images = imageStore.list();
    res.json({ success: true, data: images });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/images/:id
 * Get full image metadata + base64 data for a single image.
 */
router.get('/:id', (req, res, next) => {
  try {
    const image = imageStore.get(req.params.id);
    res.json({ success: true, data: image });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/images/:id/children
 * Get all direct children (tweak variations) of an image.
 * Useful for building carousel views.
 */
router.get('/:id/children', (req, res, next) => {
  try {
    const children = imageStore.getChildren(req.params.id);
    res.json({ success: true, data: children });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
