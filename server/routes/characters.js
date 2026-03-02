const express = require('express');
const referenceManager = require('../services/referenceManager');
const { AppError } = require('../middleware/errorHandler');
const { parseImageUpload } = require('../middleware/upload');

const router = express.Router();

router.post('/', parseImageUpload, (req, res, next) => {
  try {
    const { name, masterPrompt } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new AppError('"name" is required', 400, 'VALIDATION_ERROR');
    }
    if (!masterPrompt || typeof masterPrompt !== 'string' || masterPrompt.trim().length === 0) {
      throw new AppError('"masterPrompt" is required', 400, 'VALIDATION_ERROR');
    }

    const character = referenceManager.createCharacter(name, masterPrompt, {
      buffer: req.imageUpload.buffer,
      mimeType: req.imageUpload.mimeType,
      originalName: req.imageUpload.originalName,
    });

    res.status(201).json({ success: true, data: character });
  } catch (err) {
    next(err);
  }
});

router.get('/', (_req, res, next) => {
  try {
    const characters = referenceManager.listCharacters();
    res.json({ success: true, data: characters });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const character = referenceManager.getCharacterSafe(req.params.id);
    res.json({ success: true, data: character });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', (req, res, next) => {
  try {
    const { masterPrompt } = req.body;
    const character = referenceManager.updateMasterPrompt(req.params.id, masterPrompt);
    res.json({ success: true, data: character });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const result = referenceManager.deleteCharacter(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/image', (req, res, next) => {
  try {
    const { buffer, mimeType } = referenceManager.getPrimaryImage(req.params.id);
    res.set('Content-Type', mimeType);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/primary-images/:index', (req, res, next) => {
  try {
    const images = referenceManager.getPrimaryImages(req.params.id);
    const idx = parseInt(req.params.index, 10);
    if (isNaN(idx) || idx < 0 || idx >= images.length) {
      throw new AppError('Image index out of range', 404, 'NOT_FOUND');
    }
    res.set('Content-Type', images[idx].mimeType);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(images[idx].buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/primary-images', parseImageUpload, (req, res, next) => {
  try {
    const character = referenceManager.addPrimaryImage(req.params.id, {
      buffer: req.imageUpload.buffer,
      mimeType: req.imageUpload.mimeType,
      originalName: req.imageUpload.originalName,
    });
    res.status(201).json({ success: true, data: character });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/primary-images/:index', (req, res, next) => {
  try {
    const idx = parseInt(req.params.index, 10);
    if (isNaN(idx)) {
      throw new AppError('Invalid image index', 400, 'VALIDATION_ERROR');
    }
    const character = referenceManager.removePrimaryImage(req.params.id, idx);
    res.json({ success: true, data: character });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/references', parseImageUpload, (req, res, next) => {
  try {
    const { category, overridePrompt } = req.body;

    const reference = referenceManager.addReference(
      req.params.id,
      {
        buffer: req.imageUpload.buffer,
        mimeType: req.imageUpload.mimeType,
        originalName: req.imageUpload.originalName,
      },
      category,
      overridePrompt
    );

    res.status(201).json({ success: true, data: reference });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/references/:refId/toggle', (req, res, next) => {
  try {
    const result = referenceManager.toggleReference(req.params.id, req.params.refId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/references/:refId', (req, res, next) => {
  try {
    const result = referenceManager.removeReference(req.params.id, req.params.refId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/references/:refId/image', (req, res, next) => {
  try {
    const { buffer, mimeType } = referenceManager.getReferenceImage(req.params.id, req.params.refId);
    res.set('Content-Type', mimeType);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
