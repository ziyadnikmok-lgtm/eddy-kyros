// server/routes/niches.js

const express = require('express');
const nicheManager = require('../services/nicheManager');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

/**
 * GET /api/niches
 * List all niches (built-in + custom).
 */
router.get('/', (_req, res, next) => {
  try {
    const niches = nicheManager.listNiches();
    res.json({ success: true, data: niches });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/niches/:id
 * Get a single niche by ID.
 */
router.get('/:id', (req, res, next) => {
  try {
    const niche = nicheManager.getNiche(req.params.id);
    res.json({ success: true, data: niche });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/niches
 * Create a custom niche.
 * Body: { name, tone, styleRules: [], emotionalTriggers: [], hookStrategy, ctaStyle }
 */
router.post('/', (req, res, next) => {
  try {
    const niche = nicheManager.createNiche(req.body);
    res.status(201).json({ success: true, data: niche });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/niches/:id
 * Update a niche (partial update).
 */
router.patch('/:id', (req, res, next) => {
  try {
    const niche = nicheManager.updateNiche(req.params.id, req.body);
    res.json({ success: true, data: niche });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/niches/:id
 * Delete a niche.
 */
router.delete('/:id', (req, res, next) => {
  try {
    const result = nicheManager.deleteNiche(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
