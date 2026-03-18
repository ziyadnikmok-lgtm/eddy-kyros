const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const ffmpegPath = require('../utils/ffmpeg');
const { ApifyClient } = require('apify-client');
const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const { sharedHttpsAgent } = require('../utils/httpAgent');
const { buildLoginCookies } = require('../utils/instagramCookies');
const apiKeyManager = require('../services/apiKeyManager');
const referenceManager = require('../services/referenceManager');
const promptBuilder = require('../services/promptBuilder');
const geminiService = require('../services/geminiService');
const galleryManager = require('../services/galleryManager');
const promptKnowledgeService = require('../services/promptKnowledgeService');
const styleLibrary = require('../services/styleLibrary');
const { checkPostAvailability } = require('../services/instagramAvailabilityService');
const postCloneHistoryStore = require('../services/postCloneHistoryStore');
const REALISM_DIRECTIVE = require('../utils/realismDirective');

const router = express.Router();
const { TEMP_DIR } = require('../paths');
const THUMB_DIR = path.join(TEMP_DIR, 'thumbs');
const ROUTE_TIMEOUT_MS = 5 * 60_000;
const PROFILE_ROUTE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_ACTOR_ID = process.env.APIFY_POST_ACTOR_ID || 'apify/instagram-post-scraper';
const FALLBACK_ACTOR_ID = process.env.APIFY_POST_FALLBACK_ACTOR_ID || 'apify/instagram-scraper';
const PROFILE_ACTOR_ID = process.env.APIFY_PROFILE_ACTOR_ID || 'apify/instagram-profile-scraper';
const PROFILE_POSTS_ACTOR_ID = 'apify/instagram-post-scraper';
const COMMUNITY_POSTS_ACTOR_ID = process.env.APIFY_COMMUNITY_POSTS_ACTOR_ID || 'shu8hvrXbJbY3Eb9W';
const ANALYSIS_KEYS = ['lighting', 'camera', 'pose', 'expression', 'outfit', 'scene', 'accessories', 'details', 'format', 'wig', 'full_prompt'];
const TATTOO_TERMS_REGEX = /\b(?:tattoo(?:s|ed|ing)?|body\s*ink|inked|inkwork|sleeve\s+tattoo|tribal\s+ink)\b/i;
const TATTOO_SENTENCE_REGEX = /[^.!?\n]*\b(?:tattoo(?:s|ed|ing)?|body\s*ink|inked|inkwork|sleeve\s+tattoo|tribal\s+ink)\b[^.!?\n]*[.!?]?/gi;
const THUMB_MAX_AGE_MS = 30 * 60_000;

function ensureTempDir() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function ensureThumbDir() {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
}

async function cacheThumbnail(imageUrl) {
  if (!isHttpUrl(imageUrl)) return '';
  const id = crypto.randomUUID();
  const ext = '.jpg';
  const filename = `${id}${ext}`;
  const filePath = path.join(THUMB_DIR, filename);
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      httpsAgent: sharedHttpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'image/*,*/*;q=0.8',
        'Referer': 'https://www.instagram.com/',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const buffer = Buffer.from(response.data);
    const ct = (response.headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html') || buffer.length < 100) return '';
    fs.writeFileSync(filePath, buffer);
    return filename;
  } catch {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
    return '';
  }
}

function cleanStaleThumbs() {
  try {
    if (!fs.existsSync(THUMB_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(THUMB_DIR)) {
      const fp = path.join(THUMB_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > THUMB_MAX_AGE_MS) fs.unlinkSync(fp);
      } catch { }
    }
  } catch { }
}
setInterval(cleanStaleThumbs, 5 * 60_000).unref();

function isHttpUrl(value) {
  return /^https?:\/\//i.test(asText(value));
}

function looksLikeDirectImageUrl(url) {
  const value = asText(url);
  if (!isHttpUrl(value)) return false;
  const lower = value.toLowerCase();
  if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(lower)) return true;
  if (lower.includes('fbcdn.net') || lower.includes('cdninstagram.com')) return true;
  return false;
}

function parseStructuredAnalysis(rawText) {
  const defaults = {
    lighting: '',
    camera: '',
    pose: '',
    expression: '',
    outfit: '',
    scene: '',
    accessories: '',
    details: '',
    format: '',
    wig: '',
    full_prompt: '',
  };
  const raw = asText(rawText);
  if (!raw) {
    return { parsed: defaults, usedFallback: true };
  }

  let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const json = JSON.parse(cleaned);
    if (json && typeof json === 'object') {
      const parsed = { ...defaults };
      for (const key of ANALYSIS_KEYS) parsed[key] = asText(json[key]);
      if (!parsed.full_prompt) {
        parsed.full_prompt = ANALYSIS_KEYS
          .filter((k) => k !== 'full_prompt')
          .map((k) => parsed[k])
          .filter(Boolean)
          .join(', ');
      }
      return { parsed, usedFallback: false };
    }
  } catch { }

  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const json = JSON.parse(objMatch[0]);
      const parsed = { ...defaults };
      for (const key of ANALYSIS_KEYS) parsed[key] = asText(json[key]);
      if (!parsed.full_prompt) {
        parsed.full_prompt = ANALYSIS_KEYS
          .filter((k) => k !== 'full_prompt')
          .map((k) => parsed[k])
          .filter(Boolean)
          .join(', ');
      }
      return { parsed, usedFallback: false };
    } catch { }
  }

  const parsed = { ...defaults };
  for (const key of ANALYSIS_KEYS) {
    const match = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"`, 'i'))
      || cleaned.match(new RegExp(`${key}\\s*:\\s*([^\\n]+)`, 'i'));
    if (match) parsed[key] = asText(match[1]).replace(/\\"/g, '"');
  }
  if (!parsed.full_prompt) {
    parsed.full_prompt = ANALYSIS_KEYS
      .filter((k) => k !== 'full_prompt')
      .map((k) => parsed[k])
      .filter(Boolean)
      .join(', ');
  }
  return { parsed, usedFallback: true };
}

function stripTattooMentions(text) {
  const input = asText(text);
  if (!input) return '';
  if (!TATTOO_TERMS_REGEX.test(input)) return input.trim();

  let cleaned = input
    .replace(TATTOO_SENTENCE_REGEX, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (TATTOO_TERMS_REGEX.test(cleaned)) {
    cleaned = cleaned
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !TATTOO_TERMS_REGEX.test(line))
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  return cleaned;
}

function stripTattoosFromStructured(parsed) {
  const result = {};
  for (const key of ANALYSIS_KEYS) {
    result[key] = stripTattooMentions(parsed?.[key]);
  }
  if (!result.full_prompt) {
    result.full_prompt = ANALYSIS_KEYS
      .filter((k) => k !== 'full_prompt')
      .map((k) => result[k])
      .filter(Boolean)
      .join(', ');
  }
  return result;
}

function buildCharacterReferenceImages(characterId, activeRefs) {
  const refs = [];
  const primaries = referenceManager.getPrimaryImages(characterId);
  for (const primary of primaries) {
    if (primary?.buffer?.length) {
      refs.push({ mimeType: primary.mimeType, base64Data: primary.buffer.toString('base64') });
    }
  }
  for (const ref of activeRefs || []) {
    const data = referenceManager.getReferenceImage(characterId, ref.id);
    if (data?.buffer?.length) {
      refs.push({ mimeType: data.mimeType, base64Data: data.buffer.toString('base64') });
    }
  }
  return refs;
}

function buildStructuredAnalysisPrompt(mode, cosplayMode = false) {
  const creativeLine = mode === 'creative'
    ? 'Scene: reinterpret location creatively while keeping the same vibe and lighting feel.'
    : 'Scene: recreate the original setting faithfully.';

  const wigField = cosplayMode
    ? '\n  "wig": "Exact wig: shade, length, cut, texture, styling, accessories.",'
    : '';

  const fullPromptNote = cosplayMode
    ? 'Include wig description in the prompt. '
    : '';

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

  // Visual style direction
  parts.push(mode === 'creative'
    ? '[VISUAL STYLE: Creative reinterpretation — keep vibe/lighting, allow scene creativity.]'
    : '[VISUAL STYLE: Authentic snapshot recreation. Match casual phone-photo quality, candid feel, raw energy.]');

  if (isDelta) {
    parts.push('Carousel follow-up — maintain continuity with slide 1.');
  }

  // Scene analysis result
  if (structured.full_prompt) {
    parts.push(structured.full_prompt);
  }

  // Pose + expression
  if (structured.pose && structured.pose !== 'same as slide 1') {
    parts.push(`Pose: ${structured.pose}`);
  }
  if (structured.expression && structured.expression !== 'same as slide 1') {
    parts.push(`Expression: ${structured.expression}`);
  }

  // Cosplay wig override
  if (cosplayMode && structured.wig) {
    parts.push(`Wig: ${structured.wig} (overrides reference hair — cosplay wig on the same person).`);
  }

  // Lighting enforcement
  parts.push('Match BRIGHTNESS score and shadow coverage from the analysis exactly. Dark scenes stay dark.');
  const darkness = buildDarknessEnforcement(structured);
  if (darkness) parts.push(darkness);

  // Realism
  parts.push(REALISM_DIRECTIVE);

  return promptBuilder.buildPrompt({
    masterPrompt: character.masterPrompt,
    activeReferences: activeRefs,
    userPrompt: parts.filter(Boolean).join('\n'),
  });
}

async function analyzeImageStructured(apiKey, imageBase64, mimeType, mode, sourceMeta, characterId, cosplayMode = false) {
  const analysisPrompt = buildStructuredAnalysisPrompt(mode, cosplayMode);
  let raw = '';
  let parsed = {
    lighting: '',
    camera: '',
    pose: '',
    expression: '',
    outfit: '',
    scene: '',
    accessories: '',
    details: '',
    format: '',
    wig: '',
    full_prompt: '',
  };
  try {
    raw = await geminiService.analyzeImageWithPrompt(apiKey, imageBase64, mimeType, analysisPrompt);
    ({ parsed } = parseStructuredAnalysis(raw));
    parsed = stripTattoosFromStructured(parsed);
  } catch (err) {
    raw = `ANALYSIS_ERROR: ${err.message || 'unknown error'}`;
    promptKnowledgeService.create({
      source_url: sourceMeta.source_url,
      source_type: sourceMeta.source_type,
      carousel_position: sourceMeta.carousel_position,
      character_id: characterId,
      mode,
      lighting: '',
      camera: '',
      pose: '',
      expression: '',
      outfit: '',
      scene: '',
      accessories: '',
      details: '',
      format: '',
      full_prompt: '',
      gemini_raw_response: raw,
    });
    throw err;
  }

  promptKnowledgeService.create({
    source_url: sourceMeta.source_url,
    source_type: sourceMeta.source_type,
    carousel_position: sourceMeta.carousel_position,
    character_id: characterId,
    mode,
    lighting: parsed.lighting,
    camera: parsed.camera,
    pose: parsed.pose,
    expression: parsed.expression,
    outfit: parsed.outfit,
    scene: parsed.scene,
    accessories: parsed.accessories,
    details: parsed.details,
    format: parsed.format,
    full_prompt: parsed.full_prompt,
    gemini_raw_response: raw,
  });

  try {
    const styleCats = ['lighting', 'camera', 'pose', 'expression', 'outfit', 'scene', 'accessories', 'format'];
    for (const cat of styleCats) {
      if (typeof parsed[cat] === 'string' && parsed[cat].trim().length > 15) {
        styleLibrary.createAtom({
          category: cat,
          text: styleLibrary.stripIdentity(parsed[cat].trim()),
          tags: [],
          source: { type: 'post_clone', postUrl: sourceMeta.source_url || '' },
        });
      }
    }
  } catch (err) { console.warn('[post-clone] style library auto-feed failed:', err.message); }

  return { parsed, raw };
}

async function analyzeCarouselDelta(apiKey, firstBase64, firstMimeType, currentBase64, currentMimeType, mode, sourceMeta, characterId) {
  const prompt = buildCarouselDeltaPrompt(mode);
  let raw = '';
  let parsed = {
    lighting: '',
    camera: '',
    pose: '',
    expression: '',
    outfit: '',
    scene: '',
    accessories: '',
    details: '',
    format: '',
    wig: '',
    full_prompt: '',
  };
  try {
    raw = await geminiService.analyzeImagesWithPrompt(
      apiKey,
      [
        { base64Data: firstBase64, mimeType: firstMimeType },
        { base64Data: currentBase64, mimeType: currentMimeType },
      ],
      prompt
    );
    ({ parsed } = parseStructuredAnalysis(raw));
    parsed = stripTattoosFromStructured(parsed);
  } catch (err) {
    raw = `ANALYSIS_ERROR: ${err.message || 'unknown error'}`;
    promptKnowledgeService.create({
      source_url: sourceMeta.source_url,
      source_type: sourceMeta.source_type,
      carousel_position: sourceMeta.carousel_position,
      character_id: characterId,
      mode,
      lighting: '',
      camera: '',
      pose: '',
      expression: '',
      outfit: '',
      scene: '',
      accessories: '',
      details: '',
      format: '',
      full_prompt: '',
      gemini_raw_response: raw,
    });
    throw err;
  }

  promptKnowledgeService.create({
    source_url: sourceMeta.source_url,
    source_type: sourceMeta.source_type,
    carousel_position: sourceMeta.carousel_position,
    character_id: characterId,
    mode,
    lighting: parsed.lighting,
    camera: parsed.camera,
    pose: parsed.pose,
    expression: parsed.expression,
    outfit: parsed.outfit,
    scene: parsed.scene,
    accessories: parsed.accessories,
    details: parsed.details,
    format: parsed.format,
    full_prompt: parsed.full_prompt,
    gemini_raw_response: raw,
  });

  try {
    const styleCats = ['lighting', 'camera', 'pose', 'expression', 'outfit', 'scene', 'accessories', 'format'];
    for (const cat of styleCats) {
      if (typeof parsed[cat] === 'string' && parsed[cat].trim().length > 15) {
        styleLibrary.createAtom({
          category: cat,
          text: styleLibrary.stripIdentity(parsed[cat].trim()),
          tags: [],
          source: { type: 'post_clone', postUrl: sourceMeta.source_url || '' },
        });
      }
    }
  } catch (err) { console.warn('[post-clone] style library auto-feed failed:', err.message); }

  return { parsed, raw };
}

function extractImageUrlFromMedia(item) {
  if (typeof item === 'string') {
    const clean = asText(item);
    return looksLikeDirectImageUrl(clean) ? clean : '';
  }
  const iv2 = item?.image_versions2?.candidates;
  const iv2Best = Array.isArray(iv2) && iv2.length > 0
    ? iv2.reduce((best, c) => ((c.width || 0) > (best.width || 0) ? c : best), iv2[0])?.url
    : undefined;
  const candidates = [
    item?.displayUrl,
    item?.display_url,
    item?.thumbnailSrc,
    item?.thumbnail_src,
    item?.imageUrl,
    item?.image_url,
    item?.image,
    iv2Best,
    item?.thumbnailUrl,
    item?.thumbnail_url,
    item?.url,
    item?.src,
  ];
  for (const candidate of candidates) {
    const clean = asText(candidate);
    if (looksLikeDirectImageUrl(clean)) return clean;
  }
  return '';
}

function isVideoItem(item) {
  if (typeof item === 'string') {
    return /\.(mp4|mov|avi|webm)(\?|$)/i.test(item);
  }
  if (!item || typeof item !== 'object') return false;
  if (item.isVideo === true || item.video === true) return true;
  if (item.is_video === true) return true;
  if (item.media_type === 2 || item.mediaType === 2) return true;
  if (isHttpUrl(item.videoUrl) || isHttpUrl(item.video_url) || isHttpUrl(item.video_versions?.[0]?.url)) return true;
  const typeName = asText(item.type || item.__typename || item.productType || '').toLowerCase();
  return typeName.includes('video') || typeName.includes('reel') || typeName === 'graphvideo';
}

function extractPostImages(postItem) {
  if (!postItem || typeof postItem !== 'object') return null;

  const itemTypeName = asText(postItem.type || postItem.__typename || postItem.productType || '').toLowerCase();
  const isCarouselType = itemTypeName.includes('sidecar') || itemTypeName.includes('carousel')
    || postItem.media_type === 8 || postItem.mediaType === 8 || (postItem.mediaCount || 0) > 1;
  if (!isCarouselType && isVideoItem(postItem)) {
    return null;
  }

  const sidecarCandidates = []
    .concat(Array.isArray(postItem.images) ? postItem.images : [])
    .concat(Array.isArray(postItem.carouselMedia) ? postItem.carouselMedia : [])
    .concat(Array.isArray(postItem.carousel_media) ? postItem.carousel_media : [])
    .concat(Array.isArray(postItem.childPosts) ? postItem.childPosts : [])
    .concat(Array.isArray(postItem.sidecarChildren) ? postItem.sidecarChildren : [])
    .concat(Array.isArray(postItem.children) ? postItem.children : [])
    .concat(Array.isArray(postItem.media) ? postItem.media : []);

  const edges = postItem.edgeSidecarToChildren?.edges;
  if (Array.isArray(edges)) {
    for (const edge of edges) sidecarCandidates.push(edge?.node || edge);
  }

  const sideCar = postItem.sideCar || postItem.sidecar;
  if (Array.isArray(sideCar)) {
    for (const item of sideCar) sidecarCandidates.push(item);
  }

  const edgeAlt = postItem.edge_sidecar_to_children?.edges;
  if (Array.isArray(edgeAlt)) {
    for (const edge of edgeAlt) sidecarCandidates.push(edge?.node || edge);
  }

  const carouselImages = sidecarCandidates
    .filter((m) => m && !isVideoItem(m))
    .map((m) => extractImageUrlFromMedia(m))
    .filter((u) => isHttpUrl(u));

  if (carouselImages.length === 0) {
    for (const child of sidecarCandidates) {
      if (!child || isVideoItem(child)) continue;
      const resources = child.display_resources || child.displayResources;
      if (Array.isArray(resources) && resources.length > 0) {
        const best = resources[resources.length - 1];
        const url = asText(best?.src || best?.url);
        if (isHttpUrl(url)) carouselImages.push(url);
      }
    }
  }

  if (carouselImages.length === 0 && sidecarCandidates.length > 0) {
    for (const child of sidecarCandidates) {
      if (!child) continue;
      const thumbUrl = asText(child.thumbnailUrl || child.thumbnail_url || child.displayUrl || child.display_url);
      if (isHttpUrl(thumbUrl)) carouselImages.push(thumbUrl);
    }
  }

  const postLevelImage = extractImageUrlFromMedia(postItem);

  if (carouselImages.length > 1) {
    const deduped = Array.from(new Set(carouselImages));
    if (postLevelImage && isHttpUrl(postLevelImage) && !deduped.includes(postLevelImage)) {
      deduped.push(postLevelImage);
    }
    return {
      type: 'carousel',
      sourceUrl: asText(postItem.url || postItem.inputUrl || postItem.shortCodeUrl || ''),
      imageUrls: deduped,
    };
  }

  if (postLevelImage && !isVideoItem(postItem)) {
    const typeName = asText(postItem.type || postItem.__typename || postItem.productType || '').toLowerCase();
    if (typeName.includes('sidecar') || typeName.includes('carousel') || postItem.mediaCount > 1) {
      console.warn(`[post-clone] CAROUSEL UNDEREXTRACTED: type=${typeName}, mediaCount=${postItem.mediaCount}, extracted=1`);
    }
    return {
      type: 'single',
      sourceUrl: asText(postItem.url || postItem.inputUrl || postItem.shortCodeUrl || postLevelImage),
      imageUrls: [postLevelImage],
    };
  }

  return null;
}

async function resolveUsernameFromPostUrl(postUrl, restrictedItems) {
  const IG_USERNAME_RE = /[A-Za-z0-9._]{1,30}/;
  const RESERVED_SEGS = ['p', 'reel', 'tv', 'explore', 'accounts', 'stories', 'direct', 'about'];
  const isValidUsername = (u) => u && IG_USERNAME_RE.test(u) && !RESERVED_SEGS.includes(u.toLowerCase());

  try {
    const oembed = await axios.get('https://api.instagram.com/oembed/', {
      params: { url: postUrl },
      timeout: 10000,
      httpsAgent: sharedHttpsAgent,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const authorName = asText(oembed.data?.author_name);
    if (isValidUsername(authorName)) {
      console.log(`[post-clone] oEmbed resolved username: ${authorName}`);
      return authorName;
    }
  } catch (e) {
    console.warn(`[post-clone] oEmbed failed: ${e.message}`);
  }

  const sessionid = asText(apiKeyManager.getInstagramSessionId());
  if (sessionid) {
    try {
      const res = await axios.get(postUrl, {
        timeout: 15000,
        httpsAgent: sharedHttpsAgent,
        responseType: 'text',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Cookie': `sessionid=${sessionid}`,
        },
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const html = asText(res.data);
      const ownerMatch = html.match(/"owner"\s*:\s*\{[^}]*"username"\s*:\s*"([^"]+)"/);
      if (ownerMatch && isValidUsername(ownerMatch[1])) {
        console.log(`[post-clone] authenticated HTML resolved username (owner JSON): ${ownerMatch[1]}`);
        return ownerMatch[1];
      }
      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i);
      if (ogDesc) {
        const atMatch = ogDesc[1].match(/@([A-Za-z0-9._]+)/);
        if (atMatch && isValidUsername(atMatch[1])) {
          console.log(`[post-clone] authenticated HTML resolved username (og:desc): ${atMatch[1]}`);
          return atMatch[1];
        }
      }
      const linkMatch = html.match(/instagram\.com\/([A-Za-z0-9._]+)\/?["'\s]/);
      if (linkMatch && isValidUsername(linkMatch[1])) {
        console.log(`[post-clone] authenticated HTML resolved username (link): ${linkMatch[1]}`);
        return linkMatch[1];
      }
    } catch (e) {
      console.warn(`[post-clone] authenticated HTML fetch failed: ${e.message}`);
    }
  }

  if (Array.isArray(restrictedItems)) {
    for (const item of restrictedItems) {
      for (const key of ['ownerUsername', 'username', 'owner', 'userName']) {
        const val = asText(typeof item[key] === 'object' ? item[key]?.username : item[key]);
        if (isValidUsername(val)) {
          console.log(`[post-clone] item metadata resolved username (${key}): ${val}`);
          return val;
        }
      }
      for (const key of ['title', 'description']) {
        const text = asText(item[key]);
        if (!text) continue;
        const atMatch = text.match(/@([A-Za-z0-9._]+)/);
        if (atMatch && isValidUsername(atMatch[1])) {
          console.log(`[post-clone] item ${key} resolved username: ${atMatch[1]}`);
          return atMatch[1];
        }
        const onIg = text.match(/([A-Za-z0-9._]+)\s+on\s+Instagram/i);
        if (onIg && isValidUsername(onIg[1])) {
          console.log(`[post-clone] item ${key} resolved username: ${onIg[1]}`);
          return onIg[1];
        }
      }
    }
  }

  return '';
}

async function fetchDirectIgProfilePosts(profileUsername, limit = 12) {
  const username = asText(profileUsername);
  const sessionid = asText(apiKeyManager.getInstagramSessionId());
  if (!username || !sessionid) return [];

  const endpoint = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const response = await axios.get(endpoint, {
    timeout: 12000,
    httpsAgent: sharedHttpsAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'X-IG-App-ID': '936619743392459',
      'Referer': `https://www.instagram.com/${username}/`,
      'Cookie': `sessionid=${sessionid}`,
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const edges = response?.data?.data?.user?.edge_owner_to_timeline_media?.edges;
  if (!Array.isArray(edges) || edges.length === 0) return [];

  const limitCount = Math.max(1, Math.min(50, Number(limit) || 12));
  return edges
    .slice(0, limitCount)
    .map((e) => e?.node)
    .filter(Boolean)
    .map((n) => ({
      id: n.id,
      shortCode: n.shortcode,
      url: n.shortcode ? `https://www.instagram.com/p/${n.shortcode}/` : '',
      display_url: n.display_url,
      displayUrl: n.display_url,
      is_video: n.is_video,
      media_type: n.__typename === 'GraphSidecar' ? 8 : (n.__typename === 'GraphVideo' ? 2 : 1),
      edge_sidecar_to_children: n.edge_sidecar_to_children,
      edgeSidecarToChildren: n.edge_sidecar_to_children,
    }));
}

async function runPostActor({ url, limit, apifyToken, onlyPostsNewerThan }) {
  const token = asText(apifyToken) || asText(apiKeyManager.getApifyKey()) || asText(process.env.APIFY_TOKEN);
  if (!token) {
    throw new AppError('Apify token is required (provide APIFY_TOKEN env)', 400, 'CONFIG_ERROR');
  }

  const client = new ApifyClient({ token });
  const loginCookies = buildLoginCookies();
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 1));
  const parsedUrl = new URL(url);
  const segments = parsedUrl.pathname.split('/').filter(Boolean);
  const firstSeg = (segments[0] || '').toLowerCase();
  const isPostLike = ['p', 'reel', 'tv'].includes(firstSeg);
  const profileUsername = !isPostLike ? asText(segments[0]) : '';
  const shortCode = isPostLike && segments[1] ? asText(segments[1]) : '';

  async function callActor(actorId, input) {
    return client.actor(actorId).call(input);
  }

  console.log(`[post-clone] session cookies: ${loginCookies ? 'present' : 'MISSING'}, shortCode=${shortCode || 'none'}, profileUsername=${profileUsername || 'none'}`);

  if (profileUsername) {
    try {
      const directItems = await fetchDirectIgProfilePosts(profileUsername, boundedLimit);
      if (directItems.length > 0) {
        console.log(`[post-clone] direct IG fast-path recovered ${directItems.length} post item(s)`);
        return directItems;
      }
    } catch (err) {
      console.warn(`[post-clone] direct IG fast-path failed: ${err.message}`);
    }
  }

  const primaryActorId = profileUsername ? PROFILE_POSTS_ACTOR_ID : DEFAULT_ACTOR_ID;
  const fallbackActorId = profileUsername ? PROFILE_ACTOR_ID : FALLBACK_ACTOR_ID;
  let run;
  let actorUsed = primaryActorId;

  const primaryPayloads = [];
  if (profileUsername) {
    primaryPayloads.push({
      usernames: [profileUsername],
      resultsType: 'posts',
      resultsLimit: boundedLimit,
      addParentData: false,
      ...(loginCookies ? { loginCookies } : {}),
      ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}),
    });
    primaryPayloads.push({
      directUrls: [url],
      startUrls: [{ url }],
      resultsType: 'posts',
      resultsLimit: boundedLimit,
      addParentData: false,
      ...(loginCookies ? { loginCookies } : {}),
      ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}),
    });
    primaryPayloads.push({
      usernames: [profileUsername],
      resultsLimit: boundedLimit,
      ...(loginCookies ? { loginCookies } : {}),
    });
  } else {
    if (shortCode) {
      primaryPayloads.push({
        shortcodes: [shortCode],
        resultsLimit: boundedLimit,
        expandSlideshowImages: true,
        ...(loginCookies ? { loginCookies } : {}),
      });
    }
    primaryPayloads.push({
      directUrls: [url],
      startUrls: [{ url }],
      resultsLimit: boundedLimit,
      resultsType: 'posts',
      expandSlideshowImages: true,
      ...(loginCookies ? { loginCookies } : {}),
    });
    primaryPayloads.push({
      postUrls: [url],
      resultsLimit: boundedLimit,
      expandSlideshowImages: true,
      ...(loginCookies ? { loginCookies } : {}),
    });
  }

  let primaryErr = null;
  for (let i = 0; i < primaryPayloads.length; i++) {
    try {
      console.log(`[post-clone] trying ${primaryActorId} payload #${i + 1}: ${JSON.stringify({ ...primaryPayloads[i], loginCookies: primaryPayloads[i].loginCookies ? '[set]' : undefined })}`);
      run = await callActor(primaryActorId, primaryPayloads[i]);
      console.log(`[post-clone] ${primaryActorId} payload #${i + 1} succeeded`);
      break;
    } catch (err) {
      console.warn(`[post-clone] ${primaryActorId} payload #${i + 1} failed: ${err.message}`);
      primaryErr = err;
    }
  }

  if (!run) {
    console.warn(`[post-clone] primary actor failed, falling back to ${fallbackActorId}`);
    actorUsed = fallbackActorId;
    try {
      run = await callActor(
        fallbackActorId,
        profileUsername
          ? {
            usernames: [profileUsername],
            resultsLimit: boundedLimit,
            ...(loginCookies ? { loginCookies } : {}),
            ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}),
          }
          : {
            directUrls: [url],
            startUrls: [{ url }],
            resultsType: 'posts',
            resultsLimit: boundedLimit,
            addParentData: false,
            ...(loginCookies ? { loginCookies } : {}),
          }
      );
    } catch (fallbackErr) {
      try {
        run = await callActor(
          fallbackActorId,
          profileUsername
            ? {
              usernames: [profileUsername],
              resultsLimit: boundedLimit,
              ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}),
            }
            : {
              directUrls: [url],
              startUrls: [{ url }],
              resultsType: 'posts',
              resultsLimit: boundedLimit,
              addParentData: false,
            }
        );
      } catch {
      }
      throw new AppError(
        `Apify actor run failed (${primaryActorId}): ${primaryErr?.message || 'unknown'} — fallback (${fallbackActorId}): ${fallbackErr.message}`,
        502,
        'APIFY_ERROR'
      );
    }
  }

  const datasetId = run?.defaultDatasetId;
  if (!datasetId) throw new AppError('Apify actor returned no dataset', 502, 'APIFY_ERROR');

  let items = [];
  try {
    const fetchLimit = Math.max(5, Number(limit) * 3 || 20);
    const listed = await client.dataset(datasetId).listItems({ limit: fetchLimit });
    items = Array.isArray(listed?.items) ? listed.items : [];
    console.log(`[post-clone] dataset ${datasetId} (actor=${actorUsed}): ${items.length} item(s) fetched (limit=${fetchLimit})`);
  } catch (err) {
    throw new AppError(`Failed to read Apify dataset (${actorUsed}): ${err.message}`, 502, 'APIFY_ERROR');
  }

  if (profileUsername) {
    const hasPostSignals = (rows) => (Array.isArray(rows) ? rows : []).some((row) => {
      if (!row || typeof row !== 'object') return false;
      if (getItemShortcode(row)) return true;
      if (isHttpUrl(asText(row.displayUrl || row.display_url || row.imageUrl || row.image_url || row.videoUrl || row.video_url))) return true;
      if (Array.isArray(row.images) && row.images.length > 0) return true;
      if (Array.isArray(row.carouselMedia) && row.carouselMedia.length > 0) return true;
      if (Array.isArray(row.children) && row.children.length > 0) return true;
      return false;
    });

    if (!hasPostSignals(items)) {
      console.warn('[post-clone] profile actor returned container-only data; retrying via generic posts scraper');
      const retryPayloads = [
        {
          directUrls: [url],
          startUrls: [{ url }],
          resultsType: 'posts',
          resultsLimit: boundedLimit,
          addParentData: false,
          ...(loginCookies ? { loginCookies } : {}),
          ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}),
        },
      ];

      let retryErr = null;
      for (let i = 0; i < retryPayloads.length; i++) {
        try {
          const retryRun = await callActor(FALLBACK_ACTOR_ID, retryPayloads[i]);
          if (!retryRun?.defaultDatasetId) continue;

          const fetchLimit = Math.max(5, Number(limit) * 3 || 20);
          const listed = await client.dataset(retryRun.defaultDatasetId).listItems({ limit: fetchLimit });
          const retryItems = Array.isArray(listed?.items) ? listed.items : [];
          console.log(`[post-clone] dataset ${retryRun.defaultDatasetId} (actor=${FALLBACK_ACTOR_ID}, payload #${i + 1}): ${retryItems.length} item(s) fetched (limit=${fetchLimit})`);

          if (hasPostSignals(retryItems)) {
            items = retryItems;
            actorUsed = FALLBACK_ACTOR_ID;
            break;
          }

          const firstError = asText(retryItems?.[0]?.error).toLowerCase();
          if (firstError) {
            console.warn(`[post-clone] fallback payload #${i + 1} returned error item: ${firstError}`);
          } else {
            console.warn(`[post-clone] fallback payload #${i + 1} returned no post-like rows`);
          }
        } catch (err) {
          retryErr = err;
        }
      }

      if (!hasPostSignals(items) && retryErr) {
        console.warn(`[post-clone] retry via ${FALLBACK_ACTOR_ID} failed: ${retryErr.message}`);
      }

      if (!hasPostSignals(items)) {
        try {
          const communityPayload = {
            directUrls: [url],
            resultsType: 'posts',
            resultsLimit: Math.max(1, Math.min(200, boundedLimit)),
            addParentData: false,
            ...(loginCookies ? { loginCookies } : {}),
          };
          const communityRun = await callActor(COMMUNITY_POSTS_ACTOR_ID, communityPayload);
          if (communityRun?.defaultDatasetId) {
            const fetchLimit = Math.max(5, Number(limit) * 3 || 20);
            const listed = await client.dataset(communityRun.defaultDatasetId).listItems({ limit: fetchLimit });
            const communityItems = Array.isArray(listed?.items) ? listed.items : [];
            console.log(`[post-clone] dataset ${communityRun.defaultDatasetId} (actor=${COMMUNITY_POSTS_ACTOR_ID}): ${communityItems.length} item(s) fetched (limit=${fetchLimit})`);
            if (hasPostSignals(communityItems)) {
              items = communityItems;
              actorUsed = COMMUNITY_POSTS_ACTOR_ID;
            }
          }
        } catch (err) {
          console.warn(`[post-clone] retry via ${COMMUNITY_POSTS_ACTOR_ID} failed: ${err.message}`);
        }
      }

      if (!hasPostSignals(items)) {
        try {
          const mapped = await fetchDirectIgProfilePosts(profileUsername, boundedLimit);
          if (mapped.length > 0) {
            console.log(`[post-clone] direct IG fallback recovered ${mapped.length} post item(s)`);
            items = mapped;
            actorUsed = 'direct-ig-web-profile';
          }
        } catch (err) {
          console.warn(`[post-clone] direct IG fallback failed: ${err.message}`);
        }
      }
    }
  }

  return items;
}

async function downloadImageToTemp(imageUrl, filePath) {
  const maxAttempts = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        httpsAgent: sharedHttpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'image/*,*/*;q=0.8',
          'Referer': 'https://www.instagram.com/',
        },
        validateStatus: (status) => status >= 200 && status < 400,
      });
      const contentType = asText(response.headers?.['content-type']).toLowerCase();
      const buffer = Buffer.from(response.data);
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        throw new AppError(`Image download returned non-image content-type: ${contentType || 'unknown'}`, 502, 'IMAGE_DOWNLOAD_ERROR');
      }
      if (!buffer || buffer.length < 64) {
        throw new AppError('Downloaded image is empty or too small', 502, 'IMAGE_DOWNLOAD_ERROR');
      }
      fs.writeFileSync(filePath, buffer);
      return { contentType, size: buffer.length };
    } catch (err) {
      lastErr = err;
      if (err instanceof AppError) throw err;
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw new AppError(
    `Image download failed after ${maxAttempts} attempts: ${lastErr?.message || 'unknown'}`,
    502,
    'IMAGE_DOWNLOAD_ERROR'
  );
}

async function resolveDownloadableImageUrl(url) {
  const clean = asText(url);
  if (!isHttpUrl(clean)) return '';
  if (looksLikeDirectImageUrl(clean)) return clean;

  try {
    const res = await axios.get(clean, {
      responseType: 'text',
      timeout: 45000,
      httpsAgent: sharedHttpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const html = asText(res.data);
    const ogMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch && isHttpUrl(ogMatch[1])) {
      return ogMatch[1].replace(/&amp;/g, '&');
    }
  } catch { }

  return clean;
}

function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function safeJpegFromAnyImage(inputPath, tempFiles) {
  const outputPath = path.join(TEMP_DIR, `post-clone-xcode-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
  tempFiles.push(outputPath);
  await execFileAsync(ffmpegPath, ['-y', '-i', inputPath, '-frames:v', '1', outputPath], {
    timeout: 30000,
  });
  return outputPath;
}

async function processOneSlide({
  post, i, apiKey, character, activeRefs, mode, cosplayMode = false, baseReferenceImages,
  characterId, tempFiles, firstSlideOriginal, firstSlideRecreated, imageModel,
}) {
  const rawUrl = post.imageUrls[i];
  const imageUrl = await resolveDownloadableImageUrl(rawUrl);
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${i}`;
  const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
  const filePath = path.join(TEMP_DIR, `post-clone-${unique}${ext}`);
  tempFiles.push(filePath);
  await downloadImageToTemp(imageUrl, filePath);
  let resolvedPath = filePath;
  let buffer = fs.readFileSync(resolvedPath);
  let mimeType = mimeFromExt(resolvedPath);
  let base64Data = buffer.toString('base64');

  const original = { url: imageUrl || rawUrl, mimeType, base64Data };

  const sourceMeta = {
    source_url: post.sourceUrl || imageUrl || rawUrl,
    source_type: post.type,
    carousel_position: post.type === 'carousel' ? i + 1 : null,
  };

  let structured;
  let referenceImages = [...baseReferenceImages];
  let generationPrompt = '';

  if (post.type === 'carousel' && i > 0 && firstSlideOriginal && firstSlideRecreated) {
    let delta;
    try {
      delta = await analyzeCarouselDelta(
        apiKey, firstSlideOriginal.base64Data, firstSlideOriginal.mimeType,
        base64Data, mimeType, mode, sourceMeta, characterId
      );
    } catch (err) {
      const msg = asText(err?.message).toLowerCase();
      if (!msg.includes('unable to process input image') && !msg.includes('invalid_argument')) throw err;
      resolvedPath = await safeJpegFromAnyImage(filePath, tempFiles);
      buffer = fs.readFileSync(resolvedPath);
      mimeType = 'image/jpeg';
      base64Data = buffer.toString('base64');
      delta = await analyzeCarouselDelta(
        apiKey, firstSlideOriginal.base64Data, firstSlideOriginal.mimeType,
        base64Data, mimeType, mode, sourceMeta, characterId
      );
    }
    structured = delta.parsed;
    generationPrompt = buildGenerationPrompt({ character, activeRefs, mode, cosplayMode, structured, isDelta: true });
    referenceImages = [
      { mimeType: firstSlideRecreated.mimeType, base64Data: firstSlideRecreated.base64Data },
    ];
  } else {
    let analysis;
    try {
      analysis = await analyzeImageStructured(apiKey, base64Data, mimeType, mode, sourceMeta, characterId, cosplayMode);
    } catch (err) {
      const msg = asText(err?.message).toLowerCase();
      if (!msg.includes('unable to process input image') && !msg.includes('invalid_argument')) throw err;
      resolvedPath = await safeJpegFromAnyImage(filePath, tempFiles);
      buffer = fs.readFileSync(resolvedPath);
      mimeType = 'image/jpeg';
      base64Data = buffer.toString('base64');
      analysis = await analyzeImageStructured(apiKey, base64Data, mimeType, mode, sourceMeta, characterId, cosplayMode);
    }
    structured = analysis.parsed;
    generationPrompt = buildGenerationPrompt({ character, activeRefs, mode, cosplayMode, structured, isDelta: false });
  }

  const generated = await geminiService.generateImage(apiKey, generationPrompt, {
    aspectRatio: '4:5',
    imageSize: '2K',
    referenceImages,
    model: imageModel,
  });

  const galleryEntry = galleryManager.save({
    base64Data: generated.image.base64Data,
    mimeType: generated.image.mimeType,
    prompt: structured.full_prompt || 'Post Clone recreation',
    source: 'post-clone',
    characterId,
    aspectRatio: '4:5',
    seed: null,
  });

  return {
    original,
    recreated: {
      mimeType: generated.image.mimeType,
      base64Data: generated.image.base64Data,
      text: generated.text || null,
      prompt: generationPrompt,
      structured,
    },
    slideOriginal: { mimeType, base64Data },
    slideRecreated: { mimeType: generated.image.mimeType, base64Data: generated.image.base64Data },
    galleryId: galleryEntry?.id || null,
  };
}

async function processPostClone({
  post,
  characterId,
  mode,
  cosplayMode = false,
  apiKey,
  character,
  activeRefs,
  baseReferenceImages,
  tempFiles,
  imageModel,
}) {
  const recreatedImages = [];
  const originalImages = [];
  const galleryIds = [];
  const isCarousel = post.type === 'carousel' && post.imageUrls.length > 1;
  const slideArgs = { post, apiKey, character, activeRefs, mode, cosplayMode, baseReferenceImages, characterId, tempFiles, imageModel };

  let firstSlideOriginal = null;
  let firstSlideRecreated = null;

  try {
    const r0 = await processOneSlide({ ...slideArgs, i: 0, firstSlideOriginal: null, firstSlideRecreated: null });
    originalImages.push(r0.original);
    recreatedImages.push(r0.recreated);
    if (r0.galleryId) galleryIds.push(r0.galleryId);
    firstSlideOriginal = r0.slideOriginal;
    firstSlideRecreated = r0.slideRecreated;
  } catch (slideErr) {
    if (isCarousel) {
      console.warn(`[post-clone] carousel slide 1/${post.imageUrls.length} failed: ${slideErr.message} — skipping`);
    } else {
      throw slideErr;
    }
  }

  if (post.imageUrls.length > 1) {
    const remainingIndices = [];
    for (let i = 1; i < post.imageUrls.length; i++) remainingIndices.push(i);

    console.log(`[post-clone] processing ${remainingIndices.length} remaining slides concurrently`);
    const slidePromises = remainingIndices.map(i =>
      processOneSlide({ ...slideArgs, i, firstSlideOriginal, firstSlideRecreated })
        .then(r => ({ ok: true, i, r }))
        .catch(err => {
          console.warn(`[post-clone] carousel slide ${i + 1}/${post.imageUrls.length} failed: ${err.message} — skipping`);
          return { ok: false, i };
        })
    );

    const settled = await Promise.all(slidePromises);
    settled.sort((a, b) => a.i - b.i);
    for (const s of settled) {
      if (s.ok) {
        originalImages.push(s.r.original);
        recreatedImages.push(s.r.recreated);
        if (s.r.galleryId) galleryIds.push(s.r.galleryId);
      }
    }
  }

  return {
    type: post.type,
    sourceUrl: post.sourceUrl || null,
    originalImages,
    recreatedImages,
    galleryIds,
  };
}

function getItemShortcode(item) {
  return asText(item?.shortCode || item?.shortcode || item?.code || '');
}

function groupItemsByShortcode(items) {
  const byCode = new Map();
  const noCode = [];
  for (const item of items) {
    const sc = getItemShortcode(item);
    if (!sc) { noCode.push(item); continue; }
    if (!byCode.has(sc)) byCode.set(sc, []);
    byCode.get(sc).push(item);
  }

  const merged = [];
  for (const [sc, group] of byCode) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const parent = { ...group[0] };
    const extraImages = [];
    for (let i = 1; i < group.length; i++) {
      const sibling = group[i];
      const url = extractImageUrlFromMedia(sibling);
      if (url) extraImages.push({ displayUrl: url, url });
    }
    if (extraImages.length > 0) {
      const existing = Array.isArray(parent.images) ? [...parent.images] : [];
      parent.images = [...existing, ...extraImages];
      console.log(`[post-clone] merged ${group.length} items into 1 carousel for shortCode=${sc} (${extraImages.length} extra images)`);
    }
    merged.push(parent);
  }
  return [...merged, ...noCode];
}

function collectNestedPostsFromContainer(container) {
  if (!container || typeof container !== 'object') return [];

  const out = [];
  const pushArray = (arr) => {
    for (const entry of arr) {
      if (!entry) continue;
      out.push(entry?.node || entry);
    }
  };

  if (Array.isArray(container.latestPosts)) pushArray(container.latestPosts);
  if (Array.isArray(container.latest_posts)) pushArray(container.latest_posts);
  if (Array.isArray(container.posts)) pushArray(container.posts);
  if (Array.isArray(container.timelineMedia)) pushArray(container.timelineMedia);
  if (Array.isArray(container.timeline_media)) pushArray(container.timeline_media);

  if (container.latestPosts && typeof container.latestPosts === 'object') {
    if (Array.isArray(container.latestPosts.items)) pushArray(container.latestPosts.items);
    if (Array.isArray(container.latestPosts.edges)) pushArray(container.latestPosts.edges);
  }
  if (container.latest_posts && typeof container.latest_posts === 'object') {
    if (Array.isArray(container.latest_posts.items)) pushArray(container.latest_posts.items);
    if (Array.isArray(container.latest_posts.edges)) pushArray(container.latest_posts.edges);
  }

  const edgeTimeline = container.edge_owner_to_timeline_media?.edges;
  if (Array.isArray(edgeTimeline)) pushArray(edgeTimeline);
  const edgeTimelineAlt = container.edgeOwnerToTimelineMedia?.edges;
  if (Array.isArray(edgeTimelineAlt)) pushArray(edgeTimelineAlt);

  const isPostLikeNode = (value) => {
    if (!value || typeof value !== 'object') return false;
    const typeName = asText(value.__typename || value.type || value.media_type || '').toLowerCase();
    if (typeName.includes('graphimage') || typeName.includes('graphvideo') || typeName.includes('graphsidecar')) return true;

    const hasIdentity = !!(asText(value.shortCode || value.shortcode || value.code || value.id));
    const hasMediaHint = !!(
      asText(value.displayUrl || value.display_url || value.thumbnailSrc || value.thumbnail_src || value.imageUrl || value.image_url || value.videoUrl || value.video_url || value.url)
      || value.image_versions2
      || value.edge_sidecar_to_children
      || value.edgeSidecarToChildren
    );
    return hasIdentity && hasMediaHint;
  };

  const deepCollect = (root, maxDepth = 5) => {
    const found = [];
    const seen = new Set();
    const stack = [{ value: root, depth: 0 }];

    while (stack.length > 0) {
      const { value, depth } = stack.pop();
      if (value == null || depth > maxDepth) continue;

      if (typeof value === 'string') {
        const text = value.trim();
        if ((text.startsWith('{') || text.startsWith('['))) {
          try {
            stack.push({ value: JSON.parse(text), depth: depth + 1 });
          } catch { }
        }
        continue;
      }

      if (Array.isArray(value)) {
        for (const entry of value) stack.push({ value: entry, depth: depth + 1 });
        continue;
      }

      if (typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);

      if (isPostLikeNode(value)) found.push(value);

      for (const v of Object.values(value)) {
        if (v && (typeof v === 'object' || typeof v === 'string')) {
          stack.push({ value: v, depth: depth + 1 });
        }
      }
    }

    return found;
  };

  if (out.length === 0 && container.latestPosts !== undefined) {
    const recovered = deepCollect(container.latestPosts);
    if (recovered.length > 0) {
      out.push(...recovered);
      console.log(`[post-clone] recovered ${recovered.length} post node(s) from nested latestPosts payload`);
    }
  }

  return out;
}

function expandProfileContainerItems(items) {
  const expanded = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;

    const nested = collectNestedPostsFromContainer(item);

    if (nested.length > 0) {
      for (const n of nested) expanded.push(n);
      continue;
    }

    expanded.push(item);
  }

  if (expanded.length !== (Array.isArray(items) ? items.length : 0)) {
    console.log(`[post-clone] expanded profile container items: ${(Array.isArray(items) ? items.length : 0)} -> ${expanded.length}`);
  }
  return expanded;
}

function normalizePostsFromItems(items) {
  const normalizedInput = expandProfileContainerItems(items || []);

  console.log(`[post-clone] normalizePostsFromItems: ${(normalizedInput || []).length} item(s)`);
  for (let i = 0; i < (normalizedInput || []).length; i++) {
    const item = normalizedInput[i];
    if (!item || typeof item !== 'object') continue;
    const keys = Object.keys(item);
    const typeName = asText(item.type || item.__typename || item.productType || '');
    const shortCode = getItemShortcode(item);
    const mediaCount = item.mediaCount || item.carousel_media_count || '';
    const hasImages = Array.isArray(item.images) && item.images.length;
    const hasCarouselMedia = Array.isArray(item.carouselMedia) && item.carouselMedia.length;
    const hasChildren = Array.isArray(item.children) && item.children.length;
    const hasSideCar = Array.isArray(item.sideCar || item.sidecar) && (item.sideCar || item.sidecar).length;
    const hasEdgeSidecar = !!(item.edgeSidecarToChildren?.edges?.length) || !!(item.edge_sidecar_to_children?.edges?.length);
    console.log(`[post-clone] item[${i}]: type=${typeName}, shortCode=${shortCode}, mediaCount=${mediaCount}, keys(${keys.length})=${keys.slice(0, 25).join(',')}`);
    console.log(`[post-clone] item[${i}] arrays: images=${hasImages || 0}, carouselMedia=${hasCarouselMedia || 0}, children=${hasChildren || 0}, sideCar=${hasSideCar || 0}, edgeSidecar=${hasEdgeSidecar}`);
  }

  const errorItem = (normalizedInput || []).find((item) => {
    if (item?.restricted === true || item?.isRestricted === true) return true;
    const err = asText(item?.error).toLowerCase();
    if (!err) return false;
    return true;
  });
  if (errorItem) {
    const err = asText(errorItem?.error).toLowerCase();
    const desc = asText(errorItem?.errorDescription || errorItem?.error || '');
    const url = asText(errorItem?.url || errorItem?.inputUrl || '');
    const isRestricted = err.includes('restricted') || errorItem?.restricted === true || errorItem?.isRestricted === true;

    console.warn(`[post-clone] Apify returned error item: error="${err}", desc="${desc}", url="${url}"`);
    console.warn(`[post-clone] error item full keys: ${Object.keys(errorItem).join(', ')}`);

    if (isRestricted) {
      const hasSession = !!buildLoginCookies();
      throw new AppError(
        hasSession
          ? `Post is restricted${url ? ` (${url})` : ''}. Session cookies were sent but the post-scraper returned only a thumbnail. Will retry via profile scrape.`
          : `Post is restricted${url ? ` (${url})` : ''}. Add your Instagram sessionid in API Keys to access age-restricted or sensitive content.`,
        422,
        'INSTAGRAM_RESTRICTED'
      );
    } else {
      const hasImage = extractImageUrlFromMedia(errorItem);
      if (!hasImage) {
        throw new AppError(
          `Instagram scraper error: ${desc || err || 'unknown'}${url ? ` (${url})` : ''}. Try a different URL or check your IG session cookies.`,
          422,
          'INSTAGRAM_SCRAPER_ERROR'
        );
      }
    }
  }

  const grouped = groupItemsByShortcode(normalizedInput || []);

  const posts = [];
  for (const item of grouped) {
    const extracted = extractPostImages(item);
    if (!extracted) continue;
    posts.push(extracted);
  }
  if (posts.length === 0 && normalizedInput.length > 0) {
    console.warn(`[post-clone] ${normalizedInput.length} item(s) from Apify but 0 had extractable images. First item keys: ${Object.keys(normalizedInput[0] || {}).join(', ')}`);
  }
  return posts;
}

async function handleClone({ url, characterId, mode, cosplayMode = false, postLimit = 1, apifyApiKey, profileMode = false, imageModel }) {
  const deadline = Date.now() + (profileMode ? PROFILE_ROUTE_TIMEOUT_MS : ROUTE_TIMEOUT_MS);
  const cleanUrl = asText(url);
  if (!cleanUrl || !isHttpUrl(cleanUrl)) {
    throw new AppError('A valid Instagram URL is required', 400, 'VALIDATION_ERROR');
  }
  if (!characterId || typeof characterId !== 'string') {
    throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
  }
  if (!['exact', 'creative'].includes(mode)) {
    throw new AppError('"mode" must be "exact" or "creative"', 400, 'VALIDATION_ERROR');
  }

  const character = referenceManager.getCharacter(characterId);
  const activeRefs = referenceManager.getActiveReferences(characterId, null);
  const baseReferenceImages = buildCharacterReferenceImages(characterId, activeRefs);
  const apiKey = apiKeyManager.getActiveKey();

  const tempFiles = [];
  ensureTempDir();
  try {
    const availability = await checkPostAvailability(cleanUrl, { apifyToken: apifyApiKey });
    if (!availability.allowed) {
      throw new AppError(availability.label, 422, 'INSTAGRAM_UNAVAILABLE');
    }

    let items = await runPostActor({
      url: cleanUrl,
      limit: profileMode ? postLimit : 10,
      apifyToken: apifyApiKey,
    });

    let posts;
    try {
      posts = normalizePostsFromItems(items);
    } catch (normErr) {
      if (normErr.code === 'INSTAGRAM_RESTRICTED' && buildLoginCookies()) {
        console.log(`[post-clone] restricted — attempting profile-based fallback`);
        const ownerUsername = await resolveUsernameFromPostUrl(cleanUrl, items);
        if (ownerUsername) {
          const parsedUrl = new URL(cleanUrl);
          const segs = parsedUrl.pathname.split('/').filter(Boolean);
          const targetShortcode = ['p', 'reel', 'tv'].includes(segs[0]?.toLowerCase()) ? segs[1] || '' : '';

          const profileUrl = `https://www.instagram.com/${ownerUsername}/`;
          console.log(`[post-clone] fallback: scraping profile ${profileUrl} (looking for shortcode=${targetShortcode})`);
          const profileItems = await runPostActor({
            url: profileUrl,
            limit: 30,
            apifyToken: apifyApiKey,
          });

          if (targetShortcode && profileItems.length > 0) {
            let matching = profileItems.filter(it => getItemShortcode(it) === targetShortcode);
            if (matching.length === 0) {
              matching = profileItems.filter(it => {
                const itemUrl = asText(it?.url || it?.inputUrl || it?.shortCodeUrl || '');
                return itemUrl.includes(targetShortcode);
              });
            }
            if (matching.length > 0) {
              console.log(`[post-clone] fallback: found ${matching.length} item(s) matching shortcode=${targetShortcode}`);
              items = matching;
            } else {
              const available = profileItems.map(it => getItemShortcode(it)).filter(Boolean).join(', ');
              console.warn(`[post-clone] fallback: shortcode ${targetShortcode} not found. Available: ${available}`);

              console.log(`[post-clone] fallback: retrying profile scrape with limit=50`);
              const retryItems = await runPostActor({
                url: profileUrl,
                limit: 50,
                apifyToken: apifyApiKey,
              });
              matching = retryItems.filter(it =>
                getItemShortcode(it) === targetShortcode ||
                asText(it?.url || it?.inputUrl || '').includes(targetShortcode)
              );
              if (matching.length > 0) {
                console.log(`[post-clone] fallback retry: found ${matching.length} item(s) matching shortcode=${targetShortcode}`);
                items = matching;
              } else {
                throw new AppError(
                  `Could not find post ${targetShortcode} in @${ownerUsername}'s profile (${retryItems.length} posts scraped). The post may have been deleted or the scraper missed it — try again.`,
                  422,
                  'POST_NOT_FOUND_IN_PROFILE'
                );
              }
            }
          } else {
            items = profileItems;
          }

          posts = normalizePostsFromItems(items);
        } else {
          console.warn(`[post-clone] fallback: could not resolve username from ${cleanUrl}`);
          throw normErr;
        }
      } else {
        throw normErr;
      }
    }

    const selected = profileMode ? posts.slice(0, Math.max(1, Math.min(20, Number(postLimit) || 1))) : posts.slice(0, 1);

    if (selected.length === 0) {
      throw new AppError('No static image posts found to clone', 422, 'NO_IMAGE_POSTS');
    }

    const results = [];
    const errors = [];
    const timeoutSec = profileMode ? PROFILE_ROUTE_TIMEOUT_MS / 1000 : ROUTE_TIMEOUT_MS / 1000;

    const CONCURRENCY = profileMode ? 2 : 1;

    for (let batchStart = 0; batchStart < selected.length; batchStart += CONCURRENCY) {
      if (Date.now() > deadline) {
        const remaining = selected.slice(batchStart);
        for (let r = 0; r < remaining.length; r++) {
          errors.push({ index: batchStart + r, sourceUrl: remaining[r].sourceUrl || '', error: `Timed out after ${timeoutSec}s` });
        }
        break;
      }

      const batch = selected.slice(batchStart, batchStart + CONCURRENCY);
      const batchPromises = batch.map((post, bi) => {
        const idx = batchStart + bi;
        return processPostClone({
          post,
          characterId,
          mode,
          cosplayMode,
          apiKey,
          character,
          activeRefs,
          baseReferenceImages,
          tempFiles,
          imageModel,
        }).then(processed => ({ ok: true, idx, processed }))
          .catch(postErr => {
            console.warn(`[post-clone] post ${idx + 1}/${selected.length} failed: ${postErr.message}`);
            return { ok: false, idx, sourceUrl: post.sourceUrl || '', error: postErr.message };
          });
      });

      const settled = await Promise.all(batchPromises);
      for (const r of settled) {
        if (r.ok) {
          results.push(r.processed);
        } else {
          errors.push({ index: r.idx, sourceUrl: r.sourceUrl, error: r.error });
          if (!profileMode) {
            throw new AppError(r.error, 502, 'POST_CLONE_FAILED');
          }
        }
      }
    }

    if (results.length === 0 && errors.length > 0) {
      throw new AppError(
        `All ${errors.length} post(s) failed to clone. Last error: ${errors[errors.length - 1].error}`,
        502,
        'ALL_POSTS_FAILED'
      );
    }
    console.log(`[post-clone] profile scrape done: ${results.length} succeeded, ${errors.length} failed`);

    for (const processed of results) {
      try {
        postCloneHistoryStore.save({
          sourceUrl: processed.sourceUrl || cleanUrl,
          type: processed.type || 'single',
          mode,
          characterId,
          galleryIds: processed.galleryIds || [],
        });
      } catch (histErr) {
        console.warn('[post-clone] history save failed:', histErr.message);
      }
    }

    return results;
  } finally {
    for (const filePath of tempFiles) {
      try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch { }
    }
  }
}

router.post('/', async (req, res, next) => {
  try {
    const { postUrl, characterId, mode = 'exact', cosplayMode = false, apifyApiKey, imageModel } = req.body || {};
    const data = await handleClone({
      url: postUrl,
      characterId,
      mode: asText(mode).toLowerCase() || 'exact',
      cosplayMode: !!cosplayMode,
      apifyApiKey,
      imageModel,
      postLimit: 1,
      profileMode: false,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

const styleFocusStore = require('../services/styleFocusStore');

router.get('/style-focus', (_req, res, next) => {
  try { res.json({ success: true, data: styleFocusStore.list() }); }
  catch (err) { next(err); }
});

router.get('/style-focus/:id', (req, res, next) => {
  try { res.json({ success: true, data: styleFocusStore.get(req.params.id) }); }
  catch (err) { next(err); }
});

router.post('/style-focus', (req, res, next) => {
  try { res.status(201).json({ success: true, data: styleFocusStore.save(req.body) }); }
  catch (err) { next(err); }
});

router.delete('/style-focus/:id', (req, res, next) => {
  try { res.json({ success: true, data: styleFocusStore.remove(req.params.id) }); }
  catch (err) { next(err); }
});

router.get('/history', (_req, res, next) => {
  try { res.json({ success: true, data: postCloneHistoryStore.list() }); }
  catch (err) { next(err); }
});

router.delete('/history/:id', (req, res, next) => {
  try { res.json({ success: true, data: postCloneHistoryStore.remove(req.params.id) }); }
  catch (err) { next(err); }
});

router.get('/proxy-image', async (req, res, next) => {
  try {
    const url = asText(req.query.url);
    if (!url || !isHttpUrl(url)) {
      return res.status(400).json({ error: 'Missing or invalid url param' });
    }
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const domainParts = host.split('.');
    const top2 = domainParts.slice(-2).join('.');
    const top3 = domainParts.slice(-3).join('.');
    const isAllowed = (top2 === 'fbcdn.net' && (host === 'fbcdn.net' || host.endsWith('.fbcdn.net')))
      || (top2 === 'instagram.com' && (host === 'instagram.com' || host.endsWith('.instagram.com')))
      || (top3 === 'cdninstagram.com' && (host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com')));
    if (!isAllowed) {
      return res.status(403).json({ error: 'Only Instagram CDN URLs can be proxied' });
    }
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000,
      httpsAgent: sharedHttpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'image/*,*/*;q=0.8',
        'Referer': 'https://www.instagram.com/',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const ct = (response.headers['content-type'] || '').toLowerCase();
    if (ct && !ct.startsWith('image/') && !ct.includes('octet-stream')) {
      response.data.destroy();
      return res.status(502).json({ error: `Upstream returned non-image: ${ct}` });
    }
    res.set('Content-Type', ct || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    response.data.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.end(); });
    response.data.pipe(res);
  } catch (err) {
    next(new AppError(`Image proxy failed: ${err.message}`, 502, 'PROXY_ERROR'));
  }
});

router.get('/thumb/:filename', (req, res, next) => {
  try {
    const filename = path.basename(req.params.filename);
    if (!/^[a-f0-9-]+\.jpg$/i.test(filename)) {
      return res.status(400).json({ error: 'Invalid thumbnail filename' });
    }
    const filePath = path.join(THUMB_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Thumbnail not found or expired' });
    }
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=1800');
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => { if (!res.headersSent) next(err); else res.end(); });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.handleClone = handleClone;
module.exports.runPostActor = runPostActor;
module.exports.normalizePostsFromItems = normalizePostsFromItems;
module.exports.processPostClone = processPostClone;
module.exports.downloadImageToTemp = downloadImageToTemp;
module.exports.parseStructuredAnalysis = parseStructuredAnalysis;
module.exports.buildStructuredAnalysisPrompt = buildStructuredAnalysisPrompt;
module.exports.mimeFromExt = mimeFromExt;
module.exports.ensureTempDir = ensureTempDir;
module.exports.cacheThumbnail = cacheThumbnail;
module.exports.ensureThumbDir = ensureThumbDir;
module.exports.buildCharacterReferenceImages = buildCharacterReferenceImages;
