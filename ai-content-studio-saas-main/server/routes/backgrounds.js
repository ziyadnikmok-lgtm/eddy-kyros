const express = require('express');
const backgroundStore = require('../services/backgroundStore');

const router = express.Router();

// List all backgrounds
router.get('/', (_req, res) => {
  res.json({ success: true, data: backgroundStore.list() });
});

// Upload a new background
router.post('/', (req, res, next) => {
  try {
    const { name, mimeType, base64Data } = req.body || {};
    if (!base64Data) {
      return res.status(400).json({ success: false, error: { message: 'base64Data is required' } });
    }
    const entry = backgroundStore.add({ name: name || 'Untitled', mimeType, base64Data });
    res.status(201).json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
});

// Get background image file (for thumbnail display)
router.get('/:id/image', (req, res) => {
  const file = backgroundStore.getImageFile(req.params.id);
  if (!file) return res.status(404).json({ success: false, error: { message: 'Not found' } });
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(file.filepath);
});

// Delete a background
router.delete('/:id', (req, res, next) => {
  try {
    backgroundStore.remove(req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
