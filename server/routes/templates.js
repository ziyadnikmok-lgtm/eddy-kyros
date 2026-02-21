// server/routes/templates.js

const express = require('express');
const templateManager = require('../services/templateManager');

const router = express.Router();

/**
 * GET /api/templates
 * List templates, optionally filtered by page (?page=generate|batch).
 */
router.get('/', (req, res, next) => {
  try {
    const templates = templateManager.list(req.query.page);
    res.json({ success: true, data: templates });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/templates/:id
 * Get a single template.
 */
router.get('/:id', (req, res, next) => {
  try {
    const template = templateManager.get(req.params.id);
    res.json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/templates
 * Create a new template.
 * Body: { name, page: 'generate'|'batch', config: {...} }
 */
router.post('/', (req, res, next) => {
  try {
    const template = templateManager.create(req.body);
    res.status(201).json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/templates/:id
 * Update a template (name and/or config).
 */
router.patch('/:id', (req, res, next) => {
  try {
    const template = templateManager.update(req.params.id, req.body);
    res.json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/templates/:id
 * Delete a template.
 */
router.delete('/:id', (req, res, next) => {
  try {
    const result = templateManager.remove(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
