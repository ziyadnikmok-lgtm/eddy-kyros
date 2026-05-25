const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('../middleware/errorHandler');
const apiKeyManager = require('./apiKeyManager');
const log = require('../utils/logger');

const BASE_URL = 'https://api.wavespeed.ai/api/v3';
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3_000;

/** Retry a fetch call on connection errors (timeout, ECONNREFUSED, etc.) */
async function _fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      const isLast = attempt === retries;
      if (isLast) throw err;
      const cause = err?.cause?.code || err?.cause?.message || err.message || '';
      log.warn('wavespeed_retry', { attempt: attempt + 1, cause: String(cause).slice(0, 200) });
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

const MODEL_ENDPOINTS = {
  'kling-v2.5-turbo-std': '/kwaivgi/kling-v2.5-turbo-std/image-to-video',
  'kling-v2.5-turbo-pro': '/kwaivgi/kling-v2.5-turbo-pro/image-to-video',
  'grok-imagine-video': '/x-ai/grok-imagine-video/image-to-video',
  'kling-v2.6-motion': '/kwaivgi/kling-v2.6-std/motion-control',
  'kling-v2.6-motion-pro': '/kwaivgi/kling-v2.6-pro/motion-control',
};

function getApiKey() {
  const key = apiKeyManager.getWavespeedKey();
  if (!key) throw new AppError('WaveSpeed API key not configured. Add it in API Keys.', 400, 'NO_WAVESPEED_KEY');
  return key;
}

async function uploadFile(filePath) {
  const key = getApiKey();
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const boundary = `----WaveBoundary${crypto.randomUUID().replace(/-/g, '')}`;

  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header), fileBuffer, Buffer.from(footer)]);

  const resp = await fetch(`${BASE_URL}/media/upload/binary`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new AppError(`WaveSpeed upload failed (${resp.status}): ${text.slice(0, 300)}`, 502, 'WAVESPEED_UPLOAD_ERROR');
  }

  const json = await resp.json();
  const url = json?.data?.download_url || json?.download_url;
  if (!url) throw new AppError('WaveSpeed upload returned no download URL', 502, 'WAVESPEED_UPLOAD_ERROR');
  return url;
}

async function uploadBase64(base64Data, mimeType = 'image/png') {
  const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? '.jpg' : mimeType.includes('webp') ? '.webp' : '.png';
  const tempPath = path.join(os.tmpdir(), `ws-upload-${crypto.randomUUID()}${ext}`);
  try {
    let raw = base64Data;
    const dataUriMatch = raw.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUriMatch) raw = dataUriMatch[1];
    fs.writeFileSync(tempPath, Buffer.from(raw, 'base64'));
    return await uploadFile(tempPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

async function createVideoTask(modelId, params) {
  const key = getApiKey();
  const endpoint = MODEL_ENDPOINTS[modelId];
  if (!endpoint) throw new AppError(`Unknown video model: ${modelId}`, 400, 'INVALID_MODEL');

  const resp = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new AppError(`WaveSpeed task creation failed (${resp.status}): ${text.slice(0, 300)}`, 502, 'WAVESPEED_TASK_ERROR');
  }

  const json = await resp.json();
  log.info('wavespeed_create_response', { model: modelId, response: JSON.stringify(json).slice(0, 1000) });

  const data = json?.data || json;
  const taskId = data?.id;
  if (!taskId) throw new AppError('WaveSpeed returned no task ID', 502, 'WAVESPEED_TASK_ERROR');

  log.info('wavespeed_task_created', { taskId, model: modelId, urls: data.urls });
  return { taskId, status: data.status || 'created' };
}

async function getTaskStatus(taskId) {
  const key = getApiKey();
  const resp = await fetch(`${BASE_URL}/predictions/${taskId}/result`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new AppError(`WaveSpeed status check failed (${resp.status}): ${text.slice(0, 200)}`, 502, 'WAVESPEED_STATUS_ERROR');
  }

  const json = await resp.json();
  const data = json?.data || json;
  return {
    status: data.status || 'unknown',
    outputs: data.outputs || [],
    timings: data.timings || null,
    error: data.error || null,
  };
}

// ── Image generation (z-image/turbo-lora) ─────────────────────
const IMAGE_MODEL_ID = 'wavespeed-ai/z-image/turbo-lora';
const IMAGE_POLL_INTERVAL_MS = 800;
const IMAGE_MAX_POLL_MS = 60_000;

const IMAGE_SIZE_MAP = {
  '1:1':  '1024*1024',
  '4:5':  '896*1120',
  '5:4':  '1120*896',
  '16:9': '1344*768',
  '9:16': '768*1344',
  '4:3':  '1152*864',
  '3:4':  '864*1152',
  '3:2':  '1216*832',
  '2:3':  '832*1216',
};

/**
 * Generate an image with WaveSpeed z-image/turbo-lora.
 * @param {string} prompt
 * @param {object} options
 * @param {string} [options.aspectRatio] e.g. '4:5'
 * @param {Array<{path:string, scale:number}>} [options.loras] up to 3
 * @param {number} [options.seed] -1 = random
 * @returns {{ image: { base64Data: string, mimeType: string }, modelUsed: string }}
 */
async function generateImage(prompt, options = {}) {
  const key = getApiKey();
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new AppError('A text prompt is required', 400, 'VALIDATION_ERROR');
  }

  const size = IMAGE_SIZE_MAP[options.aspectRatio] || IMAGE_SIZE_MAP['1:1'];
  const body = {
    prompt: prompt.trim(),
    size,
    seed: typeof options.seed === 'number' ? options.seed : -1,
    output_format: 'png',
    enable_sync_mode: true,
    enable_base64_output: true,
  };

  if (Array.isArray(options.loras) && options.loras.length > 0) {
    body.loras = options.loras.slice(0, 3).map((l) => ({
      path: l.path,
      scale: typeof l.scale === 'number' ? l.scale : 1.0,
    }));
  }

  log.info('wavespeed_image_request', { model: IMAGE_MODEL_ID, size, loraCount: body.loras?.length || 0 });

  let resp;
  try {
    resp = await _fetchWithRetry(`${BASE_URL}/${IMAGE_MODEL_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(IMAGE_MAX_POLL_MS + 10_000),
    });
  } catch (fetchErr) {
    const cause = fetchErr?.cause?.message || fetchErr?.cause?.code || fetchErr?.cause || 'unknown';
    log.error('wavespeed_fetch_failed', { message: fetchErr.message, cause: String(cause).slice(0, 500) });
    throw new AppError(`WaveSpeed connection failed: ${String(cause).slice(0, 200)}`, 502, 'WAVESPEED_ERROR');
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 401) throw new AppError('WaveSpeed auth failed', 401, 'INVALID_API_KEY');
    if (resp.status === 429) throw new AppError('WaveSpeed rate limited', 429, 'RATE_LIMITED');
    throw new AppError(`WaveSpeed image error (${resp.status}): ${text.slice(0, 300)}`, 502, 'WAVESPEED_ERROR');
  }

  const json = await resp.json();
  const data = json?.data || json;

  // Sync mode — completed immediately
  if (data?.status === 'completed') {
    return await _extractImageResult(data);
  }

  // Fall back to polling
  const taskId = data?.id;
  if (!taskId) throw new AppError('WaveSpeed returned no task ID', 502, 'WAVESPEED_ERROR');
  return await _pollImageResult(key, taskId);
}

async function _pollImageResult(key, taskId, modelId) {
  const deadline = Date.now() + IMAGE_MAX_POLL_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, IMAGE_POLL_INTERVAL_MS));
    const res = await getTaskStatus(taskId);
    if (res.status === 'completed') {
      return await _extractImageResult(res, modelId);
    }
    if (res.status === 'failed') {
      throw new AppError(`WaveSpeed image failed: ${res.error || 'unknown'}`, 502, 'WAVESPEED_FAILED');
    }
  }
  throw new AppError('WaveSpeed image generation timed out', 504, 'WAVESPEED_TIMEOUT');
}

async function _extractImageResult(data, modelId) {
  const usedModel = modelId || IMAGE_MODEL_ID;
  const outputs = data.outputs || data.output || [];
  log.info('wavespeed_image_extract', { outputCount: outputs.length, firstType: typeof outputs[0], firstPrefix: typeof outputs[0] === 'string' ? outputs[0].substring(0, 60) : 'N/A' });
  if (!outputs.length) throw new AppError('WaveSpeed returned no image', 502, 'WAVESPEED_EMPTY');

  const out = outputs[0];
  // data URI with base64
  const match = typeof out === 'string' && out.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return { image: { base64Data: match[2], mimeType: match[1] }, modelUsed: usedModel };
  }
  // raw base64 (no prefix)
  if (typeof out === 'string' && !out.startsWith('http')) {
    return { image: { base64Data: out, mimeType: 'image/png' }, modelUsed: usedModel };
  }
  // URL — download and convert
  return await _downloadImageAsBase64(out, usedModel);
}

async function _downloadImageAsBase64(url, modelId) {
  const sharp = require('sharp');
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new AppError(`Failed to download WaveSpeed image: ${resp.status}`, 502, 'WAVESPEED_DOWNLOAD');
  const buf = Buffer.from(await resp.arrayBuffer());
  const pngBuf = await sharp(buf).png({ compressionLevel: 6 }).toBuffer();
  return {
    image: { base64Data: pngBuf.toString('base64'), mimeType: 'image/png' },
    modelUsed: modelId || IMAGE_MODEL_ID,
  };
}

// ── SeedDream v4.5 edit-sequential ────────────────────────────
const SEEDDREAM_MODEL_ID = 'bytedance/seedream-v4.5/edit-sequential';
const SEEDDREAM_POLL_INTERVAL_MS = 1500;
const SEEDDREAM_MAX_POLL_MS = 180_000; // 3 min — sequential edit takes longer

/**
 * Edit 1–4 images with SeedDream v4.5, preserving character identity across all.
 * @param {Array<{base64: string, mimeType: string}>} imageInputs
 * @param {string} prompt  - editing instruction ("change outfit to red dress")
 * @param {object} opts
 * @param {number} [opts.seed]
 * @param {number} [opts.guidanceScale]
 * @param {string} [opts.aspectRatio]  e.g. '4:5'
 * @returns {{ images: Array<{base64Data: string, mimeType: string}>, modelUsed: string }}
 */
async function generateSeedDreamEdit(imageInputs, prompt, opts = {}) {
  if (!prompt?.trim()) throw new AppError('A prompt is required', 400, 'VALIDATION_ERROR');
  if (!Array.isArray(imageInputs) || imageInputs.length === 0) {
    throw new AppError('At least one source image is required', 400, 'VALIDATION_ERROR');
  }

  const sharp = require('sharp');
  const key = getApiKey();

  // Upload all images in parallel
  const uploadedUrls = await Promise.all(imageInputs.map(async ({ base64, mimeType }) => {
    let raw = base64;
    const m = raw.match(/^data:[^;]+;base64,(.+)$/);
    if (m) raw = m[1];
    const srcBuf = Buffer.from(raw, 'base64');
    const jpegBuf = await sharp(srcBuf).jpeg({ quality: 95 }).toBuffer();
    const tempPath = path.join(os.tmpdir(), `ws-sd-${crypto.randomUUID()}.jpg`);
    try {
      fs.writeFileSync(tempPath, jpegBuf);
      return await uploadFile(tempPath);
    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }));

  log.info('seeddream_edit_start', { imageCount: uploadedUrls.length, promptLen: prompt.length });

  const size = IMAGE_SIZE_MAP[opts.aspectRatio] || IMAGE_SIZE_MAP['1:1'];
  const body = {
    images: uploadedUrls,
    prompt: prompt.trim(),
    seed: typeof opts.seed === 'number' ? opts.seed : -1,
    guidance_scale: typeof opts.guidanceScale === 'number' ? opts.guidanceScale : 3.5,
    num_inference_steps: 28,
    size,
  };

  let resp;
  try {
    resp = await _fetchWithRetry(`${BASE_URL}/${SEEDDREAM_MODEL_ID}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (fetchErr) {
    const cause = fetchErr?.cause?.message || fetchErr?.cause?.code || fetchErr?.cause || 'unknown';
    log.error('seeddream_fetch_failed', { message: fetchErr.message, cause: String(cause).slice(0, 500) });
    throw new AppError(`SeedDream connection failed: ${String(cause).slice(0, 200)}`, 502, 'WAVESPEED_ERROR');
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    log.error('seeddream_api_error', { status: resp.status, body: text.slice(0, 500) });
    if (resp.status === 401) throw new AppError('WaveSpeed auth failed', 401, 'INVALID_API_KEY');
    if (resp.status === 429) throw new AppError('WaveSpeed rate limited', 429, 'RATE_LIMITED');
    throw new AppError(`SeedDream error (${resp.status}): ${text.slice(0, 300)}`, 502, 'WAVESPEED_ERROR');
  }

  const json = await resp.json();
  const data = json?.data || json;
  log.info('seeddream_task_created', { taskId: data?.id, status: data?.status });

  // Sync completed immediately
  if (data?.status === 'completed') {
    return await _extractSeedDreamResults(data);
  }

  const taskId = data?.id;
  if (!taskId) throw new AppError('SeedDream returned no task ID', 502, 'WAVESPEED_ERROR');

  // Poll until done
  return await _pollSeedDreamResult(key, taskId);
}

async function _pollSeedDreamResult(key, taskId) {
  const deadline = Date.now() + SEEDDREAM_MAX_POLL_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SEEDDREAM_POLL_INTERVAL_MS));
    const res = await getTaskStatus(taskId);
    if (res.status === 'completed') return await _extractSeedDreamResults(res);
    if (res.status === 'failed') {
      throw new AppError(`SeedDream edit failed: ${res.error || 'unknown'}`, 502, 'WAVESPEED_FAILED');
    }
  }
  throw new AppError('SeedDream edit timed out', 504, 'WAVESPEED_TIMEOUT');
}

async function _extractSeedDreamResults(data) {
  const outputs = data.outputs || data.output || [];
  if (!outputs.length) throw new AppError('SeedDream returned no images', 502, 'WAVESPEED_EMPTY');

  const images = await Promise.all(outputs.map(async (out) => {
    const match = typeof out === 'string' && out.match(/^data:([^;]+);base64,(.+)$/);
    if (match) return { base64Data: match[2], mimeType: match[1] };
    if (typeof out === 'string' && !out.startsWith('http')) return { base64Data: out, mimeType: 'image/png' };
    // URL — download
    const { image } = await _downloadImageAsBase64(out, SEEDDREAM_MODEL_ID);
    return image;
  }));

  return { images, modelUsed: SEEDDREAM_MODEL_ID };
}

// ── Img2Img generation (z-image-turbo/image-to-image-lora) ────
const IMG2IMG_MODEL_ID = 'wavespeed-ai/z-image-turbo/image-to-image-lora';

/**
 * Generate a variation using img2img with LoRA.
 * @param {string} imageBase64 - Source image base64 (no data: prefix)
 * @param {string} mimeType - Source image mime type
 * @param {string} prompt - Text guidance for the variation
 * @param {object} options
 * @param {string} [options.aspectRatio] e.g. '4:5'
 * @param {number} [options.strength] 0.0-1.0 (default 0.6)
 * @param {Array<{path:string, scale:number}>} [options.loras] up to 3
 * @returns {{ image: { base64Data: string, mimeType: string }, modelUsed: string }}
 */
async function generateImg2Img(imageBase64, mimeType, prompt, options = {}) {
  const key = getApiKey();
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new AppError('A text prompt is required', 400, 'VALIDATION_ERROR');
  }
  if (!imageBase64) {
    throw new AppError('A source image is required', 400, 'VALIDATION_ERROR');
  }

  // Compress source image then upload to get a URL (inline base64 too large for JSON body)
  const sharp = require('sharp');
  let raw = imageBase64;
  const dataUriMatch = raw.match(/^data:[^;]+;base64,(.+)$/);
  if (dataUriMatch) raw = dataUriMatch[1];

  const srcBuf = Buffer.from(raw, 'base64');
  const jpegBuf = await sharp(srcBuf).jpeg({ quality: 95 }).toBuffer();

  log.info('wavespeed_img2img_start', {
    originalKB: Math.round(srcBuf.length / 1024),
    compressedKB: Math.round(jpegBuf.length / 1024),
  });

  // Write compressed JPEG to temp file and upload
  const tempPath = path.join(os.tmpdir(), `ws-img2img-${crypto.randomUUID()}.jpg`);
  let imageUrl;
  try {
    fs.writeFileSync(tempPath, jpegBuf);
    imageUrl = await uploadFile(tempPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }

  log.info('wavespeed_img2img_uploaded', { imageUrl: imageUrl.slice(0, 80) });

  const size = IMAGE_SIZE_MAP[options.aspectRatio] || IMAGE_SIZE_MAP['1:1'];
  const body = {
    image: imageUrl,
    prompt: prompt.trim(),
    size,
    strength: typeof options.strength === 'number' ? options.strength : 0.6,
    seed: typeof options.seed === 'number' ? options.seed : -1,
    output_format: 'png',
    enable_sync_mode: true,
    enable_base64_output: true,
  };

  if (Array.isArray(options.loras) && options.loras.length > 0) {
    body.loras = options.loras.slice(0, 3).map((l) => ({
      path: l.path,
      scale: typeof l.scale === 'number' ? l.scale : 1.0,
    }));
  }

  log.info('wavespeed_img2img_request', { model: IMG2IMG_MODEL_ID, size, strength: body.strength, loraCount: body.loras?.length || 0 });

  let resp;
  try {
    resp = await _fetchWithRetry(`${BASE_URL}/${IMG2IMG_MODEL_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(IMAGE_MAX_POLL_MS + 30_000),
    });
  } catch (fetchErr) {
    const cause = fetchErr?.cause?.message || fetchErr?.cause?.code || fetchErr?.cause || 'unknown';
    log.error('wavespeed_img2img_fetch_failed', { message: fetchErr.message, cause: String(cause).slice(0, 500) });
    throw new AppError(`WaveSpeed img2img connection failed: ${String(cause).slice(0, 200)}`, 502, 'WAVESPEED_ERROR');
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    log.error('wavespeed_img2img_error', { status: resp.status, body: text.slice(0, 500) });
    if (resp.status === 401) throw new AppError('WaveSpeed auth failed', 401, 'INVALID_API_KEY');
    if (resp.status === 429) throw new AppError('WaveSpeed rate limited', 429, 'RATE_LIMITED');
    throw new AppError(`WaveSpeed img2img error (${resp.status}): ${text.slice(0, 300)}`, 502, 'WAVESPEED_ERROR');
  }

  const json = await resp.json();
  const data = json?.data || json;

  if (data?.status === 'completed') {
    return await _extractImageResult(data, IMG2IMG_MODEL_ID);
  }

  const taskId = data?.id;
  if (!taskId) throw new AppError('WaveSpeed returned no task ID', 502, 'WAVESPEED_ERROR');
  return await _pollImageResult(key, taskId, IMG2IMG_MODEL_ID);
}

async function downloadVideo(videoUrl, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const filename = `video-${crypto.randomUUID()}.mp4`;
  const destPath = path.join(destDir, filename);

  const resp = await fetch(videoUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok || !resp.body) {
    throw new AppError(`Failed to download video (${resp.status})`, 502, 'VIDEO_DOWNLOAD_ERROR');
  }

  await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(destPath));

  log.info('video_downloaded', { filename, bytes: fs.statSync(destPath).size });
  return { filename, filePath: destPath };
}

module.exports = {
  uploadFile,
  uploadBase64,
  createVideoTask,
  getTaskStatus,
  downloadVideo,
  generateImage,
  generateImg2Img,
  generateSeedDreamEdit,
  MODEL_ENDPOINTS,
  IMAGE_MODEL_ID,
  IMG2IMG_MODEL_ID,
  SEEDDREAM_MODEL_ID,
};
