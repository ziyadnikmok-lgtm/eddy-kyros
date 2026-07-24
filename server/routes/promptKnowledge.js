const express = require('express');
const promptKnowledgeService = require('../services/promptKnowledgeService');

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    const data = promptKnowledgeService.list({
      character: req.query.character,
      source_type: req.query.source_type,
      mode: req.query.mode,
      field: req.query.field,
      q: req.query.q,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

