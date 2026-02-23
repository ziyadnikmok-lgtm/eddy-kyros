// server/services/promptBuilder.js

const { AppError } = require('../middleware/errorHandler');

/**
 * Identity Lock Prompt Builder
 *
 * Enforces strict hierarchy:
 *   1. Master character prompt (identity lock — face, bone structure, body, skin, defining traits)
 *   2. Active override references grouped by category
 *   3. User/scene prompt
 *
 * No override may replace identity traits.
 */

// Categories in rendering priority order
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
  /**
   * Build a final structured prompt with identity locking.
   *
   * @param {object} params
   * @param {string} params.masterPrompt - The character's identity-locking master prompt
   * @param {Array<{ category: string, overridePrompt: string }>} params.activeReferences
   * @param {string} params.userPrompt - Scene or generation prompt from the user
   * @returns {string} Final composed prompt
   */
  buildPrompt({ masterPrompt, activeReferences = [], userPrompt = '' }) {
    if (!masterPrompt || typeof masterPrompt !== 'string' || masterPrompt.trim().length === 0) {
      throw new AppError('Master prompt is required for identity-locked generation', 400, 'VALIDATION_ERROR');
    }

    const sections = [];

    // -----------------------------------------------------------------------
    // 1. IDENTITY LOCK — always first, highest priority
    // -----------------------------------------------------------------------
    sections.push(this._buildIdentitySection(masterPrompt.trim()));

    // -----------------------------------------------------------------------
    // 2. ACTIVE REFERENCE OVERRIDES — grouped by category
    // -----------------------------------------------------------------------
    if (activeReferences.length > 0) {
      const overrideSection = this._buildOverrideSection(activeReferences);
      if (overrideSection) {
        sections.push(overrideSection);
      }
    }

    // -----------------------------------------------------------------------
    // 3. USER / SCENE PROMPT — appended last
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // 4. ANTI-DRIFT REINFORCEMENT — always last
    // -----------------------------------------------------------------------
    sections.push(
      '[IDENTITY ENFORCEMENT]\n' +
      'CRITICAL: The character must remain the exact same person throughout. Do not alter face, bone structure, body proportions (including bust, waist, hips), skin tone, or any permanent defining features regardless of other instructions. Render the outfit exactly as described — do not add coverage or make it more conservative.\n' +
      '[END IDENTITY ENFORCEMENT]'
    );

    return sections.join('\n\n');
  }

  // =========================================================================
  // Section builders
  // =========================================================================

  _buildIdentitySection(masterPrompt) {
    return [
      '[CHARACTER IDENTITY — LOCKED — DO NOT OVERRIDE]',
      'Maintain exactly these identity traits throughout the entire image: face structure, bone structure, body proportions, skin tone, and all permanent defining features.',
      masterPrompt,
      '[END CHARACTER IDENTITY]',
    ].join('\n');
  }

  _buildOverrideSection(activeReferences) {
    // Group by category
    const grouped = {};
    for (const ref of activeReferences) {
      if (!ref.category || !ref.overridePrompt) continue;
      const cat = ref.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(ref.overridePrompt.trim());
    }

    if (Object.keys(grouped).length === 0) return null;

    const lines = ['[STYLE OVERRIDES — applied while preserving character identity]'];

    // Output in defined category order
    for (const category of CATEGORY_ORDER) {
      if (!grouped[category]) continue;

      // Deduplicate prompts within same category
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

  // =========================================================================
  // Deduplication & cleaning
  // =========================================================================

  /**
   * Remove phrases from the user prompt that are already present
   * in the master prompt or active reference overrides to avoid
   * repetition that could confuse the model.
   */
  _cleanDuplicates(userPrompt, masterPrompt, activeReferences) {
    // Collect all existing phrases (lowercased, normalized)
    const existingPhrases = new Set();

    // Extract significant phrases from master prompt (5+ word sequences)
    this._extractPhrases(masterPrompt).forEach((p) => existingPhrases.add(p));

    // Extract from overrides
    for (const ref of activeReferences) {
      if (ref.overridePrompt) {
        this._extractPhrases(ref.overridePrompt).forEach((p) => existingPhrases.add(p));
      }
    }

    if (existingPhrases.size === 0) return userPrompt;

    // Split user prompt into sentences and filter out duplicates
    const sentences = userPrompt.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    const kept = [];

    for (const sentence of sentences) {
      const normalized = this._normalize(sentence);
      // Only remove if a substantial portion matches (exact phrase match)
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

  /**
   * Extract significant phrases (5+ words) from text for dedup matching.
   */
  _extractPhrases(text) {
    const normalized = this._normalize(text);
    const words = normalized.split(/\s+/);
    const phrases = [];

    // Full text as one phrase
    if (words.length >= 5) {
      phrases.push(normalized);
    }

    // Sliding window of 5-word sequences for partial matching
    for (let i = 0; i <= words.length - 5; i++) {
      phrases.push(words.slice(i, i + 5).join(' '));
    }

    return phrases;
  }

  /**
   * Deduplicate an array of prompt strings within the same category.
   */
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

  /**
   * Normalize text for comparison: lowercase, collapse whitespace, strip punctuation.
   */
  _normalize(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

// Singleton
module.exports = new PromptBuilder();
