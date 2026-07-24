const express = require('express');
const captionTemplateService = require('../services/captionTemplateService');

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    const list = captionTemplateService.list(req.query.category || undefined);
    res.json({ success: true, data: list });
  } catch (err) { next(err); }
});

router.get('/suggest', (req, res, next) => {
  try {
    const suggestions = captionTemplateService.suggest(
      req.query.category || undefined,
      parseInt(req.query.limit, 10) || 5
    );
    res.json({ success: true, data: suggestions });
  } catch (err) { next(err); }
});

router.get('/:id', (req, res, next) => {
  try {
    const template = captionTemplateService.get(req.params.id);
    res.json({ success: true, data: template });
  } catch (err) { next(err); }
});

router.post('/', (req, res, next) => {
  try {
    const template = captionTemplateService.create(req.body);
    res.status(201).json({ success: true, data: template });
  } catch (err) { next(err); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const template = captionTemplateService.update(req.params.id, req.body);
    res.json({ success: true, data: template });
  } catch (err) { next(err); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const result = captionTemplateService.remove(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.post('/:id/use', (req, res, next) => {
  try {
    captionTemplateService.incrementUsage(req.params.id);
    res.json({ success: true, data: { used: true } });
  } catch (err) { next(err); }
});

module.exports = router;
