const express = require('express');
const fs = require('node:fs');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiBackend');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const tweakBuilder = require('../services/tweakBuilder');
const referenceManager = require('../services/referenceManager');
const promptBuilder = require('../services/promptBuilder');
const { resolveDimensions } = require('../services/dimensionResolver');
const REALISM_DIRECTIVE = require('../utils/realismDirective');
const { buildCharacterReferenceImages } = require('./postClone');
const { AppError } = require('../middleware/errorHandler');
const { createMultipartParser } = require('../middleware/multipartParser');

const router = express.Router();
const parseMultipartIfNeeded = createMultipartParser();

router.post('/', parseMultipartIfNeeded, async (req, res, next) => {
  try {
    let { imageId, modifications, characterId, activeReferenceIds, imageModel } = req.body || {};
    if (typeof modifications === 'string') {
      try { modifications = JSON.parse(modifications); } catch {
        throw new AppError('"modifications" must be valid JSON', 400, 'VALIDATION_ERROR');
      }
    }
    if (typeof activeReferenceIds === 'string') {
      try { activeReferenceIds = JSON.parse(activeReferenceIds); } catch { }
    }
    const { aspectRatio, resolutionTier, width, height } = resolveDimensions(req.body);

    const uploadedFile = req.file && req.file.buffer
      ? req.file
      : null;

    let resolvedImageId = null;
    let original;

    if (uploadedFile) {
      const imported = imageStore.store({
        basePrompt: 'Uploaded base image',
        characterId: null,
        activeReferenceIds: null,
        sceneDescription: null,
        modelUsed: null,
        seed: null,
        parentImageId: null,
        variationIndex: null,
        image: {
          mimeType: uploadedFile.mimetype || 'image/png',
          base64Data: uploadedFile.buffer.toString('base64'),
        },
        source: 'generate',
      });
      resolvedImageId = imported.imageId;
      original = imageStore.get(resolvedImageId);
    } else if (imageId && typeof imageId === 'string') {
      resolvedImageId = imageId;
      try {
        original = imageStore.get(imageId);
      } catch {
        const galleryEntry = galleryManager.get(imageId);
        const { filePath, mimeType } = galleryManager.getFilePath(imageId);
        const buffer = fs.readFileSync(filePath);
        const imported = imageStore.store({
          basePrompt: galleryEntry.prompt || 'Gallery image',
          characterId: galleryEntry.characterId || null,
          activeReferenceIds: null,
          sceneDescription: galleryEntry.prompt || null,
          modelUsed: null,
          seed: galleryEntry.seed || null,
          parentImageId: null,
          variationIndex: null,
          image: {
            mimeType,
            base64Data: buffer.toString('base64'),
          },
          source: 'generate',
        });
        resolvedImageId = imported.imageId;
        original = imageStore.get(resolvedImageId);
      }
    } else {
      throw new AppError('No base image provided', 400, 'VALIDATION_ERROR');
    }

    if (!original.image) {
      throw new AppError(
        'Cannot tweak an image with no image data (may be a failed or cancelled generation)',
        400,
        'NO_IMAGE_DATA'
      );
    }

    let tweakPrompt = tweakBuilder.buildTweakPrompt({
      originalMetadata: original,
      modifications: modifications || {},
    });

    let referenceImages = [];

    if (characterId && typeof characterId === 'string') {
      const character = referenceManager.getCharacter(characterId);
      const activeRefs = referenceManager.getActiveReferences(
        characterId,
        Array.isArray(activeReferenceIds) ? activeReferenceIds : null
      );
      tweakPrompt = promptBuilder.buildPrompt({
        masterPrompt: character.masterPrompt,
        activeReferences: activeRefs,
        userPrompt: tweakPrompt,
      });
      referenceImages = buildCharacterReferenceImages(characterId, activeRefs);
    }

    if (original.image?.base64Data) {
      referenceImages.push({
        mimeType: original.image.mimeType || 'image/png',
        base64Data: original.image.base64Data,
      });
    }

    const apiKey = apiKeyManager.getActiveKey();
    const finalPrompt = `${tweakPrompt}\n\n${REALISM_DIRECTIVE}`;
    const result = await geminiService.generateImage(apiKey, finalPrompt, {
      aspectRatio,
      imageSize: resolutionTier,
      referenceImages,
      model: imageModel,
    });

    const childCount = imageStore.getChildCount(resolvedImageId);
    const stored = imageStore.store({
      basePrompt: tweakPrompt,
      characterId: original.characterId,
      activeReferenceIds: original.activeReferenceIds,
      sceneDescription: original.sceneDescription,
      modelUsed: result.modelUsed || null,
      seed: null,
      parentImageId: resolvedImageId,
      variationIndex: childCount,
      image: {
        mimeType: result.image.mimeType,
        base64Data: result.image.base64Data,
      },
      source: 'tweak',
    });

    res.status(201).json({
      success: true,
      data: {
        imageId: stored.imageId,
        parentImageId: stored.parentImageId,
        variationIndex: stored.variationIndex,
        image: stored.image,
        text: result.text,
        modifications,
        dimensions: { aspectRatio, resolutionTier, width, height },
        createdAt: stored.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
