const express = require('express');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiBackend');
const sceneAnalyzer = require('../services/sceneAnalyzer');
const referenceManager = require('../services/referenceManager');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const { resolveDimensions } = require('../services/dimensionResolver');
const { buildCharacterReferenceImages } = require('./postClone');
const { AppError } = require('../middleware/errorHandler');
const { requirePlanCapacity } = require('../middleware/planLimits');
const { logUsageEvent, startGenerationRun, finishGenerationRun } = require('../services/eventLogger');
const REALISM_DIRECTIVE = require('../utils/realismDirective');

const router = express.Router();

function requestedProvider(provider) {
  return provider === 'gemini' || provider === 'vertex' || provider === 'auto' ? provider : 'auto';
}

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

router.post('/recreate', requirePlanCapacity(), async (req, res, next) => {
  let runId = null;
  try {
    const {
      sceneData,
      characterId,
      activeReferenceIds,
      masterPromptOverride,
      imageModel,
      sameBackground,
      samePose,
      sameHair,
      sameTattoos,
      provider,
      sourceUrl, // originating IG/TikTok/X post link (if the source frame came from one)
    } = req.body;
    const { aspectRatio, resolutionTier, width, height } = resolveDimensions(req.body);
    const cleanSourceUrl = (typeof sourceUrl === 'string' && sourceUrl.startsWith('http')) ? sourceUrl.slice(0, 2000) : null;

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
      masterPromptOverride,
      sameBackground: !!sameBackground,
      samePose: !!samePose,
      sameHair: !!sameHair,
      sameTattoos: !!sameTattoos,
    });

    const apiKey = apiKeyManager.getActiveKeyOrNull();
    runId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'scene-recreate',
      provider: requestedProvider(provider),
      model: imageModel || null,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.started',
      entityType: 'generation_run',
      entityId: runId,
      source: 'scene-recreate',
      payload: { feature: 'scene-recreate', model: imageModel || null, characterId, provider: requestedProvider(provider) },
    });

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
      provider,
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
      sourceUrl: cleanSourceUrl,
    });

    const galleryEntry = galleryManager.save({
      base64Data: result.image.base64Data,
      mimeType: result.image.mimeType,
      prompt: recreationPrompt,
      source: 'scene-recreate',
      characterId,
      aspectRatio: aspectRatio || null,
      sourceUrl: cleanSourceUrl,
    });

    finishGenerationRun(runId, {
      status: 'succeeded',
      outputCount: 1,
      provider: requestedProvider(provider),
      model: result.modelUsed || imageModel || null,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.succeeded',
      entityType: 'generation_run',
      entityId: runId,
      source: 'scene-recreate',
      payload: { feature: 'scene-recreate', imageId: stored.imageId, galleryId: galleryEntry?.id },
    });

    res.json({
      success: true,
      data: {
        imageId: stored.imageId,
        galleryId: galleryEntry?.id || null,
        image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
        text: result.text,
        dimensions: { aspectRatio, resolutionTier, width, height },
        generatedAt: new Date().toISOString(),
        sourceUrl: cleanSourceUrl,
      },
    });
  } catch (err) {
    finishGenerationRun(runId, {
      status: 'failed',
      outputCount: 0,
      errorCode: err.code || err.name || 'UNKNOWN',
      errorMessage: err.message || 'Scene recreate failed',
      provider: requestedProvider(req.body?.provider),
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.failed',
      entityType: 'generation_run',
      entityId: runId,
      source: 'scene-recreate',
      payload: { feature: 'scene-recreate', errorCode: err.code || err.name, message: err.message },
    });
    next(err);
  }
});

module.exports = router;
