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
const PHOTO_MATCH_REF_MAX_DIMENSION = 1536;
const PHOTO_MATCH_IDENTITY_MAX_DIMENSION = 896;
const PHOTO_MATCH_MAX_IDENTITY_IMAGES = 3;
const ANALYSIS_FALLBACK_CODES = new Set(['GEMINI_TRANSIENT', 'GEMINI_ERROR', 'PARSE_ERROR', 'GENERATION_EMPTY']);

async function optimizeImage(base64Data, mimeType, dim = PHOTO_MATCH_REF_MAX_DIMENSION) {
  if (!base64Data || typeof base64Data !== 'string') return null;
  if (!mimeType || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) return null;
  try {
    const resized = await sharp(Buffer.from(base64Data, 'base64'))
      .rotate()
      .resize(dim, dim, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { mimeType: 'image/jpeg', base64Data: resized.toString('base64') };
  } catch {
    return { mimeType, base64Data };
  }
}

function identityLabel(index) {
  return `Image 1${String.fromCharCode(65 + index)}`;
}

// Build labeled-image parts array (Image 1A/1B/1C = identity, Image 2 = source target)
function buildPhotoMatchParts({ sourceImage, identityImages, characterName, prompt }) {
  const parts = [];
  const name = characterName || 'the character';
  const refs = Array.isArray(identityImages) ? identityImages : [];

  refs.forEach((identityImage, index) => {
    const label = identityLabel(index);
    parts.push({
      text: `[${label} - ${name.toUpperCase()} IDENTITY REFERENCE]\nUse this reference only for ${name}'s identity: face, skin tone, hair, body shape, body proportions, curves, breast size/volume, makeup, and recognizable likeness. Combine all Image 1 references into one consistent identity. Do not copy these images' outfits, poses, cameras, backgrounds, or lighting.`,
    });
    parts.push({ inlineData: { mimeType: identityImage.mimeType, data: identityImage.base64Data } });
  });

  // Image 2: Source scene
  parts.push({
    text: `[Image 2 - LOCKED TARGET PHOTO]\nThis is the photo to recreate. Preserve Image 2 as the blueprint for the final output: same framing, crop, camera angle, lens perspective, pose, hand placement, outfit, background, props, lighting, shadows, colors, and composition. Replace only the person's identity with ${name} from ${refs.length > 0 ? 'the Image 1 identity references' : 'the character identity reference'}.`,
  });
  parts.push({ inlineData: { mimeType: sourceImage.mimeType, data: sourceImage.base64Data } });

  // Final prompt
  parts.push({ text: prompt.trim() });
  return parts;
}

function buildBgInstruction(strength) {
  if (strength >= 85) return 'EXACTLY REPLICATE the background from Image 2: identical environment, same location, same colors, same lighting, same depth';
  if (strength >= 60) return 'closely match the background from Image 2: same type of location, similar colors and lighting';
  if (strength >= 35) return 'use a similar background to Image 2';
  return 'take loose background inspiration from Image 2';
}

function buildPoseInstruction(strength) {
  if (strength >= 85) return 'EXACTLY REPLICATE the body pose from Image 2: identical stance, same weight distribution, same arm/hand placement, same head angle';
  if (strength >= 60) return 'closely match the body pose from Image 2';
  if (strength >= 35) return 'use a similar pose to Image 2';
  return 'take loose pose inspiration from Image 2';
}

// POST /api/photo-match/recreate
router.post('/recreate', requirePlanCapacity(), async (req, res, next) => {
  let runId = null;
  try {
    const {
      image, mimeType, characterId, activeReferenceIds,
      bgStrength = 80, poseStrength = 80, imageModel, matchMode,
      varyBackground = false,
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

    // Scene analysis
    let sceneData = {};
    try {
      sceneData = await sceneAnalyzer.analyzeScene(base64, mimeType);
    } catch (err) {
      if (!ANALYSIS_FALLBACK_CODES.has(err?.code)) throw err;
      log.warn('photo_match_scene_analysis_failed', { code: err.code || 'UNKNOWN', message: err.message, characterId });
      sceneData = {};
    }

    // Character + refs - keep the source locked, plus a small identity set for likeness.
    const character = referenceManager.getCharacter(characterId);
    const refIds = Array.isArray(activeReferenceIds) ? activeReferenceIds : null;
    const activeRefs = referenceManager.getActiveReferences(characterId, refIds);
    const allRefs = buildCharacterReferenceImages(characterId, activeRefs);

    const identityImages = (await Promise.all(
      allRefs
        .slice(0, PHOTO_MATCH_MAX_IDENTITY_IMAGES)
        .map((ref) => optimizeImage(ref.base64Data, ref.mimeType, PHOTO_MATCH_IDENTITY_MAX_DIMENSION))
    )).filter(Boolean);
    const sourceImage = await optimizeImage(base64, mimeType, PHOTO_MATCH_REF_MAX_DIMENSION);
    if (!sourceImage) throw new AppError('Unable to process source image', 400, 'VALIDATION_ERROR');

    // Build prompt
    const sceneParts = [];
    if (sceneData.environment) sceneParts.push(`Environment: ${sceneData.environment}`);
    if (sceneData.lighting) sceneParts.push(`Lighting: ${sceneData.lighting}`);
    if (sceneData.camera) sceneParts.push(`Camera: ${sceneData.camera}`);
    if (sceneData.composition) sceneParts.push(`Composition: ${sceneData.composition}`);
    if (sceneData.mood) sceneParts.push(`Mood: ${sceneData.mood}`);
    if (sceneData.pose) sceneParts.push(`Pose: ${sceneData.pose}`);
    if (sceneData.expression) sceneParts.push(`Expression: ${sceneData.expression}`);
    if (sceneData.outfit) sceneParts.push(`Outfit: ${sceneData.outfit}`);

    const prompt = [
      exactMode
        ? `Recreate Image 2 as exactly as possible, replacing only the person's identity with ${character.name} from the Image 1 identity references.`
        : `Create a photorealistic image of ${character.name} in the scene from Image 2.`,
      '',
      identityImages.length > 0
        ? `WHO: ${character.name} - face, skin tone, hair, body shape, body proportions, curves, breast size/volume, makeup, and recognizable likeness come from ${identityImages.map((_, i) => identityLabel(i)).join(', ')}. Merge these into one consistent person.`
        : `WHO: ${character.name} - use the saved character identity.`,
      `LOCKED SOURCE PHOTO: Image 2 is not inspiration. It is the target photo layout. Keep the same crop, camera distance, angle, pose, gesture, outfit, background, lighting, shadows, colors, and object placement.`,
      '',
      `SCENE from Image 2: ${buildBgInstruction(bg)}. ${buildPoseInstruction(pose)}.`,
      identityImages.length > 0
        ? `BODY SHAPE: Body shape, curves, and breast size/volume come from the Image 1 identity references. Pose, gesture, outfit, and accessories come from Image 2 exactly.`
        : null,
      identityImages.length > 0
        ? `The Image 1 references provide identity only (face, skin, hair, body shape). Image 2 provides pose, outfit, and scene.`
        : null,
      `Match expression, gaze direction, hand placement, head tilt, and body language from Image 2.`,
      '',
      'RULES:',
      identityImages.length > 0 ? `- Do NOT copy face, skin, body, or hair from Image 2` : null,
      `- The output person is ${character.name} only`,
      `- Sacrifice Image 2 person's likeness to preserve ${character.name}'s identity`,
      exactMode ? `- Do not redesign anything: same outfit, same pose, same background, same crop, same camera angle, same lighting` : null,
      exactMode ? `- Do not beautify, recompose, zoom, rotate, change location, change clothing, or invent a new scene` : null,
      '',
      varyBackground && !exactMode ? 'BACKGROUND VARIATION: Keep same location type but shift lighting, add minor details, different moment.' : null,
      varyBackground && !exactMode ? '' : null,
      sceneParts.length > 0 ? `SCENE DETAILS:\n${sceneParts.join('\n')}` : null,
      '',
      character.masterPrompt ? `ADDITIONAL IDENTITY: ${character.masterPrompt}` : null,
      '',
      'Return exactly one image. No text.',
      REALISM_DIRECTIVE,
    ].filter((s) => s != null).join('\n');

    // Build parts with numbered image references
    const parts = buildPhotoMatchParts({ sourceImage, identityImages, characterName: character.name, prompt });

    const apiKey = apiKeyManager.getActiveKeyOrNull();
    runId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'photo-match',
      provider: 'gemini',
      model: imageModel || null,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.started',
      entityType: 'generation_run',
      entityId: runId,
      source: 'photo-match',
      payload: { feature: 'photo-match', model: imageModel || null, characterId },
    });

    const result = await geminiService.generateImage(apiKey, prompt, {
      aspectRatio,
      imageSize: resolutionTier,
      parts,
      model: imageModel,
      characterId,
      requireImageInputs: true,
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
      provider: 'gemini',
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
      provider: 'gemini',
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
