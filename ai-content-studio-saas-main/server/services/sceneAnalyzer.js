const { AppError } = require('../middleware/errorHandler');
const apiKeyManager = require('./apiKeyManager');
const geminiService = require('./geminiService');
const referenceManager = require('./referenceManager');
const promptBuilder = require('./promptBuilder');

const SCENE_FIELDS = [
  'environment', 'lighting', 'camera', 'composition',
  'mood', 'pose', 'expression', 'outfit', 'format',
];

class SceneAnalyzer {
  async analyzeScene(imageBase64, mimeType) {
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new AppError('Image base64 data is required', 400, 'VALIDATION_ERROR');
    }
    if (!mimeType || typeof mimeType !== 'string') {
      throw new AppError('Image MIME type is required', 400, 'VALIDATION_ERROR');
    }

    const apiKey = apiKeyManager.getActiveKey();
    const result = await geminiService.analyzeImage(apiKey, imageBase64, mimeType);

    const scene = {};
    for (const field of SCENE_FIELDS) {
      scene[field] = (typeof result[field] === 'string') ? result[field] : '';
    }
    return scene;
  }

  buildRecreationPrompt({
    sceneData,
    characterId,
    activeReferenceIds,
    sameBackground = false,
    samePose = false,
    sameHair = false,
    sameTattoos = false,
  }) {
    if (!sceneData || typeof sceneData !== 'object') {
      throw new AppError('sceneData is required', 400, 'VALIDATION_ERROR');
    }
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('characterId is required for scene recreation', 400, 'VALIDATION_ERROR');
    }

    const character = referenceManager.getCharacter(characterId);
    const refIds = Array.isArray(activeReferenceIds) ? activeReferenceIds : null;
    const activeRefs = referenceManager.getActiveReferences(characterId, refIds);

    const sceneParagraph = this._sceneToDescription(sceneData);

    const basePrompt = promptBuilder.buildPrompt({
      masterPrompt: character.masterPrompt,
      activeReferences: activeRefs,
      userPrompt: sceneParagraph,
    });

    const bgLock = sameBackground
      ? 'BACKGROUND LOCK: EXACTLY replicate the background — identical environment, same location, same colors, same depth, same lighting direction. Do NOT change anything behind the subject.'
      : null;

    const poseLock = samePose
      ? 'POSE LOCK: EXACTLY replicate the full body movement and pose — identical stance, same weight distribution, same torso angle, same shoulder line, same hip direction, same arm and hand positions, same leg placement, same neck angle, same head tilt, same chin angle, and same facial facing direction. Mirror the pose and body language precisely.'
      : null;

    const hairRule = sameHair
      ? 'HAIR LOCK: EXACTLY replicate the source subject\'s visible hair details — same hair color, same hairstyle, same highlights, same parting, same length, same curl/straight texture, and same overall hair silhouette.'
      : 'HAIR RULE: Do NOT copy the source subject\'s hair color, dye, wig, highlights, or hairstyle. Keep the selected character\'s own hair identity from the references instead.';

    const tattooRule = sameTattoos
      ? 'TATTOO LOCK: EXACTLY replicate the source subject\'s visible tattoos, body ink, sleeve tattoos, skin markings, and written markings with matching placement and visibility.'
      : 'TATTOO RULE: Ignore all tattoos, body ink, sleeve tattoos, skin markings, and written markings from the source image. Do NOT recreate or transfer them unless they already exist on the selected character references.';

    const sceneSheet = [
      '',
      bgLock,
      poseLock,
      hairRule,
      tattooRule,
      '[SCENE DATA]',
      `Camera: ${sceneData.camera || 'as described'}`,
      `Lighting: ${sceneData.lighting || 'as described'}`,
      `Composition: ${sceneData.composition || 'as described'} | Mood: ${sceneData.mood || 'as described'}`,
      sceneData.outfit ? `Outfit: ${sceneData.outfit}` : null,
      sceneData.pose ? `Pose: ${sceneData.pose}` : null,
      sceneData.expression ? `Expression: ${sceneData.expression}` : null,
      '',
      'Match BRIGHTNESS score and shadow coverage exactly. Dark stays dark.',
      this._buildDarknessEnforcement(sceneData),
    ].filter(Boolean).join('\n');

    return basePrompt + sceneSheet;
  }

  _buildDarknessEnforcement(sceneData) {
    const text = sceneData.lighting || '';
    const match = text.match(/Brightness\s+(\d+)\s*\/\s*10/i);
    if (!match) return null;
    const score = parseInt(match[1], 10);
    if (score > 4) return null;
    return `[DARKNESS: ${score}/10] Low-light scene. Deep shadows, minimal illumination. Only the described light source visible. Dark stays dark.`;
  }

  _sceneToDescription(sceneData) {
    const parts = [];

    if (sceneData.environment) parts.push(`Setting: ${sceneData.environment}.`);
    if (sceneData.lighting) parts.push(`Lighting: ${sceneData.lighting}.`);
    if (sceneData.camera) parts.push(`Camera: ${sceneData.camera}.`);
    if (sceneData.composition) parts.push(`Composition: ${sceneData.composition}.`);
    if (sceneData.mood) parts.push(`Mood: ${sceneData.mood}.`);
    if (sceneData.pose) parts.push(`Pose: ${sceneData.pose}.`);
    if (sceneData.expression) parts.push(`Expression: ${sceneData.expression}.`);
    if (sceneData.outfit) parts.push(`Outfit: ${sceneData.outfit}.`);
    if (sceneData.format) parts.push(`Format: ${sceneData.format}.`);

    return parts.join(' ') || 'A detailed scene.';
  }
}

SceneAnalyzer.SCENE_FIELDS = SCENE_FIELDS;

module.exports = new SceneAnalyzer();
