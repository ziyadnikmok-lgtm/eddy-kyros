const express = require('express');
const wavespeedService = require('../services/wavespeedService');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const apiKeyManager = require('../services/apiKeyManager');
const { AppError } = require('../middleware/errorHandler');
const { requirePlanCapacity } = require('../middleware/planLimits');
const log = require('../utils/logger');
const { logUsageEvent, startGenerationRun, finishGenerationRun } = require('../services/eventLogger');

const router = express.Router();

const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3'];

router.post('/', requirePlanCapacity(), async (req, res, next) => {
  let runId = null;
  try {
    const { prompt, aspectRatio, loras } = req.body;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new AppError('A prompt is required', 400, 'VALIDATION_ERROR');
    }

    const finalAspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '1:1';

    const parsedLoras = Array.isArray(loras)
      ? loras.filter((l) => l && typeof l.path === 'string' && l.path.trim())
      : [];

    runId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'nsfw-generate',
      provider: 'wavespeed',
      model: null,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.started',
      entityType: 'generation_run',
      entityId: runId,
      source: 'nsfw-generate',
      payload: { feature: 'nsfw-generate', aspectRatio: finalAspectRatio },
    });

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

    try { apiKeyManager.addExternalSpend(0.01, 'nsfw-image'); } catch (e) { log.warn('nsfw_spend_track_failed', { error: e.message }); }

    finishGenerationRun(runId, {
      status: 'succeeded',
      outputCount: 1,
      provider: 'wavespeed',
      model: result.modelUsed || null,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.succeeded',
      entityType: 'generation_run',
      entityId: runId,
      source: 'nsfw-generate',
      payload: { feature: 'nsfw-generate', imageId: stored.imageId, galleryId: galleryEntry.id },
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
    finishGenerationRun(runId, {
      status: 'failed',
      outputCount: 0,
      errorCode: err.code || err.name || 'UNKNOWN',
      errorMessage: err.message || 'NSFW generation failed',
      provider: 'wavespeed',
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.failed',
      entityType: 'generation_run',
      entityId: runId,
      source: 'nsfw-generate',
      payload: { feature: 'nsfw-generate', errorCode: err.code || err.name, message: err.message },
    });
    next(err);
  }
});

// ── Img2Img variation ──────────────────────────────────────────
router.post('/vary', requirePlanCapacity(), async (req, res, next) => {
  let runId = null;
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

    runId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'nsfw-vary',
      provider: 'wavespeed',
      model: null,
    });

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

    try { apiKeyManager.addExternalSpend(0.01, 'nsfw-image'); } catch (e) { log.warn('nsfw_spend_track_failed', { error: e.message }); }

    finishGenerationRun(runId, {
      status: 'succeeded',
      outputCount: 1,
      provider: 'wavespeed',
      model: result.modelUsed || null,
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
    finishGenerationRun(runId, {
      status: 'failed',
      outputCount: 0,
      errorCode: err.code || err.name || 'UNKNOWN',
      errorMessage: err.message || 'NSFW variation failed',
      provider: 'wavespeed',
    });
    next(err);
  }
});

module.exports = router;
