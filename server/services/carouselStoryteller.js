// server/services/carouselStoryteller.js

const { AppError } = require('../middleware/errorHandler');
const fs = require('node:fs');
const apiKeyManager = require('./apiKeyManager');
const geminiService = require('./geminiService');
const imageStore = require('./imageStore');
const galleryManager = require('./galleryManager');
const nicheManager = require('./nicheManager');
const brandVoiceManager = require('./brandVoiceManager');

const VALID_CTA_TYPES = [
  'follow',
  'like',
  'comment',
  'share',
  'save',
  'link',
  'dm',
  'custom',
];

const MAX_SLIDES = 10;
const MAX_HASHTAGS = 25;
const DEFAULT_HASHTAG_COUNT = 15;

class CarouselStoryteller {
  /**
   * Generate a full carousel story with structured captions.
   *
   * @param {object} params
   * @param {string[]} params.imageIds         - Image IDs from imageStore
   * @param {string}   params.nicheId          - Niche to use
   * @param {string}  [params.toneOverride]    - Override niche tone
   * @param {boolean} [params.includeHashtags] - Include hashtags (default true)
   * @param {number}  [params.hashtagCount]    - Number of hashtags (default 15, max 25)
   * @param {string}  [params.ctaType]         - CTA type
   * @param {boolean} [params.viralMode]       - Enable viral writing techniques
   * @returns {Promise<object>} { hook, slides, finalCTA, hashtags }
   */
  async generateCarouselStory(params) {
    const {
      imageIds,
      nicheId,
      toneOverride,
      includeHashtags = true,
      hashtagCount = DEFAULT_HASHTAG_COUNT,
      ctaType = 'follow',
      viralMode = false,
    } = params || {};

    // --- Validate ---
    this._validate(params);

    // --- Load data ---
    const niche = nicheManager.getNiche(nicheId);
    const brandVoice = brandVoiceManager.getBrandVoice();
    const imageMetas = imageIds.map((id) => this._resolveImageMeta(id));

    // --- Build prompt ---
    const prompt = this._buildPrompt({
      niche,
      brandVoice,
      imageMetas,
      toneOverride: toneOverride || null,
      includeHashtags,
      hashtagCount: Math.min(hashtagCount, MAX_HASHTAGS),
      ctaType,
      viralMode,
      slideCount: Math.min(imageMetas.length, MAX_SLIDES),
    });

    // --- Call Gemini ---
    const apiKey = apiKeyManager.getActiveKey();
    const rawText = await geminiService.generateText(apiKey, prompt, {
      model: 'gemini-3-flash-preview',
    });

    // --- Parse response ---
    const parsed = this._parseResponse(rawText, imageMetas.length, includeHashtags);

    return parsed;
  }

  // =========================================================================
  // Validation
  // =========================================================================

  _validate(params) {
    if (!params || typeof params !== 'object') {
      throw new AppError('Story parameters are required', 400, 'VALIDATION_ERROR');
    }

    const { imageIds, nicheId, hashtagCount, ctaType } = params;

    // imageIds
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      throw new AppError('"imageIds" array is required and must not be empty', 400, 'VALIDATION_ERROR');
    }
    if (imageIds.length > MAX_SLIDES) {
      throw new AppError(`Max ${MAX_SLIDES} slides per carousel`, 400, 'VALIDATION_ERROR');
    }
    for (let i = 0; i < imageIds.length; i++) {
      if (!imageIds[i] || typeof imageIds[i] !== 'string') {
        throw new AppError(`imageIds[${i}] is invalid`, 400, 'VALIDATION_ERROR');
      }
    }

    // nicheId
    if (!nicheId || typeof nicheId !== 'string') {
      throw new AppError('"nicheId" is required', 400, 'VALIDATION_ERROR');
    }
    // Verify existence (throws 404 if missing)
    nicheManager.getNiche(nicheId);

    // hashtagCount
    if (hashtagCount !== undefined) {
      if (typeof hashtagCount !== 'number' || hashtagCount < 0 || hashtagCount > MAX_HASHTAGS) {
        throw new AppError(`hashtagCount must be 0–${MAX_HASHTAGS}`, 400, 'VALIDATION_ERROR');
      }
    }

    // ctaType
    if (ctaType !== undefined) {
      if (!VALID_CTA_TYPES.includes(ctaType)) {
        throw new AppError(
          `ctaType must be one of: ${VALID_CTA_TYPES.join(', ')}`,
          400,
          'VALIDATION_ERROR'
        );
      }
    }

    // toneOverride
    if (params.toneOverride !== undefined && params.toneOverride !== null) {
      if (typeof params.toneOverride !== 'string' || params.toneOverride.trim().length === 0) {
        throw new AppError('toneOverride must be a non-empty string', 400, 'VALIDATION_ERROR');
      }
      if (params.toneOverride.length > 2000) {
        throw new AppError('toneOverride must be 2000 chars or fewer', 400, 'VALIDATION_ERROR');
      }
    }
  }

  // =========================================================================
  // Prompt builder
  // =========================================================================

  _buildPrompt({ niche, brandVoice, imageMetas, toneOverride, includeHashtags, hashtagCount, ctaType, viralMode, slideCount }) {
    const sections = [];

    // --- Role ---
    sections.push(
      'You are an expert social media carousel caption writer. You create scroll-stopping, engagement-optimized carousel captions for Instagram and similar platforms.'
    );

    // --- Niche context ---
    const tone = toneOverride || niche.tone;
    sections.push([
      `[NICHE: ${niche.name}]`,
      `Tone: ${tone}`,
      `Writing style rules:`,
      ...niche.styleRules.map((r) => `  - ${r}`),
      `Emotional triggers to leverage: ${niche.emotionalTriggers.join(', ')}`,
      `Hook strategy: ${niche.hookStrategy}`,
      `CTA style: ${niche.ctaStyle}`,
    ].join('\n'));

    // --- Brand Voice overlay ---
    if (brandVoice.writingStyleDescription || brandVoice.vocabularyPreferences.length > 0 || brandVoice.forbiddenWords.length > 0) {
      const bvLines = ['[BRAND VOICE — merge with niche style]'];
      if (brandVoice.writingStyleDescription) {
        bvLines.push(`Writing style: ${brandVoice.writingStyleDescription}`);
      }
      if (brandVoice.vocabularyPreferences.length > 0) {
        bvLines.push(`Preferred vocabulary: ${brandVoice.vocabularyPreferences.join(', ')}`);
      }
      bvLines.push(`Emoji frequency: ${brandVoice.emojiFrequency}`);
      if (brandVoice.forbiddenWords.length > 0) {
        bvLines.push(`NEVER use these words: ${brandVoice.forbiddenWords.join(', ')}`);
      }
      sections.push(bvLines.join('\n'));
    }

    // --- Image context ---
    const imageLines = ['[CAROUSEL IMAGES — write captions that match these visuals]'];
    for (let i = 0; i < imageMetas.length; i++) {
      const meta = imageMetas[i];
      const desc = meta.sceneDescription || meta.basePrompt || 'No description';
      const cleanDesc = desc
        .replace(/\[CHARACTER IDENTITY[^\]]*\][\s\S]*?\[END CHARACTER IDENTITY\]/gi, '')
        .replace(/\[STYLE OVERRIDES[^\]]*\][\s\S]*?\[END STYLE OVERRIDES\]/gi, '')
        .replace(/\[SCENE[^\]]*\]|\[END[^\]]*\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      imageLines.push(`Slide ${i + 1}: ${cleanDesc}`);
    }
    sections.push(imageLines.join('\n'));

    // --- Viral mode ---
    if (viralMode) {
      sections.push([
        '[VIRAL MODE — ENABLED]',
        'Apply these viral writing techniques:',
        '  - Curiosity gap: Open a loop in the hook that only closes on the final slide',
        '  - Psychological triggers: Use social proof, scarcity, or identity signaling',
        '  - Rhythm: Alternate short and medium sentences. Never two long sentences in a row.',
        '  - Pattern interrupts: Insert an unexpected word, question, or shift mid-carousel',
        '  - Shareability: Write at least one slide that is screenshot-worthy on its own',
        '  - Emotional arc: Start with tension, build through middle, resolve at end',
      ].join('\n'));
    }

    // --- Output format ---
    const ctaDesc = this._ctaDescription(ctaType);
    const formatLines = [
      '[OUTPUT FORMAT — respond ONLY with this exact JSON structure, no markdown fences, no extra text]',
      '{',
      '  "hook": "The scroll-stopping opening line for slide 1",',
      '  "slides": [',
    ];
    for (let i = 0; i < slideCount; i++) {
      const comma = i < slideCount - 1 ? ',' : '';
      if (i === 0) {
        formatLines.push(`    { "slide": ${i + 1}, "caption": "Hook slide — the scroll-stopper" }${comma}`);
      } else if (i === slideCount - 1) {
        formatLines.push(`    { "slide": ${i + 1}, "caption": "Final slide — emotional payoff + CTA" }${comma}`);
      } else {
        formatLines.push(`    { "slide": ${i + 1}, "caption": "Build narrative / deliver value" }${comma}`);
      }
    }
    formatLines.push('  ],');
    formatLines.push(`  "finalCTA": "A compelling ${ctaDesc} call-to-action",`);
    if (includeHashtags) {
      formatLines.push(`  "hashtags": ["exactly ${hashtagCount} relevant hashtags without #"]`);
    } else {
      formatLines.push('  "hashtags": []');
    }
    formatLines.push('}');

    sections.push(formatLines.join('\n'));

    // --- Rules ---
    sections.push([
      '[RULES]',
      '- Each slide caption: 1–2 short sentences. Clear, readable, no fluff.',
      '- Slide 1 = Hook (scroll-stopping opener)',
      `- Slides 2–${Math.max(2, slideCount - 1)} = Build narrative, deliver value`,
      '- Final slide = Emotional payoff + CTA',
      '- Match the tone and style rules exactly',
      '- Do NOT use any forbidden words from the brand voice',
      '- Respond ONLY with valid JSON. No explanation, no markdown code fences, no preamble.',
    ].join('\n'));

    return sections.join('\n\n');
  }

  _ctaDescription(ctaType) {
    const map = {
      follow: 'follow-me',
      like: 'like-this-post',
      comment: 'leave-a-comment',
      share: 'share-with-friends',
      save: 'save-for-later',
      link: 'check-link-in-bio',
      dm: 'send-a-DM',
      custom: 'custom',
    };
    return map[ctaType] || 'follow-me';
  }

  /**
   * Resolve an image id from imageStore first, then gallery fallback.
   * If found in gallery, import into imageStore so downstream logic stays consistent.
   */
  _resolveImageMeta(id) {
    try {
      return imageStore.get(id);
    } catch {
      const galleryEntry = galleryManager.get(id);
      const { filePath, mimeType } = galleryManager.getFilePath(id);
      const buffer = fs.readFileSync(filePath);
      const imported = imageStore.store({
        basePrompt: galleryEntry.prompt || 'Gallery image',
        characterId: galleryEntry.characterId || null,
        activeReferenceIds: null,
        sceneDescription: galleryEntry.prompt || null,
        modelUsed: null,
        seed: galleryEntry.seed || null,
        parentImageId: null,
        variationIndex: null,
        image: {
          mimeType,
          base64Data: buffer.toString('base64'),
        },
        source: 'generate',
      });
      return imageStore.get(imported.imageId);
    }
  }

  // =========================================================================
  // Response parser
  // =========================================================================

  _parseResponse(rawText, expectedSlides, includeHashtags) {
    // Strip markdown fences if present
    let cleaned = rawText.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Try to extract JSON from surrounding text
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          throw new AppError(
            'Failed to parse Gemini response as JSON. The model returned malformed output.',
            502,
            'PARSE_ERROR'
          );
        }
      } else {
        throw new AppError(
          'Gemini did not return JSON. Try again.',
          502,
          'PARSE_ERROR'
        );
      }
    }

    // Validate structure
    const result = {
      hook: '',
      slides: [],
      finalCTA: '',
      hashtags: [],
    };

    if (typeof parsed.hook === 'string') {
      result.hook = parsed.hook.trim();
    }

    if (Array.isArray(parsed.slides)) {
      result.slides = parsed.slides
        .slice(0, MAX_SLIDES)
        .map((s, i) => ({
          slide: s.slide || i + 1,
          caption: (typeof s.caption === 'string') ? s.caption.trim() : '',
        }));
    }

    if (typeof parsed.finalCTA === 'string') {
      result.finalCTA = parsed.finalCTA.trim();
    }

    if (includeHashtags && Array.isArray(parsed.hashtags)) {
      result.hashtags = parsed.hashtags
        .filter((h) => typeof h === 'string')
        .map((h) => h.trim().replace(/^#/, ''))
        .slice(0, MAX_HASHTAGS);
    }

    // Fill hook from first slide if empty
    if (!result.hook && result.slides.length > 0) {
      result.hook = result.slides[0].caption;
    }

    return result;
  }
}

CarouselStoryteller.VALID_CTA_TYPES = VALID_CTA_TYPES;
CarouselStoryteller.MAX_SLIDES = MAX_SLIDES;
CarouselStoryteller.MAX_HASHTAGS = MAX_HASHTAGS;

module.exports = new CarouselStoryteller();
