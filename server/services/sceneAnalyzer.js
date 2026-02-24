// server/services/sceneAnalyzer.js

const { AppError } = require('../middleware/errorHandler');
const apiKeyManager = require('./apiKeyManager');
const geminiService = require('./geminiService');
const referenceManager = require('./referenceManager');
const promptBuilder = require('./promptBuilder');
const REALISM_DIRECTIVE = require('../utils/realismDirective');

const SCENE_FIELDS = [
  'environment', 'lighting', 'cameraAngle', 'composition',
  'mood', 'objects', 'depth', 'timeOfDay', 'perspective', 'framingStyle',
  'pose', 'expression', 'outfit', 'hair', 'format',
];

class SceneAnalyzer {
  /**
   * Analyze an uploaded image and extract structured scene data.
   */
  async analyzeScene(imageBase64, mimeType) {
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new AppError('Image base64 data is required', 400, 'VALIDATION_ERROR');
    }
    if (!mimeType || typeof mimeType !== 'string') {
      throw new AppError('Image MIME type is required', 400, 'VALIDATION_ERROR');
    }

    const apiKey = apiKeyManager.getActiveKey();
    const result = await geminiService.analyzeImage(apiKey, imageBase64, mimeType);

    // Ensure all expected fields exist
    const scene = {};
    for (const field of SCENE_FIELDS) {
      scene[field] = (typeof result[field] === 'string') ? result[field] : '';
    }
    return scene;
  }

  /**
   * Build a recreation prompt from scene data + character identity.
   */
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

    // Convert structured scene data to descriptive paragraph
    const sceneParagraph = this._sceneToDescription(sceneData);

    // Build the identity-locked prompt with scene as the user prompt
    const basePrompt = promptBuilder.buildPrompt({
      masterPrompt: character.masterPrompt,
      activeReferences: activeRefs,
      userPrompt: sceneParagraph,
    });

    // Add scene preservation rules
    const preservationRules = [
      '',
      '[SCENE PRESERVATION — LOCKED]',
      'Recreate the exact scene described above with this character.',
      'Maintain precisely:',
      `  - Camera angle: ${sceneData.cameraAngle || 'as described'}`,
      `  - Lighting: ${sceneData.lighting || 'as described'}`,
      `  - Composition: ${sceneData.composition || 'as described'}`,
      `  - Framing: ${sceneData.framingStyle || 'as described'}`,
      `  - Depth: ${sceneData.depth || 'as described'}`,
      `  - Mood: ${sceneData.mood || 'as described'}`,
      sceneData.outfit ? `  - Outfit (EXACT match required): ${sceneData.outfit}` : null,
      sceneData.hair ? `  - Hair: ${sceneData.hair}` : null,
      sceneData.pose ? `  - POSE LOCK — MANDATORY: ${sceneData.pose}. The character MUST be in this exact body position. Do NOT default to standing or sitting if the pose describes lying down, reclining, or any other non-upright position.` : null,
      sceneData.expression ? `  - EXPRESSION LOCK: ${sceneData.expression}` : null,
      'The character must be placed naturally within this scene.',
      'Do not alter the character identity in any way.',
      '[END SCENE PRESERVATION]',
      '',
      'LIGHTING FIDELITY — MANDATORY: If the lighting description contains a BRIGHTNESS X/10 score and shadow coverage percentage, honor them precisely. A score of 3/10 means the image must be DARK. Do NOT brighten, add fill light, or soften shadows beyond what is described.',
      'VISUAL QUALITY: Match the photo quality of the source. If it is a casual phone photo, candid snapshot, or amateur selfie — keep that natural, unpolished feel. Do NOT upgrade to professional studio lighting or commercial retouching unless the source is clearly a professional shot.',
      'BODY & OUTFIT FIDELITY: Render the outfit exactly as described — do NOT add extra fabric, raise necklines, lengthen hemlines, or make clothing more conservative.',
      '',
      REALISM_DIRECTIVE,
    ].filter(Boolean).join('\n');

    return basePrompt + preservationRules;
  }

  _sceneToDescription(sceneData) {
    const parts = [];

    if (sceneData.environment) parts.push(`Setting: ${sceneData.environment}.`);
    if (sceneData.timeOfDay) parts.push(`Time of day: ${sceneData.timeOfDay}.`);
    if (sceneData.lighting) parts.push(`Lighting: ${sceneData.lighting}.`);
    if (sceneData.mood) parts.push(`Mood: ${sceneData.mood}.`);
    if (sceneData.cameraAngle) parts.push(`Camera: ${sceneData.cameraAngle}.`);
    if (sceneData.perspective) parts.push(`Perspective: ${sceneData.perspective}.`);
    if (sceneData.framingStyle) parts.push(`Framing: ${sceneData.framingStyle}.`);
    if (sceneData.composition) parts.push(`Composition: ${sceneData.composition}.`);
    if (sceneData.depth) parts.push(`Depth: ${sceneData.depth}.`);
    if (sceneData.objects) parts.push(`Key elements: ${sceneData.objects}.`);
    if (sceneData.pose) parts.push(`Pose: ${sceneData.pose}.`);
    if (sceneData.expression) parts.push(`Expression: ${sceneData.expression}.`);
    if (sceneData.outfit) parts.push(`Outfit: ${sceneData.outfit}.`);
    if (sceneData.hair) parts.push(`Hair: ${sceneData.hair}.`);
    if (sceneData.format) parts.push(`Photo quality: ${sceneData.format}.`);

    return parts.join(' ') || 'A detailed scene.';
  }
}

SceneAnalyzer.SCENE_FIELDS = SCENE_FIELDS;

module.exports = new SceneAnalyzer();
