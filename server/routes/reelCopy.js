const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const ffmpegPath = require('../utils/ffmpeg');
const { ApifyClient } = require('apify-client');
const { AppError } = require('../middleware/errorHandler');
const { createMultipartParser } = require('../middleware/multipartParser');
const { sharedHttpsAgent } = require('../utils/httpAgent');
const { asText } = require('../utils/helpers');
const { buildLoginCookies } = require('../utils/instagramCookies');
const cfg = require('../config');
const apiKeyManager = require('../services/apiKeyManager');
const referenceManager = require('../services/referenceManager');
const sceneAnalyzer = require('../services/sceneAnalyzer');
const geminiService = require('../services/geminiService');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const { checkPostAvailability } = require('../services/instagramAvailabilityService');
const logger = require('../utils/logger');

const router = express.Router();
const { TEMP_DIR } = require('../paths');
const ROUTE_TIMEOUT_MS = 5 * 60_000; // 5 min hard ceiling
const DEFAULT_ACTOR_ID = process.env.APIFY_REEL_ACTOR_ID || 'apify/instagram-scraper';
const MATCH_STRENGTHS = new Set(['soft', 'medium', 'strict']);
const TATTOO_TERMS_REGEX = /\b(?:tattoo(?:s|ed|ing)?|body\s*ink|inked|inkwork|sleeve\s+tattoo|tribal\s+ink)\b/i;
const TATTOO_SENTENCE_REGEX = /[^.!?\n]*\b(?:tattoo(?:s|ed|ing)?|body\s*ink|inked|inkwork|sleeve\s+tattoo|tribal\s+ink)\b[^.!?\n]*[.!?]?/gi;
const parseMultipartIfNeeded = createMultipartParser({ maxBytes: 200 * 1024 * 1024 });

function normalizeMatchStrength(value, fallback = 'medium') {
  const clean = asText(value).toLowerCase();
  return MATCH_STRENGTHS.has(clean) ? clean : fallback;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return fallback;
}

function parseJsonMaybe(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (typeof value === 'object') return value;
  return null;
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

function stripTattoosFromSceneData(sceneData) {
  if (!sceneData || typeof sceneData !== 'object') return sceneData;
  const cleaned = { ...sceneData };
  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value === 'string') cleaned[key] = stripTattooMentions(value);
  }
  return cleaned;
}

function poseLockInstruction(level, stage = 'followup') {
  if (level === 'strict') {
    return stage === 'first'
      ? 'Pose/expression lock: exact pose and expression match to source frame (body orientation, shoulder/torso angle, head tilt, phone-hand placement, gaze, expression intensity).'
      : 'Pose/expression lock: recreate the original LAST-frame pose progression as exactly as possible (arm position, phone height/angle, head tilt, gaze, expression).';
  }
  if (level === 'soft') {
    return stage === 'first'
      ? 'Pose/expression match: keep the same overall pose vibe and expression mood, with mild natural variation.'
      : 'Pose/expression match: follow last-frame pose progression with mild natural variation.';
  }
  return stage === 'first'
    ? 'Pose/expression match: very close to source pose structure and facial mood with limited flexibility.'
    : 'Pose/expression match: closely follow last-frame pose progression with limited flexibility.';
}

function environmentLockInstruction(level) {
  if (level === 'strict') {
    return 'Environment/lighting lock: keep room structure, framing geometry, and lighting behavior closely aligned to source.';
  }
  if (level === 'soft') {
    return 'Environment/lighting match: keep the same general room vibe and light palette, with visible layout/detail variation allowed.';
  }
  return 'Environment/lighting match: keep core room context and light mood, while allowing moderate background variation.';
}

function ensureTempDir() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function parseVideoUrls(item) {
  if (!item || typeof item !== 'object') return [];
  const list = [];
  const pushIfHttp = (value) => {
    const v = asText(value);
    if (/^https?:\/\//i.test(v)) list.push(v);
  };

  pushIfHttp(item.videoUrl);
  pushIfHttp(item.video_url);
  pushIfHttp(item.videoPlayUrl);
  pushIfHttp(item.video_play_url);
  pushIfHttp(item.displayUrl);
  pushIfHttp(item.display_url);

  if (Array.isArray(item.videoVersions)) {
    for (const version of item.videoVersions) {
      pushIfHttp(version && (version.url || version.src));
    }
  }

  return Array.from(new Set(list));
}

async function resolveVideoUrlFromApify(reelUrl, apifyToken = '') {
  const token = asText(apifyToken) || asText(apiKeyManager.getApifyKey()) || asText(process.env.APIFY_TOKEN);
  if (!token) {
    throw new AppError('Apify token is required (provide apifyApiKey or APIFY_TOKEN env)', 400, 'CONFIG_ERROR');
  }

  const client = new ApifyClient({ token });
  const loginCookies = buildLoginCookies();
  let run;
  let actorErr = null;
  try {
    const actor = client.actor(DEFAULT_ACTOR_ID);
    run = await actor.call({
      directUrls: [reelUrl],
      startUrls: [{ url: reelUrl }],
      resultsType: 'posts',
      resultsLimit: 1,
      addParentData: false,
      ...(loginCookies ? { loginCookies } : {}),
    });
  } catch (err) {
    actorErr = err;
    if (loginCookies) {
      try {
        const actor = client.actor(DEFAULT_ACTOR_ID);
        run = await actor.call({
          directUrls: [reelUrl],
          startUrls: [{ url: reelUrl }],
          resultsType: 'posts',
          resultsLimit: 1,
          addParentData: false,
        });
      } catch (fallbackErr) {
        actorErr = actorErr || fallbackErr;
      }
    }
  }
  if (!run) {
    throw new AppError(
      `Apify actor run failed (${DEFAULT_ACTOR_ID}): ${actorErr ? actorErr.message : 'unknown error'}`,
      502,
      'APIFY_ERROR'
    );
  }

  const datasetId = run && run.defaultDatasetId;
  if (!datasetId) {
    throw new AppError('Apify actor returned no dataset', 502, 'APIFY_ERROR');
  }

  let items = [];
  try {
    const listed = await client.dataset(datasetId).listItems({ limit: 5 });
    items = Array.isArray(listed?.items) ? listed.items : [];
  } catch (err) {
    throw new AppError(`Failed to read Apify dataset: ${err.message}`, 502, 'APIFY_ERROR');
  }
  const firstItem = items[0] || null;
  const videoUrls = parseVideoUrls(firstItem);
  if (videoUrls.length === 0) {
    throw new AppError('No reel video URL found in Apify result', 422, 'NO_VIDEO_URL');
  }

  return { videoUrls, apifyItem: firstItem || null };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadVideo(videoUrls, targetPath) {
  const urls = Array.isArray(videoUrls) ? videoUrls.filter(Boolean) : [];
  if (urls.length === 0) {
    throw new AppError('No candidate video URLs provided for download', 502, 'VIDEO_DOWNLOAD_ERROR');
  }

  let lastErr = null;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Referer': 'https://www.instagram.com/',
  };

  try {
    for (const url of urls) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const writer = fs.createWriteStream(targetPath);
          const response = await axios.get(url, {
            responseType: 'stream',
            timeout: 120000,
            httpsAgent: sharedHttpsAgent,
            headers,
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 400,
          });
          await new Promise((resolve, reject) => {
            response.data.on('error', (err) => {
              writer.destroy();
              reject(err);
            });
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', (err) => {
              response.data.destroy();
              reject(err);
            });
          });
          return { videoUrl: url };
        } catch (err) {
          lastErr = err;
          try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath); } catch { /* cleanup best-effort */ }
          if (attempt < 3) await sleep(400 * attempt);
        }
      }
    }
  } catch (outerErr) {
    lastErr = outerErr;
  }

  const msg = lastErr && lastErr.message ? lastErr.message : 'unknown download error';
  throw new AppError(`Failed to download reel video from all candidates: ${msg}`, 502, 'VIDEO_DOWNLOAD_ERROR');
}

async function extractFrames(videoPath, firstPath, lastPath) {
  try {
    await execFileAsync(ffmpegPath, ['-y', '-i', videoPath, '-vframes', '1', firstPath], {
      timeout: 30000,
    });
    await execFileAsync(ffmpegPath, ['-y', '-sseof', '-1', '-i', videoPath, '-vframes', '1', lastPath], {
      timeout: 30000,
    });
  } catch (err) {
    throw new AppError(
      `Frame extraction failed. Install FFmpeg and ensure it is in PATH. ${err.message}`,
      500,
      'FFMPEG_ERROR'
    );
  }
}

function buildCharacterReferenceImages(characterId, activeRefs) {
  const parts = [];
  const primaries = referenceManager.getPrimaryImages(characterId);
  for (const primary of primaries) {
    if (primary?.buffer?.length) {
      parts.push({
        mimeType: primary.mimeType,
        base64Data: primary.buffer.toString('base64'),
      });
    }
  }

  for (const ref of activeRefs || []) {
    const data = referenceManager.getReferenceImage(characterId, ref.id);
    if (data?.buffer?.length) {
      parts.push({
        mimeType: data.mimeType,
        base64Data: data.buffer.toString('base64'),
      });
    }
  }

  return parts;
}

function buildFirstFrameLockBlock(sceneData, poseStrength, envStrength, poseEnabled, envEnabled) {
  return [
    '[REEL COPY LOCK - FIRST FRAME]',
    'Recreate the source frame as precisely as possible with the selected character identity.',
    'Non-negotiable lock points:',
    `- Exact environment/setting: ${sceneData.environment || 'match source exactly'}`,
    `- Exact lighting behavior and color temperature: ${sceneData.lighting || 'match source exactly'}`,
    `- Exact camera angle and framing: ${sceneData.cameraAngle || 'match source exactly'}`,
    `- Exact composition and background object placement: ${sceneData.composition || 'match source exactly'}`,
    sceneData.outfit ? `- OUTFIT LOCK (match exactly): ${sceneData.outfit}` : '- Wardrobe continuity lock: preserve garment structure, drape behavior, and silhouette exactly as in source.',
    sceneData.hair ? `- HAIR LOCK: ${sceneData.hair}` : null,
    poseEnabled ? `- ${poseLockInstruction(poseStrength, 'first')}` : null,
    envEnabled ? '- Environment/lighting lock: keep room structure, framing geometry, and lighting behavior closely aligned to source.' : null,
    '- Strict character identity lock: preserve face and overall silhouette consistency from character references.',
    '- Identity priority rule: selected character references always override source-subject identity traits.',
    '- Do not copy the source person face or biometric identity; copy only pose/composition/scene/outfit.',
    '- Tattoo exclusion: ignore tattoos/body ink from the source and do not render tattoos in output.',
    '- Keep proportions and styling consistent with the selected character identity lock.',
    sceneData.objects ? `- Accessories/objects lock: ${sceneData.objects}` : null,
    '- Only include objects/devices the subject is visibly holding in the source frame. Do NOT add a phone, camera, or any handheld object unless it is clearly present in the source.',
    '- Do not stylize, do not editorialize, do not swap location or lighting setup.',
  ].filter(Boolean).join('\n');
}

function buildFollowUpLockBlock({ firstGeneratedScene, targetScene, poseStrength, envStrength, poseEnabled, envEnabled, withSourceRef = true, outfitTransition = false, targetOutfit = null, targetLighting = null }) {
  let outfitLock;
  if (outfitTransition && targetOutfit) {
    outfitLock = `- OUTFIT TRANSITION (must wear a DIFFERENT outfit from first frame): ${targetOutfit}\n- This is an outfit-change transition — the character MUST be wearing the new outfit described above, NOT the first frame outfit.`;
  } else {
    outfitLock = firstGeneratedScene.outfit
      ? `- OUTFIT LOCK (must match first frame exactly): ${firstGeneratedScene.outfit}`
      : '- Keep same outfit material, garment structure, and drape behavior from frame 1 recreation.';
  }
  const hairLock = firstGeneratedScene.hair
    ? `- HAIR LOCK (must match first frame): ${firstGeneratedScene.hair}`
    : null;

  if (withSourceRef) {
    return [
      '[REEL COPY LOCK - FOLLOW-UP CONTINUITY]',
      'Reference image rule:',
      '- Reference 1 = source last frame (POSE/EXPRESSION TARGET — copy this pose exactly).',
      outfitTransition
        ? '- Reference 2 = recreated first frame (continuity anchor for environment ONLY — do NOT copy its outfit or lighting).'
        : '- Reference 2 = recreated first frame (continuity anchor for environment/outfit/identity).',
      '- Remaining references = character identity images.',
      '',
      'HIGHEST PRIORITY: Match the exact pose, body position, arm placement, hand gesture, head tilt, and expression from Reference 1 (source last frame).',
      'Copy the pose from Reference 1 as precisely as possible. This is the single most important requirement.',
      '- IDENTITY LOCK: Do NOT copy the face, skin tone, hair color, or body proportions from Reference 1. The character MUST look like the character reference images. Only copy pose and body position from Reference 1.',
      '- Tattoo exclusion: ignore tattoos/body ink from source frames and do not generate tattoos in output.',
      '',
      'Continuity lock from reference 2 (must remain consistent):',
      `- Keep the same environment/room structure from reference 2.`,
      `- Environment anchor: ${firstGeneratedScene.environment || 'same setting as reference 2'}`,
      outfitTransition && targetLighting
        ? `- LIGHTING CHANGE: The lighting MUST change from the first frame. Apply this lighting: ${targetLighting}. Do NOT use the first frame's lighting.`
        : `- Lighting anchor: ${firstGeneratedScene.lighting || 'same lighting mood as reference 2'}`,
      `- Camera anchor: ${firstGeneratedScene.cameraAngle || 'similar camera angle/framing as reference 2'}`,
      envEnabled ? `- ${environmentLockInstruction(envStrength)}` : null,
      '- Minor background/detail differences are allowed; do not hard-copy every object position.',
      outfitLock,
      hairLock,
      '- Keep selected character identity appearance consistent.',
      '- Identity priority rule: selected character references ALWAYS override source-subject identity. Never copy face or identity from Reference 1.',
      '',
      'Pose target from Reference 1 (source last frame):',
      `- Target camera/framing: ${targetScene.framingStyle || targetScene.cameraAngle || 'match Reference 1 framing'}`,
      `- Target composition: ${targetScene.composition || 'match Reference 1 composition'}`,
      `- Target visible elements: ${targetScene.objects || 'match Reference 1 details'}`,
      poseEnabled ? `- ${poseLockInstruction(poseStrength, 'followup')}` : null,
      '- Must not keep first-frame pose; explicitly change body position, arm placement, and head angle to match Reference 1 (source last frame).',
      '- Only include objects/devices the subject is visibly holding in Reference 1. Do NOT add a phone, camera, or any handheld object unless clearly present in the source last frame.',
      outfitTransition ? '- Do not change room structure while applying the pose change.' : '- Do not change room, lighting rig, or color temperature while applying the pose change.',
    ].filter(Boolean).join('\n');
  }

  // Fallback: no source frame reference — pose comes from text description only.
  return [
    '[REEL COPY LOCK - FOLLOW-UP CONTINUITY]',
    'Reference image rule:',
    outfitTransition
      ? '- Reference 1 = recreated first frame (continuity anchor for environment/identity ONLY — do NOT copy its outfit).'
      : '- Reference 1 = recreated first frame (continuity anchor for environment/outfit/identity).',
    '- Remaining references = character identity images.',
    '',
    'Continuity lock from reference 1 (must remain consistent):',
    `- Keep the same environment/room structure from reference 1.`,
    `- Environment anchor: ${firstGeneratedScene.environment || 'same setting as reference 1'}`,
    outfitTransition && targetLighting
      ? `- LIGHTING TRANSITION: Do NOT copy the first frame lighting. Use this lighting instead: ${targetLighting}`
      : `- Lighting anchor: ${firstGeneratedScene.lighting || 'same lighting mood as reference 1'}`,
    `- Camera anchor: ${firstGeneratedScene.cameraAngle || 'similar camera angle/framing as reference 1'}`,
    envEnabled ? `- ${environmentLockInstruction(envStrength)}` : null,
    '- Minor background/detail differences are allowed; do not hard-copy every object position.',
    outfitLock,
    hairLock,
    '- Keep selected character identity appearance consistent.',
    '- Identity priority rule: selected character references remain dominant over source-subject identity.',
    '- Tattoo exclusion: ignore tattoos/body ink from source frames and do not generate tattoos in output.',
    '',
    'Pose target (from text description below — match as closely as possible):',
    `- Target camera/framing: ${targetScene.framingStyle || targetScene.cameraAngle || 'match target framing'}`,
    `- Target composition: ${targetScene.composition || 'match target composition'}`,
    `- Target visible elements: ${targetScene.objects || 'match target details'}`,
    poseEnabled ? `- ${poseLockInstruction(poseStrength, 'followup')}` : null,
    '- Must not keep first-frame pose; explicitly change body position, arm placement, and head angle to match the pose description below.',
    '- Only include objects/devices the subject is visibly holding in the target pose. Do NOT add a phone, camera, or any handheld object unless described in the pose target.',
    outfitTransition ? '- Do not change room structure while applying the pose change. Lighting should match the source last frame.' : '- Do not change room, lighting rig, or color temperature while applying the pose change.',
  ].filter(Boolean).join('\n');
}

async function derivePoseExpressionHint(apiKey, frameBase64, mimeType = 'image/jpeg') {
  const prompt = [
    'Describe ONLY the subject pose/expression/camera-hand interaction for recreation.',
    'Focus on:',
    '- body orientation and weight distribution (front/side/three-quarter, which leg bears weight)',
    '- torso twist, shoulder angle, and spine curve',
    '- head tilt angle, chin position, and gaze direction (camera/away/down/over-shoulder)',
    '- arm positions: each hand placement (height, angle, what it is holding or touching — only mention objects actually visible)',
    '- finger details: grip style, spread, pointing, resting position',
    '- expression specifics: mouth (open/closed/smirk/smile width), eyebrow position, eye intensity',
    '- overall energy level (relaxed/dynamic/tense/playful)',
    'Ignore tattoos/body ink completely. Do not mention or describe tattoos.',
    'Output 7 short bullet lines in directive tone. No identity descriptors. No safety commentary.',
  ].join('\n');

  const raw = await geminiService.analyzeImageWithPrompt(apiKey, frameBase64, mimeType, prompt);
  return stripTattooMentions(raw);
}

async function recreateFrame({
  frameBase64,
  characterId,
  activeReferenceIds,
  apiKey,
  referenceImages,
  imageModel,
  extraLockText = '',
  overrideSceneData = null,
}) {
  const rawSceneData = overrideSceneData || await sceneAnalyzer.analyzeScene(frameBase64, 'image/jpeg');
  const sceneData = stripTattoosFromSceneData(rawSceneData);
  const promptBase = sceneAnalyzer.buildRecreationPrompt({
    sceneData,
    characterId,
    activeReferenceIds,
  });
  const MAX_PROMPT = cfg.PROMPT_MAX_LENGTH;
  let prompt = extraLockText
    ? `${promptBase}\n\n${extraLockText}`
    : promptBase;

  // Trim base prompt if combined length exceeds Gemini's 10K limit,
  // keeping the lock text intact since it drives recreation accuracy.
  if (prompt.trim().length > MAX_PROMPT && extraLockText) {
    const lockLen = extraLockText.length + 2; // +2 for the \n\n separator
    const maxBase = MAX_PROMPT - lockLen - 50; // 50 char safety margin
    if (maxBase > 500) {
      prompt = `${promptBase.slice(0, maxBase).trimEnd()}\n\n${extraLockText}`;
    } else {
      // Lock text alone is near the limit — trim it too
      prompt = `${promptBase.slice(0, 2000).trimEnd()}\n\n${extraLockText.slice(0, MAX_PROMPT - 2050).trimEnd()}`;
    }
    logger.info(`[reel-copy] Prompt trimmed from ${promptBase.length + lockLen} to ${prompt.length} chars`);
  }

  const generated = await geminiService.generateImage(apiKey, prompt, {
    aspectRatio: '9:16',
    imageSize: '2K',
    referenceImages,
    model: imageModel,
  });

  const stored = imageStore.store({
    basePrompt: prompt,
    characterId,
    activeReferenceIds,
    sceneDescription: JSON.stringify(sceneData),
    modelUsed: generated.modelUsed || null,
    seed: null,
    parentImageId: null,
    variationIndex: null,
    image: {
      mimeType: generated.image.mimeType,
      base64Data: generated.image.base64Data,
    },
    source: 'reel-copy',
  });

  galleryManager.save({
    base64Data: generated.image.base64Data,
    mimeType: generated.image.mimeType,
    prompt: 'Reel Copy Frame Recreation',
    source: 'reel-copy',
    characterId,
    aspectRatio: '9:16',
    seed: null,
  });

  return {
    imageId: stored.imageId,
    sceneData,
    image: generated.image,
    text: generated.text || null,
    prompt,
  };
}

/**
 * POST /api/reel-copy
 * Body: { reelUrl, characterId, apifyApiKey? }
 */
router.post('/', parseMultipartIfNeeded, async (req, res, next) => {
  let videoPath = '';
  let firstPath = '';
  let lastPath = '';
  const deadline = Date.now() + ROUTE_TIMEOUT_MS;
  try {
    const { reelUrl, characterId, apifyApiKey, activeReferenceIds: clientRefIds, imageModel } = req.body || {};
    const uploadedVideo = req.file && req.file.buffer ? req.file : null;
    const cleanUrl = asText(reelUrl);
    const sourceFrames = parseJsonMaybe(req.body?.sourceFrames);
    const sourceAnalysis = parseJsonMaybe(req.body?.sourceAnalysis);
    const hasProvidedFrames = !!(
      sourceFrames &&
      sourceFrames.first &&
      sourceFrames.last &&
      asText(sourceFrames.first.base64Data) &&
      asText(sourceFrames.last.base64Data)
    );
    const poseMatchStrength = normalizeMatchStrength(req.body?.poseMatchStrength, 'medium');
    const environmentMatchStrength = normalizeMatchStrength(req.body?.environmentMatchStrength, 'medium');
    const poseMatchEnabled = parseBoolean(req.body?.poseMatchEnabled, true);
    const environmentMatchEnabled = parseBoolean(req.body?.environmentMatchEnabled, true);
    const useSourceFrameReference = parseBoolean(req.body?.useSourceFrameReference, false);
    const outfitTransition = parseBoolean(req.body?.outfitTransition, false);

    if (!cleanUrl && !uploadedVideo && !hasProvidedFrames) {
      throw new AppError('Provide one source: "reelUrl", local video upload, or "sourceFrames"', 400, 'VALIDATION_ERROR');
    }
    if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
      throw new AppError('"reelUrl" must be a valid URL', 400, 'VALIDATION_ERROR');
    }
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
    }
    if (uploadedVideo) {
      const maxSize = 200 * 1024 * 1024;
      const allowedMime = new Set([
        'video/mp4',
        'video/quicktime',
        'video/webm',
        'application/octet-stream',
      ]);
      if (uploadedVideo.size > maxSize) {
        throw new AppError('Uploaded video exceeds 200MB limit', 400, 'FILE_TOO_LARGE');
      }
      if (!allowedMime.has(uploadedVideo.mimetype || 'application/octet-stream')) {
        throw new AppError('Unsupported video type. Use mp4, mov, or webm.', 400, 'INVALID_FILE_TYPE');
      }
    }

    referenceManager.getCharacter(characterId);
    const normalizedClientRefIds = Array.isArray(clientRefIds)
      ? clientRefIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : null;
    const activeRefs = referenceManager.getActiveReferences(characterId, normalizedClientRefIds && normalizedClientRefIds.length > 0 ? normalizedClientRefIds : null);
    const activeReferenceIds = activeRefs.map((r) => r.id);
    const referenceImages = buildCharacterReferenceImages(characterId, activeRefs);
    const apiKey = apiKeyManager.getActiveKey();

    if (cleanUrl && !uploadedVideo && !hasProvidedFrames) {
      const availability = await checkPostAvailability(cleanUrl, { apifyToken: apifyApiKey });
      if (!availability.allowed) {
        throw new AppError(availability.label, 422, 'INSTAGRAM_UNAVAILABLE');
      }
    }

    let videoUrl = null;
    let firstFrameBase64 = '';
    let lastFrameBase64 = '';
    let firstFrameMimeType = 'image/jpeg';
    let lastFrameMimeType = 'image/jpeg';

    if (hasProvidedFrames) {
      firstFrameBase64 = asText(sourceFrames.first.base64Data);
      lastFrameBase64 = asText(sourceFrames.last.base64Data);
      firstFrameMimeType = asText(sourceFrames.first.mimeType) || 'image/jpeg';
      lastFrameMimeType = asText(sourceFrames.last.mimeType) || 'image/jpeg';
    } else {
      ensureTempDir();
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      videoPath = path.join(TEMP_DIR, `reel-${unique}.mp4`);
      firstPath = path.join(TEMP_DIR, `first-${unique}.jpg`);
      lastPath = path.join(TEMP_DIR, `last-${unique}.jpg`);

      if (uploadedVideo) {
        fs.writeFileSync(videoPath, uploadedVideo.buffer);
        uploadedVideo.buffer = null; // release ~200MB from memory
      } else {
        const { videoUrls } = await resolveVideoUrlFromApify(cleanUrl, apifyApiKey);
        const downloaded = await downloadVideo(videoUrls, videoPath);
        videoUrl = downloaded.videoUrl;
      }
      await extractFrames(videoPath, firstPath, lastPath);
      firstFrameBase64 = fs.readFileSync(firstPath).toString('base64');
      lastFrameBase64 = fs.readFileSync(lastPath).toString('base64');
    }

    // Stage 1: recreate first frame with strict original-frame lock.
    const firstSourceScene = stripTattoosFromSceneData(
      sourceAnalysis?.firstSourceScene
      || await sceneAnalyzer.analyzeScene(firstFrameBase64, firstFrameMimeType)
    );
    const firstPoseHint = stripTattooMentions(asText(sourceAnalysis?.firstPoseHint))
      || await derivePoseExpressionHint(apiKey, firstFrameBase64, firstFrameMimeType);

    const firstLockText = `${buildFirstFrameLockBlock(
      firstSourceScene,
      poseMatchStrength,
      environmentMatchStrength,
      poseMatchEnabled,
      environmentMatchEnabled
    )}\n\n[FIRST FRAME POSE/EXPRESSION TARGET]\n${firstPoseHint}`;

    let first;
    if (useSourceFrameReference) {
      try {
        first = await recreateFrame({
          frameBase64: firstFrameBase64,
          characterId, activeReferenceIds, apiKey,
          imageModel,
          referenceImages: [...referenceImages, { mimeType: firstFrameMimeType, base64Data: firstFrameBase64 }],
          extraLockText: firstLockText,
        });
      } catch (refErr) {
        if (refErr.code === 'GENERATION_EMPTY' || refErr.code === 'SAFETY_BLOCKED') {
          logger.warn('First frame generation blocked with source frame reference, retrying without it');
          first = await recreateFrame({
            frameBase64: firstFrameBase64,
            characterId, activeReferenceIds, apiKey,
            imageModel,
            referenceImages,
            extraLockText: firstLockText,
          });
        } else {
          throw refErr;
        }
      }
    } else {
      first = await recreateFrame({
        frameBase64: firstFrameBase64,
        characterId, activeReferenceIds, apiKey,
        imageModel,
        referenceImages,
        extraLockText: firstLockText,
      });
    }

    // Stage 2: generate last frame from first recreation anchor + original last-frame target.
    if (Date.now() > deadline) {
      throw new AppError(`Reel copy timed out after ${ROUTE_TIMEOUT_MS / 1000}s (first frame done, second frame skipped)`, 504, 'REEL_COPY_TIMEOUT');
    }
    const resolvedLastSourceScene = stripTattoosFromSceneData(
      sourceAnalysis?.lastSourceScene
      || await sceneAnalyzer.analyzeScene(lastFrameBase64, lastFrameMimeType)
    );
    const firstGeneratedScene = stripTattoosFromSceneData(
      await sceneAnalyzer.analyzeScene(
        first.image.base64Data,
        first.image.mimeType || 'image/png'
      )
    );

    const lastPoseHint = stripTattooMentions(asText(sourceAnalysis?.lastPoseHint))
      || await derivePoseExpressionHint(apiKey, lastFrameBase64, lastFrameMimeType);

    // Use first recreated frame's scene as the base prompt scene for the last frame.
    // This prevents the base prompt from describing the source last frame's scene
    // (which conflicts with the continuity lock and causes the model to ignore pose changes).
    // When outfit transition is enabled, swap outfit in the base scene.
    // Do NOT swap lighting here — the visual reference (first frame) would conflict with text.
    // Lighting transition is driven by the lock block instruction instead.
    const lastFrameOverrideScene = outfitTransition && resolvedLastSourceScene.outfit
      ? { ...firstGeneratedScene, outfit: resolvedLastSourceScene.outfit }
      : firstGeneratedScene;

    const followUpLockParams = {
      firstGeneratedScene,
      targetScene: resolvedLastSourceScene,
      poseStrength: poseMatchStrength,
      envStrength: environmentMatchStrength,
      poseEnabled: poseMatchEnabled,
      envEnabled: environmentMatchEnabled,
      outfitTransition,
      targetOutfit: outfitTransition ? resolvedLastSourceScene.outfit : null,
      targetLighting: outfitTransition ? resolvedLastSourceScene.lighting : null,
    };

    let last;
    try {
      // Try with source last frame as visual pose reference (best quality).
      last = await recreateFrame({
        frameBase64: lastFrameBase64,
        characterId,
        activeReferenceIds,
        apiKey,
        imageModel,
        overrideSceneData: lastFrameOverrideScene,
        referenceImages: [
          { mimeType: lastFrameMimeType, base64Data: lastFrameBase64 },
          { mimeType: first.image.mimeType || 'image/png', base64Data: first.image.base64Data },
          ...referenceImages,
        ],
        extraLockText: `${buildFollowUpLockBlock(followUpLockParams)}\n\n[LAST FRAME POSE/EXPRESSION TARGET]\n${lastPoseHint}`,
      });
    } catch (refErr) {
      // If Gemini blocks/empties due to the source frame reference, fall back to text-only pose.
      if (refErr.code === 'GENERATION_EMPTY' || refErr.code === 'SAFETY_BLOCKED') {
        logger.warn('Last frame generation blocked with source frame reference, retrying without it');
        last = await recreateFrame({
          frameBase64: lastFrameBase64,
          characterId,
          activeReferenceIds,
          apiKey,
          imageModel,
          overrideSceneData: lastFrameOverrideScene,
          referenceImages: [
            { mimeType: first.image.mimeType || 'image/png', base64Data: first.image.base64Data },
            ...referenceImages,
          ],
          extraLockText: `${buildFollowUpLockBlock({ ...followUpLockParams, withSourceRef: false })}\n\n[LAST FRAME POSE/EXPRESSION TARGET]\n${lastPoseHint}`,
        });
      } else {
        throw refErr;
      }
    }

    res.json({
      success: true,
      data: {
        reelUrl: cleanUrl || null,
        source: hasProvidedFrames ? 'cached-frames' : (uploadedVideo ? 'upload' : 'instagram'),
        sourceVideoName: uploadedVideo?.originalname || null,
        sourceVideoUrl: videoUrl,
        matchStrength: {
          pose: poseMatchStrength,
          environment: environmentMatchStrength,
        },
        options: {
          poseMatchEnabled,
          environmentMatchEnabled,
          useSourceFrameReference,
          outfitTransition,
        },
        lockedFormat: { resolutionTier: '2K', aspectRatio: '9:16' },
        frames: {
          first: { mimeType: firstFrameMimeType, base64Data: firstFrameBase64 },
          last: { mimeType: lastFrameMimeType, base64Data: lastFrameBase64 },
        },
        sourceAnalysis: {
          firstSourceScene,
          lastSourceScene: resolvedLastSourceScene,
          firstPoseHint,
          lastPoseHint,
        },
        recreations: { first, last },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Reel copy failed', 500, 'REEL_COPY_ERROR'));
  } finally {
    for (const filePath of [videoPath, firstPath, lastPath]) {
      if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch { /* cleanup best-effort */ }
      }
    }
  }
});

module.exports = router;
