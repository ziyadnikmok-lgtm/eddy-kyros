const express = require('express');
const fs = require('node:fs');
let _sharp; const sharp = (...a) => { if (!_sharp) _sharp = require('sharp'); return _sharp(...a); };
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiBackend');
const log = require('../utils/logger');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const { AppError } = require('../middleware/errorHandler');
const { requirePlanCapacity } = require('../middleware/planLimits');
const { logUsageEvent, startGenerationRun, finishGenerationRun } = require('../services/eventLogger');

const router = express.Router();

const RATIO_LABELS = {
  '9:16': 'vertical story/reel (9:16)',
  '16:9': 'landscape/YouTube thumbnail (16:9)',
  '1:1': 'square post (1:1)',
  '4:5': 'portrait feed post (4:5)',
  '3:4': 'portrait (3:4)',
};

function loadImageData(imageId) {
  // Try imageStore first (batch results)
  try {
    const stored = imageStore.get(imageId);
    if (stored?.image?.base64Data) {
      return {
        base64Data: stored.image.base64Data,
        mimeType: stored.image.mimeType || 'image/png',
        characterId: stored.characterId,
        activeReferenceIds: stored.activeReferenceIds,
        modelUsed: stored.modelUsed,
      };
    }
  } catch {}

  // Try gallery (most images live here)
  try {
    const { filePath, mimeType } = galleryManager.getFilePath(imageId);
    const buf = fs.readFileSync(filePath);
    const entry = galleryManager.get(imageId);
    return {
      base64Data: buf.toString('base64'),
      mimeType: mimeType || 'image/png',
      characterId: entry?.characterId || null,
      activeReferenceIds: null,
      modelUsed: null,
    };
  } catch {}

  return null;
}

router.post('/', requirePlanCapacity(), async (req, res, next) => {
  let runId = null;
  try {
    const { imageId, targetRatio, imageBase64, imageMimeType } = req.body || {};

    if (!imageId && !imageBase64) throw new AppError('imageId or imageBase64 is required', 400, 'VALIDATION_ERROR');
    if (!targetRatio || !RATIO_LABELS[targetRatio]) {
      throw new AppError(`targetRatio must be one of: ${Object.keys(RATIO_LABELS).join(', ')}`, 400, 'VALIDATION_ERROR');
    }

    let original;
    if (imageBase64) {
      original = {
        base64Data: imageBase64,
        mimeType: imageMimeType || 'image/png',
        characterId: null,
        activeReferenceIds: null,
        modelUsed: null,
      };
    } else {
      original = loadImageData(imageId);
      if (!original) {
        throw new AppError('Image not found in gallery or image store', 404, 'NOT_FOUND');
      }
    }

    const reformatPrompt = `Reformat this image to ${RATIO_LABELS[targetRatio]} aspect ratio by naturally extending the scene outward. Expand the background, environment, and surroundings beyond the current frame edges to fill the new canvas. Keep the subject, character, face, clothing, lighting, color grading, and style completely unchanged — only extend the image, never crop or modify the existing content.`;

    const apiKey = apiKeyManager.getActiveKeyOrNull();
    runId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'reformat',
      provider: 'gemini',
      model: null,
    });

    const result = await geminiService.generateImage(apiKey, reformatPrompt, {
      aspectRatio: targetRatio,
      imageSize: '2K',
      referenceImages: [
        {
          mimeType: original.mimeType,
          base64Data: original.base64Data,
        },
      ],
      model: original.modelUsed || undefined,
    });

    // Convert to PNG for quality consistency
    let finalBase64 = result.image.base64Data;
    let finalMime = result.image.mimeType || 'image/png';
    try {
      const buf = Buffer.from(result.image.base64Data, 'base64');
      const pngBuf = await sharp(buf).png({ compressionLevel: 6 }).toBuffer();
      finalBase64 = pngBuf.toString('base64');
      finalMime = 'image/png';
    } catch (e) {
      log.warn('reformat_png_conversion_failed', { message: e.message });
    }

    // Save to gallery
    let galleryEntry = null;
    try {
      galleryEntry = galleryManager.save({
        base64Data: finalBase64,
        mimeType: finalMime,
        prompt: reformatPrompt,
        source: 'reformat',
        characterId: original.characterId || null,
        aspectRatio: targetRatio,
        tags: ['reformat', targetRatio.replace(':', 'x')],
      });
    } catch (e) {
      log.error('reformat_gallery_save_failed', { message: e.message });
    }

    res.status(201).json({
      success: true,
      data: {
        imageId: galleryEntry?.id || null,
        parentImageId: imageId,
        targetRatio,
        image: { mimeType: finalMime, base64Data: finalBase64 },
        galleryId: galleryEntry?.id || null,
        createdAt: new Date().toISOString(),
      },
    });

    finishGenerationRun(runId, {
      status: 'succeeded',
      outputCount: 1,
      provider: 'gemini',
      model: result.modelUsed || null,
    });
  } catch (err) {
    finishGenerationRun(runId, {
      status: 'failed',
      outputCount: 0,
      errorCode: err.code || err.name || 'UNKNOWN',
      errorMessage: err.message || 'Reformat failed',
      provider: 'gemini',
    });
    next(err);
  }
});

module.exports = router;
