const express = require('express');
const router = express.Router();
const { AppError } = require('../middleware/errorHandler');
const { generateSeedDreamEdit } = require('../services/wavespeedService');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const log = require('../utils/logger');

/**
 * POST /api/seed-dream/edit
 * Edit 1–4 images with SeedDream v4.5, preserving character identity.
 *
 * Body: {
 *   images: [{ base64: string, mimeType: string }],  // 1–4 images
 *   prompt: string,
 *   aspectRatio?: string,   // '1:1' | '4:5' | '9:16' | ...
 *   guidanceScale?: number, // 1–10, default 3.5
 *   seed?: number,
 * }
 */
router.post('/edit', async (req, res, next) => {
  try {
    const { images, prompt, aspectRatio, guidanceScale, seed } = req.body;

    if (!Array.isArray(images) || images.length === 0) {
      throw new AppError('images array is required', 400, 'VALIDATION_ERROR');
    }
    if (images.length > 4) {
      throw new AppError('Maximum 4 images allowed', 400, 'VALIDATION_ERROR');
    }
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new AppError('prompt is required', 400, 'VALIDATION_ERROR');
    }
    for (const img of images) {
      if (!img.base64 || !img.mimeType) {
        throw new AppError('Each image must have base64 and mimeType', 400, 'VALIDATION_ERROR');
      }
    }

    log.info('seeddream_edit_req', {
      userId: req.session?.userId,
      imageCount: images.length,
      prompt: prompt.slice(0, 100),
      aspectRatio,
    });

    const result = await generateSeedDreamEdit(images, prompt, {
      aspectRatio: aspectRatio || '1:1',
      guidanceScale: typeof guidanceScale === 'number' ? guidanceScale : 3.5,
      seed: typeof seed === 'number' ? seed : -1,
    });

    // Persist each edited image to the gallery and session imageStore
    const savedImages = await Promise.all(result.images.map(async (img, i) => {
      const stored = imageStore.store({
        basePrompt: prompt.trim(),
        modelUsed: result.modelUsed,
        image: { mimeType: img.mimeType, base64Data: img.base64Data },
        source: 'generate', // fallback source name allowed in imageStore
      });

      const galleryEntry = galleryManager.save({
        base64Data: img.base64Data,
        mimeType: img.mimeType,
        prompt: prompt.trim(),
        source: 'generate',
        aspectRatio: aspectRatio || '1:1',
        tags: ['seed-dream-edit'],
      });

      return {
        imageId: stored.imageId,
        galleryId: galleryEntry.id,
        mimeType: img.mimeType,
        base64Data: img.base64Data,
      };
    }));

    res.json({
      success: true,
      data: {
        images: savedImages,
        modelUsed: result.modelUsed,
        prompt: prompt.trim(),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
