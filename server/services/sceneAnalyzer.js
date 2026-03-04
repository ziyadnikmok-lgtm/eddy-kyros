const { AppError } = require('../middleware/errorHandler');
const apiKeyManager = require('./apiKeyManager');
const geminiService = require('./geminiService');
const referenceManager = require('./referenceManager');
const promptBuilder = require('./promptBuilder');
const REALISM_DIRECTIVE = require('../utils/realismDirective');

const SCENE_FIELDS = [
  'environment', 'lighting', 'camera', 'composition',
  'mood', 'pose', 'expression', 'outfit', 'hair', 'format',
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

  buildRecreationPrompt({ sceneData, characterId, activeReferenceIds }) {
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

    const preservationRules = [
      '',
      '[SCENE PRESERVATION — LOCKED]',
      'Recreate the exact scene with this character. Maintain:',
      `  - Camera: ${sceneData.camera || 'as described'}`,
      `  - Lighting: ${sceneData.lighting || 'as described'}`,
      `  - Composition: ${sceneData.composition || 'as described'}`,
      `  - Mood: ${sceneData.mood || 'as described'}`,
      sceneData.outfit ? `  - Outfit (EXACT): ${sceneData.outfit}` : null,
      sceneData.hair ? `  - Hair: ${sceneData.hair}` : null,
      sceneData.pose ? `  - POSE LOCK: ${sceneData.pose}. MUST match this exact body position — do NOT default to standing/sitting.` : null,
      sceneData.expression ? `  - EXPRESSION: ${sceneData.expression}` : null,
      'Place the character naturally. Do not alter identity.',
      '[END SCENE PRESERVATION]',
      '',
      'Honor BRIGHTNESS score and shadow % exactly. Dark scenes stay dark.',
      'OUTFIT FIDELITY: Render exactly as described — no added fabric, no raised necklines.',
      '',
      REALISM_DIRECTIVE,
    ].filter(Boolean).join('\n');

    return basePrompt + preservationRules;
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
    if (sceneData.hair) parts.push(`Hair: ${sceneData.hair}.`);
    if (sceneData.format) parts.push(`Format: ${sceneData.format}.`);

    return parts.join(' ') || 'A detailed scene.';
  }
}

SceneAnalyzer.SCENE_FIELDS = SCENE_FIELDS;

module.exports = new SceneAnalyzer();
