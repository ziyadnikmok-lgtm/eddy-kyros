const express = require('express');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiService');
const sceneAnalyzer = require('../services/sceneAnalyzer');
const referenceManager = require('../services/referenceManager');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const { resolveDimensions } = require('../services/dimensionResolver');
const { buildCharacterReferenceImages } = require('./postClone');
const { AppError } = require('../middleware/errorHandler');
const REALISM_DIRECTIVE = require('../utils/realismDirective');

const router = express.Router();

router.post('/analyze', async (req, res, next) => {
  try {
    const { image, mimeType } = req.body;

    if (!image || typeof image !== 'string') {
      throw new AppError('"image" base64 string is required', 400, 'VALIDATION_ERROR');
    }
    if (!mimeType || typeof mimeType !== 'string') {
      throw new AppError('"mimeType" is required', 400, 'VALIDATION_ERROR');
    }

    const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
    if (!ALLOWED_MIME.includes(mimeType)) {
      throw new AppError('mimeType must be image/png, image/jpeg, or image/webp', 400, 'VALIDATION_ERROR');
    }
    if (typeof image === 'string' && image.length > 15_000_000) {
      throw new AppError('Image data too large (max ~10MB)', 413, 'PAYLOAD_TOO_LARGE');
    }

    let base64 = image;
    const dataUriMatch = image.match(/^data:image\/\w+;base64,(.+)$/);
    if (dataUriMatch) base64 = dataUriMatch[1];

    const sceneData = await sceneAnalyzer.analyzeScene(base64, mimeType);

    res.json({ success: true, data: sceneData });
  } catch (err) {
    next(err);
  }
});

router.post('/recreate', async (req, res, next) => {
  try {
    const { sceneData, characterId, activeReferenceIds, imageModel, sameBackground, samePose } = req.body;
    const { aspectRatio, resolutionTier, width, height } = resolveDimensions(req.body);

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
      sameBackground: !!sameBackground,
      samePose: !!samePose,
    });

    const apiKey = apiKeyManager.getActiveKey();
    const activeRefs = referenceManager.getActiveReferences(
      characterId,
      Array.isArray(activeReferenceIds) ? activeReferenceIds : null
    );
    const referenceImages = buildCharacterReferenceImages(characterId, activeRefs);

    const finalPrompt = `${recreationPrompt}\n\n${REALISM_DIRECTIVE}`;
    const result = await geminiService.generateImage(apiKey, finalPrompt, {
      aspectRatio,
      imageSize: resolutionTier,
      referenceImages,
      model: imageModel,
    });

    const stored = imageStore.store({
      basePrompt: recreationPrompt,
      characterId,
      activeReferenceIds: activeReferenceIds || null,
      sceneDescription: JSON.stringify(sceneData),
      modelUsed: result.modelUsed || null,
      seed: null,
      parentImageId: null,
      variationIndex: null,
      image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
      source: 'generate',
    });

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
        dimensions: { aspectRatio, resolutionTier, width, height },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
