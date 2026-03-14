const express = require('express');
const wavespeedService = require('../services/wavespeedService');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3'];

router.post('/', async (req, res, next) => {
  try {
    const { prompt, aspectRatio, loras } = req.body;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new AppError('A prompt is required', 400, 'VALIDATION_ERROR');
    }

    const finalAspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '1:1';

    const parsedLoras = Array.isArray(loras)
      ? loras.filter((l) => l && typeof l.path === 'string' && l.path.trim())
      : [];

    const result = await wavespeedService.generateImage(prompt.trim(), {
      aspectRatio: finalAspectRatio,
      loras: parsedLoras,
    });

    const stored = imageStore.store({
      basePrompt: prompt.trim(),
      characterId: null,
      activeReferenceIds: null,
      sceneDescription: prompt.trim(),
      modelUsed: result.modelUsed || null,
      seed: null,
      parentImageId: null,
      variationIndex: null,
      image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
      source: 'nsfw-generate',
    });

    const galleryEntry = galleryManager.save({
      base64Data: result.image.base64Data,
      mimeType: result.image.mimeType,
      prompt: prompt.trim(),
      source: 'nsfw-generate',
      characterId: null,
      aspectRatio: finalAspectRatio,
      seed: null,
      tags: ['nsfw', 'wavespeed'],
    });

    res.json({
      success: true,
      data: {
        imageId: stored.imageId,
        galleryId: galleryEntry.id,
        image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
        aspectRatio: finalAspectRatio,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Img2Img variation ──────────────────────────────────────────
router.post('/vary', async (req, res, next) => {
  try {
    const { imageBase64, mimeType, prompt, aspectRatio, strength, loras } = req.body;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new AppError('A prompt is required', 400, 'VALIDATION_ERROR');
    }
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new AppError('A source image (imageBase64) is required', 400, 'VALIDATION_ERROR');
    }

    const finalAspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '1:1';
    const parsedLoras = Array.isArray(loras)
      ? loras.filter((l) => l && typeof l.path === 'string' && l.path.trim())
      : [];

    const result = await wavespeedService.generateImg2Img(
      imageBase64,
      mimeType || 'image/png',
      prompt.trim(),
      {
        aspectRatio: finalAspectRatio,
        strength: typeof strength === 'number' ? strength : 0.6,
        loras: parsedLoras,
      }
    );

    const stored = imageStore.store({
      basePrompt: prompt.trim(),
      characterId: null,
      activeReferenceIds: null,
      sceneDescription: prompt.trim(),
      modelUsed: result.modelUsed || null,
      seed: null,
      parentImageId: null,
      variationIndex: null,
      image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
      source: 'nsfw-generate',
    });

    const galleryEntry = galleryManager.save({
      base64Data: result.image.base64Data,
      mimeType: result.image.mimeType,
      prompt: prompt.trim(),
      source: 'nsfw-generate',
      characterId: null,
      aspectRatio: finalAspectRatio,
      seed: null,
      tags: ['nsfw', 'wavespeed', 'variation'],
    });

    res.json({
      success: true,
      data: {
        imageId: stored.imageId,
        galleryId: galleryEntry.id,
        image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
        aspectRatio: finalAspectRatio,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
