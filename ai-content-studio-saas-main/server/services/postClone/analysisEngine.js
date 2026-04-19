'use strict';
const { asText } = require('../../utils/helpers');
const geminiService = require('../geminiBackend');
const referenceManager = require('../referenceManager');
const promptBuilder = require('../promptBuilder');
const promptKnowledgeService = require('../promptKnowledgeService');
const styleLibrary = require('../styleLibrary');
const REALISM_DIRECTIVE = require('../../utils/realismDirective');
const log = require('../../utils/logger');
const { TATTOO_TERMS_REGEX, TATTOO_SENTENCE_REGEX } = require('./mediaUtils');

const ANALYSIS_KEYS = ['lighting', 'camera', 'pose', 'expression', 'outfit', 'scene', 'accessories', 'details', 'format', 'wig', 'full_prompt'];

// ── Parsing ────────────────────────────────────────────────────────────────────

function parseStructuredAnalysis(rawText) {
  const defaults = Object.fromEntries(ANALYSIS_KEYS.map((k) => [k, '']));
  const raw = asText(rawText);
  if (!raw) return { parsed: defaults, usedFallback: true };

  let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  for (const attempt of [cleaned, cleaned.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean)) {
    try {
      const json = JSON.parse(attempt);
      if (json && typeof json === 'object') {
        const parsed = { ...defaults };
        for (const key of ANALYSIS_KEYS) parsed[key] = asText(json[key]);
        if (!parsed.full_prompt) {
          parsed.full_prompt = ANALYSIS_KEYS.filter((k) => k !== 'full_prompt').map((k) => parsed[k]).filter(Boolean).join(', ');
        }
        return { parsed, usedFallback: false };
      }
    } catch { }
  }

  const parsed = { ...defaults };
  for (const key of ANALYSIS_KEYS) {
    const match = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"`, 'i'))
      || cleaned.match(new RegExp(`${key}\\s*:\\s*([^\\n]+)`, 'i'));
    if (match) parsed[key] = asText(match[1]).replace(/\\"/g, '"');
  }
  if (!parsed.full_prompt) {
    parsed.full_prompt = ANALYSIS_KEYS.filter((k) => k !== 'full_prompt').map((k) => parsed[k]).filter(Boolean).join(', ');
  }
  return { parsed, usedFallback: true };
}

// ── Tattoo filtering ───────────────────────────────────────────────────────────

function stripTattooMentions(text) {
  const input = asText(text);
  if (!input) return '';
  if (!TATTOO_TERMS_REGEX.test(input)) return input.trim();

  let cleaned = input.replace(TATTOO_SENTENCE_REGEX, ' ').replace(/\s{2,}/g, ' ').trim();
  if (TATTOO_TERMS_REGEX.test(cleaned)) {
    cleaned = cleaned.split('\n').map((l) => l.trim()).filter(Boolean)
      .filter((l) => !TATTOO_TERMS_REGEX.test(l)).join(' ').replace(/\s{2,}/g, ' ').trim();
  }
  return cleaned;
}

function stripTattoosFromStructured(parsed) {
  const result = {};
  for (const key of ANALYSIS_KEYS) result[key] = stripTattooMentions(parsed?.[key]);
  if (!result.full_prompt) {
    result.full_prompt = ANALYSIS_KEYS.filter((k) => k !== 'full_prompt').map((k) => result[k]).filter(Boolean).join(', ');
  }
  return result;
}

// ── Reference images ───────────────────────────────────────────────────────────

function buildCharacterReferenceImages(characterId, activeRefs) {
  const refs = [];
  for (const primary of referenceManager.getPrimaryImages(characterId)) {
    if (primary?.buffer?.length) refs.push({ mimeType: primary.mimeType, base64Data: primary.buffer.toString('base64') });
  }
  for (const ref of activeRefs || []) {
    const data = referenceManager.getReferenceImage(characterId, ref.id);
    if (data?.buffer?.length) refs.push({ mimeType: data.mimeType, base64Data: data.buffer.toString('base64') });
  }
  return refs;
}

// ── Prompt builders ────────────────────────────────────────────────────────────

function buildStructuredAnalysisPrompt(mode, cosplayMode = false) {
  const creativeLine = mode === 'creative'
    ? 'Scene: reinterpret location creatively while keeping the same vibe and lighting feel.'
    : 'Scene: recreate the original setting faithfully.';
  const wigField = cosplayMode ? '\n  "wig": "Exact wig: shade, length, cut, texture, styling, accessories.",' : '';
  const fullPromptNote = cosplayMode ? 'Include wig description in the prompt. ' : '';

  return [
    `Analyze this image. Return ONLY valid JSON. Directive tone (brief a photographer). No tattoos.`,
    '',
    `{`,
    `  "lighting": "Brightness X/10. Shadow coverage %. Key light (source, direction, temp). Fill level. Shadow character (hard/soft). Mood summary.",`,
    `  "camera": "Shot type, focal length, angle, DOF.",`,
    `  "pose": "Weight distribution, limb placement, torso angle, hand positions.",`,
    `  "expression": "Mood, gaze direction, mouth/brow state.",`,
    `  "outfit": "Exact garments: fit, fabric, color, coverage. Do NOT sanitize.",`,
    `  "scene": "Environment, surfaces, depth, color palette.",`,
    `  "accessories": "Type, material, placement.",`,
    `  "details": "Color grading, grain, contrast, saturation.",`,
    `  "format": "Photo type (casual phone / pro studio), post-processing style.",`,
    `${wigField}`,
    `  "full_prompt": "Single flowing paragraph: SCENE→LIGHTING→CAMERA→POSE→EXPRESSION→OUTFIT→DETAILS→FORMAT. Start with 'BRIGHTNESS X/10.' Identity-agnostic. ${fullPromptNote}Include exact outfit. State photo quality (casual/pro)."`,
    `}`,
    '',
    creativeLine,
  ].join('\n');
}

function buildCarouselDeltaPrompt(mode) {
  const sceneLine = mode === 'creative'
    ? 'For scene changes, keep vibe continuity but reinterpret setting details creatively when appropriate.'
    : 'Keep scene progression faithful to original sequence.';
  return [
    'You are given two carousel images: first is slide 1 baseline, second is current slide.',
    'Compare current slide to slide 1 and respond in JSON only with keys:',
    'lighting, camera, pose, expression, outfit, scene, accessories, details, format, full_prompt',
    '',
    'Describe ONLY what changed from slide 1.',
    "For unchanged fields, write exactly: same as slide 1",
    'EXCEPTION — outfit, accessories, and lighting MUST always be described in FULL even if unchanged. Never write "same as slide 1" for these fields.',
    'IMPORTANT: For each changed field, write a DESCRIPTIVE NATURAL LANGUAGE sentence — NOT comma-separated tags.',
    'Describe like briefing a photographer. Use directive tone (not "she is" or "the woman"). At least 8 words per changed field.',
    'TATTOO EXCLUSION RULE: Ignore tattoos/body ink entirely. Never mention tattoos in any field, even if visible in either image.',
    '',
    'lighting: MUST include ALL of the following even if unchanged from slide 1:',
    '  1) BRIGHTNESS SCORE: Rate overall scene brightness 1-10 (1=near-black, 3=very dark/nighttime, 5=medium, 7=bright, 10=blown-out white).',
    '  2) SHADOW COVERAGE: Estimate what percentage of the frame is in shadow.',
    '  3) KEY LIGHT: Primary light source type, direction, intensity, color temperature.',
    '  4) FILL LIGHT: Ambient/fill light level.',
    '  5) SHADOW CHARACTER: Hard-edged or soft? How black are the deepest shadows?',
    '  6) MOOD SUMMARY: One sentence.',
    'outfit: Always provide the COMPLETE outfit description with garment type, fit, fabric, color, and coverage.',
    'accessories: Always describe all visible accessories in full.',
    '',
    'For other changed fields describe: camera (shot type/angle/focal length/DOF), pose (weight distribution/limbs/torso/hands), expression (mood/gaze/mouth/eyebrows), format (rendering style/visual treatment).',
    sceneLine,
    'full_prompt: write an identity-agnostic delta prompt following SCENE → LIGHTING → CAMERA → POSE → EXPRESSION → OUTFIT → ACCESSORIES → DETAILS → FORMAT order. Describe only changes from slide 1 EXCEPT always include FULL lighting (with BRIGHTNESS X/10 score, shadow coverage %), outfit, and accessories. START with "BRIGHTNESS X/10." No identity/body descriptors. Keep expression. Directive tone. One flowing natural language paragraph.',
    'Output strictly valid JSON object only.',
  ].join('\n');
}

function buildDarknessEnforcement(structured) {
  const prompt = structured.full_prompt || structured.lighting || '';
  const match = prompt.match(/BRIGHTNESS\s+(\d+)\s*\/\s*10/i);
  if (!match) return null;
  const score = parseInt(match[1], 10);
  if (score > 4) return null;
  return `[DARKNESS: ${score}/10] Low-light scene. Deep shadows, minimal illumination. Only the described light source visible. Dark stays dark.`;
}

function buildGenerationPrompt({ character, activeRefs, mode, cosplayMode = false, structured, isDelta }) {
  const parts = [];
  parts.push(mode === 'creative'
    ? '[VISUAL STYLE: Creative reinterpretation — keep vibe/lighting, allow scene creativity.]'
    : '[VISUAL STYLE: Authentic snapshot recreation. Match casual phone-photo quality, candid feel, raw energy.]');
  if (isDelta) parts.push('Carousel follow-up — maintain continuity with slide 1.');
  if (structured.full_prompt) parts.push(structured.full_prompt);
  if (structured.pose && structured.pose !== 'same as slide 1') parts.push(`Pose: ${structured.pose}`);
  if (structured.expression && structured.expression !== 'same as slide 1') parts.push(`Expression: ${structured.expression}`);
  if (cosplayMode && structured.wig) parts.push(`Wig: ${structured.wig} (overrides reference hair — cosplay wig on the same person).`);
  parts.push('Match BRIGHTNESS score and shadow coverage from the analysis exactly. Dark scenes stay dark.');
  const darkness = buildDarknessEnforcement(structured);
  if (darkness) parts.push(darkness);
  parts.push(REALISM_DIRECTIVE);
  return promptBuilder.buildPrompt({
    masterPrompt: character.masterPrompt,
    activeReferences: activeRefs,
    userPrompt: parts.filter(Boolean).join('\n'),
  });
}

// ── AI analysis ────────────────────────────────────────────────────────────────

async function analyzeImageStructured(apiKey, imageBase64, mimeType, mode, sourceMeta, characterId, cosplayMode = false) {
  const analysisPrompt = buildStructuredAnalysisPrompt(mode, cosplayMode);
  let raw = '';
  const emptyParsed = Object.fromEntries(ANALYSIS_KEYS.map((k) => [k, '']));
  let parsed = { ...emptyParsed };

  try {
    raw = await geminiService.analyzeImageWithPrompt(apiKey, imageBase64, mimeType, analysisPrompt);
    ({ parsed } = parseStructuredAnalysis(raw));
    parsed = stripTattoosFromStructured(parsed);
  } catch (err) {
    raw = `ANALYSIS_ERROR: ${err.message || 'unknown error'}`;
    promptKnowledgeService.create({ source_url: sourceMeta.source_url, source_type: sourceMeta.source_type, carousel_position: sourceMeta.carousel_position, character_id: characterId, mode, ...emptyParsed, gemini_raw_response: raw });
    throw err;
  }

  promptKnowledgeService.create({ source_url: sourceMeta.source_url, source_type: sourceMeta.source_type, carousel_position: sourceMeta.carousel_position, character_id: characterId, mode, ...parsed, gemini_raw_response: raw });

  try {
    const styleCats = ['lighting', 'camera', 'pose', 'expression', 'outfit', 'scene', 'accessories', 'format'];
    for (const cat of styleCats) {
      if (typeof parsed[cat] === 'string' && parsed[cat].trim().length > 15) {
        styleLibrary.createAtom({ category: cat, text: styleLibrary.stripIdentity(parsed[cat].trim()), tags: [], source: { type: 'post_clone', postUrl: sourceMeta.source_url || '' } });
      }
    }
  } catch (err) { log.warn('post_clone_style_feed_failed', { message: err.message }); }

  return { parsed, raw };
}

async function analyzeCarouselDelta(apiKey, firstBase64, firstMimeType, currentBase64, currentMimeType, mode, sourceMeta, characterId) {
  const prompt = buildCarouselDeltaPrompt(mode);
  let raw = '';
  const emptyParsed = Object.fromEntries(ANALYSIS_KEYS.map((k) => [k, '']));
  let parsed = { ...emptyParsed };

  try {
    raw = await geminiService.analyzeImagesWithPrompt(apiKey, [{ base64Data: firstBase64, mimeType: firstMimeType }, { base64Data: currentBase64, mimeType: currentMimeType }], prompt);
    ({ parsed } = parseStructuredAnalysis(raw));
    parsed = stripTattoosFromStructured(parsed);
  } catch (err) {
    raw = `ANALYSIS_ERROR: ${err.message || 'unknown error'}`;
    promptKnowledgeService.create({ source_url: sourceMeta.source_url, source_type: sourceMeta.source_type, carousel_position: sourceMeta.carousel_position, character_id: characterId, mode, ...emptyParsed, gemini_raw_response: raw });
    throw err;
  }

  promptKnowledgeService.create({ source_url: sourceMeta.source_url, source_type: sourceMeta.source_type, carousel_position: sourceMeta.carousel_position, character_id: characterId, mode, ...parsed, gemini_raw_response: raw });

  try {
    const styleCats = ['lighting', 'camera', 'pose', 'expression', 'outfit', 'scene', 'accessories', 'format'];
    for (const cat of styleCats) {
      if (typeof parsed[cat] === 'string' && parsed[cat].trim().length > 15) {
        styleLibrary.createAtom({ category: cat, text: styleLibrary.stripIdentity(parsed[cat].trim()), tags: [], source: { type: 'post_clone', postUrl: sourceMeta.source_url || '' } });
      }
    }
  } catch (err) { log.warn('post_clone_style_feed_failed', { message: err.message }); }

  return { parsed, raw };
}

module.exports = {
  ANALYSIS_KEYS,
  parseStructuredAnalysis, stripTattooMentions, stripTattoosFromStructured,
  buildCharacterReferenceImages,
  buildStructuredAnalysisPrompt, buildCarouselDeltaPrompt, buildDarknessEnforcement, buildGenerationPrompt,
  analyzeImageStructured, analyzeCarouselDelta,
};
