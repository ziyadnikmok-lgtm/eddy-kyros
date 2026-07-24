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

    // Single identity anchor at the top
    sections.push([
      '[IDENTITY ANCHOR]',
      'Reference photos define the EXACT subject. Preserve face, bone structure, body proportions, and skin tone.',
      'Reproduce the makeup EXACTLY as shown in the reference photos — same lip color and lipstick (including bold or dark shades such as black/dark lips), same eyeshadow, same eyeliner, same false lashes, and same brows. Do NOT neutralize, soften, lighten, or "naturalize" the makeup; if the references show black lipstick, the output MUST keep black lipstick.',
      masterPrompt.trim(),
    ].join('\n'));

    // Style overrides from active references
    if (activeReferences.length > 0) {
      const overrideSection = this._buildOverrideSection(activeReferences);
      if (overrideSection) {
        sections.push(overrideSection);
      }
    }

    // Scene/generation instructions
    if (userPrompt && typeof userPrompt === 'string' && userPrompt.trim().length > 0) {
      const cleanedUserPrompt = this._cleanDuplicates(
        userPrompt.trim(),
        masterPrompt,
        activeReferences
      );
      if (cleanedUserPrompt.length > 0) {
        sections.push(cleanedUserPrompt);
      }
    }

    // Single compact tech footer
    sections.push(
      '[TECHNICAL]\n' +
      'Render outfit exactly as described — no added coverage, no raised necklines. Maintain character proportions from references. No tattoos/ink.'
    );

    return sections.join('\n\n');
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

    const parts = [];
    for (const category of CATEGORY_ORDER) {
      if (!grouped[category]) continue;
      const unique = this._deduplicatePrompts(grouped[category]);
      parts.push(`${category}: ${unique.join('. ')}`);
    }

    return `[STYLE OVERRIDES]\n${parts.join('\n')}`;
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
