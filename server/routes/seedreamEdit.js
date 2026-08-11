const express = require('express');
const router = express.Router();
const { AppError } = require('../middleware/errorHandler');
const { generateSeedreamEdit, SEEDREAM_MAX_IMAGES } = require('../services/muapiService');
const { generateSeedream5Edit } = require('../services/wavespeedService');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const apiKeyManager = require('../services/apiKeyManager');
const log = require('../utils/logger');

// Muapi's published rates: base per resolution, +$0.003 per EXTRA image (first image is free).
const SEEDREAM_BASE_COST = { '1K': 0.045, '2K': 0.090 };
const SEEDREAM_EXTRA_IMAGE_COST = 0.003;

function estimateCost(resolution, imageCount) {
  const base = SEEDREAM_BASE_COST[resolution] ?? SEEDREAM_BASE_COST['1K'];
  return base + Math.max(0, imageCount - 1) * SEEDREAM_EXTRA_IMAGE_COST;
}

/**
 * POST /api/seedream/edit
 * Edit 1–10 images with Muapi's Seedream 5.0 Pro Edit.
 *
 * Body: {
 *   images: [{ base64: string, mimeType: string }],
 *   prompt: string,
 *   aspectRatio?: '1:1'|'4:3'|'3:4'|'16:9'|'9:16'|'2:3'|'3:2',
 *   resolution?: '1K'|'2K',
 * }
 */
router.post('/edit', async (req, res, next) => {
  try {
    const { images, prompt, aspectRatio, resolution, provider, tags: extraTags } = req.body || {};

    if (!Array.isArray(images) || images.length === 0) {
      throw new AppError('images array is required', 400, 'VALIDATION_ERROR');
    }
    if (images.length > SEEDREAM_MAX_IMAGES) {
      throw new AppError(`Maximum ${SEEDREAM_MAX_IMAGES} images allowed`, 400, 'VALIDATION_ERROR');
    }
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new AppError('prompt is required', 400, 'VALIDATION_ERROR');
    }
    for (const img of images) {
      if (!img.base64 || !img.mimeType) {
        throw new AppError('Each image must have base64 and mimeType', 400, 'VALIDATION_ERROR');
      }
    }

    const ar = aspectRatio || '1:1';
    const res_ = resolution || '1K';

    log.info('seedream_edit_req', {
      userId: req.session?.userId,
      imageCount: images.length,
      prompt: prompt.slice(0, 100),
      aspectRatio: ar,
      resolution: res_,
    });

    // WaveSpeed is the default provider for Seedream: same model, same price, but Muapi rejects
    // long prompts outright ("The text length cannot exceed the maximum limit") and WaveSpeed
    // documents no such cap. Muapi still serves Seedance/Omni; only Seedream moved.
    //
    // If no WaveSpeed key is configured we fall back to Muapi rather than break every Seedream
    // tool at once -- but the response says which provider ran, so this is never silent.
    const hasWsKey = !!apiKeyManager.getWavespeedKeyInfo()?.hasWavespeedKey;
    const useWavespeed = provider === 'muapi' ? false : hasWsKey;
    if (!useWavespeed && provider !== 'muapi') {
      log.warn('seedream_wavespeed_key_missing', { fellBackTo: 'muapi' });
    }
    const result = useWavespeed
      ? await generateSeedream5Edit(images, prompt, { aspectRatio: ar, resolution: res_ })
      : await generateSeedreamEdit(images, prompt, { aspectRatio: ar, resolution: res_ });

    // allSettled: the provider has already generated and billed these. One gallery write
// failing used to reject the whole request, so a paid image was lost to a 500.
const settled = await Promise.allSettled(result.images.map(async (img) => {
      const stored = imageStore.store({
        basePrompt: prompt.trim(),
        modelUsed: result.modelUsed,
        image: { mimeType: img.mimeType, base64Data: img.base64Data },
        source: 'generate',
      });

      const galleryEntry = galleryManager.save({
        base64Data: img.base64Data,
        mimeType: img.mimeType,
        prompt: prompt.trim(),
        source: 'generate',
        aspectRatio: ar,
        // Extra tags let a caller mark WHERE a generation came from. Eddy uses this so its
        // Library can recover images whose request was cut short — the picture is saved here
        // regardless, but the browser is what normally files it.
        tags: ['seedream-5-pro-edit', useWavespeed ? 'wavespeed' : 'muapi',
          ...(Array.isArray(extraTags) ? extraTags.filter((t) => typeof t === 'string').slice(0, 4) : [])],
      });

      return {
        imageId: stored.imageId,
        galleryId: galleryEntry.id,
        mimeType: img.mimeType,
        base64Data: img.base64Data,
      };
    }));

    const savedImages = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!savedImages.length) throw new AppError('Generated, but none could be saved', 500, 'SAVE_FAILED');
    if (savedImages.length < settled.length) {
      log.warn('seedream_partial_save', { generated: settled.length, saved: savedImages.length });
    }

    // Track spend against the active key so the budget bar stays honest.
    try {
      const cost = estimateCost(res_, images.length) + (savedImages.length - 1) * (SEEDREAM_BASE_COST[res_] ?? SEEDREAM_BASE_COST['1K']);
      if (cost > 0) apiKeyManager.addExternalSpend(cost, 'seedream-edit');
    } catch (e) {
      log.warn('seedream_spend_track_failed', { error: e.message });
    }

    res.json({
      success: true,
      data: {
        images: savedImages,
        modelUsed: result.modelUsed,
        prompt: prompt.trim(),
        resolution: res_,
        aspectRatio: ar,
        provider: useWavespeed ? 'wavespeed' : 'muapi',
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
