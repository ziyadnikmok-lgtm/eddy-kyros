const { AppError } = require('../middleware/errorHandler');
const fs = require('node:fs');
const apiKeyManager = require('./apiKeyManager');
const geminiService = require('./geminiBackend');
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

const VALID_OPTIMIZE_FOR = ['saves', 'shares', 'comments', 'reach', 'explore'];

const OPTIMIZE_STRATEGIES = {
  saves: {
    label: 'Saves',
    prompt: [
      '[ENGAGEMENT OPTIMIZATION — maximize SAVES]',
      'Your content strategy MUST maximize bookmark-worthy, save-for-later value:',
      '  - Structure content as a reference: lists, frameworks, step-by-step, or checklists',
      '  - Each slide should deliver standalone value worth revisiting',
      '  - Use "save this for later" or "bookmark this" language naturally',
      '  - Include at least one "screenshot slide" — valuable enough to screenshot on its own',
      '  - Educational depth > surface entertainment. Teach something actionable.',
      '  - End with a summary or key takeaway that rewards the full swipe',
    ].join('\n'),
  },
  shares: {
    label: 'Shares',
    prompt: [
      '[ENGAGEMENT OPTIMIZATION — maximize SHARES]',
      'Your content strategy MUST maximize share-worthy, send-to-a-friend potential:',
      '  - Write for RELATABILITY — universal experiences that make people say "this is so me"',
      '  - Include identity signaling — content people share to say something about themselves',
      '  - Use "tag someone who..." or "send this to..." framing naturally',
      '  - Create emotional resonance: humor, nostalgia, validation, or solidarity',
      '  - At least one slide should work as a standalone share (out of context still makes sense)',
      '  - Strong opinions and bold takes > safe generic content',
    ].join('\n'),
  },
  comments: {
    label: 'Comments',
    prompt: [
      '[ENGAGEMENT OPTIMIZATION — maximize COMMENTS]',
      'Your content strategy MUST maximize comment engagement and conversation:',
      '  - End at least 2 slides with a direct question or debate prompt',
      '  - Use "fill in the blank" or "unpopular opinion" or "hot take" framing',
      '  - Present a slightly controversial or debatable perspective to spark replies',
      '  - Ask for personal stories: "tell me about a time when..." or "what\'s your..."',
      '  - Create a curiosity gap that people NEED to discuss in comments',
      '  - Use polls/choices: "A or B?" or "which one are you?"',
    ].join('\n'),
  },
  reach: {
    label: 'Reach',
    prompt: [
      '[ENGAGEMENT OPTIMIZATION — maximize REACH]',
      'Your content strategy MUST maximize algorithmic reach and new audience discovery:',
      '  - Hook must stop scrollers in under 1.5 seconds — lead with shock value or curiosity',
      '  - Optimize for dwell time: make people pause and read every slide',
      '  - Broad appeal with niche depth — accessible to new followers but valuable to existing ones',
      '  - Trending topic hooks or current cultural moments increase distribution',
      '  - First 3 slides determine if people keep swiping — front-load the value',
      '  - Encourage multiple engagement types (like + comment + save) for compound algorithmic boost',
    ].join('\n'),
  },
  explore: {
    label: 'Explore Page',
    prompt: [
      '[ENGAGEMENT OPTIMIZATION — maximize EXPLORE PAGE potential]',
      'Your content strategy MUST hit Explore page quality thresholds:',
      '  - Explore rewards high save-to-impression ratio above all else',
      '  - Content must be niche-specific but accessible to adjacent audiences',
      '  - Visual-text alignment must be tight — captions should directly reference images',
      '  - Hook strength is critical — Explore users decide in <1 second whether to engage',
      '  - Combine educational depth with aesthetic appeal',
      '  - Avoid engagement bait ("like if you agree") — Explore penalizes it',
      '  - Focus on genuine value delivery over manipulation tactics',
    ].join('\n'),
  },
};

const MAX_SLIDES = 10;
const MAX_HASHTAGS = 25;
const DEFAULT_HASHTAG_COUNT = 15;

class CarouselStoryteller {
  async generateCarouselStory(params) {
    const {
      imageIds,
      nicheId,
      toneOverride,
      includeHashtags = true,
      hashtagCount = DEFAULT_HASHTAG_COUNT,
      ctaType = 'follow',
      viralMode = false,
      optimizeFor,
    } = params || {};

    this._validate(params);

    const niche = nicheManager.getNiche(nicheId);
    const brandVoice = brandVoiceManager.getBrandVoice();
    const imageMetas = imageIds.map((id) => this._resolveImageMeta(id));

    const useOptimize = VALID_OPTIMIZE_FOR.includes(optimizeFor) ? optimizeFor : null;
    const prompt = this._buildPrompt({
      niche,
      brandVoice,
      imageMetas,
      toneOverride: toneOverride || null,
      includeHashtags,
      hashtagCount: Math.min(hashtagCount, MAX_HASHTAGS),
      ctaType,
      viralMode,
      optimizeFor: useOptimize,
      slideCount: Math.min(imageMetas.length, MAX_SLIDES),
    });

    const apiKey = apiKeyManager.getActiveKey();
    const rawText = await geminiService.generateText(apiKey, prompt, {
      model: 'gemini-3-flash-preview',
    });

    const parsed = this._parseResponse(rawText, imageMetas.length, includeHashtags);

    return parsed;
  }

  _validate(params) {
    if (!params || typeof params !== 'object') {
      throw new AppError('Story parameters are required', 400, 'VALIDATION_ERROR');
    }

    const { imageIds, nicheId, hashtagCount, ctaType } = params;

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

    if (!nicheId || typeof nicheId !== 'string') {
      throw new AppError('"nicheId" is required', 400, 'VALIDATION_ERROR');
    }
    nicheManager.getNiche(nicheId);

    if (hashtagCount !== undefined) {
      if (typeof hashtagCount !== 'number' || hashtagCount < 0 || hashtagCount > MAX_HASHTAGS) {
        throw new AppError(`hashtagCount must be 0–${MAX_HASHTAGS}`, 400, 'VALIDATION_ERROR');
      }
    }

    if (ctaType !== undefined) {
      if (!VALID_CTA_TYPES.includes(ctaType)) {
        throw new AppError(
          `ctaType must be one of: ${VALID_CTA_TYPES.join(', ')}`,
          400,
          'VALIDATION_ERROR'
        );
      }
    }

    if (params.optimizeFor !== undefined && params.optimizeFor !== null) {
      if (!VALID_OPTIMIZE_FOR.includes(params.optimizeFor)) {
        throw new AppError(
          `optimizeFor must be one of: ${VALID_OPTIMIZE_FOR.join(', ')}`,
          400,
          'VALIDATION_ERROR'
        );
      }
    }

    if (params.toneOverride !== undefined && params.toneOverride !== null) {
      if (typeof params.toneOverride !== 'string' || params.toneOverride.trim().length === 0) {
        throw new AppError('toneOverride must be a non-empty string', 400, 'VALIDATION_ERROR');
      }
      if (params.toneOverride.length > 2000) {
        throw new AppError('toneOverride must be 2000 chars or fewer', 400, 'VALIDATION_ERROR');
      }
    }
  }

  _buildPrompt({ niche, brandVoice, imageMetas, toneOverride, includeHashtags, hashtagCount, ctaType, viralMode, optimizeFor, slideCount }) {
    const sections = [];

    const tone = toneOverride || niche.tone;
    sections.push([
      `Act as a high-growth Instagram creator writing carousel captions.`,
      '',
      `[ANTI-AI VOICE — CRITICAL]`,
      `Write like a real person, not an AI. NO corporate jargon. NO "Unlock your potential", "Dive into", "Elevate your", "In a world where", "Here\'s the thing", "Let\'s talk about". Use lowercase aesthetic or casual conversational tone. Short punchy sentences. Max 2 emojis per slide. Sound like a friend texting, not a marketing bot.`,
    ].join('\n'));

    sections.push([
      `[NICHE: ${niche.name}]`,
      `Tone: ${tone}`,
      ...niche.styleRules.map((r) => `- ${r}`),
      `Triggers: ${niche.emotionalTriggers.join(', ')}`,
      `Hook: ${niche.hookStrategy} | CTA: ${niche.ctaStyle}`,
    ].join('\n'));

    if (brandVoice.writingStyleDescription || brandVoice.vocabularyPreferences.length > 0 || brandVoice.forbiddenWords.length > 0) {
      const bvLines = ['[BRAND VOICE]'];
      if (brandVoice.writingStyleDescription) bvLines.push(`Style: ${brandVoice.writingStyleDescription}`);
      if (brandVoice.vocabularyPreferences.length > 0) bvLines.push(`Vocab: ${brandVoice.vocabularyPreferences.join(', ')}`);
      bvLines.push(`Emojis: ${brandVoice.emojiFrequency}`);
      if (brandVoice.forbiddenWords.length > 0) bvLines.push(`Banned words: ${brandVoice.forbiddenWords.join(', ')}`);
      sections.push(bvLines.join('\n'));
    }

    const imageLines = ['[SLIDES]'];
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
      imageLines.push(`${i + 1}: ${cleanDesc}`);
    }
    sections.push(imageLines.join('\n'));

    if (viralMode) {
      sections.push([
        '[VIRAL MODE]',
        'Curiosity gap in hook (close on final slide). Alternate short/medium sentences.',
        'Pattern interrupt mid-carousel. At least one screenshot-worthy slide.',
        'Emotional arc: tension → build → resolve.',
      ].join('\n'));
    }

    if (optimizeFor && OPTIMIZE_STRATEGIES[optimizeFor]) {
      sections.push(OPTIMIZE_STRATEGIES[optimizeFor].prompt);
    }

    const ctaDesc = this._ctaDescription(ctaType);
    sections.push([
      '[OUTPUT — JSON only, no markdown]',
      `{ "hook": "scroll-stopper", "slides": [{ "slide": 1, "caption": "..." }...${slideCount} slides],`,
      `  "finalCTA": "${ctaDesc} CTA",`,
      includeHashtags ? `  "hashtags": [${hashtagCount} tags without #],` : '  "hashtags": [],',
      `  "engagementInsights": { "hookStrength": 1-10, "saveWorthiness": 1-10, "sharePotential": 1-10, "commentLikelihood": 1-10, "exploreScore": 1-100, "optimizedFor": "${optimizeFor || 'general'}", "tips": ["...", "..."] },`,
      `  "lifecycleTips": { "goldenHour": ["..."], "sustain": ["..."], "archive": ["..."] }`,
      '}',
    ].join('\n'));

    sections.push([
      '[RULES]',
      `1-2 short sentences per slide. Slide 1 = hook. Slides 2-${Math.max(2, slideCount - 1)} = value. Final = payoff + CTA.`,
      'JSON only. No preamble.',
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

  _parseResponse(rawText, expectedSlides, includeHashtags) {
    let cleaned = rawText.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
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

    const result = {
      hook: '',
      slides: [],
      finalCTA: '',
      hashtags: [],
      engagementInsights: null,
      lifecycleTips: null,
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

    if (!result.hook && result.slides.length > 0) {
      result.hook = result.slides[0].caption;
    }

    if (parsed.engagementInsights && typeof parsed.engagementInsights === 'object') {
      const ei = parsed.engagementInsights;
      result.engagementInsights = {
        hookStrength: this._clampScore(ei.hookStrength, 1, 10),
        saveWorthiness: this._clampScore(ei.saveWorthiness, 1, 10),
        sharePotential: this._clampScore(ei.sharePotential, 1, 10),
        commentLikelihood: this._clampScore(ei.commentLikelihood, 1, 10),
        exploreScore: this._clampScore(ei.exploreScore, 1, 100),
        optimizedFor: typeof ei.optimizedFor === 'string' ? ei.optimizedFor : 'general',
        tips: Array.isArray(ei.tips) ? ei.tips.filter((t) => typeof t === 'string').slice(0, 5) : [],
      };
    }

    if (parsed.lifecycleTips && typeof parsed.lifecycleTips === 'object') {
      const lt = parsed.lifecycleTips;
      const extractList = (arr) => Array.isArray(arr) ? arr.filter((t) => typeof t === 'string').slice(0, 4) : [];
      result.lifecycleTips = {
        goldenHour: extractList(lt.goldenHour),
        sustain: extractList(lt.sustain),
        archive: extractList(lt.archive),
      };
    }

    return result;
  }

  _clampScore(value, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.max(min, Math.min(max, Math.round(num)));
  }
}

CarouselStoryteller.VALID_CTA_TYPES = VALID_CTA_TYPES;
CarouselStoryteller.VALID_OPTIMIZE_FOR = VALID_OPTIMIZE_FOR;
CarouselStoryteller.MAX_SLIDES = MAX_SLIDES;
CarouselStoryteller.MAX_HASHTAGS = MAX_HASHTAGS;

module.exports = new CarouselStoryteller();
