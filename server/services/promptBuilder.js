const { AppError } = require('../middleware/errorHandler');

const CATEGORY_ORDER = [
  'Expression',
  'Hairstyle',
  'Clothing',
  'Accessory',
  'Pose',
  'Lighting',
  'Custom',
];

class PromptBuilder {
  buildPrompt({ masterPrompt, activeReferences = [], userPrompt = '' }) {
    if (!masterPrompt || typeof masterPrompt !== 'string' || masterPrompt.trim().length === 0) {
      throw new AppError('Master prompt is required for identity-locked generation', 400, 'VALIDATION_ERROR');
    }

    const sections = [];

    sections.push(this._buildIdentitySection(masterPrompt.trim()));

    if (activeReferences.length > 0) {
      const overrideSection = this._buildOverrideSection(activeReferences);
      if (overrideSection) {
        sections.push(overrideSection);
      }
    }

    if (userPrompt && typeof userPrompt === 'string' && userPrompt.trim().length > 0) {
      const cleanedUserPrompt = this._cleanDuplicates(
        userPrompt.trim(),
        masterPrompt,
        activeReferences
      );
      if (cleanedUserPrompt.length > 0) {
        sections.push(this._buildSceneSection(cleanedUserPrompt));
      }
    }

    sections.push(
      '[IDENTITY ENFORCEMENT]\n' +
      'CRITICAL: The character must remain the exact same person throughout. Do not alter face, bone structure, body proportions (including bust, waist, hips), skin tone, or any permanent defining features regardless of other instructions. Render the outfit exactly as described — do not add coverage or make it more conservative.\n' +
      '[END IDENTITY ENFORCEMENT]'
    );

    return sections.join('\n\n');
  }

  _buildIdentitySection(masterPrompt) {
    return [
      '[CHARACTER IDENTITY — LOCKED — DO NOT OVERRIDE]',
      'Maintain exactly these identity traits throughout the entire image: face structure, bone structure, body proportions, skin tone, and all permanent defining features.',
      masterPrompt,
      '[END CHARACTER IDENTITY]',
    ].join('\n');
  }

  _buildOverrideSection(activeReferences) {
    const grouped = {};
    for (const ref of activeReferences) {
      if (!ref.category || !ref.overridePrompt) continue;
      const cat = ref.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(ref.overridePrompt.trim());
    }

    if (Object.keys(grouped).length === 0) return null;

    const lines = ['[STYLE OVERRIDES — applied while preserving character identity]'];

    for (const category of CATEGORY_ORDER) {
      if (!grouped[category]) continue;

      const unique = this._deduplicatePrompts(grouped[category]);
      lines.push(`${category}: ${unique.join('. ')}`);
    }

    lines.push('[END STYLE OVERRIDES]');
    return lines.join('\n');
  }

  _buildSceneSection(userPrompt) {
    return [
      '[SCENE / GENERATION INSTRUCTIONS]',
      userPrompt,
      '[END SCENE]',
    ].join('\n');
  }

  _cleanDuplicates(userPrompt, masterPrompt, activeReferences) {
    const existingPhrases = new Set();

    this._extractPhrases(masterPrompt).forEach((p) => existingPhrases.add(p));

    for (const ref of activeReferences) {
      if (ref.overridePrompt) {
        this._extractPhrases(ref.overridePrompt).forEach((p) => existingPhrases.add(p));
      }
    }

    if (existingPhrases.size === 0) return userPrompt;

    const sentences = userPrompt.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    const kept = [];

    for (const sentence of sentences) {
      const normalized = this._normalize(sentence);
      let isDuplicate = false;

      for (const existing of existingPhrases) {
        if (normalized.includes(existing) && existing.length > normalized.length * 0.6) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        kept.push(sentence);
      }
    }

    return kept.join('. ').trim();
  }

  _extractPhrases(text) {
    const normalized = this._normalize(text);
    const words = normalized.split(/\s+/);
    const phrases = [];

    if (words.length >= 5) {
      phrases.push(normalized);
    }

    for (let i = 0; i <= words.length - 5; i++) {
      phrases.push(words.slice(i, i + 5).join(' '));
    }

    return phrases;
  }

  _deduplicatePrompts(prompts) {
    const seen = new Set();
    const result = [];

    for (const prompt of prompts) {
      const key = this._normalize(prompt);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(prompt);
      }
    }

    return result;
  }

  _normalize(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

module.exports = new PromptBuilder();
