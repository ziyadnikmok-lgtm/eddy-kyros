const express = require('express');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiBackend');
const sceneAnalyzer = require('../services/sceneAnalyzer');
const referenceManager = require('../services/referenceManager');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const { resolveDimensions } = require('../services/dimensionResolver');
const { buildCharacterReferenceImages } = require('./postClone');
const { AppError } = require('../middleware/errorHandler');
const { requirePlanCapacity } = require('../middleware/planLimits');
const REALISM_DIRECTIVE = require('../utils/realismDirective');
const ffmpegPath = require('../utils/ffmpeg');

const router = express.Router();
const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const KLICKPIN_BASE = 'https://klickpin.com';
const RESOLVER_BASE = 'https://resolve-b0d2aeb0b598.vasinvictory3.workers.dev';
const PROXY_HOST = 'kpxy-dl.vasinvictory3.workers.dev';

/** Build a fresh axios instance with its own cookie jar for each request. */
function makeSession() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));
  return client;
}

/** Infer a quality label from a URL (e.g. "736x", "originals", "1200x"). */
function qualityLabel(url) {
  const m = url.match(/\/([0-9]+x[0-9]*|originals)\//i);
  if (m) return m[1];
  if (url.includes('originals')) return 'original';
  if (url.includes(PROXY_HOST)) return 'proxy';
  return '';
}

/** Extract all usable media URLs from the klickpin result HTML. */
function parseMedia(html) {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim() || '';

  const variants = [];
  const seen = new Set();

  function addVariant(url, label, quality) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    variants.push({ url, label: label || '', quality: quality || qualityLabel(url) });
  }

  // --- video: <video src>, <source src>, .mp4 links ---
  $('video[src]').each((_, el) => {
    addVariant($(el).attr('src'), 'video', 'mp4');
  });
  $('video source[src]').each((_, el) => {
    addVariant($(el).attr('src'), 'video', 'mp4');
  });

  // --- anchor download links ---
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('pinimg.com') && !href.includes(PROXY_HOST)) return;
    const txt = $(el).text().trim();
    addVariant(href, txt || 'download', qualityLabel(href));
  });

  // --- img tags with pinimg.com src inside result containers ---
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src.includes('pinimg.com')) return;
    addVariant(src, 'image', qualityLabel(src));
  });

  if (!variants.length) return null;

  // Determine type: if any variant is .mp4 or from a video tag, it's video
  const hasVideo = variants.some(
    (v) => v.url.endsWith('.mp4') || v.label === 'video' || v.url.includes('.mp4')
  );
  const type = hasVideo ? 'video' : 'image';

  // Pick best URL:
  // video: prefer .mp4 proxy link
  // image: prefer highest-res pinimg.com (originals > 736x > others)
  let best;
  if (hasVideo) {
    best =
      variants.find((v) => v.url.includes(PROXY_HOST) && v.url.includes('.mp4')) ||
      variants.find((v) => v.url.includes('.mp4')) ||
      variants[0];
  } else {
    best =
      variants.find((v) => v.url.includes('originals')) ||
      variants.find((v) => /\/736x\//.test(v.url)) ||
      variants.find((v) => v.url.includes('pinimg.com')) ||
      variants[0];
  }

  return { type, url: best.url, variants, title };
}

async function downloadVideoToTemp(videoUrl) {
  const filePath = path.join(os.tmpdir(), `pinterest-video-${crypto.randomUUID()}.mp4`);
  const response = await axios.get(videoUrl, {
    responseType: 'stream',
    timeout: 60_000,
    headers: { 'User-Agent': UA, Referer: 'https://www.pinterest.com/' },
  });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });
  return filePath;
}

async function extractFirstFrameFromVideo(videoPath) {
  const framePath = path.join(os.tmpdir(), `pinterest-first-frame-${crypto.randomUUID()}.jpg`);
  try {
    await execFileAsync(ffmpegPath, ['-y', '-i', videoPath, '-frames:v', '1', framePath], {
      timeout: 30_000,
    });
    const buffer = fs.readFileSync(framePath);
    if (!buffer.length) {
      throw new AppError('Failed to extract first frame from video', 500, 'FRAME_EXTRACTION_EMPTY');
    }
    return { mimeType: 'image/jpeg', base64Data: buffer.toString('base64') };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      `Video frame extraction failed. Ensure ffmpeg is installed and in PATH. ${err.message}`,
      500,
      'FFMPEG_ERROR'
    );
  } finally {
    try { fs.unlinkSync(framePath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// POST / — fetch media info for a Pinterest URL
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    const session = makeSession();

    // Step 1: get CSRF token
    const csrfRes = await session.get(
      `${KLICKPIN_BASE}/get-csrf-token.php?t=${Date.now()}`,
      {
        headers: { 'User-Agent': UA, Referer: KLICKPIN_BASE },
        timeout: 15000,
      }
    );
    const csrfData = typeof csrfRes.data === 'string'
      ? JSON.parse(csrfRes.data)
      : csrfRes.data;
    const csrf_token = csrfData.csrf_token || csrfData.token || '';
    if (!csrf_token) throw new Error('Failed to obtain CSRF token from klickpin');

    // Step 2: resolve short URL if needed
    let resolvedUrl = url;
    if (url.startsWith('https://pin.it') || url.startsWith('http://pin.it')) {
      const resolveRes = await axios.get(
        `${RESOLVER_BASE}/?url=${encodeURIComponent(url)}`,
        { timeout: 10000 }
      );
      const body = typeof resolveRes.data === 'string'
        ? JSON.parse(resolveRes.data)
        : resolveRes.data;
      resolvedUrl = body.finalUrl || body.url || url;
    }

    // Step 3: POST to klickpin download endpoint
    const formBody = `url=${encodeURIComponent(resolvedUrl)}&csrf_token=${encodeURIComponent(csrf_token)}`;
    const dlRes = await session.post(
      `${KLICKPIN_BASE}/download`,
      formBody,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
          Referer: `${KLICKPIN_BASE}/`,
          Origin: KLICKPIN_BASE,
        },
        timeout: 20000,
      }
    );

    // Step 4: parse returned HTML
    const html = typeof dlRes.data === 'string' ? dlRes.data : JSON.stringify(dlRes.data);
    const result = parseMedia(html);

    if (!result) {
      return res.status(422).json({
        error: 'No downloadable media found in klickpin response. The pin may be unavailable or unsupported.',
      });
    }

    return res.json(result);
  } catch (err) {
    const msg = err?.response?.data
      ? `klickpin error: ${JSON.stringify(err.response.data).slice(0, 200)}`
      : err.message;
    return res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /proxy — stream a remote media file to the client as a download
// ---------------------------------------------------------------------------
router.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url query param is required' });
  }

  // Safety: only proxy known trusted hosts
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  const allowed = ['pinimg.com', PROXY_HOST, 'pinterest.com'];
  const isAllowed = allowed.some((h) => parsed.hostname.endsWith(h));
  if (!isAllowed) {
    return res.status(403).json({ error: 'Proxy only allowed for Pinterest/klickpin media URLs' });
  }

  try {
    const upstream = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000,
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.pinterest.com/',
      },
    });

    const contentType = upstream.headers['content-type'] || 'application/octet-stream';
    const filename = path.basename(parsed.pathname) || 'download';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }

    upstream.data.pipe(res);

    upstream.data.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.destroy();
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ---------------------------------------------------------------------------
// POST /analyze — analyze a Pinterest image with Gemini scene understanding
// ---------------------------------------------------------------------------
router.post('/analyze', async (req, res, next) => {
  try {
    const { image, mimeType } = req.body;

    if (!image || typeof image !== 'string') {
      throw new AppError('"image" base64 string is required', 400, 'VALIDATION_ERROR');
    }
    if (!mimeType || typeof mimeType !== 'string') {
      throw new AppError('"mimeType" is required', 400, 'VALIDATION_ERROR');
    }

    const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
    if (!ALLOWED_MIME.includes(mimeType)) {
      throw new AppError('mimeType must be image/png, image/jpeg, or image/webp', 400, 'VALIDATION_ERROR');
    }
    if (image.length > 15_000_000) {
      throw new AppError('Image data too large (max ~10MB)', 413, 'PAYLOAD_TOO_LARGE');
    }

    let base64 = image;
    const dataUriMatch = image.match(/^data:image\/\w+;base64,(.+)$/);
    if (dataUriMatch) base64 = dataUriMatch[1];

    const sceneData = await sceneAnalyzer.analyzeScene(base64, mimeType);

    res.json({ success: true, data: sceneData });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /recreate — recreate a Pinterest image with a character identity
// ---------------------------------------------------------------------------
router.post('/recreate', requirePlanCapacity(), async (req, res, next) => {
  try {
    const { sceneData, characterId, activeReferenceIds, imageModel, sameBackground, samePose } = req.body;
    const { aspectRatio, resolutionTier, width, height } = resolveDimensions(req.body);

    if (!sceneData || typeof sceneData !== 'object') {
      throw new AppError('"sceneData" object is required', 400, 'VALIDATION_ERROR');
    }
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
    }

    const recreationPrompt = sceneAnalyzer.buildRecreationPrompt({
      sceneData,
      characterId,
      activeReferenceIds,
      sameBackground: !!sameBackground,
      samePose: !!samePose,
    });

    const apiKey = apiKeyManager.getActiveKey();
    const activeRefs = referenceManager.getActiveReferences(
      characterId,
      Array.isArray(activeReferenceIds) ? activeReferenceIds : null
    );
    const referenceImages = buildCharacterReferenceImages(characterId, activeRefs);

    const finalPrompt = `${recreationPrompt}\n\n${REALISM_DIRECTIVE}`;
    const result = await geminiService.generateImage(apiKey, finalPrompt, {
      aspectRatio,
      imageSize: resolutionTier,
      referenceImages,
      model: imageModel,
    });

    const stored = imageStore.store({
      basePrompt: recreationPrompt,
      characterId,
      activeReferenceIds: activeReferenceIds || null,
      sceneDescription: JSON.stringify(sceneData),
      modelUsed: result.modelUsed || null,
      seed: null,
      parentImageId: null,
      variationIndex: null,
      image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
      source: 'pinterest-recreate',
    });

    galleryManager.save({
      base64Data: result.image.base64Data,
      mimeType: result.image.mimeType,
      prompt: 'Pinterest recreation',
      source: 'pinterest-recreate',
      characterId,
      aspectRatio: aspectRatio || null,
    });

    res.json({
      success: true,
      data: {
        imageId: stored.imageId,
        image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
        text: result.text,
        dimensions: { aspectRatio, resolutionTier, width, height },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /recreate-video-frame — extract the first frame from a Pinterest video
// and recreate it with the selected character
// ---------------------------------------------------------------------------
router.post('/recreate-video-frame', requirePlanCapacity(), async (req, res, next) => {
  let videoPath = null;
  try {
    const { videoUrl, characterId, activeReferenceIds, imageModel } = req.body || {};

    if (!videoUrl || typeof videoUrl !== 'string') {
      throw new AppError('"videoUrl" is required', 400, 'VALIDATION_ERROR');
    }
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
    }

    videoPath = await downloadVideoToTemp(videoUrl);
    const sourceFrame = await extractFirstFrameFromVideo(videoPath);
    const sceneData = await sceneAnalyzer.analyzeScene(sourceFrame.base64Data, sourceFrame.mimeType);

    const recreationPrompt = sceneAnalyzer.buildRecreationPrompt({
      sceneData,
      characterId,
      activeReferenceIds,
      sameBackground: true,
      samePose: true,
    });

    const apiKey = apiKeyManager.getActiveKey();
    const activeRefs = referenceManager.getActiveReferences(
      characterId,
      Array.isArray(activeReferenceIds) ? activeReferenceIds : null
    );
    const referenceImages = buildCharacterReferenceImages(characterId, activeRefs);

    const aspectRatio = '9:16';
    const resolutionTier = '2K';
    const { width, height } = resolveDimensions({ aspectRatio, resolutionTier });
    const finalPrompt = `${recreationPrompt}\n\n${REALISM_DIRECTIVE}`;
    const result = await geminiService.generateImage(apiKey, finalPrompt, {
      aspectRatio,
      imageSize: resolutionTier,
      referenceImages,
      model: imageModel,
    });

    const stored = imageStore.store({
      basePrompt: recreationPrompt,
      characterId,
      activeReferenceIds: activeReferenceIds || null,
      sceneDescription: JSON.stringify(sceneData),
      modelUsed: result.modelUsed || null,
      seed: null,
      parentImageId: null,
      variationIndex: null,
      image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
      source: 'pinterest-recreate',
    });

    galleryManager.save({
      base64Data: result.image.base64Data,
      mimeType: result.image.mimeType,
      prompt: 'Pinterest video first-frame recreation',
      source: 'pinterest-recreate',
      characterId,
      aspectRatio,
    });

    res.json({
      success: true,
      data: {
        imageId: stored.imageId,
        image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
        sourceFrame,
        sceneData,
        text: result.text,
        dimensions: { aspectRatio, resolutionTier, width, height },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  } finally {
    if (videoPath) {
      try { fs.unlinkSync(videoPath); } catch {}
    }
  }
});


// ---------------------------------------------------------------------------
// POST /analyze-video — upload a Pinterest video to Gemini, get Kling 2.6 prompt
// ---------------------------------------------------------------------------
router.post('/analyze-video', async (req, res, next) => {
  const { GoogleGenAI, Modality } = require('@google/genai');

  const { url: videoUrl } = req.body || {};
  if (!videoUrl || typeof videoUrl !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  const apiKey = apiKeyManager.getActiveKey();
  if (!apiKey) {
    return res.status(500).json({ error: 'No active Gemini API key' });
  }

  const tmpFile = path.join(os.tmpdir(), `pin-video-${Date.now()}.mp4`);
  let uploadedFileName = null;

  try {
    // Step 1: stream download the video to a temp file
    const videoRes = await axios.get(videoUrl, {
      responseType: 'stream',
      timeout: 60000,
      headers: { 'User-Agent': UA, Referer: 'https://www.pinterest.com/' },
    });
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(tmpFile);
      videoRes.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
      videoRes.data.on('error', reject);
    });

    // Step 2: upload to Gemini File API
    const genAI = new GoogleGenAI({ apiKey });
    const uploadResp = await genAI.files.upload({
      file: tmpFile,
      config: { mimeType: 'video/mp4' },
    });
    uploadedFileName = uploadResp.name;

    // Step 3: poll until ACTIVE (max 2 minutes)
    let fileInfo = uploadResp;
    const deadline = Date.now() + 120_000;
    while (fileInfo.state !== 'ACTIVE') {
      if (Date.now() > deadline) throw new Error('Gemini file processing timed out');
      if (fileInfo.state === 'FAILED') throw new Error('Gemini file processing failed');
      await new Promise((r) => setTimeout(r, 3000));
      fileInfo = await genAI.files.get({ name: uploadedFileName });
    }

    // Step 4: send to Gemini with Kling 2.6 system prompt
    const KLING_SYSTEM_PROMPT =
      "You are a Kling 2.6 AI video generation expert. Analyze this video and write a single consecutive Kling 2.6 generation prompt. Rules: refer to the person only as 'her' or 'she' \u2014 never describe any physical characteristics, face, body, skin, hair, or appearance. Focus entirely on: the movement and action happening, her facial expression and emotion, camera movement and angles, shot composition, lighting mood, pacing and transitions, and the overall scene atmosphere. Output ONE single consecutive prompt paragraph with no headers, no bullet points, no line breaks \u2014 just one flowing expert Kling 2.6 prompt ready to paste and use.";

    const response = await genAI.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { mimeType: 'video/mp4', fileUri: fileInfo.uri } },
            { text: KLING_SYSTEM_PROMPT },
          ],
        },
      ],
      config: { responseModalities: [Modality.TEXT] },
    });

    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      throw new Error('No response from Gemini');
    }
    const promptText = parts.filter((p) => p.text).map((p) => p.text).join('').trim();
    if (!promptText) throw new Error('Gemini returned empty response');

    return res.json({ prompt: promptText });
  } catch (err) {
    next(err);
  } finally {
    // Clean up temp file
    try { require('node:fs').unlinkSync(tmpFile); } catch { /* ignore */ }
  }
});
module.exports = router;
