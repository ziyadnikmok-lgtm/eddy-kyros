'use strict';
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

function bgStrengthInstruction(strength) {
  if (strength >= 85) return 'EXACTLY REPLICATE the background: identical environment, same location, same colors, same lighting conditions, same depth and distance of background elements — keep the background pixel-perfect';
  if (strength >= 60) return 'closely match the background environment: same type of location, very similar colors and lighting, keep most background elements';
  if (strength >= 35) return 'use a similar background and environment to the reference image';
  return 'take loose inspiration from the background setting only';
}

function poseStrengthInstruction(strength) {
  if (strength >= 85) return 'EXACTLY REPLICATE the body pose: identical stance, same weight distribution, same arm position, same hand placement, same head angle and tilt — mirror the pose precisely';
  if (strength >= 60) return 'closely match the body pose and stance from the reference image';
  if (strength >= 35) return 'use a similar body position and pose to the reference';
  return 'take loose inspiration from the pose only, feel free to adapt it';
}

// POST /api/photo-match/recreate
router.post('/recreate', async (req, res, next) => {
  try {
    const {
      image, mimeType, characterId, activeReferenceIds,
      bgStrength = 80, poseStrength = 80, imageModel,
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

    const bg = Math.max(0, Math.min(100, Number(bgStrength) || 80));
    const pose = Math.max(0, Math.min(100, Number(poseStrength) || 80));

    // Analyze the scene automatically
    const sceneData = await sceneAnalyzer.analyzeScene(base64, mimeType);

    // Get character and references
    const character = referenceManager.getCharacter(characterId);
    const refIds = Array.isArray(activeReferenceIds) ? activeReferenceIds : null;
    const activeRefs = referenceManager.getActiveReferences(characterId, refIds);
    const referenceImages = buildCharacterReferenceImages(characterId, activeRefs);

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
      `Photo match recreation of ${character.name}.`,
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
      '[IDENTITY]',
      character.masterPrompt || '',
      '',
      REALISM_DIRECTIVE,
    ].filter(s => s !== undefined).join('\n');

    const apiKey = apiKeyManager.getActiveKey();
    const result = await geminiService.generateImage(apiKey, prompt, {
      aspectRatio,
      imageSize: resolutionTier,
      referenceImages,
      model: imageModel,
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

    galleryManager.save({
      base64Data: result.image.base64Data,
      mimeType: result.image.mimeType,
      prompt: 'Photo match',
      source: 'photo-match',
      characterId,
      aspectRatio: aspectRatio || null,
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
    next(err);
  }
});

module.exports = router;
