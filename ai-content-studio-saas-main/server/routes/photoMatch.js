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
const REALISM_DIRECTIVE = require('../utils/realismDirective');

const router = express.Router();
const PHOTO_MATCH_REF_MAX_DIMENSION = 1024;
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
    return 'EXACTLY REPLICATE the expression, gaze direction, head tilt, and overall attitude from the source image. Do NOT replicate the hair color, hair style, or face of the source image — use the character identity references for all facial features and hair.';
  }
  return 'keep the expression, gaze, and head position close to the source image. Do NOT copy hair color or facial features from the source — use the character identity references for face and hair.';
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

async function buildPhotoMatchIdentityImages(characterId, activeRefs) {
  const primary = referenceManager.getPrimaryImages(characterId)[0];
  if (primary?.buffer?.length) {
    const optimized = await optimizeInlineImage(primary.buffer.toString('base64'), primary.mimeType);
    return optimized ? [optimized] : [];
  }

  const firstActiveRef = Array.isArray(activeRefs) && activeRefs.length > 0 ? activeRefs[0] : null;
  if (!firstActiveRef) return [];

  const data = referenceManager.getReferenceImage(characterId, firstActiveRef.id);
  if (!data?.buffer?.length) return [];
  const optimized = await optimizeInlineImage(data.buffer.toString('base64'), data.mimeType);
  return optimized ? [optimized] : [];
}

function buildPhotoMatchParts({ sourceImage, identityImages, prompt, exactMode = false }) {
  const parts = [
    {
      text: exactMode
        ? '[SOURCE PHOTO]\nUse this uploaded image as an exact reconstruction blueprint. Recreate the same framing, outfit, background, expression, lighting, and pose as closely as possible. Do NOT copy the face, hair color, or hair style from this source image — those come exclusively from the character identity references.'
        : '[SOURCE PHOTO]\nUse this uploaded image as the scene blueprint. Match its composition, framing, outfit, background, lighting, expression, and overall vibe according to the strength controls. Do NOT copy the face, hair color, or hair style from this source image — use the character identity references for those.',
    },
    {
      inlineData: {
        mimeType: sourceImage.mimeType,
        data: sourceImage.base64Data,
      },
    },
  ];

  if (Array.isArray(identityImages) && identityImages.length > 0) {
    parts.push({
      text: '[CHARACTER IDENTITY REFERENCES]\nUse these images for face, hair color, hair style, body identity, skin tone, and all recognizable subject features. The character\'s face and hair MUST come from these references, not from the source photo. Do not copy their scene or outfit unless the prompt explicitly says to.',
    });
    for (const ref of identityImages) {
      parts.push({
        inlineData: {
          mimeType: ref.mimeType,
          data: ref.base64Data,
        },
      });
    }
  }

  parts.push({ text: prompt.trim() });
  return parts;
}

// POST /api/photo-match/recreate
router.post('/recreate', async (req, res, next) => {
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
    if (sceneData.expression)   sceneParts.push(`Expression: ${sceneData.expression}`);
    if (sceneData.outfit)       sceneParts.push(`Outfit: ${sceneData.outfit}`);
    const activeRefNotes = (activeRefs || [])
      .map((ref) => {
        const note = typeof ref?.overridePrompt === 'string' ? ref.overridePrompt.trim() : '';
        if (!note) return null;
        const category = ref.category ? `${ref.category}: ` : '';
        return `${category}${note}`;
      })
      .filter(Boolean);

    const prompt = [
      exactMode
        ? `Create one photorealistic exact recreation of the uploaded photo using ${character.name}'s identity.`
        : `Create one photorealistic matched image of ${character.name}.`,
      exactMode
        ? 'Use the uploaded source photo as a strict blueprint. Preserve the same shot, clothing, environment, pose, expression, lighting, and composition.'
        : 'Use the uploaded source photo as the scene and styling blueprint.',
      'Use the character identity references for face, hair color, and hair style. Do NOT copy hair color or facial features from the source photo.',
      'Return exactly one image and no text.',
      '',
      '[BACKGROUND — strength ' + bg + '%]',
      bgInstruction + '.',
      '',
      '[POSE — strength ' + pose + '%]',
      poseInstruction + '.',
      '',
      '[OUTFIT]',
      outfitInstruction(exactMode),
      '',
      '[FRAMING]',
      framingInstruction(exactMode),
      '',
      '[EXPRESSION]',
      expressionInstruction(exactMode),
      '',
      sceneParts.length > 0 ? '[SCENE ANALYSIS]' : null,
      ...sceneParts,
      sceneParts.length > 0 ? '' : null,
      activeRefNotes.length > 0 ? '[ACTIVE REFERENCE DETAILS]' : null,
      ...activeRefNotes,
      activeRefNotes.length > 0 ? '' : null,
      '[IDENTITY]',
      character.masterPrompt || '',
      '',
      exactMode ? '[DO NOT CHANGE]\nDo not invent a new outfit, new background, new pose, new crop, new camera angle, new expression, or new scene layout.' : null,
      exactMode ? '' : null,
      REALISM_DIRECTIVE,
    ].filter((s) => s != null).join('\n');

    const parts = buildPhotoMatchParts({
      sourceImage,
      identityImages,
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
