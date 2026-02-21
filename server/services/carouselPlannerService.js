const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const apiKeyManager = require('./apiKeyManager');
const geminiService = require('./geminiService');
const poseEngine = require('./poseEngine');
const externalProfileMemory = require('./auto/externalProfileMemory');

const SHOT_TYPES = [
  'establishing',
  'full-body',
  'half-body',
  'close-up',
  'mirror selfie',
  'detail shot',
];

const FRAMING_TYPES = [
  'centered',
  'rule-of-thirds',
  'off-center',
  'foreground layered',
  'reflection framing',
];

const ANGLE_TYPES = [
  'eye-level',
  'slight high-angle',
  'slight low-angle',
  'over-shoulder',
  'diagonal candid',
];

const EXPRESSION_TYPES = [
  'confident neutral',
  'soft smile',
  'intense gaze',
  'playful smirk',
  'candid look-away',
];

const CAMERA_PROFILE_IDS = [
  'iphone_selfie',
  'mirror_selfie',
  'cinematic_wide',
  'friend_phone_flash',
  'friend_phone_window_harsh',
  'overhead_selfie',
  'night_street_flash',
  'paparazzi_flash',
  'golden_hour_glow',
  'ultrawide_baddie_05x',
  'ring_light_vanity',
];

function cleanJson(rawText) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  if (!cleaned) return '';
  return cleaned;
}

function tryParseJson(rawText) {
  const cleaned = cleanJson(rawText);
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeEnum(value, allowed, fallbackIndex) {
  const normalized = asText(value).toLowerCase();
  if (normalized) {
    const hit = allowed.find((item) => item.toLowerCase() === normalized);
    if (hit) return hit;
  }
  return allowed[fallbackIndex % allowed.length];
}

function fallbackPlan({ narrative, slideCount, allowOutfitChanges }) {
  const count = Math.max(1, Math.min(10, Number.isInteger(slideCount) ? slideCount : 5));
  const sceneAnchor = externalProfileMemory.sampleLocation() || `Narrative setting: ${asText(narrative)}`;
  const defaultOutfit = externalProfileMemory.sampleOutfit() || 'coordinated premium outfit';
  const poses = poseEngine.getUniquePoses(Math.min(count, poseEngine.getPoseList().length));
  const poseList = poseEngine.getPoseList();

  const slides = [];
  for (let i = 0; i < count; i += 1) {
    const pose = poses[i] || poseList[i % poseList.length] || 'standing power pose';
    const outfit = allowOutfitChanges
      ? (externalProfileMemory.sampleOutfit() || defaultOutfit)
      : defaultOutfit;

    slides.push({
      slide: i + 1,
      shotType: SHOT_TYPES[i % SHOT_TYPES.length],
      framingType: FRAMING_TYPES[i % FRAMING_TYPES.length],
      angleType: ANGLE_TYPES[i % ANGLE_TYPES.length],
      expressionType: EXPRESSION_TYPES[i % EXPRESSION_TYPES.length],
      pose,
      outfit,
      locationHint: sceneAnchor,
      cameraProfileId: (SHOT_TYPES[i % SHOT_TYPES.length] === 'mirror selfie') ? 'mirror_selfie' : 'iphone_selfie',
      userSceneContext: `${asText(narrative)} with ${pose}, ${outfit}, ${sceneAnchor}`,
    });
  }

  return {
    narrative: asText(narrative),
    sceneAnchor,
    outfitPolicy: allowOutfitChanges ? 'adaptive' : 'locked',
    slides,
  };
}

function normalizePlanShape(rawPlan, { narrative, slideCount, allowOutfitChanges }) {
  if (!rawPlan || typeof rawPlan !== 'object') {
    return fallbackPlan({ narrative, slideCount, allowOutfitChanges });
  }

  const count = Math.max(1, Math.min(10, Number.isInteger(slideCount) ? slideCount : 5));
  const rawSlides = Array.isArray(rawPlan.slides) ? rawPlan.slides : [];
  const normalizedSlides = [];
  const baseOutfit = asText(rawPlan.baseOutfit) || externalProfileMemory.sampleOutfit() || 'coordinated premium outfit';

  for (let i = 0; i < count; i += 1) {
    const source = rawSlides[i] && typeof rawSlides[i] === 'object' ? rawSlides[i] : {};
    const shotType = normalizeEnum(source.shotType, SHOT_TYPES, i);
    const framingType = normalizeEnum(source.framingType, FRAMING_TYPES, i);
    const angleType = normalizeEnum(source.angleType, ANGLE_TYPES, i);
    const expressionType = normalizeEnum(source.expressionType, EXPRESSION_TYPES, i);
    const cameraProfileId = normalizeEnum(source.cameraProfileId, CAMERA_PROFILE_IDS, i);
    const pose = asText(source.pose) || poseEngine.getPoseList()[i % poseEngine.getPoseList().length] || 'standing power pose';
    const outfit = allowOutfitChanges
      ? (asText(source.outfit) || externalProfileMemory.sampleOutfit() || baseOutfit)
      : baseOutfit;
    const locationHint = asText(source.locationHint) || asText(rawPlan.sceneAnchor) || externalProfileMemory.sampleLocation() || 'editorial interior setting';

    const userSceneContext = asText(source.userSceneContext)
      || `${asText(narrative)} | ${shotType}, ${framingType}, ${angleType}, ${pose}, ${outfit}, ${locationHint}`;

    normalizedSlides.push({
      slide: i + 1,
      shotType,
      framingType,
      angleType,
      expressionType,
      pose,
      outfit,
      locationHint,
      cameraProfileId,
      userSceneContext,
    });
  }

  return {
    narrative: asText(rawPlan.narrative) || asText(narrative),
    sceneAnchor: asText(rawPlan.sceneAnchor) || normalizedSlides[0]?.locationHint || asText(narrative),
    outfitPolicy: allowOutfitChanges ? 'adaptive' : 'locked',
    slides: normalizedSlides,
  };
}

function buildPlannerPrompt({ narrative, slideCount, allowOutfitChanges, character }) {
  const lockLine = allowOutfitChanges
    ? 'Outfit policy: allow small coordinated outfit changes by slide.'
    : 'Outfit policy: keep one outfit locked across all slides.';
  const identityHint = character && character.masterPrompt
    ? `Character identity anchor (do not rewrite it): ${character.masterPrompt.slice(0, 2000)}`
    : 'Character identity anchor: not provided.';

  return `You are a carousel visual planner. Return JSON only.

Create ${slideCount} slides from this narrative:
${asText(narrative)}

${lockLine}
${identityHint}

Allowed enums:
shotType: ${JSON.stringify(SHOT_TYPES)}
framingType: ${JSON.stringify(FRAMING_TYPES)}
angleType: ${JSON.stringify(ANGLE_TYPES)}
expressionType: ${JSON.stringify(EXPRESSION_TYPES)}
cameraProfileId: ${JSON.stringify(CAMERA_PROFILE_IDS)}

Return exact structure:
{
  "narrative": string,
  "sceneAnchor": string,
  "baseOutfit": string,
  "slides": [
    {
      "slide": number,
      "shotType": string,
      "framingType": string,
      "angleType": string,
      "expressionType": string,
      "pose": string,
      "outfit": string,
      "locationHint": string,
      "cameraProfileId": string,
      "userSceneContext": string
    }
  ]
}

Rules:
- Keep one consistent environment arc for the whole carousel.
- Vary pose, framing, and expression per slide.
- Single female subject only.
- No couples and no male interaction.
- JSON only, no markdown.`;
}

async function generateCarouselPlan({ narrative, slideCount = 5, allowOutfitChanges = false, character = null }) {
  const safeNarrative = asText(narrative);
  if (!safeNarrative) {
    throw new AppError('"narrative" is required', 400, 'VALIDATION_ERROR');
  }

  const safeCount = Math.max(1, Math.min(10, Number.isInteger(slideCount) ? slideCount : 5));
  const plannerPrompt = buildPlannerPrompt({
    narrative: safeNarrative,
    slideCount: safeCount,
    allowOutfitChanges: !!allowOutfitChanges,
    character,
  });

  let rawPlan = null;
  try {
    const apiKey = apiKeyManager.getActiveKey();
    const rawText = await geminiService.generateText(apiKey, plannerPrompt, {
      temperature: 0.35,
      responseMimeType: 'application/json',
    });
    rawPlan = tryParseJson(rawText);
  } catch {
    // Use fallback plan below.
  }

  return normalizePlanShape(rawPlan, {
    narrative: safeNarrative,
    slideCount: safeCount,
    allowOutfitChanges: !!allowOutfitChanges,
  });
}

module.exports = {
  generateCarouselPlan,
  SHOT_TYPES,
  FRAMING_TYPES,
  ANGLE_TYPES,
  EXPRESSION_TYPES,
  CAMERA_PROFILE_IDS,
};
