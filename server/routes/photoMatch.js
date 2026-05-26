'use strict';
const express = require('express');
const sharp = require('sharp');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiBackend');
const sceneAnalyzer = require('../services/sceneAnalyzer');
const referenceManager = require('../services/referenceManager');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const log = require('../utils/logger');
const { logUsageEvent, startGenerationRun, finishGenerationRun } = require('../services/eventLogger');
const { resolveDimensions } = require('../services/dimensionResolver');
const { buildCharacterReferenceImages } = require('./postClone');
const { AppError } = require('../middleware/errorHandler');
const { requirePlanCapacity } = require('../middleware/planLimits');
const REALISM_DIRECTIVE = require('../utils/realismDirective');

const router = express.Router();
const PHOTO_MATCH_REF_MAX_DIMENSION = 1024;
const ANALYSIS_FALLBACK_CODES = new Set(['GEMINI_TRANSIENT', 'GEMINI_ERROR', 'PARSE_ERROR', 'GENERATION_EMPTY']);

function bgStrengthInstruction(strength) {
  if (strength >= 85) return 'EXACTLY REPLICATE the background: identical environment, same location, same colors, same lighting conditions, same depth and distance of background elements';
  if (strength >= 60) return 'closely match the background environment: same type of location, very similar colors and lighting, keep most background elements';
  if (strength >= 35) return 'use a similar background and environment to the reference image';
  return 'take loose inspiration from the background setting only';
}

function poseStrengthInstruction(strength) {
  if (strength >= 85) return 'EXACTLY REPLICATE the body pose: identical stance, same weight distribution, same arm position, same hand placement, same head angle and tilt';
  if (strength >= 60) return 'closely match the body pose and stance from the reference image';
  if (strength >= 35) return 'use a similar body position and pose to the reference';
  return 'take loose inspiration from the pose only, feel free to adapt it';
}

async function optimizeSourceImage(base64Data, mimeType) {
  if (!base64Data || typeof base64Data !== 'string') return null;
  if (!mimeType || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) return null;
  try {
    const resized = await sharp(Buffer.from(base64Data, 'base64'))
      .rotate()
      .resize(PHOTO_MATCH_REF_MAX_DIMENSION, PHOTO_MATCH_REF_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { mimeType: 'image/jpeg', base64Data: resized.toString('base64') };
  } catch {
    return { mimeType, base64Data };
  }
}

// POST /api/photo-match/recreate
router.post('/recreate', requirePlanCapacity(), async (req, res, next) => {
  let runId = null;
  try {
    const {
      image, mimeType, characterId, activeReferenceIds,
      bgStrength = 80, poseStrength = 80, imageModel, matchMode,
      varyBackground = false,
      provider, // 'gemini' | 'vertex' — forces provider override
    } = req.body;
    const { aspectRatio, resolutionTier, width, height } = resolveDimensions(req.body);

    if (!image || typeof image !== 'string') throw new AppError('"image" base64 string is required', 400, 'VALIDATION_ERROR');
    if (!mimeType || typeof mimeType !== 'string') throw new AppError('"mimeType" is required', 400, 'VALIDATION_ERROR');
    if (!characterId || typeof characterId !== 'string') throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');

    const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
    if (!ALLOWED_MIME.includes(mimeType)) throw new AppError('mimeType must be image/png, image/jpeg, or image/webp', 400, 'VALIDATION_ERROR');
    if (image.length > 15_000_000) throw new AppError('Image data too large (max ~10MB)', 413, 'PAYLOAD_TOO_LARGE');

    let base64 = image;
    const dataUriMatch = image.match(/^data:image\/\w+;base64,(.+)$/);
    if (dataUriMatch) base64 = dataUriMatch[1];

    const exactMode = matchMode === 'exact' || req.body?.exactRecreate === true;
    const bg = exactMode ? 100 : Math.max(0, Math.min(100, Number(bgStrength) || 80));
    const pose = exactMode ? 100 : Math.max(0, Math.min(100, Number(poseStrength) || 80));

    // Analyze the scene automatically
    let sceneData = {};
    try {
      sceneData = await sceneAnalyzer.analyzeScene(base64, mimeType);
    } catch (err) {
      if (!ANALYSIS_FALLBACK_CODES.has(err?.code)) throw err;
      log.warn('photo_match_scene_analysis_failed', {
        code: err.code || 'UNKNOWN',
        message: err.message,
        characterId,
      });
      sceneData = {};
    }

    // Get character and references
    const character = referenceManager.getCharacter(characterId);
    const refIds = Array.isArray(activeReferenceIds) ? activeReferenceIds : null;
    const activeRefs = referenceManager.getActiveReferences(characterId, refIds);
    const referenceImages = buildCharacterReferenceImages(characterId, activeRefs);

    // Optimize and include the uploaded source image as a reference
    const sourceImage = await optimizeSourceImage(base64, mimeType);
    if (sourceImage) {
      referenceImages.push(sourceImage);
    }

    // Build strength-aware prompt
    const bgInstruction = bgStrengthInstruction(bg);
    const poseInstruction = poseStrengthInstruction(pose);

    const sceneParts = [];
    if (sceneData.environment) sceneParts.push(`Environment: ${sceneData.environment}`);
    if (sceneData.lighting)     sceneParts.push(`Lighting: ${sceneData.lighting}`);
    if (sceneData.camera)       sceneParts.push(`Camera: ${sceneData.camera}`);
    if (sceneData.composition)  sceneParts.push(`Composition: ${sceneData.composition}`);
    if (sceneData.mood)         sceneParts.push(`Mood: ${sceneData.mood}`);
    if (sceneData.pose)         sceneParts.push(`Pose reference: ${sceneData.pose}`);
    if (sceneData.expression)   sceneParts.push(`Expression: ${sceneData.expression}`);
    if (sceneData.outfit)       sceneParts.push(`Outfit: ${sceneData.outfit}`);

    const prompt = [
      exactMode
        ? `Exact photo match recreation of ${character.name}. Recreate the uploaded source photo as closely as possible while preserving ${character.name}'s identity from the character references.`
        : `Photo match recreation of ${character.name}. Match the uploaded source photo's scene, outfit, pose, and background while preserving ${character.name}'s identity.`,
      '',
      '[BACKGROUND — strength ' + bg + '%]',
      bgInstruction + '.',
      '',
      '[POSE — strength ' + pose + '%]',
      poseInstruction + '.',
      '',
      '[SCENE ANALYSIS]',
      ...sceneParts,
      '',
      varyBackground && !exactMode
        ? [
            'BACKGROUND VARIATION: Keep the same location type, but shift lighting mood slightly, add or change minor background details, and make it feel like a different moment in the same place.',
          ].join('\n')
        : null,
      varyBackground && !exactMode ? '' : null,
      '[IDENTITY]',
      character.masterPrompt || '',
      '',
      'Return exactly one image. No text.',
      REALISM_DIRECTIVE,
    ].filter((s) => s != null).join('\n');

    const apiKey = apiKeyManager.getActiveKeyOrNull();
    runId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'photo-match',
      provider: provider || 'gemini',
      model: imageModel || null,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.started',
      entityType: 'generation_run',
      entityId: runId,
      source: 'photo-match',
      payload: { feature: 'photo-match', model: imageModel || null, characterId, provider: provider || 'auto' },
    });

    const result = await geminiService.generateImage(apiKey, prompt, {
      aspectRatio,
      imageSize: resolutionTier,
      referenceImages,
      model: imageModel,
      characterId,
      provider,
    });

    const stored = imageStore.store({
      basePrompt: prompt,
      characterId,
      activeReferenceIds: activeReferenceIds || null,
      sceneDescription: JSON.stringify(sceneData),
      modelUsed: result.modelUsed || null,
      seed: null,
      parentImageId: null,
      variationIndex: null,
      image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
      source: 'photo-match',
    });

    const galleryEntry = galleryManager.save({
      base64Data: result.image.base64Data,
      mimeType: result.image.mimeType,
      prompt: prompt,
      source: 'photo-match',
      characterId,
      aspectRatio: aspectRatio || null,
    });

    finishGenerationRun(runId, {
      status: 'succeeded',
      outputCount: 1,
      provider: provider || 'gemini',
      model: result.modelUsed || imageModel || null,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.succeeded',
      entityType: 'generation_run',
      entityId: runId,
      source: 'photo-match',
      payload: { feature: 'photo-match', imageId: stored.imageId, galleryId: galleryEntry?.id },
    });

    res.json({
      success: true,
      data: {
        imageId: stored.imageId,
        image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
        sceneData,
        dimensions: { aspectRatio, resolutionTier, width, height },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    finishGenerationRun(runId, {
      status: 'failed',
      outputCount: 0,
      errorCode: err.code || err.name || 'UNKNOWN',
      errorMessage: err.message || 'Photo match failed',
      provider: req.body?.provider || 'gemini',
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.failed',
      entityType: 'generation_run',
      entityId: runId,
      source: 'photo-match',
      payload: { feature: 'photo-match', errorCode: err.code || err.name, message: err.message },
    });
    next(err);
  }
});

module.exports = router;
