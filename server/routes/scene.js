// server/routes/scene.js

const express = require('express');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiService');
const sceneAnalyzer = require('../services/sceneAnalyzer');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const { resolveDimensions } = require('../services/dimensionResolver');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

/**
 * POST /api/scene/analyze
 * Body: { image: "base64string", mimeType: "image/png" }
 */
router.post('/analyze', async (req, res, next) => {
  try {
    const { image, mimeType } = req.body;

    if (!image || typeof image !== 'string') {
      throw new AppError('"image" base64 string is required', 400, 'VALIDATION_ERROR');
    }
    if (!mimeType || typeof mimeType !== 'string') {
      throw new AppError('"mimeType" is required', 400, 'VALIDATION_ERROR');
    }

    // Strip data URI prefix if present
    let base64 = image;
    const dataUriMatch = image.match(/^data:image\/\w+;base64,(.+)$/);
    if (dataUriMatch) base64 = dataUriMatch[1];

    const sceneData = await sceneAnalyzer.analyzeScene(base64, mimeType);

    res.json({ success: true, data: sceneData });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/scene/recreate
 * Body: { sceneData, characterId, activeReferenceIds?, aspectRatio?, resolutionTier? }
 */
router.post('/recreate', async (req, res, next) => {
  try {
    const { sceneData, characterId, activeReferenceIds } = req.body;
    const { aspectRatio, resolutionTier: resolvedResolutionTier, width, height } = resolveDimensions(req.body);
    const allowedResolutions = ['1K', '2K', '4K'];
    const resolutionTier =
      allowedResolutions.includes(req.body.resolutionTier)
        ? req.body.resolutionTier
        : '1K';

    if (!sceneData || typeof sceneData !== 'object') {
      throw new AppError('"sceneData" object is required', 400, 'VALIDATION_ERROR');
    }
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
    }

    const recreationPrompt = sceneAnalyzer.buildRecreationPrompt({
      sceneData,
      characterId,
      activeReferenceIds,
    });

    const apiKey = apiKeyManager.getActiveKey();
    const result = await geminiService.generateImage(apiKey, recreationPrompt, {
      aspectRatio,
      imageSize: resolutionTier,
    });

    // Store in imageStore
    const stored = imageStore.store({
      basePrompt: recreationPrompt,
      characterId,
      activeReferenceIds: activeReferenceIds || null,
      sceneDescription: JSON.stringify(sceneData),
      modelUsed: null,
      seed: null,
      parentImageId: null,
      variationIndex: null,
      image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
      source: 'generate',
    });

    // Save to gallery
    galleryManager.save({
      base64Data: result.image.base64Data,
      mimeType: result.image.mimeType,
      prompt: 'Scene recreation',
      source: 'scene-recreate',
      characterId,
      aspectRatio: aspectRatio || null,
    });

    res.json({
      success: true,
      data: {
        imageId: stored.imageId,
        image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
        text: result.text,
        dimensions: { aspectRatio, resolutionTier: resolvedResolutionTier || resolutionTier, width, height },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
