const express = require('express');
const outfitMemoryService = require('../services/outfitMemoryService');

const router = express.Router();

/**
 * GET /api/outfits
 * List all saved outfits.
 */
router.get('/', (_req, res, next) => {
  try {
    const outfits = outfitMemoryService.getAllOutfits();
    res.json({ success: true, data: outfits });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/outfits
 * Create an outfit memory record.
 */
router.post('/', (req, res, next) => {
  try {
    const outfit = outfitMemoryService.createOutfit(req.body);
    res.status(201).json({ success: true, data: outfit });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/outfits/:id
 * Delete an outfit memory record by ID.
 */
router.delete('/:id', (req, res, next) => {
  try {
    const result = outfitMemoryService.deleteOutfit(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
