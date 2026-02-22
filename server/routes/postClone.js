const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { ApifyClient } = require('apify-client');
const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const { buildLoginCookies } = require('../utils/instagramCookies');
const apiKeyManager = require('../services/apiKeyManager');
const referenceManager = require('../services/referenceManager');
const promptBuilder = require('../services/promptBuilder');
const geminiService = require('../services/geminiService');
const galleryManager = require('../services/galleryManager');
const promptKnowledgeService = require('../services/promptKnowledgeService');
const styleLibrary = require('../services/styleLibrary');
const { checkPostAvailability } = require('../services/instagramAvailabilityService');

const router = express.Router();
const TEMP_DIR = path.join(process.cwd(), 'temp');
const ROUTE_TIMEOUT_MS = 5 * 60_000; // 5 min hard ceiling per clone request
const DEFAULT_ACTOR_ID = process.env.APIFY_POST_ACTOR_ID || 'apify/instagram-post-scraper';
const FALLBACK_ACTOR_ID = process.env.APIFY_POST_FALLBACK_ACTOR_ID || 'apify/instagram-scraper';
const ANALYSIS_KEYS = ['lighting', 'camera', 'pose', 'expression', 'outfit', 'scene', 'accessories', 'details', 'full_prompt'];

function ensureTempDir() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

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
    'lighting: Describe light source type, direction, quality, color temperature, and shadow character as a flowing description. Example: "Soft diffused natural light from a large window camera-left, creating gentle wrap-around illumination with subtle warm undertones"',
    'camera: Describe shot type, lens perspective, estimated focal length, shooting angle, and depth of field. Example: "Medium portrait framing at eye level with an estimated 50mm focal length, shallow depth of field softly blurring the background"',
    'pose: Describe full body positioning — weight distribution, limb placement, torso angle, hand placement and what they interact with. Directive tone. Example: "Standing with weight shifted to the right hip, left hand resting on a railing, torso turned slightly camera-left with relaxed shoulders"',
    'expression: Describe facial mood, gaze direction and intensity, mouth position, emotional read. Example: "Calm direct gaze into the lens with softly parted lips and relaxed brow, conveying quiet confidence"',
    'outfit: Describe all garments with fit, fabric, color, texture, and body interaction. Example: "White ribbed off-shoulder crop top with a relaxed drape, paired with high-waisted dark wash straight-leg jeans and chunky white platform sneakers"',
    'scene: Describe the environment — setting type, architecture, surfaces, textures, color palette, spatial depth, background and foreground',
    'accessories: Describe all visible accessories with type, material, placement, and visual effect',
    'details: Describe color grading, film stock look, grain, contrast style, saturation, visual filters',
    'format: Describe the visual rendering style — photography type, post-processing aesthetic, visual treatment',
    'full_prompt: Write an optimal identity-agnostic image generation prompt following Nano-Banana formula: SCENE → LIGHTING → CAMERA → POSE → EXPRESSION → OUTFIT → ACCESSORIES → DETAILS → FORMAT. No identity descriptors. Directive tone. One flowing natural language paragraph.',
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
  } catch { /* non-critical — don't break clone flow */ }

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
  } catch { /* non-critical — don't break clone flow */ }

  return { parsed, raw };
}

function extractImageUrlFromMedia(item) {
  // Handle plain URL strings (some actors return images as string arrays)
  if (typeof item === 'string') {
    const clean = asText(item);
    return looksLikeDirectImageUrl(clean) ? clean : '';
  }
  const candidates = [
    item?.displayUrl,
    item?.display_url,
    item?.imageUrl,
    item?.image_url,
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
  if (isHttpUrl(item.videoUrl) || isHttpUrl(item.video_url)) return true;
  const typeName = asText(item.type || item.__typename).toLowerCase();
  return typeName.includes('video') || typeName.includes('reel');
}

function extractPostImages(postItem) {
  if (!postItem || typeof postItem !== 'object') return null;

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

  if (carouselImages.length > 1) {
    return {
      type: 'carousel',
      sourceUrl: asText(postItem.url || postItem.inputUrl || postItem.shortCodeUrl || ''),
      imageUrls: Array.from(new Set(carouselImages)),
    };
  }

  const singleImage = extractImageUrlFromMedia(postItem);
  if (singleImage && !isVideoItem(postItem)) {
    // Log when we expected a carousel but only got 1 image
    const typeName = asText(postItem.type || postItem.__typename || postItem.productType || '').toLowerCase();
    if (typeName.includes('sidecar') || typeName.includes('carousel') || postItem.mediaCount > 1) {
      console.warn(`[post-clone] CAROUSEL UNDEREXTRACTED: type=${typeName}, mediaCount=${postItem.mediaCount}, extracted=1`);
      console.warn(`[post-clone] full keys: ${Object.keys(postItem).join(', ')}`);
      try { console.warn(`[post-clone] item preview: ${JSON.stringify(postItem).slice(0, 600)}`); } catch { /* circular ref */ }
    }
    return {
      type: 'single',
      sourceUrl: asText(postItem.url || postItem.inputUrl || postItem.shortCodeUrl || singleImage),
      imageUrls: [singleImage],
    };
  }

  return null;
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

  async function callActor(actorId, input) {
    return client.actor(actorId).call(input);
  }

  let run;
  let actorUsed = DEFAULT_ACTOR_ID;
  try {
    if (profileUsername) {
      const input = {
        username: profileUsername,
        resultsLimit: boundedLimit,
        directUrls: [url],
        startUrls: [{ url }],
        expandSlideshowImages: true,
        ...(loginCookies ? { loginCookies } : {}),
        ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}),
      };
      console.log(`[post-clone] calling actor ${DEFAULT_ACTOR_ID} (profile) input: ${JSON.stringify({ ...input, loginCookies: input.loginCookies ? '[set]' : undefined })}`);
      run = await callActor(DEFAULT_ACTOR_ID, input);
    } else {
      const input = {
        directUrls: [url],
        startUrls: [{ url }],
        resultsLimit: boundedLimit,
        resultsType: 'posts',
        expandSlideshowImages: true,
        ...(loginCookies ? { loginCookies } : {}),
      };
      console.log(`[post-clone] calling actor ${DEFAULT_ACTOR_ID} (post) input: ${JSON.stringify({ ...input, loginCookies: input.loginCookies ? '[set]' : undefined })}`);
      run = await callActor(DEFAULT_ACTOR_ID, input);
    }
  } catch (err) {
    // Fallback for actor schema mismatch (common for single post URLs).
    const message = asText(err?.message).toLowerCase();
    const shouldFallback =
      message.includes('username is required')
      || message.includes('input is not valid')
      || message.includes('schema')
      || message.includes('validation');
    if (!shouldFallback) {
      throw new AppError(`Apify actor run failed (${DEFAULT_ACTOR_ID}): ${err.message}`, 502, 'APIFY_ERROR');
    }
    try {
      actorUsed = FALLBACK_ACTOR_ID;
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
        `Apify actor run failed (${DEFAULT_ACTOR_ID}) and fallback (${FALLBACK_ACTOR_ID}): ${fallbackErr.message}`,
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

  let firstSlideOriginal = null;
  let firstSlideRecreated = null;

  for (let i = 0; i < post.imageUrls.length; i += 1) {
    try {
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

    originalImages.push({ url: imageUrl || rawUrl, mimeType, base64Data });

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
          apiKey,
          firstSlideOriginal.base64Data,
          firstSlideOriginal.mimeType,
          base64Data,
          mimeType,
          mode,
          sourceMeta,
          characterId
        );
      } catch (err) {
        const msg = asText(err?.message).toLowerCase();
        if (!msg.includes('unable to process input image') && !msg.includes('invalid_argument')) throw err;
        resolvedPath = await safeJpegFromAnyImage(filePath, tempFiles);
        buffer = fs.readFileSync(resolvedPath);
        mimeType = 'image/jpeg';
        base64Data = buffer.toString('base64');
        delta = await analyzeCarouselDelta(
          apiKey,
          firstSlideOriginal.base64Data,
          firstSlideOriginal.mimeType,
          base64Data,
          mimeType,
          mode,
          sourceMeta,
          characterId
        );
      }
      structured = delta.parsed;
      generationPrompt = buildGenerationPrompt({
        character,
        activeRefs,
        mode,
        structured,
        isDelta: true,
      });
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
      generationPrompt = buildGenerationPrompt({
        character,
        activeRefs,
        mode,
        structured,
        isDelta: false,
      });
    }

    const generated = await geminiService.generateImage(apiKey, generationPrompt, {
      aspectRatio: '4:5',
      imageSize: '2K',
      referenceImages,
    });

    galleryManager.save({
      base64Data: generated.image.base64Data,
      mimeType: generated.image.mimeType,
      prompt: structured.full_prompt || 'Post Clone recreation',
      source: 'post-clone',
      characterId,
      aspectRatio: '4:5',
      seed: null,
    });

    recreatedImages.push({
      mimeType: generated.image.mimeType,
      base64Data: generated.image.base64Data,
      text: generated.text || null,
      prompt: generationPrompt,
      structured,
    });

    if (i === 0) {
      firstSlideOriginal = { mimeType, base64Data };
      firstSlideRecreated = {
        mimeType: generated.image.mimeType,
        base64Data: generated.image.base64Data,
      };
    }
    } catch (slideErr) {
      // For carousels, skip failed slides and continue with the rest
      if (post.type === 'carousel' && post.imageUrls.length > 1) {
        console.warn(`[post-clone] carousel slide ${i + 1}/${post.imageUrls.length} failed: ${slideErr.message} — skipping`);
        continue;
      }
      // Single post — re-throw
      throw slideErr;
    }
  }

  return {
    type: post.type,
    sourceUrl: post.sourceUrl || null,
    originalImages,
    recreatedImages,
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
    if (!byCode.has(sc)) { byCode.set(sc, []); continue; }
    byCode.get(sc).push(item);
  }

  // First pass added first occurrence as the only entry — re-scan to build properly
  byCode.clear();
  for (const item of items) {
    const sc = getItemShortcode(item);
    if (!sc) continue;
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

  const restricted = (items || []).find((item) => {
    const err = asText(item?.error).toLowerCase();
    if (err === 'restricted_page' || err === 'restricted' || err.includes('restricted')) return true;
    if (item?.restricted === true || item?.isRestricted === true) return true;
    return false;
  });
  if (restricted) {
    const url = asText(restricted?.url || restricted?.inputUrl || '');
    throw new AppError(
      `Post is restricted — Apify could only get partial data${url ? ` (${url})` : ''}. Your IG session may be expired, or this post requires age-verified access.`,
      422,
      'INSTAGRAM_RESTRICTED'
    );
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
  const deadline = Date.now() + ROUTE_TIMEOUT_MS;
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
    const items = await runPostActor({
      url: cleanUrl,
      limit: profileMode ? postLimit : 10,
      apifyToken: apifyApiKey,
    });
    const posts = normalizePostsFromItems(items);
    const selected = profileMode ? posts.slice(0, Math.max(1, Math.min(20, Number(postLimit) || 1))) : posts.slice(0, 1);

    if (selected.length === 0) {
      throw new AppError('No static image posts found to clone', 422, 'NO_IMAGE_POSTS');
    }

    const results = [];
    const errors = [];
    for (let idx = 0; idx < selected.length; idx++) {
      const post = selected[idx];
      if (Date.now() > deadline) {
        errors.push({ index: idx, sourceUrl: post.sourceUrl || '', error: `Timed out after ${ROUTE_TIMEOUT_MS / 1000}s` });
        break;
      }
      try {
        const processed = await processPostClone({
          post,
          characterId,
          mode,
          apiKey,
          character,
          activeRefs,
          baseReferenceImages,
          tempFiles,
        });
        results.push(processed);
      } catch (postErr) {
        console.warn(`[post-clone] post ${idx + 1}/${selected.length} failed: ${postErr.message}`);
        errors.push({ index: idx, sourceUrl: post.sourceUrl || '', error: postErr.message });
        // For single-post mode, surface the error directly
        if (!profileMode) throw postErr;
        // For profile mode, continue with remaining posts
      }
    }
    if (results.length === 0 && errors.length > 0) {
      throw new AppError(
        `All ${errors.length} post(s) failed to clone. Last error: ${errors[errors.length - 1].error}`,
        502,
        'ALL_POSTS_FAILED'
      );
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

module.exports = router;
module.exports.handleClone = handleClone;
module.exports.runPostActor = runPostActor;
module.exports.normalizePostsFromItems = normalizePostsFromItems;
module.exports.downloadImageToTemp = downloadImageToTemp;
module.exports.parseStructuredAnalysis = parseStructuredAnalysis;
module.exports.buildStructuredAnalysisPrompt = buildStructuredAnalysisPrompt;
module.exports.mimeFromExt = mimeFromExt;
module.exports.ensureTempDir = ensureTempDir;
