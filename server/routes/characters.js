// server/routes/characters.js

const express = require('express');
const referenceManager = require('../services/referenceManager');
const { AppError } = require('../middleware/errorHandler');
const { parseImageUpload } = require('../middleware/upload');

const router = express.Router();

// =========================================================================
// Character CRUD
// =========================================================================

/**
 * POST /api/characters
 * Create a new character.
 * Body (JSON): {
 *   name: string,
 *   masterPrompt: string,
 *   image: string (base64 or data URI),
 *   mimeType?: string,
 *   imageName?: string
 * }
 */
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

/**
 * GET /api/characters
 * List all characters.
 */
router.get('/', (_req, res, next) => {
  try {
    const characters = referenceManager.listCharacters();
    res.json({ success: true, data: characters });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/characters/:id
 * Get a single character by ID.
 */
router.get('/:id', (req, res, next) => {
  try {
    const character = referenceManager.getCharacterSafe(req.params.id);
    res.json({ success: true, data: character });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/characters/:id
 * Update master prompt.
 */
router.patch('/:id', (req, res, next) => {
  try {
    const { masterPrompt } = req.body;
    const character = referenceManager.updateMasterPrompt(req.params.id, masterPrompt);
    res.json({ success: true, data: character });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/characters/:id
 * Delete a character and all its references.
 */
router.delete('/:id', (req, res, next) => {
  try {
    const result = referenceManager.deleteCharacter(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// Image serving (safe — no internal paths exposed)
// =========================================================================

/**
 * GET /api/characters/:id/image
 * Serve the first primary image for a character.
 */
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

/**
 * GET /api/characters/:id/primary-images/:index
 * Serve a specific primary image by index.
 */
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

/**
 * POST /api/characters/:id/primary-images
 * Add an additional primary reference image.
 */
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

/**
 * DELETE /api/characters/:id/primary-images/:index
 * Remove a primary image by index.
 */
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

// =========================================================================
// Reference CRUD
// =========================================================================

/**
 * POST /api/characters/:id/references
 * Add a reference image to a character.
 * Body (JSON): {
 *   category: string,
 *   overridePrompt: string,
 *   image: string (base64 or data URI),
 *   mimeType?: string,
 *   name?: string
 * }
 */
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

/**
 * PATCH /api/characters/:id/references/:refId/toggle
 * Toggle a reference's active state.
 */
router.patch('/:id/references/:refId/toggle', (req, res, next) => {
  try {
    const result = referenceManager.toggleReference(req.params.id, req.params.refId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/characters/:id/references/:refId
 * Remove a reference.
 */
router.delete('/:id/references/:refId', (req, res, next) => {
  try {
    const result = referenceManager.removeReference(req.params.id, req.params.refId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/characters/:id/references/:refId/image
 * Serve a reference image.
 */
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
