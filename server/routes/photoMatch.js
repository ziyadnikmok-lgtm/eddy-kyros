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
const PHOTO_MATCH_REF_MAX_DIMENSION = 1024;
const ANALYSIS_FALLBACK_CODES = new Set(['GEMINI_TRANSIENT', 'GEMINI_ERROR', 'PARSE_ERROR', 'GENERATION_EMPTY']);

function bgStrengthInstruction(strength) {
  if (strength >= 85) return 'EXACTLY REPLICATE the background: identical environment, same location, same colors, same lighting conditions, same depth and distance of background elements';
  if (strength >= 60) return 'closely match the background environment: same type of location, very similar colors and lighting, keep most background elements';
  if (strength >= 35) return 'use a similar background and environment to the reference image';
  return 'take loose inspiration from the background setting only';
}

function poseStrengthInstruction(strength) {
  if (strength >= 85) return 'EXACTLY REPLICATE the body pose: identical stance, same weight distribution, same arm position, same hand placement, same head angle and tilt';
  if (strength >= 60) return 'closely match the body pose and stance from the reference image';
  if (strength >= 35) return 'use a similar body position and pose to the reference';
  return 'take loose inspiration from the pose only, feel free to adapt it';
}

function formatIdentityList(count) {
  if (count <= 0) return 'character references';
  if (count === 1) return 'Image 1';
  if (count === 2) return 'Image 1 and Image 2';
  
  const numbers = [];
  for (let i = 0; i < count; i++) {
    numbers.push(`Image ${i + 1}`);
  }
  const allExceptLast = numbers.slice(0, -1).join(', ');
  const last = numbers[numbers.length - 1];
  return `${allExceptLast}, and ${last}`;
}

function formatSourceLabel(identityCount) {
  return `Image ${identityCount + 1}`;
}

function buildPhotoMatchParts({ sourceImage, identityImages, characterName, prompt }) {
  const parts = [];
  const name = characterName || 'the character';

  // Images 1..N: Identity references (FIRST)
  identityImages.forEach((identityImage, index) => {
    const label = `Image ${index + 1}`;
    parts.push({
      text: `[${label} — CHARACTER IDENTITY REFERENCE — HIGHEST PRIORITY]\nThis is the absolute source for the output person's face, figure, skin tone, hair, makeup, and likeness. The person in the final output MUST look exactly like the person in this image. This image overrides all other image inputs completely for identity.`,
    });
    parts.push({ inlineData: { mimeType: identityImage.mimeType, data: identityImage.base64Data } });
  });

  // Image N+1: Source scene blueprint (LAST)
  const sourceLabel = `Image ${identityImages.length + 1}`;
  parts.push({
    text: `[${sourceLabel} — SOURCE SCENE BLUEPRINT — FORBIDDEN IDENTITY]\nThis image is ONLY a blueprint for: background environment, body pose, outfit/clothing, props, lighting, and camera framing.
⚠️ FORBIDDEN — Do NOT copy ANY of these from ${sourceLabel}:
- Face, facial features, facial structure, eyes, nose, mouth, jaw
- Hair color, hair style, hairline, hair texture
- Skin tone, skin texture, skin color
- Body shape, figure, curves
- Tattoos, body ink, skin markings, sleeve tattoos, written markings — ALL tattoos from ${sourceLabel} are STRICTLY FORBIDDEN
- Any aspect of the person's identity in ${sourceLabel}
The person in ${sourceLabel} is an anonymous stand-in. Their entire appearance is irrelevant and must NOT appear in the output.`,
  });
  parts.push({ inlineData: { mimeType: sourceImage.mimeType, data: sourceImage.base64Data } });

  // The main text prompt
  parts.push({ text: prompt.trim() });

  return parts;
}

function isVertexActive(providerOverride) {
  if (providerOverride === 'gemini') return false;
  if (providerOverride === 'vertex') return true;
  try {
    const apiKeyManager = require('../services/apiKeyManager');
    if (apiKeyManager.shouldUseVertexBackend()) return true;
  } catch { /* ignore */ }
  const cfg = require('../config');
  return cfg.GEMINI_BACKEND === 'vertex';
}

function mapUnsafeTermsForVertex(text) {
  if (!text) return '';
  return text
    .replace(/\bbreast(s)?\s+size\/volume\b/gi, 'curves/volume')
    .replace(/\bbreast(s)?\s+volume\b/gi, 'curves')
    .replace(/\bbreast(s)?\s+size\b/gi, 'curves')
    .replace(/\bvery\s+large\s+volume\s+breast(s)?\b/gi, 'very large volume curves')
    .replace(/\bbreast(s)?\b/gi, 'curves');
}

async function optimizeImage(base64Data, mimeType, maxDim = PHOTO_MATCH_REF_MAX_DIMENSION) {
  if (!base64Data || typeof base64Data !== 'string') return null;
  if (!mimeType || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) return null;
  try {
    const resized = await sharp(Buffer.from(base64Data, 'base64'))
      .rotate()
      .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { mimeType: 'image/jpeg', base64Data: resized.toString('base64') };
  } catch {
    return { mimeType, base64Data };
  }
}

// POST /api/photo-match/recreate
router.post('/recreate', requirePlanCapacity(), async (req, res, next) => {
  let runId = null;
  try {
    const {
      image, mimeType, characterId, activeReferenceIds,
      bgStrength = 80, poseStrength = 80, imageModel, matchMode,
      varyBackground = false,
      provider, // 'gemini' | 'vertex' — forces provider override
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

    // Analyze the scene automatically
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
    const allRefs = Array.isArray(character.references) ? character.references : [];
    // buildCharacterReferenceImages loads primary images unconditionally + any active refs
    const rawRefs = buildCharacterReferenceImages(characterId, allRefs);

    // Optimize source image (Image 1)
    const sourceImage = await optimizeImage(base64, mimeType, PHOTO_MATCH_REF_MAX_DIMENSION);
    if (!sourceImage) throw new AppError('Unable to process source image', 400, 'VALIDATION_ERROR');

    // Optimize character identity reference images (limit to 3 for best quality/token usage)
    const identityImages = (await Promise.all(
      rawRefs.slice(0, 3).map((ref) => optimizeImage(ref.base64Data, ref.mimeType, PHOTO_MATCH_REF_MAX_DIMENSION))
    )).filter(Boolean);

    // Hard-stop: if we have no identity images the AI will use the scene person's face.
    // Better to fail clearly than silently produce wrong output.
    if (identityImages.length === 0) {
      log.warn('photo_match_no_identity_images', { characterId, rawRefsCount: rawRefs.length });
      throw new AppError(
        'No character identity images could be loaded. Add at least one primary image to this character.',
        422,
        'NO_IDENTITY_IMAGES'
      );
    }


    // Build strength-aware prompt instructions
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

    const activeProvider = provider || 'gemini';
    const isVertex = isVertexActive(activeProvider);

    let masterPrompt = character.masterPrompt || '';
    if (isVertex) {
      masterPrompt = mapUnsafeTermsForVertex(masterPrompt);
    }

    const identityCount = identityImages.length;
    const refList = formatIdentityList(identityCount);
    const sourceLabel = formatSourceLabel(identityCount);
    const verbOverride = identityCount > 1 ? 'override' : 'overrides';
    const refNoun = identityCount > 1 ? 'references are' : 'reference is';

    const sceneInstructions = exactMode
      ? [
          `${bgInstruction} — background must be pixel-perfect, no changes allowed.`,
          `${poseInstruction} — mirror the pose exactly, including every prop held (phone, bag, cup, etc.), hand placement, finger position, and head tilt.`,
          `EXACTLY REPLICATE the outfit: same garment type, same color, same cut, same fabric, same coverage — no substitutions, no additions.`,
          `EXACTLY REPLICATE the composition, crop, camera angle, lens perspective, framing, and distance from the camera.`,
          `EXACTLY REPLICATE expression, gaze direction, lip position, and head angle.`,
          `EXACTLY REPLICATE any props visible in ${sourceLabel} (phone, mirror, furniture, objects) — position, size, and orientation.`,
          `Do NOT add, remove, or change any element of the scene — the only change allowed is replacing the person's identity with ${character.name}.`,
          `Do NOT copy face, skin tone, hair, or body from ${sourceLabel} — identity comes only from ${refList}.`,
        ].join(' ')
      : [
          bg >= 85 ? `${bgInstruction} — keep the background pixel-perfect.` : `${bgInstruction}.`,
          pose >= 85 ? `${poseInstruction} — mirror the pose precisely.` : `${poseInstruction}.`,
          `keep the outfit and styling very close to the reference image.`,
          `closely match the composition, framing, and camera perspective from the reference image.`,
          `keep the expression, gaze, and head position close to the source image.`,
          `Do NOT copy ANY of the following from ${sourceLabel}: face, facial structure, eyes, skin tone, hair color, hair style, tattoos, body ink, or body shape — use ONLY ${refList} for identity.`,
          varyBackground ? `BACKGROUND VARIATION: Keep the same location type, but shift lighting mood slightly, add or change minor background details, and make it feel like a different moment in the same place.` : ''
        ].filter(Boolean).join(' ');

    const prompt = [
      exactMode
        ? `EXACT RECREATE MODE — reproduce ${sourceLabel} with pixel-perfect fidelity. Replace ONLY the person's identity with ${character.name}. Every other element (background, pose, outfit, props, composition, lighting, crop, camera angle) must be identical to ${sourceLabel}.`
        : `Create a photorealistic image of ${character.name} in the scene from ${sourceLabel}.`,
      '',
      `WHO: ${character.name} — face, figure, skin tone, hair, and makeup come from ${refList}. The ${refList} ${refNoun} the ONLY identity source.`,
      '',
      `IDENTITY PRIORITY: ${refList} ALWAYS ${verbOverride} ${sourceLabel} for face, skin, figure, hair, and makeup. If ${sourceLabel}'s person looks different, ignore ${sourceLabel}'s person completely. The person in ${sourceLabel} is an unknown stand-in — their face and body are FORBIDDEN.`,
      `CONFLICT RESOLUTION: Any time ${sourceLabel} and ${refList} disagree about identity, always choose ${refList}. Sacrifice ${sourceLabel}'s likeness 100% to preserve the character's identity.`,
      '',
      `SCENE (from ${sourceLabel}): ${sceneInstructions}`,
      '',
      `RULES:`,
      `- FORBIDDEN: face, facial structure, eyes, figure, hair color, skin tone, or likeness from ${sourceLabel}`,
      `- FORBIDDEN: using ${sourceLabel} as a face reference or identity reference`,
      `- FORBIDDEN: tattoos, body ink, sleeve tattoos, skin markings, or written markings from ${sourceLabel} — do NOT transfer any tattoo from the scene person to the output`,
      `- NO BLENDING: The final output face and body must be a 100% match to the character references (${refList}). Do NOT blend, mix, merge, or average the face, head, hair, skin, or body of the character with the person in ${sourceLabel}. The person in ${sourceLabel} is an anonymous stand-in; their features must be completely discarded.`,
      `- CHARACTER BODY SHAPE: Replicate the body shape, figure, curves, height, and chest size of ${character.name} as shown in ${refList}. Do NOT copy the body shape or chest size of the person in ${sourceLabel}.`,
      `- REQUIRED: The person in the output is ${character.name} only — they must look like ${character.name}`,
      `- REQUIRED: The output must clearly look like ${character.name}, even if the person in ${sourceLabel} looks very different`,
      `- REQUIRED: Sacrifice ${sourceLabel} person's likeness completely to preserve ${character.name}'s identity`,
      `- REQUIRED: When in doubt, ignore ${sourceLabel}'s person and copy ${refList} exactly`,
      `- TATTOO RULE: IGNORE all tattoos, body ink, sleeve tattoos, skin markings, and written text on skin from ${sourceLabel}. Do NOT recreate or transfer them. The output person has only the tattoos (if any) visible on ${character.name} in ${refList}.`,
      exactMode ? `- EXACT MODE: Do not redesign, add, or remove anything — same outfit, same props, same pose, same background, same crop, same camera angle, same lighting` : null,
      exactMode ? `- EXACT MODE: Do not beautify, recompose, zoom, rotate, change location, change clothing, change props, or invent anything new` : null,
      exactMode ? `- EXACT MODE: If ${sourceLabel} shows a phone in hand — the output must also show a phone in hand in the same position` : null,
      exactMode ? `- EXACT MODE: If ${sourceLabel} shows a mirror selfie — the output must also be a mirror selfie with the same phone, same mirror, same angle` : null,
      '',
      `SCENE DETAILS:`,
      sceneParts.join('\n'),
      '',
      `ADDITIONAL IDENTITY: ${masterPrompt}`,
      '',
      `Return exactly one image. No text.`,
      `[PHOTO STYLE]`,
      `RAW handheld iPhone photo. 26mm lens, candid framing, slightly off-center.`,
      `High ISO grain in shadows, slight natural softness, deep depth of field.`,
      `Natural skin: visible pores, slight shine, real texture under makeup. Skin reacts to light like flesh.`,
      `Real hair: individual strands, slight flyaways, natural volume.`,
      `Real fabric: visible weave, natural creases and wrinkles in clothing.`,
      `Slight facial asymmetry — real human face, not perfectly mirrored.`,
      `Eyes: matched irises, natural catchlight, realistic detail.`,
      `Avoid: studio lighting, airbrushed skin, CGI, 3D render, digital art, symmetrical features, smooth plastic skin, anime, illustration.`,
      `[END PHOTO STYLE]`,
    ].filter((s) => s != null).join('\n');

    // Build structured parts array to control exact image ordering
    const parts = buildPhotoMatchParts({
      sourceImage,
      identityImages,
      characterName: character.name,
      prompt,
    });

    const apiKey = apiKeyManager.getActiveKeyOrNull();
    runId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'photo-match',
      provider: activeProvider,
      model: imageModel || null,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.started',
      entityType: 'generation_run',
      entityId: runId,
      source: 'photo-match',
      payload: { feature: 'photo-match', model: imageModel || null, characterId, provider: provider || 'auto' },
    });

    const result = await geminiService.generateImage(apiKey, prompt, {
      aspectRatio,
      imageSize: resolutionTier,
      parts,
      model: imageModel,
      characterId,
      provider,
      maxAttempts: provider === 'gemini' ? 3 : undefined,
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
      provider: provider || 'gemini',
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
      provider: req.body?.provider || 'gemini',
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
