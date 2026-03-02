const express = require('express');
const nicheManager = require('../services/nicheManager');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/', (_req, res, next) => {
  try {
    const niches = nicheManager.listNiches();
    res.json({ success: true, data: niches });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const niche = nicheManager.getNiche(req.params.id);
    res.json({ success: true, data: niche });
  } catch (err) {
    next(err);
  }
});

router.post('/', (req, res, next) => {
  try {
    const niche = nicheManager.createNiche(req.body);
    res.status(201).json({ success: true, data: niche });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', (req, res, next) => {
  try {
    const niche = nicheManager.updateNiche(req.params.id, req.body);
    res.json({ success: true, data: niche });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const result = nicheManager.deleteNiche(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
