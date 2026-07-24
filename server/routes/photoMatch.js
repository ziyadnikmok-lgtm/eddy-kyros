'use strict';
const express = require('express');
let _sharp; const sharp = (...a) => { if (!_sharp) _sharp = require('sharp'); return _sharp(...a); };
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
const ANALYSIS_FALLBACK_CODES = new Set(['GEMINI_TRANSIENT', 'GEMINI_ERROR', 'PARSE_ERROR', 'GENERATION_EMPTY', 'RATE_LIMITED']);

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
    text: `[${sourceLabel} — SOURCE SCENE BLUEPRINT — FORBIDDEN IDENTITY]\nThis image is ONLY a blueprint for: background environment, body pose, outfit/clothing, props, lighting, and camera framing.\n⚠️ FORBIDDEN — Do NOT copy ANY of these from ${sourceLabel}:\n- Face, facial features, facial structure, eyes, nose, mouth, jaw\n- Hair color, hair style, hairline, hair texture\n- Skin tone, skin texture, skin color\n- Body shape, figure, curves\n- Tattoos, body ink, sleeve tattoos, skin markings, written markings — ALL tattoos from ${sourceLabel} are STRICTLY FORBIDDEN\n- Any aspect of the person's identity in ${sourceLabel}\nThe person in ${sourceLabel} is an anonymous stand-in. Their entire appearance is irrelevant and must NOT appear in the output.`,
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

// Pose-fix style presets — each style has several variations so a batch of the same
// source doesn't come out with the identical pose/hand placement every time. One is
// picked at random per request.
const POSE_STYLES = {
  sexy_confident: [
    'a confident, sexy Instagram pose — chin slightly up, strong direct eye contact, one hand on the hip and the other relaxed at her side, body turned three-quarters with weight on one leg, lips slightly parted',
    'a confident, sexy Instagram pose — one hand sliding up through her hair with the head tilted back a little, shoulders relaxed and open, a slow smoldering gaze, hips shifted to one side',
    'a confident, sexy Instagram pose — both hands resting low on the hips, chest slightly forward, chin level, a subtle smoldering look, standing tall with a strong S-curve',
    'a confident, sexy Instagram pose — looking back over the shoulder with a sultry expression, one arm crossed under the chest and the other hand near the collarbone',
    'a confident, sexy Instagram pose — one hand at the back of the neck/hair with the elbow raised and the torso gently arched, the other hand on the waist, direct confident eye contact',
  ],
  flirty_playful: [
    'a flirty, playful Instagram pose — soft playful smile, head tilted, one finger near the lips, shoulders drawn up a little in a cute way',
    'a flirty, playful Instagram pose — a slight lip bite, one hand twirling a strand of hair, body angled with the hip popped, eyes glancing to the side',
    'a flirty, playful Instagram pose — both hands playfully framing the face, a big genuine smile, leaning slightly toward the camera',
    'a flirty, playful Instagram pose — hands clasped behind the back, chin dipped, looking up through the lashes with a flirty grin',
    'a flirty, playful Instagram pose — one hand on the cheek, a soft laugh or wink, weight shifted onto one leg, lively energetic vibe',
  ],
  elegant_alluring: [
    'an elegant, alluring Instagram pose — graceful upright posture, one hand resting elegantly on the opposite arm, chin lifted, soft seductive gaze',
    'an elegant, alluring Instagram pose — long neck extended and head turned in profile with eyes to the camera, one hand lightly at the throat/collarbone',
    'an elegant, alluring Instagram pose — poised and composed with hands folded softly at the waist, refined posture, a subtle alluring expression',
    'an elegant, alluring Instagram pose — one arm raised gracefully overhead resting on the hair, body elongated, softly parted lips, a sophisticated gaze',
    'an elegant, alluring Instagram pose — shoulders back and down with a gentle over-the-shoulder look, one hand trailing along the jaw, elegant and sensual',
  ],
  natural_candid: [
    'a natural, candid Instagram pose — relaxed mid-laugh with hands loose and natural, weight on one leg, caught-in-the-moment energy',
    'a natural, candid Instagram pose — a mid-step walking feel with hair in slight motion, hands natural at the sides, a soft genuine smile',
    'a natural, candid Instagram pose — one hand tucked in a pocket and the other adjusting the hair, looking slightly off-camera, an effortless vibe',
    'a natural, candid Instagram pose — sitting casually or leaning with hands resting naturally, a warm soft expression, an unposed feel',
    'a natural, candid Instagram pose — hands loosely clasped in front, a gentle candid smile, relaxed shoulders, a natural weight shift',
  ],
};
const DEFAULT_POSE_STYLE = 'sexy_confident';

// Pick a random pose variation for the chosen style (so each image differs).
function pickPoseVariation(styleKey) {
  const arr = POSE_STYLES[styleKey] || POSE_STYLES[DEFAULT_POSE_STYLE];
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildPoseFixPrompt({ characterName, refList, sourceLabel, poseStyleText, aspectRatio, masterPrompt }) {
  return [
    `INSTAGRAM POSE REMAKE — Keep the exact person, outfit, and location from ${sourceLabel}, but give them ${poseStyleText}. Produce a polished Instagram feed photo in ${aspectRatio} framing.`,
    '',
    `WHO: ${characterName} — face, figure, skin tone, hair, and makeup come ONLY from ${refList}. The output person MUST look exactly like ${characterName}.`,
    `IDENTITY PRIORITY: ${refList} ALWAYS overrides ${sourceLabel} for identity. If ${sourceLabel}'s person looks even slightly different, follow ${refList}.`,
    '',
    `KEEP from ${sourceLabel} (do NOT change): the outfit/clothing, the location and background, the overall lighting and mood, and the general styling. Same clothes, same place.`,
    '',
    `CHANGE (this is the whole point): the body pose, body angle, stance, weight distribution, arm and hand placement, head angle, and facial expression. Replace the original pose entirely with ${poseStyleText}.`,
    `Do NOT copy the original pose from ${sourceLabel} — create a NEW, natural, flattering pose. Hands must look anatomically correct (five fingers, no distortion). The expression must feel intentional and attractive, never stiff or blank.`,
    '',
    `REFRAME: compose for a ${aspectRatio} Instagram feed photo — balanced framing, subject flatteringly placed, full use of the ${aspectRatio} frame. This is NOT a cropped vertical reel; recompose the camera framing to suit ${aspectRatio}.`,
    '',
    `RULES:`,
    `- FORBIDDEN: copying the original pose, original facial expression, or original hand placement from ${sourceLabel}`,
    `- FORBIDDEN: copying the face/identity/body shape of the person in ${sourceLabel} if it conflicts with ${refList}`,
    `- FORBIDDEN: changing the outfit, the location, or the character's identity`,
    `- FORBIDDEN: tattoos, body ink, or skin markings that are not already on ${characterName} in ${refList}`,
    `- REQUIRED: keep ${characterName}'s exact makeup from ${refList} — same lip color (including black/dark lips), eye makeup, and lashes; do NOT neutralize or naturalize it`,
    `- REQUIRED: keep the body shape, figure, and curves of ${characterName} from ${refList}`,
    `- REQUIRED: realistic anatomy — natural hands and fingers, natural proportions, believable posture`,
    `- REQUIRED: the result must look like a real candid iPhone photo, attractive and Instagram-ready`,
    '',
    `CHARACTER IDENTITY DETAILS: ${masterPrompt}`,
    '',
    `Return exactly one image. No text.`,
    `[PHOTO STYLE]`,
    `RAW handheld iPhone photo, candid framing, slightly off-center. Natural skin with visible pores and real texture, real individual hair strands, real fabric weave and creases. Slight facial asymmetry. Natural catchlight in the eyes. Avoid: studio lighting, airbrushed skin, CGI, 3D render, plastic skin, anime, illustration.`,
    `[END PHOTO STYLE]`,
  ].join('\n');
}

// Direct pose: no character refs — reposes the exact person from the source image.
function buildDirectPosePrompt({ poseStyleText, aspectRatio }) {
  return [
    `DIRECT POSE CHANGE — The source image contains a real person. Keep EVERYTHING about them exactly the same — their face, identity, hair, skin tone, outfit, location, background, lighting, and styling. Only change their body pose.`,
    '',
    `CHANGE (this is the ONLY thing to change): give them ${poseStyleText}. Change the body angle, stance, weight distribution, arm and hand placement, head angle, and facial expression to match the new pose. Do NOT keep the original pose.`,
    '',
    `KEEP UNCHANGED: face, skin, hair, outfit, background, location, lighting, accessories, tattoos, makeup, body proportions — everything except the pose.`,
    '',
    `REFRAME for ${aspectRatio} Instagram feed — balanced composition, full use of the frame.`,
    '',
    `RULES:`,
    `- FORBIDDEN: changing the person's face, identity, or body shape`,
    `- FORBIDDEN: changing their outfit, background, or location`,
    `- FORBIDDEN: adding or removing tattoos, piercings, or accessories`,
    `- REQUIRED: new pose must be ${poseStyleText} — completely replace the original pose`,
    `- REQUIRED: realistic anatomy — natural hands and fingers, no extra limbs`,
    `- REQUIRED: the result must look like a real candid iPhone photo, attractive and Instagram-ready`,
    '',
    `Return exactly one image. No text.`,
    `[PHOTO STYLE]`,
    `RAW handheld iPhone photo, candid framing. Natural skin with visible pores and real texture, real individual hair strands, real fabric weave and creases. Slight facial asymmetry. Natural catchlight in the eyes. Avoid: studio lighting, airbrushed skin, CGI, 3D render, plastic skin, anime, illustration.`,
    `[END PHOTO STYLE]`,
  ].join('\n');
}

// POST /api/photo-match/recreate
router.post('/recreate', requirePlanCapacity(), async (req, res, next) => {
  let runId = null;
  try {
    const {
      image, mimeType, characterId, activeReferenceIds,
      bgStrength = 80, poseStrength = 80, imageModel, matchMode,
      varyBackground = false,
      poseFix = false, poseStyle, // pose-fix mode: re-pose into a flattering Instagram pose
      provider, // 'gemini' | 'vertex' — forces provider override
      sourceUrl, // originating IG/TikTok/X post link (if the source frame came from one)
    } = req.body;
    const cleanSourceUrl = (typeof sourceUrl === 'string' && sourceUrl.startsWith('http')) ? sourceUrl.slice(0, 2000) : null;
    const { aspectRatio, resolutionTier, width, height } = resolveDimensions(req.body);
    const poseFixMode = poseFix === true;

    if (!image || typeof image !== 'string') throw new AppError('"image" base64 string is required', 400, 'VALIDATION_ERROR');
    if (!mimeType || typeof mimeType !== 'string') throw new AppError('"mimeType" is required', 400, 'VALIDATION_ERROR');
    // In pose-fix direct mode, characterId is optional — we repose the source image person as-is.
    const directPoseMode = poseFixMode && (!characterId || characterId === 'direct');
    if (!directPoseMode && (!characterId || typeof characterId !== 'string')) throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');

    const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
    if (!ALLOWED_MIME.includes(mimeType)) throw new AppError('mimeType must be image/png, image/jpeg, or image/webp', 400, 'VALIDATION_ERROR');
    if (image.length > 15_000_000) throw new AppError('Image data too large (max ~10MB)', 413, 'PAYLOAD_TOO_LARGE');

    let base64 = image;
    const dataUriMatch = image.match(/^data:image\/\w+;base64,(.+)$/);
    if (dataUriMatch) base64 = dataUriMatch[1];

    const exactMode = matchMode === 'exact' || req.body?.exactRecreate === true;
    const bg = exactMode ? 100 : Math.max(0, Math.min(100, Number(bgStrength) || 80));
    const pose = exactMode ? 100 : Math.max(0, Math.min(100, Number(poseStrength) || 80));

    // Analyze the scene automatically (skipped for pose-fix — it keeps the source scene
    // and only re-poses, so scene analysis isn't needed and we save an API call).
    let sceneData = {};
    if (!poseFixMode) {
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
    }

    // Optimize source image (Image 1)
    const sourceImage = await optimizeImage(base64, mimeType, PHOTO_MATCH_REF_MAX_DIMENSION);
    if (!sourceImage) throw new AppError('Unable to process source image', 400, 'VALIDATION_ERROR');

    // --- Direct Pose Mode: no character refs, just repose the source image person ---
    if (directPoseMode) {
      const poseStyleText = pickPoseVariation(poseStyle);
      const directPrompt = buildDirectPosePrompt({ poseStyleText, aspectRatio });
      const activeProvider = provider || 'gemini';
      const isVertex = isVertexActive(activeProvider);
      runId = startGenerationRun({
        userId: req.session?.userId,
        feature: 'pose-fix-direct',
        provider: isVertex ? 'vertex' : 'gemini',
        model: imageModel || null,
      });
      logUsageEvent({
        userId: req.session?.userId,
        eventType: 'generation.started',
        entityType: 'generation_run',
        entityId: runId,
        source: 'pose-fix-direct',
        payload: { feature: 'pose-fix-direct', provider: activeProvider, model: imageModel || null },
      });
      const parts = [
        { inlineData: { mimeType: sourceImage.mimeType, data: sourceImage.base64Data } },
        { text: directPrompt },
      ];
      const genResult = await geminiService.generateImage('', directPrompt, {
        parts,
        model: geminiService.resolveImageModel(imageModel),
        aspectRatio,
        imageSize: resolutionTier || '1K',
        provider: activeProvider !== 'auto' ? activeProvider : undefined,
        requireImageInputs: true,
      });
      if (!genResult?.image?.base64Data) throw new AppError('No image returned from pose engine', 502, 'GENERATION_EMPTY');
      const savedImage = galleryManager.save({
        base64Data: genResult.image.base64Data,
        mimeType: genResult.image.mimeType || 'image/png',
        prompt: directPrompt,
        model: genResult.modelUsed || imageModel || '',
        characterId: null,
        feature: 'pose-fix-direct',
        aspectRatio,
        resolutionTier,
        sourceUrl: cleanSourceUrl,
      });
      finishGenerationRun(runId, 'success');
      logUsageEvent({
        userId: req.session?.userId,
        eventType: 'generation.completed',
        entityType: 'generation_run',
        entityId: runId,
        source: 'pose-fix-direct',
        payload: { imageId: savedImage.id, characterId: null },
      });
      return res.json({
        image: { mimeType: savedImage.mimeType, base64Data: genResult.image.base64Data },
        imageId: savedImage.id,
        galleryId: savedImage.id,
        characterId: null,
        prompt: directPrompt,
        sourceUrl: cleanSourceUrl,
      });
    }

    // Get character and references
    const character = referenceManager.getCharacter(characterId);
    const allRefs = Array.isArray(character.references) ? character.references : [];
    // buildCharacterReferenceImages loads primary images unconditionally + any active refs
    const rawRefs = buildCharacterReferenceImages(characterId, allRefs);

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

    const prompt = poseFixMode ? buildPoseFixPrompt({
      characterName: character.name,
      refList,
      sourceLabel,
      poseStyleText: pickPoseVariation(poseStyle),
      aspectRatio,
      masterPrompt,
    }) : [
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
      `- MAKEUP: Reproduce ${character.name}'s makeup EXACTLY as shown in ${refList} — same lip color and lipstick (including bold or dark shades such as black/dark lips), same eyeshadow, same eyeliner, same false lashes, and same brows. Do NOT neutralize, soften, or "naturalize" it; if ${refList} shows black lipstick, the output MUST keep black lipstick.`,
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
      sourceUrl: cleanSourceUrl,
    });

    const galleryEntry = galleryManager.save({
      base64Data: result.image.base64Data,
      mimeType: result.image.mimeType,
      prompt: prompt,
      source: 'photo-match',
      characterId,
      aspectRatio: aspectRatio || null,
      sourceUrl: cleanSourceUrl,
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
        galleryId: galleryEntry?.id || null,
        image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
        sceneData,
        dimensions: { aspectRatio, resolutionTier, width, height },
        generatedAt: new Date().toISOString(),
        sourceUrl: cleanSourceUrl,
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
