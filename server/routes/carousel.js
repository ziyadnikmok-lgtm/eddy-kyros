'use strict';
const express = require('express');
const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const referenceManager = require('../services/referenceManager');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiBackend');
const carouselPlannerService = require('../services/carouselPlannerService');
const batchGenerator = require('../services/batchGenerator');
const imageStore = require('../services/imageStore');
const {
  requirePlanCapacity,
} = require('../middleware/planLimits');
const { logUsageEvent, startGenerationRun, finishGenerationRun } = require('../services/eventLogger');
const {
  resolveActiveReferenceIds,
  startMultiBatches,
  buildSceneMemoryForPlan, getOrCreateOutfit,
  buildSlidePrompt, withImageQualityLock,
  getKineticBlurSettings, selectKineticBlurIndices, withKineticBlurPrompt,
  ensureImageInStore, importInlineImageToStore,
  parseJsonFromText, sanitizePollOptionPrompt,
  extractWardrobeLock, buildLockedModificationPrompt, buildAIFollowUpDirections,
} = require('../services/carousel/carouselHelpers');

const router = express.Router();
const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];
const VALID_KINETIC_BLUR_MODES = ['off', 'some', 'more'];

router.post('/plan', async (req, res, next) => {
  try {
    const { narrative, characterId, slideCount = 5, allowOutfitChanges = false } = req.body || {};
    if (!narrative || typeof narrative !== 'string' || narrative.trim().length === 0) throw new AppError('"narrative" is required', 400, 'VALIDATION_ERROR');
    if (!Number.isInteger(slideCount) || slideCount < 1 || slideCount > 10) throw new AppError('"slideCount" must be an integer between 1 and 10', 400, 'VALIDATION_ERROR');
    if (typeof allowOutfitChanges !== 'boolean') throw new AppError('"allowOutfitChanges" must be boolean', 400, 'VALIDATION_ERROR');
    const character = (characterId && typeof characterId === 'string') ? referenceManager.getCharacter(characterId) : null;
    const plan = await carouselPlannerService.generateCarouselPlan({ narrative: narrative.trim(), slideCount, allowOutfitChanges, character });
    res.json({ success: true, data: plan });
  } catch (err) { next(err); }
});

router.post('/execute', requirePlanCapacity({
  costResolver: (req) => {
    const slideCount = Number(req.body?.slideCount);
    if (Number.isInteger(slideCount) && slideCount > 0) return slideCount;
    const plannedSlides = Array.isArray(req.body?.plan?.slides) ? req.body.plan.slides.length : 0;
    return plannedSlides > 0 ? plannedSlides : 5;
  },
}), async (req, res, next) => {
  try {
    const { narrative, plan, characterId, activeReferenceIds, slideCount = 5, allowOutfitChanges = false, kineticMotionBlur = 'off', aspectRatio, resolutionTier, imageModel } = req.body || {};
    if (!characterId || typeof characterId !== 'string') throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
    const finalAspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '4:5';
    const finalImageSize = VALID_IMAGE_SIZES.includes(resolutionTier) ? resolutionTier : '2K';
    const blurMode = VALID_KINETIC_BLUR_MODES.includes(kineticMotionBlur) ? kineticMotionBlur : 'off';
    const character = referenceManager.getCharacter(characterId);
    const resolvedActiveReferenceIds = resolveActiveReferenceIds(activeReferenceIds, character);

    let resolvedPlan = plan;
    if (!resolvedPlan || typeof resolvedPlan !== 'object' || !Array.isArray(resolvedPlan.slides)) {
      if (!narrative || typeof narrative !== 'string' || narrative.trim().length === 0) throw new AppError('Provide either "plan" or "narrative"', 400, 'VALIDATION_ERROR');
      resolvedPlan = await carouselPlannerService.generateCarouselPlan({ narrative: narrative.trim(), slideCount, allowOutfitChanges, character });
    }
    if (!Array.isArray(resolvedPlan.slides) || resolvedPlan.slides.length === 0) throw new AppError('Carousel plan has no slides', 400, 'VALIDATION_ERROR');

    const sceneMemory = buildSceneMemoryForPlan(resolvedPlan);
    const sceneMemoryId = sceneMemory ? sceneMemory.id : null;
    const outfitCache = new Map();
    const blurSettings = getKineticBlurSettings(blurMode);
    const blurIndices = blurSettings.enabled ? selectKineticBlurIndices(resolvedPlan.slides.length, blurSettings.ratio) : new Set();

    const entries = resolvedPlan.slides.map((slide, index) => {
      const outfit = getOrCreateOutfit(outfitCache, slide.outfit);
      const basePrompt = buildSlidePrompt(slide, resolvedPlan.narrative || narrative || 'carousel narrative');
      const qualityLockedPrompt = withImageQualityLock(basePrompt, { allowMotionBlur: blurIndices.has(index) });
      const prompt = blurIndices.has(index) ? withKineticBlurPrompt(qualityLockedPrompt, blurMode === 'more' ? 'strong' : 'subtle') : qualityLockedPrompt;
      return { type: 'carousel', prompt, sceneMemoryId, outfitId: outfit.id, cameraProfileId: slide.cameraProfileId || 'iphone_selfie', slide: index + 1, kineticMotionBlur: blurIndices.has(index) };
    });

    const jobIds = startMultiBatches(entries, { aspectRatio: finalAspectRatio, imageSize: finalImageSize, imageModel, gallerySource: 'carousel' }, { characterId, activeReferenceIds: resolvedActiveReferenceIds });
    const runId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'carousel',
      provider: 'gemini',
      model: imageModel || null,
    });
    finishGenerationRun(runId, {
      status: 'succeeded',
      outputCount: entries.length,
      provider: 'gemini',
      model: imageModel || null,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.started',
      entityType: 'generation_run',
      entityId: runId,
      source: 'carousel',
      payload: { feature: 'carousel', slideCount: entries.length },
    });

    res.status(202).json({
      success: true,
      data: {
        totalImages: entries.length, jobIds, sceneMemoryId, plan: resolvedPlan,
        kineticMotionBlur: { mode: blurMode, appliedSlides: entries.filter((e) => e.kineticMotionBlur).map((e) => e.slide) },
        formatLock: { aspectRatio: finalAspectRatio, imageSize: finalImageSize },
      },
    });
  } catch (err) { next(err); }
});

router.post('/follow-up', requirePlanCapacity({
  costResolver: (req) => {
    const count = Number(req.body?.count);
    return Number.isInteger(count) && count > 0 ? count : 4;
  },
}), async (req, res, next) => {
  try {
    const { imageId, imageBase64, mimeType, characterId, activeReferenceIds, count = 4, direction = '', followUpMode = 'manual', strictContinuityLock = true, useCharacterRefsInFollowUp = false, aspectRatio, resolutionTier, imageModel } = req.body || {};
    if ((!imageId || typeof imageId !== 'string') && (!imageBase64 || typeof imageBase64 !== 'string')) throw new AppError('Provide "imageId" or "imageBase64"', 400, 'VALIDATION_ERROR');
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new AppError('"count" must be an integer between 1 and 10', 400, 'VALIDATION_ERROR');
    if (followUpMode !== 'manual' && followUpMode !== 'ai') throw new AppError('"followUpMode" must be "manual" or "ai"', 400, 'VALIDATION_ERROR');
    if (typeof strictContinuityLock !== 'boolean') throw new AppError('"strictContinuityLock" must be boolean', 400, 'VALIDATION_ERROR');
    if (typeof useCharacterRefsInFollowUp !== 'boolean') throw new AppError('"useCharacterRefsInFollowUp" must be boolean', 400, 'VALIDATION_ERROR');

    let resolvedCharacterId = null;
    let resolvedActiveReferenceIds = [];
    if (characterId && typeof characterId === 'string') {
      const character = referenceManager.getCharacter(characterId);
      resolvedCharacterId = characterId;
      resolvedActiveReferenceIds = resolveActiveReferenceIds(activeReferenceIds, character);
    }

    const finalAspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '4:5';
    const finalImageSize = VALID_IMAGE_SIZES.includes(resolutionTier) ? resolutionTier : '2K';
    const resolvedImageId = (imageBase64 && mimeType) ? importInlineImageToStore({ imageBase64, mimeType }) : ensureImageInStore(imageId);
    const moodBlock = asText(direction) || 'new framing, new posing, and new expression while preserving scene continuity';

    const base = imageStore.get(resolvedImageId);
    if (!base || !base.image || !base.image.base64Data || !base.image.mimeType) throw new AppError('Selected image data unavailable for follow-up', 400, 'VALIDATION_ERROR');
    const wardrobeLock = extractWardrobeLock(base);

    let jobId = null;
    let jobIds = [];

    if (followUpMode === 'ai') {
      const prompts = await buildAIFollowUpDirections({ imageBase64: base.image.base64Data, mimeType: base.image.mimeType, count, manualDirection: moodBlock, strictContinuityLock, wardrobeLock });
      for (const modificationPrompt of prompts) {
        const job = batchGenerator.startBatch('edit', { imageId: resolvedImageId, modificationPrompt, count: 1, characterId: resolvedCharacterId, activeReferenceIds: resolvedActiveReferenceIds, disableCharacterReferenceImages: !useCharacterRefsInFollowUp, disableCharacterIdentityLock: !useCharacterRefsInFollowUp }, { aspectRatio: finalAspectRatio, imageSize: finalImageSize, imageModel, gallerySource: 'carousel' });
        jobIds.push(job.jobId);
      }
      jobId = jobIds[0] || null;
    } else {
      const manualPrompt = strictContinuityLock ? buildLockedModificationPrompt({ direction: moodBlock, strictContinuityLock, wardrobeLock }) : moodBlock;
      const job = batchGenerator.startBatch('edit', { imageId: resolvedImageId, modificationPrompt: manualPrompt, count, characterId: resolvedCharacterId, activeReferenceIds: resolvedActiveReferenceIds, disableCharacterReferenceImages: !useCharacterRefsInFollowUp, disableCharacterIdentityLock: !useCharacterRefsInFollowUp }, { aspectRatio: finalAspectRatio, imageSize: finalImageSize, imageModel, gallerySource: 'carousel' });
      jobId = job.jobId;
      jobIds = [job.jobId];
    }

    res.status(202).json({ success: true, data: { jobId, jobIds, count, imageId: resolvedImageId, followUpMode, strictContinuityLock } });
  } catch (err) { next(err); }
});

router.post('/polls', requirePlanCapacity({
  costResolver: (req) => {
    const pollCount = Number(req.body?.pollCount);
    const safePollCount = Math.max(1, Math.min(5, Number.isInteger(pollCount) ? pollCount : 3));
    return safePollCount * 2;
  },
}), async (req, res, next) => {
  try {
    const { topic, characterId, activeReferenceIds, pollCount = 3, aspectRatio, resolutionTier, imageModel } = req.body || {};
    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) throw new AppError('"topic" is required', 400, 'VALIDATION_ERROR');
    const safePollCount = Math.max(1, Math.min(5, Number.isInteger(pollCount) ? pollCount : 3));
    const finalAspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '4:5';
    const finalImageSize = VALID_IMAGE_SIZES.includes(resolutionTier) ? resolutionTier : '2K';

    let character = null;
    let resolvedActiveReferenceIds = [];
    if (characterId && typeof characterId === 'string') {
      character = referenceManager.getCharacter(characterId);
      resolvedActiveReferenceIds = resolveActiveReferenceIds(activeReferenceIds, character);
    }
    const characterPromptLockRules = character
      ? '- Character identity is locked by the runtime system.\n- Do NOT describe or modify face traits, body traits, skin tone, or hair (color/style/length).\n- Only vary: outfit, location, props, lighting mood, pose, expression, and framing.'
      : '';

    const pollPrompt = `You generate "This or That" engagement poll content for Instagram carousels.\n\nTopic: ${topic.trim()}\n\nTask:\n- Generate exactly ${safePollCount} poll questions.\n- Each poll has a question and two contrasting visual options (A and B).\n- Each option needs a short label (2-5 words) and a detailed image generation prompt.\n- Image prompts should describe the same person in contrasting scenarios/styles/settings.\n- Keep the same single female subject identity across all prompts.\n- Make prompts vivid and specific for AI image generation.\n- No couples, no male interaction.\n- Mirror selfies are allowed only when the setting plausibly supports a real mirror/reflection.\n- Do not place random mirror reflections in outdoor scenes.\n${characterPromptLockRules}\n\nReturn JSON only:\n{\n  "polls": [\n    {\n      "question": "Which vibe are you?",\n      "optionA": { "label": "Beach Day", "prompt": "detailed image prompt for option A..." },\n      "optionB": { "label": "City Night", "prompt": "detailed image prompt for option B..." }\n    }\n  ]\n}`;

    const apiKey = apiKeyManager.getActiveKeyOrNull();
    let parsed = null;
    try {
      const raw = await geminiService.generateText(apiKey, pollPrompt, { temperature: 0.6, responseMimeType: 'application/json' });
      parsed = parseJsonFromText(raw);
    } catch { parsed = null; }

    const enforceHairLock = !!character;
    const polls = (parsed && Array.isArray(parsed.polls) ? parsed.polls : [])
      .filter((p) => p && p.question && p.optionA?.prompt && p.optionB?.prompt)
      .map((p) => ({ ...p, optionA: { ...p.optionA, prompt: sanitizePollOptionPrompt(p.optionA.prompt, { enforceHairLock, enforceMirrorRealism: true }) }, optionB: { ...p.optionB, prompt: sanitizePollOptionPrompt(p.optionB.prompt, { enforceHairLock, enforceMirrorRealism: true }) } }))
      .slice(0, safePollCount);

    if (polls.length === 0) throw new AppError('Failed to generate poll content. Try a different topic.', 500, 'GENERATION_FAILED');

    const entries = [];
    for (const poll of polls) {
      entries.push({ type: 'carousel', prompt: withImageQualityLock(poll.optionA.prompt), sceneMemoryId: null, outfitId: null, cameraProfileId: 'iphone_selfie' });
      entries.push({ type: 'carousel', prompt: withImageQualityLock(poll.optionB.prompt), sceneMemoryId: null, outfitId: null, cameraProfileId: 'iphone_selfie' });
    }

    const jobIds = startMultiBatches(entries, { aspectRatio: finalAspectRatio, imageSize: finalImageSize, imageModel, gallerySource: 'carousel' }, { characterId: characterId || null, activeReferenceIds: resolvedActiveReferenceIds });
    const pollRunId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'carousel-polls',
      provider: 'gemini',
      model: imageModel || null,
    });
    finishGenerationRun(pollRunId, {
      status: 'succeeded',
      outputCount: entries.length,
      provider: 'gemini',
      model: imageModel || null,
    });

    res.status(202).json({ success: true, data: { polls, jobIds, totalImages: entries.length, formatLock: { aspectRatio: finalAspectRatio, imageSize: finalImageSize } } });
  } catch (err) { next(err); }
});

module.exports = router;
