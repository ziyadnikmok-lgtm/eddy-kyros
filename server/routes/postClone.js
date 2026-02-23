const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
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

const router = express.Router();
const TEMP_DIR = path.join(process.cwd(), 'temp');
const THUMB_DIR = path.join(TEMP_DIR, 'thumbs');
const ROUTE_TIMEOUT_MS = 5 * 60_000; // 5 min hard ceiling for single post
const PROFILE_ROUTE_TIMEOUT_MS = 15 * 60_000; // 15 min for profile scrape (many slides)
const DEFAULT_ACTOR_ID = process.env.APIFY_POST_ACTOR_ID || 'apify/instagram-post-scraper';
const FALLBACK_ACTOR_ID = process.env.APIFY_POST_FALLBACK_ACTOR_ID || 'apify/instagram-scraper';
const ANALYSIS_KEYS = ['lighting', 'camera', 'pose', 'expression', 'outfit', 'scene', 'accessories', 'details', 'full_prompt'];
const THUMB_MAX_AGE_MS = 30 * 60_000; // 30 min — auto-cleanup stale thumbnails

function ensureTempDir() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function ensureThumbDir() {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
}

/**
 * Download a single thumbnail image server-side (while CDN URL is fresh).
 * Returns the filename on success, or '' on failure.
 */
async function cacheThumbnail(imageUrl) {
  if (!isHttpUrl(imageUrl)) return '';
  const id = crypto.randomUUID();
  const ext = '.jpg'; // IG images are always JPEG
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
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* */ }
    return '';
  }
}

/** Periodically clean stale thumbnails */
function cleanStaleThumbs() {
  try {
    if (!fs.existsSync(THUMB_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(THUMB_DIR)) {
      const fp = path.join(THUMB_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > THUMB_MAX_AGE_MS) fs.unlinkSync(fp);
      } catch { /* best-effort */ }
    }
  } catch { /* */ }
}
setInterval(cleanStaleThumbs, 5 * 60_000).unref(); // don't block graceful shutdown

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
  } catch { /* JSON parse failed — try object extraction */ }

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
    } catch { /* object parse failed — use fallback */ }
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

function buildCharacterReferenceImages(characterId, activeRefs) {
  const refs = [];
  const primary = referenceManager.getPrimaryImage(characterId);
  if (primary?.buffer?.length) {
    refs.push({ mimeType: primary.mimeType, base64Data: primary.buffer.toString('base64') });
  }
  for (const ref of activeRefs || []) {
    const data = referenceManager.getReferenceImage(characterId, ref.id);
    if (data?.buffer?.length) {
      refs.push({ mimeType: data.mimeType, base64Data: data.buffer.toString('base64') });
    }
  }
  return refs;
}

function buildStructuredAnalysisPrompt(mode) {
  const creativeLine = mode === 'creative'
    ? `For the "scene" field, do not copy the original location literally. Create a unique reinterpretation that keeps the same vibe and lighting feel.`
    : 'For the "scene" field, recreate the original scene as faithfully as possible.';

  return [
    'Analyze this image and respond in JSON only with these keys:',
    'lighting, camera, pose, expression, outfit, scene, accessories, details, format, full_prompt',
    '',
    'IMPORTANT: Write each field as a DESCRIPTIVE NATURAL LANGUAGE sentence or short paragraph — NOT as comma-separated tags.',
    'Describe like you are briefing a human photographer. Be specific about relationships, cause-and-effect, and visual interactions.',
    'Each field should be at least 10 words. Use directive tone (NOT "she is" or "the woman").',
    '',
    'lighting: CRITICAL FIELD — Describe the OVERALL BRIGHTNESS LEVEL first (dark/dim/medium/bright/high-key), then light source type, direction, quality, color temperature, shadow character, and time-of-day feel. Be extremely precise about how dark or bright the scene is. A dimly lit room with one lamp is NOT the same as natural daylight. Example for dark scene: "Low-key dim interior, mostly shadows with a single warm bedside lamp camera-right casting localized golden glow, deep shadows across most of the frame, intimate nighttime mood". Example for bright scene: "Bright natural daylight flooding from a large window camera-left, high-key even illumination with soft shadows"',
    'camera: Describe shot type, lens perspective, estimated focal length, shooting angle, and depth of field. Example: "Medium portrait framing at eye level with an estimated 50mm focal length, shallow depth of field softly blurring the background"',
    'pose: Describe full body positioning — weight distribution, limb placement, torso angle, hand placement and what they interact with. Directive tone. Example: "Standing with weight shifted to the right hip, left hand resting on a railing, torso turned slightly camera-left with relaxed shoulders"',
    'expression: Describe facial mood, gaze direction and intensity, mouth position, emotional read. Example: "Calm direct gaze into the lens with softly parted lips and relaxed brow, conveying quiet confidence"',
    'outfit: Describe all garments with EXACT fit, fabric, color, texture, coverage level, and body interaction. Be precise about how tight/loose the clothing fits, how much skin is showing, neckline depth, hemline position, and whether clothing is form-fitting or relaxed. Do NOT make clothing more conservative than it actually is — describe the actual coverage faithfully. Example: "Fitted beige ribbed tank top with racerback cut showing shoulders, snug fit highlighting figure, paired with light-wash high-waisted denim shorts with frayed hem sitting mid-thigh"',
    'scene: Describe the environment — setting type, architecture, surfaces, textures, color palette, spatial depth, background and foreground',
    'accessories: Describe all visible accessories with type, material, placement, and visual effect',
    'details: Describe color grading, film stock look, grain, contrast style, saturation, visual filters',
    'format: Describe the visual rendering style — photography type, post-processing aesthetic, visual treatment. IMPORTANT: Note the photo quality level — is it a casual phone photo, candid snapshot, amateur selfie, or professional studio shot? Include this in the description.',
    'full_prompt: Write an optimal identity-agnostic image generation prompt following Nano-Banana formula: SCENE → LIGHTING → CAMERA → POSE → EXPRESSION → OUTFIT → ACCESSORIES → DETAILS → FORMAT. No identity descriptors (face, ethnicity, hair color, skin tone). Directive tone. One flowing natural language paragraph. START the prompt with the overall brightness level (e.g. "Dark moody interior..." or "Bright daylight...") so the lighting mood is established first. IMPORTANT: Include the EXACT outfit description with accurate coverage/fit — do NOT make clothing more modest or conservative than the original. CRITICAL: If the original is a casual/candid phone photo, explicitly state "casual phone photo quality" or "candid snapshot aesthetic" — do NOT describe it as a professional/studio shot.',
    '',
    creativeLine,
    'Output strictly valid JSON object only.',
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
    'IMPORTANT: For each changed field, write a DESCRIPTIVE NATURAL LANGUAGE sentence — NOT comma-separated tags.',
    'Describe like briefing a photographer. Use directive tone (not "she is" or "the woman"). At least 8 words per changed field.',
    'For each changed field describe: lighting (source/direction/quality/temperature), camera (shot type/angle/focal length/DOF), pose (weight distribution/limbs/torso/hands), expression (mood/gaze/mouth/eyebrows), outfit (garment/fit/fabric/color), format (rendering style/visual treatment).',
    sceneLine,
    'full_prompt: write an identity-agnostic delta prompt following SCENE → LIGHTING → CAMERA → POSE → EXPRESSION → OUTFIT → ACCESSORIES → DETAILS → FORMAT order. Describe only changes from slide 1. No identity/body descriptors. Keep expression. Directive tone. One flowing natural language paragraph.',
    'Output strictly valid JSON object only.',
  ].join('\n');
}

function buildGenerationPrompt({ character, activeRefs, mode, structured, isDelta }) {
  const userPrompt = [
    mode === 'creative'
      ? 'Creative reinterpretation mode: keep vibe/lighting/story, allow scene creativity while preserving identity.'
      : 'Exact recreate mode: keep composition, camera feel, and visual tone close to source.',
    isDelta
      ? 'This is a carousel follow-up delta prompt relative to slide 1 continuity anchor.'
      : 'This is a base prompt for the first image/standalone post.',
    // Prevent Gemini from over-polishing casual/candid photos into studio shots
    'IMPORTANT VISUAL QUALITY DIRECTION: Match the casual, authentic quality of the original source photo. If the source looks like a casual phone photo or candid snapshot, the recreation should have that same relaxed, natural, slightly imperfect feel — NOT hyper-polished studio lighting or commercial retouching. Preserve the raw/real energy. Avoid making it look like a professional photoshoot unless the original clearly is one.',
    // Prevent Gemini from brightening dark scenes
    'LIGHTING FIDELITY: Match the EXACT brightness level and mood of the source. If the scene is dark, dimly lit, or moody — the output MUST be equally dark with deep shadows. Do NOT brighten, add fill light, or illuminate dark scenes. A nighttime photo with one lamp must stay dark with one lamp — do NOT turn it into daylight.',
    // Reinforce identity anchor from reference images
    'IDENTITY ANCHORING: The reference images provided show the EXACT person to depict. The generated face, body proportions, skin tone, and all physical features MUST match these reference photos precisely. Do NOT substitute, blend, or drift from the person shown in the references.',
    // Prevent body proportion drift and clothing conservatism
    'BODY & OUTFIT FIDELITY: Maintain the character\'s exact body proportions as shown in reference images — do NOT reduce or minimize any body features. The outfit description must be rendered exactly as written — do NOT add extra fabric, raise necklines, lengthen hemlines, or make clothing more conservative than described. If the prompt says form-fitting, render it form-fitting.',
    structured.full_prompt || '',
  ].filter(Boolean).join('\n');

  return promptBuilder.buildPrompt({
    masterPrompt: character.masterPrompt,
    activeReferences: activeRefs,
    userPrompt,
  });
}

async function analyzeImageStructured(apiKey, imageBase64, mimeType, mode, sourceMeta, characterId) {
  const analysisPrompt = buildStructuredAnalysisPrompt(mode);
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
    full_prompt: '',
  };
  try {
    raw = await geminiService.analyzeImageWithPrompt(apiKey, imageBase64, mimeType, analysisPrompt);
    ({ parsed } = parseStructuredAnalysis(raw));
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

  // Auto-feed style library with identity-stripped atoms
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

  // Auto-feed style library with identity-stripped atoms
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
  // Handle plain URL strings (some actors return images as string arrays)
  if (typeof item === 'string') {
    const clean = asText(item);
    return looksLikeDirectImageUrl(clean) ? clean : '';
  }
  // image_versions2 is common in newer Apify actors — pick highest resolution
  const iv2 = item?.image_versions2?.candidates;
  const iv2Best = Array.isArray(iv2) && iv2.length > 0
    ? iv2.reduce((best, c) => ((c.width || 0) > (best.width || 0) ? c : best), iv2[0])?.url
    : undefined;
  const candidates = [
    item?.displayUrl,
    item?.display_url,
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
  // Plain URL string — check extension for video formats
  if (typeof item === 'string') {
    return /\.(mp4|mov|avi|webm)(\?|$)/i.test(item);
  }
  if (!item || typeof item !== 'object') return false;
  if (item.isVideo === true || item.video === true) return true;
  if (item.is_video === true) return true;
  // Instagram media_type: 1=image, 2=video, 8=carousel
  if (item.media_type === 2 || item.mediaType === 2) return true;
  if (isHttpUrl(item.videoUrl) || isHttpUrl(item.video_url) || isHttpUrl(item.video_versions?.[0]?.url)) return true;
  const typeName = asText(item.type || item.__typename || item.productType || '').toLowerCase();
  return typeName.includes('video') || typeName.includes('reel') || typeName === 'graphvideo';
}

function extractPostImages(postItem) {
  if (!postItem || typeof postItem !== 'object') return null;

  // Skip pure video posts early (not carousels that may contain some images)
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

  // Also check latestComments-style nested media and sideCar fields
  const sideCar = postItem.sideCar || postItem.sidecar;
  if (Array.isArray(sideCar)) {
    for (const item of sideCar) sidecarCandidates.push(item);
  }

  // Some actors nest children under edge_sidecar_to_children
  const edgeAlt = postItem.edge_sidecar_to_children?.edges;
  if (Array.isArray(edgeAlt)) {
    for (const edge of edgeAlt) sidecarCandidates.push(edge?.node || edge);
  }

  const carouselImages = sidecarCandidates
    .filter((m) => m && !isVideoItem(m))
    .map((m) => extractImageUrlFromMedia(m))
    .filter((u) => isHttpUrl(u));

  // Also collect displayUrl from each child that has its own display_resources
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

  // Last resort for mixed carousels: extract video thumbnails so we still have *something*
  if (carouselImages.length === 0 && sidecarCandidates.length > 0) {
    for (const child of sidecarCandidates) {
      if (!child) continue;
      const thumbUrl = asText(child.thumbnailUrl || child.thumbnail_url || child.displayUrl || child.display_url);
      if (isHttpUrl(thumbUrl)) carouselImages.push(thumbUrl);
    }
  }

  // Always capture the post-level display image as a fallback thumbnail
  const postLevelImage = extractImageUrlFromMedia(postItem);

  if (carouselImages.length > 1) {
    const deduped = Array.from(new Set(carouselImages));
    // Append post-level image as last-resort fallback (if not already in the list)
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
    // Log when we expected a carousel but only got 1 image
    const typeName = asText(postItem.type || postItem.__typename || postItem.productType || '').toLowerCase();
    if (typeName.includes('sidecar') || typeName.includes('carousel') || postItem.mediaCount > 1) {
      console.warn(`[post-clone] CAROUSEL UNDEREXTRACTED: type=${typeName}, mediaCount=${postItem.mediaCount}, extracted=1`);
      console.warn(`[post-clone] full keys: ${Object.keys(postItem).join(', ')}`);
      try { console.warn(`[post-clone] item preview: ${JSON.stringify(postItem).slice(0, 600)}`); } catch { /* circular ref */ }
    }
    return {
      type: 'single',
      sourceUrl: asText(postItem.url || postItem.inputUrl || postItem.shortCodeUrl || postLevelImage),
      imageUrls: [postLevelImage],
    };
  }

  return null;
}

/**
 * Resolve the owner username from a post/reel URL.
 * Strategies (in order):
 *  1. oEmbed API (no auth — works for non-restricted posts)
 *  2. Authenticated HTML fetch (uses session cookie — works for restricted)
 *  3. Parse from Apify restricted-item metadata (title / description fields)
 *
 * @param {string} postUrl   Full IG post URL
 * @param {object[]} [restrictedItems]  The Apify items that triggered the restricted error
 */
async function resolveUsernameFromPostUrl(postUrl, restrictedItems) {
  const IG_USERNAME_RE = /[A-Za-z0-9._]{1,30}/;
  const RESERVED_SEGS = ['p', 'reel', 'tv', 'explore', 'accounts', 'stories', 'direct', 'about'];
  const isValidUsername = (u) => u && IG_USERNAME_RE.test(u) && !RESERVED_SEGS.includes(u.toLowerCase());

  // --- Strategy 1: oEmbed (fast, no auth) ---
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

  // --- Strategy 2: Fetch post page WITH session cookie ---
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
      // Try multiple patterns found in IG HTML:
      // "owner":{"username":"xxx"}  (JSON in script tag)
      const ownerMatch = html.match(/"owner"\s*:\s*\{[^}]*"username"\s*:\s*"([^"]+)"/);
      if (ownerMatch && isValidUsername(ownerMatch[1])) {
        console.log(`[post-clone] authenticated HTML resolved username (owner JSON): ${ownerMatch[1]}`);
        return ownerMatch[1];
      }
      // <meta property="og:description" content="... @username ..." />
      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i);
      if (ogDesc) {
        const atMatch = ogDesc[1].match(/@([A-Za-z0-9._]+)/);
        if (atMatch && isValidUsername(atMatch[1])) {
          console.log(`[post-clone] authenticated HTML resolved username (og:desc): ${atMatch[1]}`);
          return atMatch[1];
        }
      }
      // instagram.com/username in any link or canonical
      const linkMatch = html.match(/instagram\.com\/([A-Za-z0-9._]+)\/?["'\s]/);
      if (linkMatch && isValidUsername(linkMatch[1])) {
        console.log(`[post-clone] authenticated HTML resolved username (link): ${linkMatch[1]}`);
        return linkMatch[1];
      }
    } catch (e) {
      console.warn(`[post-clone] authenticated HTML fetch failed: ${e.message}`);
    }
  }

  // --- Strategy 3: Parse from Apify restricted-item metadata ---
  if (Array.isArray(restrictedItems)) {
    for (const item of restrictedItems) {
      // Some scrapers set ownerUsername/username even on error items
      for (const key of ['ownerUsername', 'username', 'owner', 'userName']) {
        const val = asText(typeof item[key] === 'object' ? item[key]?.username : item[key]);
        if (isValidUsername(val)) {
          console.log(`[post-clone] item metadata resolved username (${key}): ${val}`);
          return val;
        }
      }
      // title/description may contain "@username" or "username on Instagram"
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
  // Extract shortcode from post URLs like /p/ABC123/ or /reel/ABC123/
  const shortCode = isPostLike && segments[1] ? asText(segments[1]) : '';

  async function callActor(actorId, input) {
    return client.actor(actorId).call(input);
  }

  console.log(`[post-clone] session cookies: ${loginCookies ? 'present' : 'MISSING'}, shortCode=${shortCode || 'none'}, profileUsername=${profileUsername || 'none'}`);

  let run;
  let actorUsed = DEFAULT_ACTOR_ID;

  // Build input payloads for the primary actor — try multiple shapes to handle
  // schema differences across actor versions.
  const primaryPayloads = [];
  if (profileUsername) {
    primaryPayloads.push({
      username: profileUsername,
      resultsLimit: boundedLimit,
      directUrls: [url],
      startUrls: [{ url }],
      expandSlideshowImages: true,
      ...(loginCookies ? { loginCookies } : {}),
      ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}),
    });
    primaryPayloads.push({
      username: profileUsername,
      resultsLimit: boundedLimit,
      ...(loginCookies ? { loginCookies } : {}),
    });
  } else {
    // Post URL — try multiple input shapes that different actor versions accept.
    // Shape 1: shortcodes array (most post-scraper actors prefer this)
    if (shortCode) {
      primaryPayloads.push({
        shortcodes: [shortCode],
        resultsLimit: boundedLimit,
        expandSlideshowImages: true,
        ...(loginCookies ? { loginCookies } : {}),
      });
    }
    // Shape 2: directUrls + startUrls (generic format)
    primaryPayloads.push({
      directUrls: [url],
      startUrls: [{ url }],
      resultsLimit: boundedLimit,
      resultsType: 'posts',
      expandSlideshowImages: true,
      ...(loginCookies ? { loginCookies } : {}),
    });
    // Shape 3: postUrls array
    primaryPayloads.push({
      postUrls: [url],
      resultsLimit: boundedLimit,
      expandSlideshowImages: true,
      ...(loginCookies ? { loginCookies } : {}),
    });
  }

  // Try primary actor with multiple input shapes
  let primaryErr = null;
  for (let i = 0; i < primaryPayloads.length; i++) {
    try {
      console.log(`[post-clone] trying ${DEFAULT_ACTOR_ID} payload #${i + 1}: ${JSON.stringify({ ...primaryPayloads[i], loginCookies: primaryPayloads[i].loginCookies ? '[set]' : undefined })}`);
      run = await callActor(DEFAULT_ACTOR_ID, primaryPayloads[i]);
      console.log(`[post-clone] ${DEFAULT_ACTOR_ID} payload #${i + 1} succeeded`);
      break;
    } catch (err) {
      console.warn(`[post-clone] ${DEFAULT_ACTOR_ID} payload #${i + 1} failed: ${err.message}`);
      primaryErr = err;
    }
  }

  // Fallback to generic scraper only if primary actor failed entirely
  if (!run) {
    console.warn(`[post-clone] primary actor failed, falling back to ${FALLBACK_ACTOR_ID}`);
    actorUsed = FALLBACK_ACTOR_ID;
    try {
      run = await callActor(FALLBACK_ACTOR_ID, {
        directUrls: [url],
        startUrls: [{ url }],
        resultsType: 'posts',
        resultsLimit: boundedLimit,
        addParentData: false,
        ...(loginCookies ? { loginCookies } : {}),
      });
    } catch (fallbackErr) {
      // Final retry without cookies in case actor schema rejects loginCookies.
      try {
        run = await callActor(FALLBACK_ACTOR_ID, {
          directUrls: [url],
          startUrls: [{ url }],
          resultsType: 'posts',
          resultsLimit: boundedLimit,
          addParentData: false,
        });
      } catch {
        // keep original fallbackErr
      }
      throw new AppError(
        `Apify actor run failed (${DEFAULT_ACTOR_ID}): ${primaryErr?.message || 'unknown'} — fallback (${FALLBACK_ACTOR_ID}): ${fallbackErr.message}`,
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
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* cleanup best-effort */ }
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
  } catch { /* HTML fetch failed — return original URL */ }

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
  await execFileAsync('ffmpeg', ['-y', '-i', inputPath, '-frames:v', '1', outputPath], {
    timeout: 30000,
  });
  return outputPath;
}

async function processOneSlide({
  post, i, apiKey, character, activeRefs, mode, baseReferenceImages,
  characterId, tempFiles, firstSlideOriginal, firstSlideRecreated,
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
    generationPrompt = buildGenerationPrompt({ character, activeRefs, mode, structured, isDelta: true });
    referenceImages = [
      { mimeType: firstSlideRecreated.mimeType, base64Data: firstSlideRecreated.base64Data },
    ];
  } else {
    let analysis;
    try {
      analysis = await analyzeImageStructured(apiKey, base64Data, mimeType, mode, sourceMeta, characterId);
    } catch (err) {
      const msg = asText(err?.message).toLowerCase();
      if (!msg.includes('unable to process input image') && !msg.includes('invalid_argument')) throw err;
      resolvedPath = await safeJpegFromAnyImage(filePath, tempFiles);
      buffer = fs.readFileSync(resolvedPath);
      mimeType = 'image/jpeg';
      base64Data = buffer.toString('base64');
      analysis = await analyzeImageStructured(apiKey, base64Data, mimeType, mode, sourceMeta, characterId);
    }
    structured = analysis.parsed;
    generationPrompt = buildGenerationPrompt({ character, activeRefs, mode, structured, isDelta: false });
  }

  const generated = await geminiService.generateImage(apiKey, generationPrompt, {
    aspectRatio: '4:5',
    imageSize: '2K',
    referenceImages,
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
  apiKey,
  character,
  activeRefs,
  baseReferenceImages,
  tempFiles,
}) {
  const recreatedImages = [];
  const originalImages = [];
  const galleryIds = [];
  const isCarousel = post.type === 'carousel' && post.imageUrls.length > 1;
  const slideArgs = { post, apiKey, character, activeRefs, mode, baseReferenceImages, characterId, tempFiles };

  // --- Slide 0: always processed first (serves as reference for subsequent slides) ---
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

  // --- Slides 1+: run concurrently (they all use slide 0 as reference, independent of each other) ---
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
    // Insert in order so carousel slide order is preserved
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

/**
 * Some Apify actors return carousel slides as separate dataset items that
 * share the same shortcode.  This helper groups them so extractPostImages()
 * can treat the merged result as a single carousel.
 */
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
    // Merge: keep first item as parent, collect image URLs from siblings
    const parent = { ...group[0] };
    const extraImages = [];
    for (let i = 1; i < group.length; i++) {
      const sibling = group[i];
      const url = extractImageUrlFromMedia(sibling);
      if (url) extraImages.push({ displayUrl: url, url });
    }
    if (extraImages.length > 0) {
      // Inject siblings' images into parent's images array
      const existing = Array.isArray(parent.images) ? [...parent.images] : [];
      parent.images = [...existing, ...extraImages];
      console.log(`[post-clone] merged ${group.length} items into 1 carousel for shortCode=${sc} (${extraImages.length} extra images)`);
    }
    merged.push(parent);
  }
  return [...merged, ...noCode];
}

function normalizePostsFromItems(items) {
  // --- Diagnostic logging of raw Apify dataset ---
  console.log(`[post-clone] normalizePostsFromItems: ${(items || []).length} item(s)`);
  for (let i = 0; i < (items || []).length; i++) {
    const item = items[i];
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

  // Check for error items returned by Apify (restricted pages, login walls, etc.)
  const errorItem = (items || []).find((item) => {
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
      // For non-restricted errors, only throw if there's no extractable image
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

  // Group items by shortcode to merge carousel slides returned as separate items
  const grouped = groupItemsByShortcode(items || []);

  const posts = [];
  for (const item of grouped) {
    const extracted = extractPostImages(item);
    if (!extracted) continue;
    posts.push(extracted);
  }
  if (posts.length === 0 && items.length > 0) {
    console.warn(`[post-clone] ${items.length} item(s) from Apify but 0 had extractable images. First item keys: ${Object.keys(items[0] || {}).join(', ')}`);
  }
  return posts;
}

async function handleClone({ url, characterId, mode, postLimit = 1, apifyApiKey, profileMode = false }) {
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

    // Use limit 10 for single posts — Instagram carousels can have up to 10 slides,
    // and some actors return each slide as a separate dataset item.
    let items = await runPostActor({
      url: cleanUrl,
      limit: profileMode ? postLimit : 10,
      apifyToken: apifyApiKey,
    });

    let posts;
    try {
      posts = normalizePostsFromItems(items);
    } catch (normErr) {
      // For restricted posts with a session, fall back to scraping via profile URL.
      // The profile-scraper properly uses session cookies and returns full carousel data.
      if (normErr.code === 'INSTAGRAM_RESTRICTED' && buildLoginCookies()) {
        console.log(`[post-clone] restricted — attempting profile-based fallback`);
        const ownerUsername = await resolveUsernameFromPostUrl(cleanUrl, items);
        if (ownerUsername) {
          // Extract shortcode from the post URL to find the matching post
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

          // Find matching post by shortcode or URL
          if (targetShortcode && profileItems.length > 0) {
            // Match by shortcode field
            let matching = profileItems.filter(it => getItemShortcode(it) === targetShortcode);
            // Also match by URL containing the shortcode
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
              // Log available shortcodes for debugging
              const available = profileItems.map(it => getItemShortcode(it)).filter(Boolean).join(', ');
              console.warn(`[post-clone] fallback: shortcode ${targetShortcode} not found. Available: ${available}`);

              // Retry once with higher limit in case the post is older
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

    // Profile mode: process 2 posts concurrently to cut wall-clock time roughly in half.
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
          apiKey,
          character,
          activeRefs,
          baseReferenceImages,
          tempFiles,
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
          // For single-post mode, surface the error directly
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

    // Save history entries (non-critical — never break clone on failure)
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
      } catch { /* cleanup best-effort */ }
    }
  }
}

/**
 * POST /api/post-clone
 * Body: { postUrl, characterId, mode: "exact" | "creative", apifyApiKey? }
 */
router.post('/', async (req, res, next) => {
  try {
    const { postUrl, characterId, mode = 'exact', apifyApiKey } = req.body || {};
    const data = await handleClone({
      url: postUrl,
      characterId,
      mode: asText(mode).toLowerCase() || 'exact',
      apifyApiKey,
      postLimit: 1,
      profileMode: false,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ---------------------
// Style Focus CRUD
// ---------------------
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

// ---------------------
// Clone History
// ---------------------

router.get('/history', (_req, res, next) => {
  try { res.json({ success: true, data: postCloneHistoryStore.list() }); }
  catch (err) { next(err); }
});

router.delete('/history/:id', (req, res, next) => {
  try { res.json({ success: true, data: postCloneHistoryStore.remove(req.params.id) }); }
  catch (err) { next(err); }
});

// ---------------------
// Image Proxy (IG CDN → browser)
// ---------------------

router.get('/proxy-image', async (req, res, next) => {
  try {
    const url = asText(req.query.url);
    if (!url || !isHttpUrl(url)) {
      return res.status(400).json({ error: 'Missing or invalid url param' });
    }
    // Only proxy known IG CDN domains
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const domainParts = host.split('.');
    const top2 = domainParts.slice(-2).join('.');
    const top3 = domainParts.slice(-3).join('.');
    const isAllowed = top2 === 'fbcdn.net' || top2 === 'instagram.com' || top3 === 'cdninstagram.com';
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
    // Reject non-image responses (HTML error pages, login redirects, video streams)
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

// ---------------------
// Cached Thumbnails (downloaded during /fetch, served locally)
// ---------------------

router.get('/thumb/:filename', (req, res, next) => {
  try {
    const filename = path.basename(req.params.filename); // sanitize
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
