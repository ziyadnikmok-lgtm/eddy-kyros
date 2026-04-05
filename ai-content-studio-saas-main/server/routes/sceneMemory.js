const express = require('express');
const sceneMemoryService = require('../services/sceneMemoryService');

const router = express.Router();

router.get('/', (_req, res, next) => {
  try {
    const scenes = sceneMemoryService.getAllScenes();
    res.json({ success: true, data: scenes });
  } catch (err) {
    next(err);
  }
});

router.post('/', (req, res, next) => {
  try {
    const scene = sceneMemoryService.createScene(req.body);
    res.status(201).json({ success: true, data: scene });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const result = sceneMemoryService.deleteScene(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
