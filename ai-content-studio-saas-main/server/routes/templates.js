const express = require('express');
const templateManager = require('../services/templateManager');

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    const templates = templateManager.list(req.query.page);
    res.json({ success: true, data: templates });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const template = templateManager.get(req.params.id);
    res.json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
});

router.post('/', (req, res, next) => {
  try {
    const template = templateManager.create(req.body);
    res.status(201).json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', (req, res, next) => {
  try {
    const template = templateManager.update(req.params.id, req.body);
    res.json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const result = templateManager.remove(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
