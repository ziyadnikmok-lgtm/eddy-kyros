const express = require('express');
const { AppError } = require('../middleware/errorHandler');
const REALISM_DIRECTIVE = require('../utils/realismDirective');
const referenceManager = require('../services/referenceManager');
const sceneAnalyzer = require('../services/sceneAnalyzer');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiService');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const reelReferenceService = require('../services/reelReferenceService');
const { buildCharacterReferenceImages } = require('./postClone');

const router = express.Router();

function normalizeRefIds(activeReferenceIds) {
  return Array.isArray(activeReferenceIds)
    ? activeReferenceIds.filter((id) => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
    : null;
}

async function analyzeAndRecreateFrame({ frame, characterId, activeReferenceIds, apiKey, referenceImages, imageModel }) {
  const sceneData = await sceneAnalyzer.analyzeScene(frame.base64Data, frame.mimeType);
  const prompt = sceneAnalyzer.buildRecreationPrompt({
    sceneData,
    characterId,
    activeReferenceIds,
  });

  const finalPrompt = `${prompt}\n\n${REALISM_DIRECTIVE}`;
  const result = await geminiService.generateImage(apiKey, finalPrompt, {
    aspectRatio: '9:16',
    imageSize: '2K',
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
    image: {
      mimeType: result.image.mimeType,
      base64Data: result.image.base64Data,
    },
    source: 'reel-recreate',
  });

  galleryManager.save({
    base64Data: result.image.base64Data,
    mimeType: result.image.mimeType,
    prompt: finalPrompt,
    source: 'reel-recreate',
    characterId,
    aspectRatio: '9:16',
    seed: null,
  });

  return {
    imageId: stored.imageId,
    sceneData,
    image: {
      mimeType: result.image.mimeType,
      base64Data: result.image.base64Data,
    },
    text: result.text || null,
  };
}

router.post('/recreate', async (req, res, next) => {
  try {
    const { reelUrl, characterId, activeReferenceIds, apifyApiKey, imageModel } = req.body || {};

    if (!reelUrl || typeof reelUrl !== 'string') {
      throw new AppError('"reelUrl" is required', 400, 'VALIDATION_ERROR');
    }
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
    }

    referenceManager.getCharacter(characterId);
    const refIds = normalizeRefIds(activeReferenceIds);
    const apiKey = apiKeyManager.getActiveKey();
    const activeRefs = referenceManager.getActiveReferences(characterId, refIds);
    const charRefImages = buildCharacterReferenceImages(characterId, activeRefs);

    const { frames, videoUrl } = await reelReferenceService.resolveReelFrames(reelUrl, {
      apifyToken: apifyApiKey,
    });
    const [first, last] = await Promise.all([
      analyzeAndRecreateFrame({
        frame: frames.first,
        characterId,
        activeReferenceIds: refIds,
        apiKey,
        referenceImages: charRefImages,
        imageModel,
      }),
      analyzeAndRecreateFrame({
        frame: frames.last,
        characterId,
        activeReferenceIds: refIds,
        apiKey,
        referenceImages: charRefImages,
        imageModel,
      }),
    ]);

    res.json({
      success: true,
      data: {
        reelUrl,
        videoUrl,
        lockedFormat: { resolutionTier: '2K', aspectRatio: '9:16' },
        frames: {
          first: frames.first,
          last: frames.last,
        },
        recreations: {
          first,
          last,
        },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
