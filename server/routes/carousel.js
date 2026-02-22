const express = require('express');
const fs = require('node:fs');
const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const referenceManager = require('../services/referenceManager');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiService');
const sceneAnalyzer = require('../services/sceneAnalyzer');
const carouselPlannerService = require('../services/carouselPlannerService');
const sceneMemoryService = require('../services/sceneMemoryService');
const outfitMemoryService = require('../services/outfitMemoryService');
const batchGenerator = require('../services/batchGenerator');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');

const router = express.Router();
const MAX_BATCH_PROMPTS = 20;
const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];
const VALID_KINETIC_BLUR_MODES = ['off', 'some', 'more'];

function normalizeActiveReferenceIds(activeReferenceIds) {
  return Array.isArray(activeReferenceIds)
    ? activeReferenceIds.filter((id) => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
    : [];
}

function resolveActiveReferenceIds(activeReferenceIds, character) {
  const provided = normalizeActiveReferenceIds(activeReferenceIds);
  if (provided.length > 0) return provided;
  if (character && (character.profileImage || character.primaryImageFile)) {
    return ['__profile__'];
  }
  return [];
}

function startMultiBatches(entries, generationOptions, characterContext = {}) {
  const jobIds = [];
  const grouped = new Map();

  for (const entry of entries) {
    const key = [
      entry.sceneMemoryId || '',
      entry.outfitId || '',
      entry.cameraProfileId || '',
    ].join('::');

    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }

  for (const group of grouped.values()) {
    for (let i = 0; i < group.length; i += MAX_BATCH_PROMPTS) {
      const chunk = group.slice(i, i + MAX_BATCH_PROMPTS);
      if (chunk.length === 0) continue;

      const config = {
        prompts: chunk.map((entry) => entry.prompt),
        sceneMemoryId: chunk[0].sceneMemoryId || null,
        outfitId: chunk[0].outfitId || null,
        cameraProfileId: chunk[0].cameraProfileId || null,
        characterId: characterContext.characterId || null,
        activeReferenceIds: Array.isArray(characterContext.activeReferenceIds)
          ? characterContext.activeReferenceIds
          : [],
      };
      const job = batchGenerator.startBatch('multi', config, generationOptions);
      jobIds.push(job.jobId);
    }
  }

  return jobIds;
}

function buildSceneMemoryForPlan(plan) {
  const anchor = asText(plan && plan.sceneAnchor);
  if (!anchor) return null;
  return sceneMemoryService.createScene({
    name: `Carousel Scene: ${anchor}`.slice(0, 120),
    architecture: anchor,
    lightingProfile: 'cinematic mixed lighting',
    colorPalette: 'balanced premium tones',
    recurringElements: anchor,
    timeOfDayBias: 'mixed',
  });
}

function getOrCreateOutfit(outfitCache, outfitLabel) {
  const key = asText(outfitLabel) || 'coordinated premium outfit';
  if (outfitCache.has(key)) return outfitCache.get(key);

  const created = outfitMemoryService.createOutfit({
    name: `Carousel Outfit: ${key}`.slice(0, 120),
    top: key,
    bottom: `Coordinated bottom aligned with ${key}`,
    accessories: `Accessories aligned with ${key}`,
    footwear: `Footwear aligned with ${key}`,
  });
  outfitCache.set(key, created);
  return created;
}

function buildSlidePrompt(slide, narrative) {
  const safeSlide = slide || {};
  return [
    `CAROUSEL SLIDE ${safeSlide.slide || 1}`,
    `Narrative: ${asText(narrative)}`,
    `Shot type: ${asText(safeSlide.shotType)}`,
    `Framing type: ${asText(safeSlide.framingType)}`,
    `Angle type: ${asText(safeSlide.angleType)}`,
    `Expression: ${asText(safeSlide.expressionType)}`,
    `Pose: ${asText(safeSlide.pose)}`,
    `Outfit intent: ${asText(safeSlide.outfit)}`,
    `Location hint: ${asText(safeSlide.locationHint)}`,
    `Scene context: ${asText(safeSlide.userSceneContext)}`,
  ].join('\n');
}

function withImageQualityLock(prompt, { allowMotionBlur = false } = {}) {
  const blurRule = allowMotionBlur
    ? 'Allow only intentional cinematic motion blur from movement; keep face and identity-defining details crisp.'
    : 'No motion blur. No soft focus. No haze. No lens-smear look.';

  return [
    prompt,
    '',
    '[IMAGE QUALITY LOCK]',
    'Target output quality: ultra-clean 2K render with high micro-contrast and crisp edge detail.',
    'Preserve realistic skin texture without waxy smoothing.',
    blurRule,
    '[END IMAGE QUALITY LOCK]',
  ].join('\n');
}

function getKineticBlurSettings(mode) {
  if (mode === 'some') return { enabled: true, ratio: 0.35 };
  if (mode === 'more') return { enabled: true, ratio: 0.55 };
  return { enabled: false, ratio: 0 };
}

function selectKineticBlurIndices(total, ratio) {
  const count = Number.isInteger(total) ? total : 0;
  if (count <= 0 || ratio <= 0) return new Set();

  const target = Math.max(1, Math.min(count, Math.round(count * ratio)));
  const candidates = [];
  for (let i = 0; i < count; i += 1) {
    candidates.push(i);
  }

  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  return new Set(candidates.slice(0, target));
}

function withKineticBlurPrompt(prompt, level = 'subtle') {
  const modeLine = level === 'strong'
    ? 'Use strong cinematic kinetic motion blur from subject movement or camera pan.'
    : 'Use subtle cinematic kinetic motion blur from subject movement or camera pan.';

  return [
    prompt,
    '',
    '[KINETIC MOTION BLUR]',
    modeLine,
    'Keep face and key identity-defining features clear and recognizable.',
    'Do not change outfit, location, lighting identity, or character identity.',
    '[END KINETIC MOTION BLUR]',
  ].join('\n');
}

function ensureImageInStore(imageId) {
  try {
    imageStore.get(imageId);
    return imageId;
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
    return imported.imageId;
  }
}

function importInlineImageToStore({ imageBase64, mimeType }) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new AppError('"imageBase64" is required for inline image import', 400, 'VALIDATION_ERROR');
  }
  if (!mimeType || typeof mimeType !== 'string') {
    throw new AppError('"mimeType" is required for inline image import', 400, 'VALIDATION_ERROR');
  }

  let base64Data = imageBase64.trim();
  const dataUriMatch = base64Data.match(/^data:image\/[\w.+-]+;base64,(.+)$/i);
  if (dataUriMatch) base64Data = dataUriMatch[1];

  const imported = imageStore.store({
    basePrompt: 'Inline uploaded image',
    characterId: null,
    activeReferenceIds: null,
    sceneDescription: null,
    modelUsed: null,
    seed: null,
    parentImageId: null,
    variationIndex: null,
    image: {
      mimeType,
      base64Data,
    },
    source: 'generate',
  });
  return imported.imageId;
}

function parseJsonFromText(rawText) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]); } catch { /* fallback below */ }
    }
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); } catch { /* fallback below */ }
    }
    return null;
  }
}

function uniqueNonEmptyStrings(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const value = asText(item);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeDeltaDirection(direction) {
  const raw = asText(direction);
  if (!raw) return '';

  // Drop continuity/style instructions from user/model text so follow-up remains delta-only.
  let cleaned = raw
    .replace(/\b(same outfit|same scene|same style|same lighting|identity lock|strict continuity)\b/gi, '')
    .replace(/\b(phone selfie|selfie camera|camera style|camera angle|lens|focal|lighting|illumination|exposure)\b/gi, '')
    .replace(/\b(scene|background|location|environment|wardrobe|clothing|outfit)\b/gi, '')
    .replace(/\b(bright|harsh frontal light|clean white|flat illumination)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Keep only short delta clauses that typically indicate pose/expression/view changes.
  const chunks = cleaned
    .split(/[.;\n|]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const allowed = [];
  for (const chunk of chunks) {
    const lower = chunk.toLowerCase();
    const looksLikeDelta =
      /(pose|expression|gaze|chin|head|hand|viewer|angle|lean|turn|look|smile|relaxed|confident|upper body|close[- ]?up|framing)/i.test(lower);
    const looksLikeContinuity =
      /(lighting|scene|background|outfit|clothing|camera|lens|environment|location)/i.test(lower);
    if (looksLikeDelta && !looksLikeContinuity) {
      allowed.push(chunk);
    }
  }

  const out = allowed.join('; ').trim();
  return out || cleaned;
}

function extractWardrobeLock(baseMetadata) {
  const candidates = [
    asText(baseMetadata && baseMetadata.sceneDescription),
    asText(baseMetadata && baseMetadata.basePrompt),
  ].filter(Boolean);

  for (const source of candidates) {
    const outfitIntent = source.match(/Outfit intent:\s*([^\n]+)/i);
    if (outfitIntent && outfitIntent[1]) return outfitIntent[1].trim();

    const outfit = source.match(/Outfit:\s*([^\n|]+)/i);
    if (outfit && outfit[1]) return outfit[1].trim();

    const top = source.match(/top:\s*([^\n]+)/i);
    const bottom = source.match(/bottom:\s*([^\n]+)/i);
    if (top || bottom) {
      return [top ? `top ${top[1].trim()}` : '', bottom ? `bottom ${bottom[1].trim()}` : '']
        .filter(Boolean)
        .join(', ');
    }
  }

  return '';
}

function buildLockedModificationPrompt({ direction, strictContinuityLock = true, wardrobeLock = '' }) {
  const variationRequest = normalizeDeltaDirection(direction)
    || 'Viewer/subject angle change, hand change, head tilt change, pose change, expression change.';
  if (!strictContinuityLock) return variationRequest;

  const wardrobeLine = wardrobeLock
    ? `Exact wardrobe lock: ${wardrobeLock}. Do not change garment type, color, or silhouette.`
    : 'Exact wardrobe lock: same clothing as base image. Do not change garment type, color, or silhouette.';

  return [
    'Maintain full strict 100% identity lock.',
    'Same scene, same camera style, same lighting.',
    'Image quality lock: tack-sharp focus, crisp facial detail, high texture fidelity, no haze or soft-focus wash.',
    wardrobeLine,
    'Subtle-change mode: micro-variation only (about 5-15% change from base image).',
    'Do not introduce dramatic new composition, distance, or body-position extremes.',
    'Only change what is requested below.',
    `Change only: ${variationRequest}`,
  ].join(' ');
}

function buildFallbackFollowUpDirections(
  sceneData,
  count,
  manualDirection = '',
  strictContinuityLock = true,
  wardrobeLock = ''
) {
  const safeCount = Math.max(1, Math.min(10, Number.isInteger(count) ? count : 4));
  const framingPool = [
    'slight off-center framing adjustment',
    'small three-quarter framing shift',
    'minor crop variation with same camera distance',
    'gentle headroom change',
    'slight lateral framing offset',
    'subtle perspective nudge at similar focal feel',
  ];
  const posePool = [
    'small shoulder turn',
    'slight chin tilt adjustment',
    'gentle hand placement change',
    'minor torso angle shift',
    'light head orientation change',
    'subtle posture relaxation',
  ];
  const expressionPool = [
    'expression: slight confident smile',
    'expression: soft neutral gaze',
    'expression: very mild smirk',
    'expression: calm relaxed look',
    'expression: subtle look-away',
    'expression: composed editorial softness',
  ];

  const directions = [];
  for (let i = 0; i < safeCount; i += 1) {
    const framing = framingPool[i % framingPool.length];
    const pose = posePool[i % posePool.length];
    const expression = expressionPool[i % expressionPool.length];
    const variation = [
      `Follow-up variant ${i + 1}: ${framing}; ${pose}; ${expression}.`,
      manualDirection ? `Extra direction: ${normalizeDeltaDirection(manualDirection)}.` : '',
    ].filter(Boolean).join(' ');
    directions.push(buildLockedModificationPrompt({ direction: variation, strictContinuityLock, wardrobeLock }));
  }
  return directions;
}

async function buildAIFollowUpDirections({
  imageBase64,
  mimeType,
  count,
  manualDirection = '',
  strictContinuityLock = true,
  wardrobeLock = '',
}) {
  const safeCount = Math.max(1, Math.min(10, Number.isInteger(count) ? count : 4));
  const sceneData = await sceneAnalyzer.analyzeScene(imageBase64, mimeType);
  const prompt = `You generate unique follow-up image edit instructions.

Input scene analysis:
${JSON.stringify(sceneData, null, 2)}

Task:
- Return exactly ${safeCount} unique follow-up modification prompts.
- Each prompt MUST vary framing, posing, and expression.
- Prompts must be DELTA-ONLY: describe only what should change.
- Do not restate scene/outfit/camera continuity in each prompt.
- Base wardrobe lock reference: ${wardrobeLock || 'same exact outfit as base image'}.
- Keep variation subtle: micro-adjustments only (about 5-15% change).
- Avoid dramatic changes in camera distance, body orientation, or composition style.
- Prefer one primary change + one secondary tweak per prompt.
- Keep same single female identity.
- No male interaction, no couples.
${manualDirection ? `- Also respect this manual direction (delta-only): ${normalizeDeltaDirection(manualDirection)}` : ''}

Return JSON only in this format:
{
  "prompts": ["...", "..."]
}`;

  const apiKey = apiKeyManager.getActiveKey();
  let parsed = null;
  try {
    const raw = await geminiService.generateText(apiKey, prompt, {
      temperature: 0.5,
      responseMimeType: 'application/json',
    });
    parsed = parseJsonFromText(raw);
  } catch {
    parsed = null;
  }

  const fromModel = uniqueNonEmptyStrings(
    parsed && Array.isArray(parsed.prompts) ? parsed.prompts : []
  );

  const modelPrompts = fromModel.map((item) => buildLockedModificationPrompt({
    direction: item,
    strictContinuityLock,
    wardrobeLock,
  }));

  if (modelPrompts.length >= safeCount) {
    return modelPrompts.slice(0, safeCount);
  }

  const fallback = buildFallbackFollowUpDirections(
    sceneData,
    safeCount,
    manualDirection,
    strictContinuityLock,
    wardrobeLock
  );
  const merged = uniqueNonEmptyStrings([...modelPrompts, ...fallback]);
  return merged.slice(0, safeCount);
}

router.post('/plan', async (req, res, next) => {
  try {
    const {
      narrative,
      characterId,
      slideCount = 5,
      allowOutfitChanges = false,
    } = req.body || {};

    if (!narrative || typeof narrative !== 'string' || narrative.trim().length === 0) {
      throw new AppError('"narrative" is required', 400, 'VALIDATION_ERROR');
    }
    if (!Number.isInteger(slideCount) || slideCount < 1 || slideCount > 10) {
      throw new AppError('"slideCount" must be an integer between 1 and 10', 400, 'VALIDATION_ERROR');
    }
    if (typeof allowOutfitChanges !== 'boolean') {
      throw new AppError('"allowOutfitChanges" must be boolean', 400, 'VALIDATION_ERROR');
    }

    const character = (characterId && typeof characterId === 'string')
      ? referenceManager.getCharacter(characterId)
      : null;

    const plan = await carouselPlannerService.generateCarouselPlan({
      narrative: narrative.trim(),
      slideCount,
      allowOutfitChanges,
      character,
    });

    res.json({ success: true, data: plan });
  } catch (err) {
    next(err);
  }
});

router.post('/execute', async (req, res, next) => {
  try {
    const {
      narrative,
      plan,
      characterId,
      activeReferenceIds,
      slideCount = 5,
      allowOutfitChanges = false,
      kineticMotionBlur = 'off',
      aspectRatio,
      resolutionTier,
    } = req.body || {};

    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
    }

    const finalAspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '4:5';
    const finalImageSize = VALID_IMAGE_SIZES.includes(resolutionTier) ? resolutionTier : '2K';
    const blurMode = VALID_KINETIC_BLUR_MODES.includes(kineticMotionBlur) ? kineticMotionBlur : 'off';
    const character = referenceManager.getCharacter(characterId);
    const resolvedActiveReferenceIds = resolveActiveReferenceIds(activeReferenceIds, character);

    let resolvedPlan = plan;
    if (!resolvedPlan || typeof resolvedPlan !== 'object' || !Array.isArray(resolvedPlan.slides)) {
      if (!narrative || typeof narrative !== 'string' || narrative.trim().length === 0) {
        throw new AppError('Provide either "plan" or "narrative"', 400, 'VALIDATION_ERROR');
      }
      resolvedPlan = await carouselPlannerService.generateCarouselPlan({
        narrative: narrative.trim(),
        slideCount,
        allowOutfitChanges,
        character,
      });
    }

    if (!Array.isArray(resolvedPlan.slides) || resolvedPlan.slides.length === 0) {
      throw new AppError('Carousel plan has no slides', 400, 'VALIDATION_ERROR');
    }

    const sceneMemory = buildSceneMemoryForPlan(resolvedPlan);
    const sceneMemoryId = sceneMemory ? sceneMemory.id : null;
    const outfitCache = new Map();
    const blurSettings = getKineticBlurSettings(blurMode);
    const blurIndices = blurSettings.enabled
      ? selectKineticBlurIndices(resolvedPlan.slides.length, blurSettings.ratio)
      : new Set();
    const entries = resolvedPlan.slides.map((slide, index) => {
      const outfit = getOrCreateOutfit(outfitCache, slide.outfit);
      const basePrompt = buildSlidePrompt(slide, resolvedPlan.narrative || narrative || 'carousel narrative');
      const qualityLockedPrompt = withImageQualityLock(basePrompt, {
        allowMotionBlur: blurIndices.has(index),
      });
      const prompt = blurIndices.has(index)
        ? withKineticBlurPrompt(qualityLockedPrompt, blurMode === 'more' ? 'strong' : 'subtle')
        : qualityLockedPrompt;
      return {
        type: 'carousel',
        prompt,
        sceneMemoryId,
        outfitId: outfit.id,
        cameraProfileId: slide.cameraProfileId || 'iphone_selfie',
        slide: index + 1,
        kineticMotionBlur: blurIndices.has(index),
      };
    });

    const jobIds = startMultiBatches(
      entries,
      { aspectRatio: finalAspectRatio, imageSize: finalImageSize },
      { characterId, activeReferenceIds: resolvedActiveReferenceIds }
    );

    res.status(202).json({
      success: true,
      data: {
        totalImages: entries.length,
        jobIds,
        sceneMemoryId,
        plan: resolvedPlan,
        kineticMotionBlur: {
          mode: blurMode,
          appliedSlides: entries.filter((entry) => entry.kineticMotionBlur).map((entry) => entry.slide),
        },
        formatLock: {
          aspectRatio: finalAspectRatio,
          imageSize: finalImageSize,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/follow-up', async (req, res, next) => {
  try {
    const {
      imageId,
      imageBase64,
      mimeType,
      characterId,
      activeReferenceIds,
      count = 4,
      direction = '',
      followUpMode = 'manual',
      strictContinuityLock = true,
      useCharacterRefsInFollowUp = false,
      aspectRatio,
      resolutionTier,
    } = req.body || {};

    if ((!imageId || typeof imageId !== 'string') && (!imageBase64 || typeof imageBase64 !== 'string')) {
      throw new AppError('Provide "imageId" or "imageBase64"', 400, 'VALIDATION_ERROR');
    }
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw new AppError('"count" must be an integer between 1 and 10', 400, 'VALIDATION_ERROR');
    }
    if (followUpMode !== 'manual' && followUpMode !== 'ai') {
      throw new AppError('"followUpMode" must be "manual" or "ai"', 400, 'VALIDATION_ERROR');
    }
    if (typeof strictContinuityLock !== 'boolean') {
      throw new AppError('"strictContinuityLock" must be boolean', 400, 'VALIDATION_ERROR');
    }
    if (typeof useCharacterRefsInFollowUp !== 'boolean') {
      throw new AppError('"useCharacterRefsInFollowUp" must be boolean', 400, 'VALIDATION_ERROR');
    }

    let resolvedCharacterId = null;
    let resolvedActiveReferenceIds = [];
    if (characterId && typeof characterId === 'string') {
      const character = referenceManager.getCharacter(characterId);
      resolvedCharacterId = characterId;
      resolvedActiveReferenceIds = resolveActiveReferenceIds(activeReferenceIds, character);
    }

    const finalAspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '4:5';
    const finalImageSize = VALID_IMAGE_SIZES.includes(resolutionTier) ? resolutionTier : '2K';
    const resolvedImageId = (imageBase64 && mimeType)
      ? importInlineImageToStore({ imageBase64, mimeType })
      : ensureImageInStore(imageId);
    const moodBlock = asText(direction) || 'new framing, new posing, and new expression while preserving scene continuity';

    let jobId = null;
    let jobIds = [];

    const base = imageStore.get(resolvedImageId);
    if (!base || !base.image || !base.image.base64Data || !base.image.mimeType) {
      throw new AppError('Selected image data unavailable for follow-up', 400, 'VALIDATION_ERROR');
    }
    const wardrobeLock = extractWardrobeLock(base);

    if (followUpMode === 'ai') {
      const prompts = await buildAIFollowUpDirections({
        imageBase64: base.image.base64Data,
        mimeType: base.image.mimeType,
        count,
        manualDirection: moodBlock,
        strictContinuityLock,
        wardrobeLock,
      });

      for (const modificationPrompt of prompts) {
        const job = batchGenerator.startBatch('edit', {
          imageId: resolvedImageId,
          modificationPrompt,
          count: 1,
          characterId: resolvedCharacterId,
          activeReferenceIds: resolvedActiveReferenceIds,
          disableCharacterReferenceImages: !useCharacterRefsInFollowUp,
          disableCharacterIdentityLock: !useCharacterRefsInFollowUp,
        }, {
          aspectRatio: finalAspectRatio,
          imageSize: finalImageSize,
        });
        jobIds.push(job.jobId);
      }
      jobId = jobIds[0] || null;
    } else {
      const manualPrompt = strictContinuityLock
        ? buildLockedModificationPrompt({
          direction: moodBlock,
          strictContinuityLock,
          wardrobeLock,
        })
        : moodBlock;
      const job = batchGenerator.startBatch('edit', {
        imageId: resolvedImageId,
        modificationPrompt: manualPrompt,
        count,
        characterId: resolvedCharacterId,
        activeReferenceIds: resolvedActiveReferenceIds,
        disableCharacterReferenceImages: !useCharacterRefsInFollowUp,
        disableCharacterIdentityLock: !useCharacterRefsInFollowUp,
      }, {
        aspectRatio: finalAspectRatio,
        imageSize: finalImageSize,
      });
      jobId = job.jobId;
      jobIds = [job.jobId];
    }

    res.status(202).json({
      success: true,
      data: {
        jobId,
        jobIds,
        count,
        imageId: resolvedImageId,
        followUpMode,
        strictContinuityLock,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/carousel/polls
 * Generate "This or That" engagement poll carousel content.
 *
 * Body: {
 *   topic: string,               — poll theme (e.g. "beach vs city", "morning vs night")
 *   characterId?: string,
 *   activeReferenceIds?: string[],
 *   pollCount?: number,          — number of poll questions (1-5, default 3)
 *   aspectRatio?: string,
 *   resolutionTier?: string,
 * }
 *
 * Returns: { polls: [{question, optionA, optionB}], jobIds, totalImages }
 */
router.post('/polls', async (req, res, next) => {
  try {
    const {
      topic,
      characterId,
      activeReferenceIds,
      pollCount = 3,
      aspectRatio,
      resolutionTier,
    } = req.body || {};

    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      throw new AppError('"topic" is required', 400, 'VALIDATION_ERROR');
    }
    const safePollCount = Math.max(1, Math.min(5, Number.isInteger(pollCount) ? pollCount : 3));

    const finalAspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '4:5';
    const finalImageSize = VALID_IMAGE_SIZES.includes(resolutionTier) ? resolutionTier : '2K';

    let character = null;
    let resolvedActiveReferenceIds = [];
    if (characterId && typeof characterId === 'string') {
      character = referenceManager.getCharacter(characterId);
      resolvedActiveReferenceIds = resolveActiveReferenceIds(activeReferenceIds, character);
    }

    // Generate poll questions + contrasting image prompts via Gemini
    const pollPrompt = `You generate "This or That" engagement poll content for Instagram carousels.

Topic: ${topic.trim()}

Task:
- Generate exactly ${safePollCount} poll questions.
- Each poll has a question and two contrasting visual options (A and B).
- Each option needs a short label (2-5 words) and a detailed image generation prompt.
- Image prompts should describe the same person in contrasting scenarios/styles/settings.
- Keep the same single female subject identity across all prompts.
- Make prompts vivid and specific for AI image generation.
- No couples, no male interaction.

Return JSON only:
{
  "polls": [
    {
      "question": "Which vibe are you?",
      "optionA": { "label": "Beach Day", "prompt": "detailed image prompt for option A..." },
      "optionB": { "label": "City Night", "prompt": "detailed image prompt for option B..." }
    }
  ]
}`;

    const apiKey = apiKeyManager.getActiveKey();
    let parsed = null;
    try {
      const raw = await geminiService.generateText(apiKey, pollPrompt, {
        temperature: 0.6,
        responseMimeType: 'application/json',
      });
      parsed = parseJsonFromText(raw);
    } catch {
      parsed = null;
    }

    const polls = (parsed && Array.isArray(parsed.polls) ? parsed.polls : [])
      .filter(p => p && p.question && p.optionA?.prompt && p.optionB?.prompt)
      .slice(0, safePollCount);

    if (polls.length === 0) {
      throw new AppError('Failed to generate poll content. Try a different topic.', 500, 'GENERATION_FAILED');
    }

    // Build image entries from poll options (2 images per poll)
    const entries = [];
    for (const poll of polls) {
      entries.push({
        type: 'carousel',
        prompt: withImageQualityLock(poll.optionA.prompt),
        sceneMemoryId: null,
        outfitId: null,
        cameraProfileId: 'iphone_selfie',
      });
      entries.push({
        type: 'carousel',
        prompt: withImageQualityLock(poll.optionB.prompt),
        sceneMemoryId: null,
        outfitId: null,
        cameraProfileId: 'iphone_selfie',
      });
    }

    const jobIds = startMultiBatches(
      entries,
      { aspectRatio: finalAspectRatio, imageSize: finalImageSize },
      { characterId: characterId || null, activeReferenceIds: resolvedActiveReferenceIds }
    );

    res.status(202).json({
      success: true,
      data: {
        polls,
        jobIds,
        totalImages: entries.length,
        formatLock: {
          aspectRatio: finalAspectRatio,
          imageSize: finalImageSize,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
