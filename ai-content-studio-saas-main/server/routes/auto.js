'use strict';
const express = require('express');
const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const referenceManager = require('../services/referenceManager');
const autoPlanStore = require('../services/autoPlanStore');
const backgroundStore = require('../services/backgroundStore');
const { generateWeeklyPlan } = require('../services/auto/planner');
const {
  startMultiBatches, resolveActiveReferenceIds, buildAutoPlanData,
} = require('../services/auto/planHelpers');
const {
  getCurrentPlan,
  getUsageLast24h,
  getFreeTrialUsage,
  reserveFreeTrialUsage,
  releaseFreeTrialUsage,
  PLAN_LIMITS,
  isHostedRuntime,
} = require('../middleware/planLimits');

const router = express.Router();
const MAX_DURATION_DAYS = 30;

function reservePlanCapacity(req, res, cost, source = 'auto') {
  if (!isHostedRuntime()) return { plan: 'unlimited', reservationIds: [] };
  const userId = req.session?.userId;
  if (!userId) return { plan: 'unlimited', reservationIds: [] };

  const safeCost = Math.max(1, Math.floor(Number(cost) || 1));
  const plan = getCurrentPlan(userId);
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  if (!isFinite(limit)) return { plan, reservationIds: [] };

  const used = plan === 'free' ? getFreeTrialUsage(userId) : getUsageLast24h(userId);
  if (used + safeCost > limit) {
    throw new AppError(
      plan === 'free'
        ? `Free trial limit reached (${used}/${limit} generations used). Upgrade to keep creating.`
        : `Daily generation limit reached (${used}/${limit} images used). Upgrade your plan for more.`,
      429,
      'PLAN_LIMIT_EXCEEDED',
    );
  }

  if (plan !== 'free') return { plan, reservationIds: [] };

  const reservationIds = reserveFreeTrialUsage(
    userId,
    safeCost,
    source || req.path || req.originalUrl || 'auto',
  );

  // If request fails, refund reservations
  res.once('finish', () => {
    if (res.statusCode >= 400) {
      try { releaseFreeTrialUsage(reservationIds); } catch { /* best effort */ }
    }
  });

  return { plan, reservationIds };
}

// ── Plan CRUD ──────────────────────────────────────────────────────────────────

router.get('/plans', (_req, res, next) => {
  try { res.json({ success: true, data: autoPlanStore.list() }); }
  catch (err) { next(err); }
});

router.get('/plans/:id', (req, res, next) => {
  try { res.json({ success: true, data: autoPlanStore.get(req.params.id) }); }
  catch (err) { next(err); }
});

router.post('/plans', (req, res, next) => {
  try { res.status(201).json({ success: true, data: autoPlanStore.save(req.body) }); }
  catch (err) { next(err); }
});

router.patch('/plans/:id', (req, res, next) => {
  try { res.json({ success: true, data: autoPlanStore.update(req.params.id, req.body) }); }
  catch (err) { next(err); }
});

router.delete('/plans/:id', (req, res, next) => {
  try { res.json({ success: true, data: autoPlanStore.remove(req.params.id) }); }
  catch (err) { next(err); }
});

router.post('/plans/:id/execute-day', async (req, res, next) => {
  let reservationIds = [];
  try {
    const plan = autoPlanStore.get(req.params.id);
    const { dayNumber } = req.body || {};
    if (!Number.isInteger(dayNumber) || dayNumber < 1) throw new AppError('"dayNumber" is required (positive integer)', 400, 'VALIDATION_ERROR');
    const dayBlock = plan.days.find((d) => d.day === dayNumber);
    if (!dayBlock) throw new AppError(`Day ${dayNumber} not found in plan`, 404, 'NOT_FOUND');
    if ((plan.executedDays || []).some((d) => d.day === dayNumber)) throw new AppError(`Day ${dayNumber} has already been executed`, 400, 'ALREADY_EXECUTED');
    if (!plan.characterId) throw new AppError('Plan is missing characterId', 400, 'VALIDATION_ERROR');

    const characterConfig = referenceManager.getCharacter(plan.characterId);
    const activeReferenceIds = resolveActiveReferenceIds(plan.config?.activeReferenceIds, characterConfig);
    const entries = [];

    for (const prompt of (dayBlock.carouselPrompts || [])) {
      if (typeof prompt === 'string' && prompt.trim()) entries.push({ type: 'carousel', prompt, sceneMemoryId: dayBlock.sceneMemoryId || null, outfitId: dayBlock.outfitId || null, cameraProfileId: dayBlock.cameraProfiles?.carousel || 'iphone_selfie', resolutionTier: '2K', aspectRatio: '4:5' });
    }
    if (dayBlock.lifestylePrompt && typeof dayBlock.lifestylePrompt === 'string' && dayBlock.lifestylePrompt.trim()) {
      entries.push({ type: 'lifestyle', prompt: dayBlock.lifestylePrompt, sceneMemoryId: dayBlock.sceneMemoryId || null, outfitId: dayBlock.outfitId || null, cameraProfileId: dayBlock.cameraProfiles?.carousel || 'iphone_selfie', resolutionTier: '2K', aspectRatio: '4:5' });
    }
    for (const prompt of (dayBlock.reelPrompts || [])) {
      if (typeof prompt === 'string' && prompt.trim()) entries.push({ type: 'reel', prompt, sceneMemoryId: dayBlock.sceneMemoryId || null, outfitId: dayBlock.outfitId || null, cameraProfileId: dayBlock.cameraProfiles?.reel || 'friend_phone_flash', resolutionTier: '2K', aspectRatio: '9:16' });
    }
    for (const prompt of (dayBlock.storyPrompts || [])) {
      if (typeof prompt === 'string' && prompt.trim()) entries.push({ type: 'story', prompt, sceneMemoryId: dayBlock.sceneMemoryId || null, outfitId: dayBlock.outfitId || null, cameraProfileId: dayBlock.cameraProfiles?.reel || 'friend_phone_flash', resolutionTier: '2K', aspectRatio: '9:16' });
    }
    if (entries.length === 0) throw new AppError(`Day ${dayNumber} has no prompts to execute`, 400, 'VALIDATION_ERROR');
    ({ reservationIds } = reservePlanCapacity(req, res, entries.length, '/api/auto/plans/:id/execute-day'));

    const styleAtomIds = plan.config?.styleAtomIds || [];
    const planImageModel = plan.config?.imageModel || undefined;
    const usesAnchor = plan.personaMode === 'cosplay' || plan.personaMode === 'goth';
    let bgRefs = [];
    const savedBgRefId = plan.config?.backgroundRefId;
    if (savedBgRefId) {
      const bgData = backgroundStore.getImageData(savedBgRefId);
      if (bgData) bgRefs = [{ base64Data: bgData.base64Data, mimeType: bgData.mimeType, referenceType: 'background', note: 'Show her in this exact LED themed room, perfectly blended. The room lighting reflects on her body and skin for raw candid realism. Do NOT add random objects not in this room.' }];
    }

    const postEntries = entries.filter((e) => e.type === 'carousel' || e.type === 'lifestyle');
    const verticalEntries = entries.filter((e) => e.type === 'reel' || e.type === 'story');
    const jobIds = [
      ...startMultiBatches(postEntries, { imageSize: '2K', aspectRatio: '4:5', imageModel: planImageModel, personaMode: plan.personaMode || null }, { characterId: plan.characterId, activeReferenceIds }, styleAtomIds, { anchorFirst: usesAnchor, specificReferences: bgRefs }),
      ...startMultiBatches(verticalEntries, { imageSize: '2K', aspectRatio: '9:16', imageModel: planImageModel, personaMode: plan.personaMode || null }, { characterId: plan.characterId, activeReferenceIds }, styleAtomIds, { anchorFirst: usesAnchor, specificReferences: bgRefs }),
    ];

    autoPlanStore.markDayExecuted(plan.id, dayNumber, jobIds);
    res.status(202).json({ success: true, data: { dayNumber, totalImages: entries.length, jobIds } });
  } catch (err) {
    if (reservationIds.length) {
      try { releaseFreeTrialUsage(reservationIds); } catch { /* best effort */ }
    }
    next(err);
  }
});

// ── Plan + execute helpers ─────────────────────────────────────────────────────

async function validateAndPlan(body) {
  const {
    theme, duration, characterId, personaMode, customPersona, spicinessLevel,
    includeReels = true, includeStories = false, carouselCount = 3, reelCount = 1, storyCount = 1,
    activeReferenceIds, similarityCooldown = 'on', footwearLock = '',
    styleAtomIds, cosplayOptions, imageModel,
  } = body || {};

  if (!theme || typeof theme !== 'string' || theme.trim().length === 0) throw new AppError('"theme" is required', 400, 'VALIDATION_ERROR');
  if (!Number.isInteger(duration) || duration <= 0 || duration > MAX_DURATION_DAYS) throw new AppError(`"duration" must be a positive integer (max ${MAX_DURATION_DAYS})`, 400, 'VALIDATION_ERROR');
  if (!characterId || typeof characterId !== 'string') throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
  if (typeof includeReels !== 'boolean') throw new AppError('"includeReels" must be a boolean', 400, 'VALIDATION_ERROR');
  if (typeof includeStories !== 'boolean') throw new AppError('"includeStories" must be a boolean', 400, 'VALIDATION_ERROR');
  if (!Number.isInteger(carouselCount) || carouselCount < 1 || carouselCount > 10) throw new AppError('"carouselCount" must be an integer between 1 and 10', 400, 'VALIDATION_ERROR');
  if (!Number.isInteger(reelCount) || reelCount < 1 || reelCount > 10) throw new AppError('"reelCount" must be an integer between 1 and 10', 400, 'VALIDATION_ERROR');
  if (!Number.isInteger(storyCount) || storyCount < 1 || storyCount > 10) throw new AppError('"storyCount" must be an integer between 1 and 10', 400, 'VALIDATION_ERROR');
  if (similarityCooldown !== 'on' && similarityCooldown !== 'off') throw new AppError('"similarityCooldown" must be "on" or "off"', 400, 'VALIDATION_ERROR');
  if (cosplayOptions != null && (typeof cosplayOptions !== 'object' || Array.isArray(cosplayOptions))) throw new AppError('"cosplayOptions" must be an object if provided', 400, 'VALIDATION_ERROR');

  const resolvedImageModel = typeof imageModel === 'string' && imageModel.trim() ? imageModel.trim() : undefined;
  const characterConfig = referenceManager.getCharacter(characterId);
  const resolvedActiveReferenceIds = resolveActiveReferenceIds(activeReferenceIds, characterConfig);
  const weeklyPlan = await generateWeeklyPlan({ theme: theme.trim(), duration, personaMode, customPersona, spicinessLevel, cosplayOptions });
  if (!weeklyPlan || !Array.isArray(weeklyPlan.days)) throw new AppError('Planner returned invalid structure: missing "days" array', 502, 'PARSE_ERROR');

  let backgroundRefs = [];
  const bgRefId = cosplayOptions?.backgroundRefId;
  if (bgRefId && typeof bgRefId === 'string') {
    const bgData = await backgroundStore.getImageData(bgRefId);
    if (bgData) {
      backgroundRefs = [{ base64Data: bgData.base64Data, mimeType: bgData.mimeType, referenceType: 'background', note: `BACKGROUND LOCK: Use this EXACT background/setting for ALL shots. Match the room, lighting, colors, and atmosphere exactly. Do NOT add objects, furniture, or elements not visible in this background reference. Only the character should be placed in this scene` }];
    }
  }

  const planned = buildAutoPlanData({ weeklyPlan, characterConfig, carouselCount, includeReels, reelCount, includeStories, storyCount, similarityCooldown, footwearLock, styleAtomIds: Array.isArray(styleAtomIds) ? styleAtomIds : [], personaMode, backgroundLocked: backgroundRefs.length > 0 });
  return { planned, characterId, personaMode, resolvedActiveReferenceIds, resolvedImageModel, backgroundRefs };
}

function executePlannedEntries(planned, { characterId, personaMode, resolvedActiveReferenceIds, resolvedImageModel, backgroundRefs = [] }) {
  const lockedEntries = planned.imageEntries
    .map((entry) => ({ ...entry, resolutionTier: '2K', aspectRatio: (entry.type === 'carousel' || entry.type === 'lifestyle') ? '4:5' : '9:16' }))
    .filter((entry) => typeof entry.prompt === 'string' && entry.prompt.trim().length > 0);

  const postEntries = lockedEntries.filter((e) => e.type === 'carousel' || e.type === 'lifestyle');
  const verticalEntries = lockedEntries.filter((e) => e.type === 'reel' || e.type === 'story');
  const usesAnchor = personaMode === 'cosplay' || personaMode === 'goth';

  const jobIds = [
    ...startMultiBatches(postEntries, { imageSize: '2K', aspectRatio: '4:5', imageModel: resolvedImageModel, personaMode }, { characterId, activeReferenceIds: resolvedActiveReferenceIds }, planned.styleAtomIds, { anchorFirst: usesAnchor, specificReferences: backgroundRefs }),
    ...startMultiBatches(verticalEntries, { imageSize: '2K', aspectRatio: '9:16', imageModel: resolvedImageModel, personaMode }, { characterId, activeReferenceIds: resolvedActiveReferenceIds }, planned.styleAtomIds, { anchorFirst: usesAnchor, specificReferences: backgroundRefs }),
  ];

  return { totalImages: lockedEntries.length, jobIds, sceneMemoryId: planned.sceneMemoryId, footwearLock: planned.footwearLock, styleAtomIds: planned.styleAtomIds, formatLock: { carousel: '2K 4:5', reel: '2K 9:16', story: '2K 9:16' } };
}

// ── Plan / Execute routes ──────────────────────────────────────────────────────

router.post('/plan', async (req, res, next) => {
  let reservationIds = [];
  try {
    const result = await validateAndPlan(req.body);
    const { planned } = result;
    if (req.body && req.body.execute) {
      const data = executePlannedEntries(planned, result);
      ({ reservationIds } = reservePlanCapacity(req, res, data.totalImages, '/api/auto/plan'));
      return res.status(202).json({ success: true, data });
    }
    res.json({ success: true, data: planned.days });
  } catch (err) {
    if (reservationIds.length) {
      try { releaseFreeTrialUsage(reservationIds); } catch { /* best effort */ }
    }
    next(err);
  }
});

router.post('/execute', async (req, res, next) => {
  let reservationIds = [];
  try {
    const result = await validateAndPlan(req.body);
    const { planned } = result;
    if (planned.imageEntries.length === 0) throw new AppError('No prompts produced for execution', 400, 'VALIDATION_ERROR');

    const { theme, personaMode: pm, duration, startDate, imageModel, styleAtomIds: sIds, characterId: cId, includeReels, includeStories, carouselCount, reelCount, storyCount } = req.body;
    const savedPlan = autoPlanStore.save({
      name: (theme || '').trim().slice(0, 80),
      theme: (theme || '').trim(),
      personaMode: pm,
      characterId: cId,
      duration,
      startDate,
      days: planned.days,
      config: {
        activeReferenceIds: result.resolvedActiveReferenceIds || [],
        styleAtomIds: Array.isArray(sIds) ? sIds : [],
        includeReels, includeStories, carouselCount, reelCount, storyCount,
        imageModel,
        backgroundRefId: req.body?.cosplayOptions?.backgroundRefId || undefined,
      },
    });

    const data = executePlannedEntries(planned, result);
    ({ reservationIds } = reservePlanCapacity(req, res, data.totalImages, '/api/auto/execute'));
    for (const day of planned.days) autoPlanStore.markDayExecuted(savedPlan.id, day.day, data.jobIds);
    res.status(202).json({ success: true, data: { ...data, planId: savedPlan.id, plan: savedPlan } });
  } catch (err) {
    if (reservationIds.length) {
      try { releaseFreeTrialUsage(reservationIds); } catch { /* best effort */ }
    }
    next(err);
  }
});

module.exports = router;
