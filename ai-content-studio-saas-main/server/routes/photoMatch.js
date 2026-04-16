'use strict';
const express = require('express');
const sharp = require('sharp');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiService');
const sceneAnalyzer = require('../services/sceneAnalyzer');
const referenceManager = require('../services/referenceManager');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const log = require('../utils/logger');
const { resolveDimensions } = require('../services/dimensionResolver');
const { AppError } = require('../middleware/errorHandler');
const { requirePlanCapacity } = require('../middleware/planLimits');
const REALISM_DIRECTIVE = require('../utils/realismDirective');

const router = express.Router();
const PHOTO_MATCH_REF_MAX_DIMENSION = 896;
const PHOTO_MATCH_IDENTITY_MAX_DIMENSION = 2048; // keep character identity refs higher res than the scene blueprint
const ANALYSIS_FALLBACK_CODES = new Set(['GEMINI_TRANSIENT', 'GEMINI_ERROR', 'PARSE_ERROR', 'GENERATION_EMPTY']);

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

function outfitInstruction(exactMode) {
  if (exactMode) {
    return 'EXACTLY REPLICATE the outfit and styling: same clothing pieces, same fit, same neckline, same sleeves, same hem length, same accessories, same colors, same textures, same layering, and same overall styling. Do not redesign or substitute the outfit.';
  }
  return 'keep the outfit and styling very close to the reference image unless the character identity references require small adjustments.';
}

function framingInstruction(exactMode) {
  if (exactMode) {
    return 'EXACTLY REPLICATE framing and composition: same crop, same camera distance, same lens feel, same subject scale, same body framing, same perspective, same headroom, and same placement in frame.';
  }
  return 'closely match the composition, framing, and camera perspective from the reference image.';
}

function expressionInstruction(exactMode) {
  if (exactMode) {
    return 'EXACTLY REPLICATE the expression, gaze direction, and overall attitude from the source image. Do NOT copy the facial structure, skin tone, hair color, hairline, or hair style of the person in the source image — use the character identity references only.';
  }
  return 'keep the expression, gaze, and head position close to the source image. Do NOT copy the facial structure, skin tone, hair color, hairline, or hair style of the person in the source image — use the character identity references only.';
}

async function optimizeInlineImage(base64Data, mimeType) {
  if (!base64Data || typeof base64Data !== 'string') return null;
  if (!mimeType || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) return null;

  try {
    const resized = await sharp(Buffer.from(base64Data, 'base64'))
      .rotate()
      .resize(PHOTO_MATCH_REF_MAX_DIMENSION, PHOTO_MATCH_REF_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return {
      mimeType: 'image/jpeg',
      base64Data: resized.toString('base64'),
    };
  } catch {
    return { mimeType, base64Data };
  }
}

async function optimizeIdentityImage(base64Data, mimeType) {
  if (!base64Data || typeof base64Data !== 'string') return null;
  if (!mimeType || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) return null;
  try {
    const resized = await sharp(Buffer.from(base64Data, 'base64'))
      .rotate()
      .resize(PHOTO_MATCH_IDENTITY_MAX_DIMENSION, PHOTO_MATCH_IDENTITY_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { mimeType: 'image/jpeg', base64Data: resized.toString('base64') };
  } catch {
    return { mimeType, base64Data };
  }
}

async function buildPhotoMatchIdentityImages(characterId, activeRefs) {
  const results = [];

  // Primary image(s) first — higher res for identity
  const primaries = referenceManager.getPrimaryImages(characterId);
  for (const primary of primaries) {
    if (!primary?.buffer?.length) continue;
    const optimized = await optimizeIdentityImage(primary.buffer.toString('base64'), primary.mimeType);
    if (optimized) results.push(optimized);
  }

  // All active reference images
  if (Array.isArray(activeRefs)) {
    for (const ref of activeRefs) {
      const data = referenceManager.getReferenceImage(characterId, ref.id);
      if (!data?.buffer?.length) continue;
      const optimized = await optimizeIdentityImage(data.buffer.toString('base64'), data.mimeType);
      if (optimized) results.push(optimized);
    }
  }

  // Allow up to 5 identity images so multi-primary characters keep stronger identity lock.
  return results.slice(0, 5);
}

function buildPhotoMatchParts({ sourceImage, identityImages, characterName, prompt, exactMode = false }) {
  const parts = [];
  const refCount = Array.isArray(identityImages) ? identityImages.length : 0;
  const sourceNum = refCount + 1;
  const name = characterName || 'the character';

  // Build ref label e.g. "Image 1", "Images 1 and 2", "Images 1, 2 and 3"
  const refLabel = refCount === 0 ? null
    : refCount === 1 ? 'Image 1'
    : refCount === 2 ? 'Images 1 and 2'
    : `Images 1, ${Array.from({ length: refCount - 2 }, (_, i) => i + 2).join(', ')} and ${refCount}`;

  // --- CHARACTER REFS FIRST ---
  if (refCount > 0) {
    parts.push({
      text: [
        `[${refLabel} — ${name.toUpperCase()} REFERENCE PHOTOS]`,
        `These ${refCount === 1 ? 'is' : 'are'} the character reference ${refCount === 1 ? 'photo' : 'photos'} for ${name}.`,
        `Copy from ${refLabel}:`,
        `- Face (exact likeness, not approximate)`,
        `- Skin tone and facial structure`,
        `- Body shape and breast size/volume (match exactly)`,
        `- Hair color and style`,
        `- Makeup`,
        `These identity traits are locked and override anything seen in the scene image.`,
        `Do NOT copy the scene, background, or outfit from ${refLabel}.`,
      ].join('\n'),
    });
    for (const ref of identityImages) {
      parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.base64Data } });
    }
  }

  // --- SOURCE PHOTO LAST ---
  parts.push({
    text: [
      `[Image ${sourceNum} — SCENE TO RECREATE]`,
      exactMode
        ? `Recreate this photo exactly: same outfit, background, lighting, pose, expression, framing.`
        : `Use this photo as the scene blueprint: match outfit, background, lighting, pose, and composition.`,
      refLabel
        ? `Replace the person in this photo with ${name} from ${refLabel}.`
        : `The person should be ${name}.`,
      `Do NOT copy from Image ${sourceNum}: face, facial structure, skin tone, body shape, breast size, hair color, hair style, or tattoos.`,
      `Image ${sourceNum} is a scene-only reference, not an identity reference.`,
    ].join('\n'),
  });
  parts.push({ inlineData: { mimeType: sourceImage.mimeType, data: sourceImage.base64Data } });

  parts.push({ text: prompt.trim() });
  return parts;
}

// POST /api/photo-match/recreate
router.post('/recreate', requirePlanCapacity(), async (req, res, next) => {
  try {
    const {
      image, mimeType, characterId, activeReferenceIds,
      bgStrength = 80, poseStrength = 80, imageModel, matchMode,
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

    let sceneData = {};
    try {
      sceneData = await sceneAnalyzer.analyzeScene(base64, mimeType);
    } catch (err) {
      if (!ANALYSIS_FALLBACK_CODES.has(err?.code)) throw err;
      log.warn('photo_match_scene_analysis_failed', {
        code: err.code || 'UNKNOWN',
        message: err.message,
        characterId,
      });
      sceneData = {};
    }

    // Get character and references
    const character = referenceManager.getCharacter(characterId);
    const refIds = Array.isArray(activeReferenceIds) ? activeReferenceIds : null;
    const activeRefs = referenceManager.getActiveReferences(characterId, refIds);
    const sourceImage = await optimizeInlineImage(base64, mimeType);
    if (!sourceImage) {
      throw new AppError('Unable to process uploaded image for photo match', 400, 'VALIDATION_ERROR');
    }
    const identityImages = await buildPhotoMatchIdentityImages(characterId, activeRefs);

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
    // Intentionally exclude sceneData.expression and sceneData.outfit — those describe
    // the source person's body/face which we do NOT want to copy onto the character
    const activeRefNotes = (activeRefs || [])
      .map((ref) => {
        const note = typeof ref?.overridePrompt === 'string' ? ref.overridePrompt.trim() : '';
        if (!note) return null;
        const category = ref.category ? `${ref.category}: ` : '';
        return `${category}${note}`;
      })
      .filter(Boolean);

    const refCount = identityImages.length;
    const sourceNum = refCount + 1;
    const refLabel = refCount === 0 ? null
      : refCount === 1 ? 'Image 1'
      : refCount === 2 ? 'Images 1 and 2'
      : `Images 1–${refCount}`;
    const sourceRef = `Image ${sourceNum}`;
    const name = character.name;

    const prompt = [
      // Core task
      exactMode
        ? `Recreate ${sourceRef} exactly. Replace the person with ${name}.`
        : `Create a photorealistic image of ${name} in the scene from ${sourceRef}.`,
      '',
      // Who is the person
      refLabel
        ? `WHO: ${name} — take face, facial structure, body shape, breast volume, hair color, hair style, skin tone, and makeup from ${refLabel}. Match exactly as shown.`
        : `WHO: ${name} — ${character.masterPrompt || ''}`,
      '',
      `IDENTITY PRIORITY: if anything in the scene image conflicts with the character references, the character references always win for face, skin, body shape, breast volume, hair, and makeup.`,
      `Treat the uploaded scene image only as a blueprint for environment, outfit, framing, pose, and expression.`,
      '',
      // What to copy from scene
      `SCENE (from ${sourceRef}): ${bgInstruction}. ${poseInstruction}. ${outfitInstruction(exactMode)} ${framingInstruction(exactMode)} ${expressionInstruction(exactMode)}`,
      '',
      // Hard rules
      `RULES:`,
      `- Do NOT copy face, facial structure, body shape, breast size, hair color, skin tone, or tattoos from ${sourceRef}`,
      `- The person in the output is ${name} only`,
      `- The output must clearly look like ${name}, even if the source image person looks very different`,
      `- If needed, sacrifice source-person likeness completely to preserve ${name}'s identity`,
      exactMode ? `- Do not change outfit, background, crop, camera angle, or scene layout` : null,
      '',
      // Scene analysis context
      sceneParts.length > 0 ? `SCENE DETAILS:\n${sceneParts.join('\n')}` : null,
      '',
      // Active ref notes (per-ref overrides)
      activeRefNotes.length > 0 ? `CHARACTER NOTES:\n${activeRefNotes.join('\n')}` : null,
      '',
      // Identity / master prompt (only if refs exist, otherwise already used above)
      refLabel && character.masterPrompt ? `ADDITIONAL IDENTITY: ${character.masterPrompt}` : null,
      '',
      'Return exactly one image. No text.',
      REALISM_DIRECTIVE,
    ].filter((s) => s != null).join('\n');

    const parts = buildPhotoMatchParts({
      sourceImage,
      identityImages,
      characterName: name,
      prompt,
      exactMode,
    });

    const apiKey = apiKeyManager.getActiveKey();
    const result = await geminiService.generateImage(apiKey, prompt, {
      aspectRatio,
      imageSize: resolutionTier,
      parts,
      model: imageModel,
      characterId,
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
      prompt: prompt,
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
