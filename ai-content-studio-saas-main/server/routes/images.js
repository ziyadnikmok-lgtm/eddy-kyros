const express = require('express');
const imageStore = require('../services/imageStore');

const router = express.Router();

router.get('/', (_req, res, next) => {
  try {
    const images = imageStore.list();
    res.json({ success: true, data: images });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const image = imageStore.get(req.params.id);
    res.json({ success: true, data: image });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/children', (req, res, next) => {
  try {
    const children = imageStore.getChildren(req.params.id);
    res.json({ success: true, data: children });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
