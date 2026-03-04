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
  MODEL_ENDPOINTS,
};
