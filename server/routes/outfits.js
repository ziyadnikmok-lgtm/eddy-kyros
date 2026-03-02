const express = require('express');
const outfitMemoryService = require('../services/outfitMemoryService');

const router = express.Router();

router.get('/', (_req, res, next) => {
  try {
    const outfits = outfitMemoryService.getAllOutfits();
    res.json({ success: true, data: outfits });
  } catch (err) {
    next(err);
  }
});

router.post('/', (req, res, next) => {
  try {
    const outfit = outfitMemoryService.createOutfit(req.body);
    res.status(201).json({ success: true, data: outfit });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const result = outfitMemoryService.deleteOutfit(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
