const { AppError } = require('../middleware/errorHandler');
const referenceManager = require('./referenceManager');
const REALISM_DIRECTIVE = require('../utils/realismDirective');

const VALID_MODIFICATIONS = ['pose', 'expression', 'clothing', 'cameraAngle', 'mood'];

class TweakBuilder {
  buildTweakPrompt({ originalMetadata, modifications }) {
    if (!originalMetadata || !originalMetadata.basePrompt) {
      throw new AppError('Original image metadata with basePrompt is required', 400, 'VALIDATION_ERROR');
    }

    this._validateModifications(modifications);

    const sections = [];

    const identitySection = this._buildIdentitySection(originalMetadata);
    if (identitySection) {
      sections.push(identitySection);
    }

    sections.push(this._buildSceneLockSection(originalMetadata));
    sections.push(this._buildModificationSection(modifications));
    sections.push(this._buildAntiDriftSection(originalMetadata));
    sections.push(REALISM_DIRECTIVE);

    return sections.join('\n\n');
  }

  _validateModifications(modifications) {
    if (!modifications || typeof modifications !== 'object') {
      throw new AppError('Modifications object is required', 400, 'VALIDATION_ERROR');
    }

    const extraKeys = Object.keys(modifications).filter((k) => !VALID_MODIFICATIONS.includes(k));
    if (extraKeys.length > 0) {
      throw new AppError(
        `Unknown modification fields: ${extraKeys.join(', ')}. Valid: ${VALID_MODIFICATIONS.join(', ')}`,
        400,
        'VALIDATION_ERROR'
      );
    }

    for (const key of VALID_MODIFICATIONS) {
      const val = modifications[key];
      if (val !== undefined && val !== null) {
        if (typeof val !== 'string') {
          throw new AppError(`modifications.${key} must be a string`, 400, 'VALIDATION_ERROR');
        }
        if (val.trim().length > 2000) {
          throw new AppError(`modifications.${key} must be 2000 characters or fewer`, 400, 'VALIDATION_ERROR');
        }
      }
    }

    const hasAny = VALID_MODIFICATIONS.some((key) => {
      const val = modifications[key];
      return val && typeof val === 'string' && val.trim().length > 0;
    });

    if (!hasAny) {
      throw new AppError(
        `At least one modification is required: ${VALID_MODIFICATIONS.join(', ')}`,
        400,
        'EMPTY_TWEAK'
      );
    }
  }

  _buildIdentitySection(metadata) {
    if (!metadata.characterId) return null;

    try {
      const character = referenceManager.getCharacter(metadata.characterId);
      return [
        '[CHARACTER IDENTITY — LOCKED — DO NOT OVERRIDE]',
        'Maintain exactly these identity traits throughout the entire image: face structure, bone structure, body proportions, skin tone, and all permanent defining features.',
        character.masterPrompt,
        '[END CHARACTER IDENTITY]',
      ].join('\n');
    } catch {
      return null;
    }
  }

  _buildSceneLockSection(metadata) {
    const sceneDesc = metadata.sceneDescription
      || this._extractSceneFromPrompt(metadata.basePrompt);

    const lines = [
      '[SCENE CONTINUITY — LOCKED]',
      'This image is a controlled variation of a previous generation.',
      'Reproduce the original scene with exact visual continuity.',
      '',
      `Original scene: ${sceneDesc}`,
      '',
      'Preserve exactly:',
      '  - Environment and background elements',
      '  - Lighting direction, color temperature, and intensity',
      '  - Camera framing, angle, and focal distance',
      '  - Overall composition and spatial layout',
      '  - Color palette and atmosphere',
      '  - Time of day and weather conditions',
      '[END SCENE CONTINUITY]',
    ];

    return lines.join('\n');
  }

  _buildModificationSection(modifications) {
    const lines = [
      '[MODIFICATIONS — apply only these changes]',
      'Change ONLY the following attributes while keeping everything else identical:',
    ];

    if (modifications.pose && modifications.pose.trim()) {
      lines.push(`  Pose: ${this._sanitizeModValue(modifications.pose)}`);
    }
    if (modifications.expression && modifications.expression.trim()) {
      lines.push(`  Expression: ${this._sanitizeModValue(modifications.expression)}`);
    }
    if (modifications.clothing && modifications.clothing.trim()) {
      lines.push(`  Clothing: ${this._sanitizeModValue(modifications.clothing)}`);
    }
    if (modifications.cameraAngle && modifications.cameraAngle.trim()) {
      lines.push(`  Camera angle: ${this._sanitizeModValue(modifications.cameraAngle)}`);
    }
    if (modifications.mood && modifications.mood.trim()) {
      lines.push(`  Mood/atmosphere: ${this._sanitizeModValue(modifications.mood)}`);
    }

    lines.push('[END MODIFICATIONS]');
    return lines.join('\n');
  }

  _buildAntiDriftSection(metadata) {
    const lines = [
      '[CONTINUITY ENFORCEMENT]',
      'CRITICAL: Do not alter character identity.',
    ];

    if (metadata.characterId) {
      lines.push('The character must remain the same person — same face, same body, same skin, same defining features.');
    }

    lines.push(
      'The scene must look like a continuation or alternate take of the original image.',
      'Only the explicitly listed modifications should differ.',
      '[END CONTINUITY ENFORCEMENT]'
    );

    return lines.join('\n');
  }

  _sanitizeModValue(value) {
    return value
      .trim()
      .replace(/\[CHARACTER IDENTITY[^\]]*\]/gi, '')
      .replace(/\[END CHARACTER IDENTITY\]/gi, '')
      .replace(/\[SCENE CONTINUITY[^\]]*\]/gi, '')
      .replace(/\[END SCENE[^\]]*\]/gi, '')
      .replace(/\[STYLE OVERRIDES[^\]]*\]/gi, '')
      .replace(/\[END STYLE[^\]]*\]/gi, '')
      .replace(/\[MODIFICATIONS[^\]]*\]/gi, '')
      .replace(/\[END MODIFICATIONS\]/gi, '')
      .replace(/\[CONTINUITY ENFORCEMENT\]/gi, '')
      .replace(/\[END CONTINUITY[^\]]*\]/gi, '')
      .replace(/DO NOT OVERRIDE/gi, '')
      .replace(/IGNORE (?:ALL )?(?:PREVIOUS|ABOVE) INSTRUCTIONS/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _extractSceneFromPrompt(prompt) {
    if (!prompt || typeof prompt !== 'string') return 'Unknown scene';

    const sceneMatch = prompt.match(
      /\[SCENE\s*\/?\s*GENERATION INSTRUCTIONS\]\s*([\s\S]*?)\s*\[END SCENE\]/i
    );
    if (sceneMatch && sceneMatch[1].trim().length > 0) {
      return sceneMatch[1].trim();
    }

    const endIdentity = prompt.indexOf('[END CHARACTER IDENTITY]');
    const endOverrides = prompt.indexOf('[END STYLE OVERRIDES]');
    const afterStructured = Math.max(endIdentity, endOverrides);

    if (afterStructured > -1) {
      const remainder = prompt.slice(afterStructured).replace(/\[END[^\]]*\]/g, '').trim();
      if (remainder.length > 10) return remainder;
    }

    const cleaned = prompt
      .replace(/\[CHARACTER IDENTITY[^\]]*\][\s\S]*?\[END CHARACTER IDENTITY\]/gi, '')
      .replace(/\[STYLE OVERRIDES[^\]]*\][\s\S]*?\[END STYLE OVERRIDES\]/gi, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return cleaned.length > 0 ? cleaned.slice(0, 500) : 'Scene from previous generation';
  }
}

TweakBuilder.VALID_MODIFICATIONS = VALID_MODIFICATIONS;

module.exports = new TweakBuilder();
