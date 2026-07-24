const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { GoogleGenAI, GenerateVideosOperation } = require('@google/genai');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');

const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const CLIENT_CACHE_MAX = 5;

const _clientCache = new Map();

function getClient(apiKey) {
  let client = _clientCache.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    if (_clientCache.size >= CLIENT_CACHE_MAX) {
      const oldest = _clientCache.keys().next().value;
      _clientCache.delete(oldest);
    }
    _clientCache.set(apiKey, client);
  }
  return client;
}

function toImagePart(base64Data, mimeType) {
  if (!base64Data) return null;
  return {
    imageBytes: base64Data,
    mimeType: mimeType || 'image/png',
  };
}

function normalizeVideoError(err) {
  const message = err?.message || 'Unknown Veo error';
  if (message.includes('API_KEY_INVALID') || message.includes('401')) {
    throw new AppError('Invalid Gemini API key.', 401, 'INVALID_API_KEY');
  }
  if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
    throw new AppError('Veo rate limit reached. Wait and try again.', 429, 'RATE_LIMITED');
  }
  if (message.includes('FAILED_PRECONDITION')) {
    throw new AppError(`Veo request blocked: ${message}`, 400, 'VEO_PRECONDITION');
  }
  throw new AppError(`Veo error: ${message}`, 502, 'VEO_ERROR');
}

function buildVideoConfig(params, includeAudio = true) {
  return {
    ...(params.durationSeconds ? { durationSeconds: params.durationSeconds } : {}),
    ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
    ...(params.resolution ? { resolution: params.resolution } : {}),
    ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
    ...(includeAudio && typeof params.generateAudio === 'boolean' ? { generateAudio: params.generateAudio } : {}),
    ...(params.lastImageBase64
      ? { lastFrame: toImagePart(params.lastImageBase64, params.lastImageMimeType) }
      : {}),
  };
}

function isUnsupportedAudioParamError(err) {
  const message = String(err?.message || '').toLowerCase();
  return message.includes('generateaudio') && message.includes('not supported');
}

async function createVideoOperation(apiKey, params) {
  try {
    const client = getClient(apiKey);
    let operation;
    try {
      operation = await client.models.generateVideos({
        model: params.model,
        prompt: params.prompt || undefined,
        image: toImagePart(params.imageBase64, params.imageMimeType),
        config: buildVideoConfig(params, true),
      });
    } catch (err) {
      if (!isUnsupportedAudioParamError(err) || typeof params.generateAudio !== 'boolean') {
        throw err;
      }
      log.warn('veo_generate_audio_unsupported_retrying_without_audio', { model: params.model });
      operation = await client.models.generateVideos({
        model: params.model,
        prompt: params.prompt || undefined,
        image: toImagePart(params.imageBase64, params.imageMimeType),
        config: buildVideoConfig(params, false),
      });
    }

    if (!operation?.name) {
      throw new AppError('Veo did not return an operation name', 502, 'VEO_EMPTY');
    }

    return {
      operationName: operation.name,
      done: !!operation.done,
      response: operation.response || null,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    normalizeVideoError(err);
  }
}

async function getVideoOperation(apiKey, operationName) {
  try {
    const client = getClient(apiKey);
    const operationRef = new GenerateVideosOperation();
    operationRef.name = operationName;
    let operation = await client.operations.getVideosOperation({
      operation: operationRef,
    });
    if (!operation?.done) {
      return {
        done: false,
        operation,
      };
    }
    if (operation.error) {
      throw new AppError(
        operation.error.message || operation.error.code || 'Veo video generation failed',
        502,
        'VEO_FAILED'
      );
    }

    return {
      done: !!operation?.done,
      operation,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    normalizeVideoError(err);
  }
}

async function downloadVideo(apiKey, videoUri, destDir) {
  if (!videoUri) {
    throw new AppError('No Veo download URI returned', 502, 'VEO_EMPTY');
  }

  fs.mkdirSync(destDir, { recursive: true });
  const filename = `veo-${crypto.randomUUID()}.mp4`;
  const filePath = path.join(destDir, filename);

  const resp = await fetch(videoUri, {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new AppError(`Failed to download Veo video (${resp.status}): ${text.slice(0, 200)}`, 502, 'VEO_DOWNLOAD_ERROR');
  }

  await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(filePath));
  return { filename, filePath };
}

module.exports = {
  createVideoOperation,
  getVideoOperation,
  downloadVideo,
};
