const express = require('express');
const galleryManager = require('../services/galleryManager');
const apiKeyManager = require('../services/apiKeyManager');
const referenceManager = require('../services/referenceManager');
const { AppError } = require('../middleware/errorHandler');
const { requirePlanCapacity } = require('../middleware/planLimits');
const { logUsageEvent, startGenerationRun, finishGenerationRun } = require('../services/eventLogger');
const log = require('../utils/logger');

const router = express.Router();

const VALID_ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K'];
const VALID_MODELS = ['flash'];

const MODEL_IDS = {
  flash: 'gemini-3.1-flash-image-preview',
};

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_ONLY_HIGH' },
];

function extractImageFromResponse(data) {
  const candidates = data?.candidates || [];
  if (!candidates.length) return null;
  const parts = candidates[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.thought) continue;
    if (part.inlineData?.data) return part.inlineData.data;
  }
  return null;
}

async function callGemini(apiKey, modelId, parts, aspectRatio, imageSize, temperature) {
  const imageConfig = {};
  if (aspectRatio && aspectRatio !== 'auto') imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;

  const genConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    temperature: temperature ?? 1.0,
  };
  if (Object.keys(imageConfig).length) genConfig.imageConfig = imageConfig;

  const payload = {
    contents: [{ parts }],
    generationConfig: genConfig,
    safetySettings: SAFETY_SETTINGS,
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  // Up to 3 attempts with progressive simplification (mirrors the ComfyUI node logic)
  for (let attempt = 1; attempt <= 3; attempt++) {
    let body = payload;
    if (attempt === 2) {
      body = { ...payload, generationConfig: { responseModalities: ['IMAGE'], temperature: temperature ?? 1.0 } };
    } else if (attempt === 3) {
      body = { ...payload, generationConfig: { responseModalities: ['IMAGE'], temperature: 0.8 } };
      delete body.safetySettings;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });

    if (!resp.ok && resp.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new AppError(`Gemini API error (${resp.status}): ${text.slice(0, 200)}`, 502, 'NANO_BYPASS_ERROR');
    }

    const data = await resp.json();
    const b64 = extractImageFromResponse(data);
    if (b64) return b64;

    // Last attempt — surface a useful error
    if (attempt === 3) {
      const finishReason = data?.candidates?.[0]?.finishReason || 'UNKNOWN';
      const textParts = (data?.candidates?.[0]?.content?.parts || [])
        .filter((p) => !p.thought && p.text)
        .map((p) => p.text)
        .join(' ');
      throw new AppError(
        `Nano Bypass returned no image (reason: ${finishReason})${textParts ? ` — ${textParts.slice(0, 200)}` : ''}`,
        502,
        'NANO_BYPASS_NO_IMAGE'
      );
    }
  }
}

// POST /api/nano-bypass/edit
router.post('/edit', express.json({ limit: '50mb' }), requirePlanCapacity(), async (req, res, next) => {
  let runId = null;
  try {
    const {
      images,        // array of { base64, mimeType }
      prompt,
      characterId = null,
      model = 'flash',
      aspectRatio = 'auto',
      imageSize = '2K',
      temperature = 1.0,
      saveToGallery = true,
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new AppError('prompt is required', 400, 'VALIDATION_ERROR');
    }
    if (!Array.isArray(images) || images.length === 0) {
      throw new AppError('at least one image is required', 400, 'VALIDATION_ERROR');
    }
    if (images.length > 5) {
      throw new AppError('maximum 5 images at once', 400, 'VALIDATION_ERROR');
    }
    if (!VALID_MODELS.includes(model)) {
      throw new AppError('Nano Bypass only supports Gemini 3.1 Flash', 400, 'VALIDATION_ERROR');
    }
    if (aspectRatio && !VALID_ASPECT_RATIOS.includes(aspectRatio)) {
      throw new AppError(`invalid aspectRatio`, 400, 'VALIDATION_ERROR');
    }
    if (imageSize && !VALID_IMAGE_SIZES.includes(imageSize)) {
      throw new AppError(`invalid imageSize`, 400, 'VALIDATION_ERROR');
    }

    const apiKey = apiKeyManager.getActiveKey();
    const modelId = MODEL_IDS[model];
    runId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'nano-bypass',
      provider: 'gemini',
      model: modelId,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.started',
      entityType: 'generation_run',
      entityId: runId,
      source: 'nano-bypass',
      payload: { feature: 'nano-bypass', model: modelId, imageCount: images.length },
    });

    let effectivePrompt = prompt.trim();
    let characterName = null;
    if (characterId) {
      try {
        const character = referenceManager.getCharacter(characterId);
        characterName = character?.name || null;
      } catch {
        characterName = null;
      }
      if (characterName) {
        effectivePrompt = `Keep the character identity consistent with ${characterName}. ${effectivePrompt}`;
      }
    }

    // Build parts: images first, then prompt (mirrors ComfyUI node)
    const parts = [];
    for (const img of images) {
      if (!img.base64 || typeof img.base64 !== 'string') {
        throw new AppError('each image must have a base64 field', 400, 'VALIDATION_ERROR');
      }
      // Strip data URI prefix if present
      const raw = img.base64.replace(/^data:[^;]+;base64,/, '');
      parts.push({ inlineData: { mimeType: img.mimeType || 'image/png', data: raw } });
    }
    parts.push({ text: effectivePrompt });

    const b64Result = await callGemini(apiKey, modelId, parts, aspectRatio, imageSize, temperature);

    let galleryId = null;
    if (saveToGallery) {
      const entry = galleryManager.save({
        base64Data: b64Result,
        mimeType: 'image/png',
        prompt: `[Nano Bypass ${model.toUpperCase()}] ${effectivePrompt.slice(0, 200)}`,
        source: 'nano-bypass',
        characterId: characterId || null,
        aspectRatio: aspectRatio !== 'auto' ? aspectRatio : null,
        tags: ['nano-bypass', model],
      });
      galleryId = entry.id;
    }

    finishGenerationRun(runId, {
      status: 'succeeded',
      outputCount: 1,
      provider: 'gemini',
      model: modelId,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.succeeded',
      entityType: 'generation_run',
      entityId: runId,
      source: 'nano-bypass',
      payload: { feature: 'nano-bypass', galleryId, model: modelId },
    });

    log.info('nano_bypass_edit_ok', { model: modelId, imageCount: images.length, galleryId });

    res.json({
      success: true,
      data: {
        base64Data: b64Result,
        mimeType: 'image/png',
        galleryId,
        model: modelId,
      },
    });
  } catch (err) {
    finishGenerationRun(runId, {
      status: 'failed',
      outputCount: 0,
      provider: 'gemini',
      errorCode: err.code || err.name || 'UNKNOWN',
      errorMessage: err.message || 'Nano bypass failed',
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.failed',
      entityType: 'generation_run',
      entityId: runId,
      source: 'nano-bypass',
      payload: { feature: 'nano-bypass', errorCode: err.code || err.name || 'UNKNOWN', message: err.message || 'Nano bypass failed' },
    });
    next(err);
  }
});

module.exports = router;
