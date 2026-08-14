const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const ffmpegPath = require('../utils/ffmpeg');
const { AppError } = require('../middleware/errorHandler');
const apiKeyManager = require('./apiKeyManager');
const log = require('../utils/logger');

const BASE_URL = 'https://api.muapi.ai/api/v1';
const REQUEST_TIMEOUT_MS = 30_000;
// Omni reference clips are tens of megabytes and this is a single multipart POST, so the
// ceiling has to cover the whole transfer on a slow uplink. 60s aborted a real upload that
// succeeded in 6s on retry — the same file, just a worse minute on the line.
const UPLOAD_TIMEOUT_MS = 300_000;

const MODEL_SLUGS = {
  'seedance-2-fast': 'seedance-2-image-to-video-fast',
  'seedance-2-vip': 'seedance-2-vip-image-to-video-fast',
};

// Ground truth from Muapi's own OpenAPI spec (Seedance2PiapiI2VRequest schema) — not guessed.
const ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const DURATION_MIN = 4;
const DURATION_MAX = 15;

function getApiKey() {
  const key = apiKeyManager.getMuapiKey();
  if (!key) throw new AppError('Muapi API key not configured. Add it in API Keys.', 400, 'NO_MUAPI_KEY');
  return key;
}

/**
 * Muapi error bodies come in two shapes:
 *  - {"detail": "some string"} or {"error": {"message": "..."}}
 *  - FastAPI-style validation errors: {"detail": [{"loc":[...], "msg":"...", "type":"..."}]}
 */
function extractErrorMessage(text) {
  try {
    const json = JSON.parse(text);
    if (json?.error?.message) return json.error.message;
    if (Array.isArray(json?.detail)) {
      return json.detail.map((d) => d?.msg || JSON.stringify(d)).join('; ');
    }
    if (typeof json?.detail === 'string') return json.detail;
    return text;
  } catch {
    return text;
  }
}

/** images_list must be a real hosted URL (max 2083 chars) — Muapi's own /upload_file hosts it. No other API key needed. */
async function uploadFile(filePath) {
  const key = getApiKey();
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const boundary = `----MuapiBoundary${crypto.randomUUID().replace(/-/g, '')}`;

  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header), fileBuffer, Buffer.from(footer)]);

  const sizeMb = (body.length / 1024 / 1024).toFixed(1);
  // This upload is FREE — nothing is billed until createVideoTask posts the job below — so a
  // transient network blip is worth retrying instead of killing a generation the user is waiting on.
  // Seen in the wild as two 502 "fetch failed" seconds apart while api.muapi.ai was perfectly
  // healthy: a connection dropped mid-upload, not an outage. Retry ONLY network errors — a real
  // timeout keeps its own path (silently retrying a 300s upload would triple the wait), and the HTTP
  // responses handled below (402 credits, other 4xx) are deterministic and must never be retried.
  const MAX_UPLOAD_ATTEMPTS = 3;
  let resp;
  for (let attempt = 1; ; attempt += 1) {
    try {
      resp = await fetch(`${BASE_URL}/upload_file`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        // Re-created per attempt: an AbortSignal that has already fired cannot be reused.
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      break;
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        log.warn('muapi_upload_timeout', { fileName, sizeMb, limitMs: UPLOAD_TIMEOUT_MS });
        throw new AppError(
          `Upload timed out sending ${sizeMb} MB to Muapi after ${UPLOAD_TIMEOUT_MS / 1000}s. Nothing was charged — retry, or use a shorter clip.`,
          504,
          'UPLOAD_TIMEOUT',
        );
      }
      // undici reports EVERY network failure as the bare string "fetch failed"; the actual reason
      // (ECONNRESET / ENOTFOUND / ETIMEDOUT / cert error) hangs off .cause. Without unwrapping it the
      // log says nothing useful — which is exactly why the first occurrence was undiagnosable.
      const reason = err?.cause?.code || err?.cause?.message || err?.message || 'connection error';
      if (attempt >= MAX_UPLOAD_ATTEMPTS) {
        log.warn('muapi_upload_failed', { fileName, sizeMb, reason, attempts: attempt });
        throw new AppError(
          `Upload failed after ${attempt} attempts: ${reason}. Nothing was charged — retry.`,
          502,
          'UPLOAD_ERROR',
        );
      }
      log.warn('muapi_upload_retry', { fileName, sizeMb, reason, attempt });
      await new Promise((r) => setTimeout(r, 1000 * attempt)); // 1s, then 2s
    }
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const message = extractErrorMessage(text);
    if (resp.status === 402) throw new AppError(`Muapi upload: ${message} — top up at https://muapi.ai/topup`, 402, 'INSUFFICIENT_CREDITS');
    throw new AppError(`Muapi upload failed (${resp.status}): ${String(message).slice(0, 300)}`, 502, 'MUAPI_UPLOAD_ERROR');
  }

  const json = await resp.json();
  const url = json?.url || json?.data?.url;
  if (!url) throw new AppError('Muapi upload returned no URL', 502, 'MUAPI_UPLOAD_ERROR');
  return url;
}

/** Extension must match the real media type — Muapi rejects/misreads an mp4 named .png. */
function extForMime(mimeType = 'image/png') {
  const m = String(mimeType).toLowerCase();
  if (m.includes('mp4')) return '.mp4';
  if (m.includes('quicktime') || m.includes('mov')) return '.mov';
  if (m.includes('webm')) return '.webm';
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('wav')) return '.wav';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  return '.png';
}

// Drop the audio track before upload. Omni recreates the source clip's soundtrack and that
// generated audio hits moderation ("generated audio did not pass review"), failing the whole
// job. No video track is touched — video is copied, audio is removed (-an). Best-effort: on any
// ffmpeg error, fall back to the original bytes so a generation never dies over a preview detail.
function stripAudio(inputBuf) {
  return new Promise((resolve) => {
    const inPath = path.join(os.tmpdir(), `muapi-src-${crypto.randomUUID()}.mp4`);
    const outPath = path.join(os.tmpdir(), `muapi-noaudio-${crypto.randomUUID()}.mp4`);
    try { fs.writeFileSync(inPath, inputBuf); } catch { resolve(inputBuf); return; }
    execFile(ffmpegPath, ['-y', '-i', inPath, '-c:v', 'copy', '-an', outPath], { timeout: 120_000 }, (err) => {
      let out = inputBuf;
      if (!err) { try { out = fs.readFileSync(outPath); } catch { /* keep original */ } }
      else log.warn('omni_strip_audio_failed', { error: err.message });
      try { fs.unlinkSync(inPath); } catch { /* best-effort */ }
      try { fs.unlinkSync(outPath); } catch { /* best-effort */ }
      resolve(out);
    });
  });
}

async function _bufToTemp(buf, ext) {
  const tempPath = path.join(os.tmpdir(), `muapi-upload-${crypto.randomUUID()}${ext}`);
  fs.writeFileSync(tempPath, buf);
  return tempPath;
}

async function uploadBase64(base64Data, mimeType = 'image/png') {
  const ext = extForMime(mimeType);
  const tempPath = path.join(os.tmpdir(), `muapi-upload-${crypto.randomUUID()}${ext}`);
  try {
    let raw = base64Data;
    const dataUriMatch = raw.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUriMatch) raw = dataUriMatch[1];
    fs.writeFileSync(tempPath, Buffer.from(raw, 'base64'));
    return await uploadFile(tempPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* temp file cleanup is best-effort */ }
  }
}

/**
 * `images` — one or more source images, in order. images_list is an ARRAY in Muapi's schema and the
 * first entry is the frame the video starts from; any further entries ride along as additional
 * reference. Previously this only ever sent one because the route only ever offered one.
 *
 * `imageBase64` is still accepted as the single-image form so every existing caller keeps working.
 *
 * If Muapi rejects more than one for this model it does so on THIS request — before a task exists —
 * so a refusal costs nothing and surfaces as a plain error rather than a silent charge.
 */
async function createVideoTask(modelId, { images, imageBase64, imageMimeType, prompt, aspectRatio, duration }) {
  const key = getApiKey();
  const slug = MODEL_SLUGS[modelId];
  if (!slug) throw new AppError(`Unknown Muapi video model: ${modelId}`, 400, 'INVALID_MODEL');

  const list = Array.isArray(images) && images.length
    ? images
    : (imageBase64 ? [{ base64: imageBase64, mimeType: imageMimeType }] : []);
  if (!list.length) throw new AppError('A source image is required', 400, 'VALIDATION_ERROR');

  const imageUrls = [];
  for (const img of list) {
    if (!img?.base64) continue;
    imageUrls.push(await uploadBase64(img.base64, img.mimeType || 'image/png'));
  }
  if (!imageUrls.length) throw new AppError('A source image is required', 400, 'VALIDATION_ERROR');

  const ratio = ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '16:9';
  const dur = Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(Number(duration)) || 5));

  const body = {
    prompt: prompt || '',
    images_list: imageUrls,
    aspect_ratio: ratio,
    duration: dur,
  };

  // Log the exact outgoing payload (prompt included) so we can verify what Muapi actually receives.
  log.info('muapi_request_payload', { model: modelId, promptLen: (prompt || '').length, prompt: (prompt || '').slice(0, 300), aspect_ratio: ratio, duration: dur, imageCount: imageUrls.length, imageUrl: imageUrls[0].slice(0, 80) });

  // A bare 5xx here is MUAPI'S OWN SERVER failing, not a problem with this request — seen in the wild
  // as one "500: Internal Server Error" among a run of otherwise-identical requests (same model, same
  // payload shape) that succeeded seconds before and after it. Nothing is billed until the response
  // below actually carries a request_id, so a retry costs nothing extra on a false start. 4xx codes
  // (auth, credits, not-found, rate-limit) are deterministic and are handled immediately below without
  // ever reaching a second attempt — retrying those would just fail the same way again.
  const MAX_TASK_ATTEMPTS = 3;
  let resp;
  for (let attempt = 1; attempt <= MAX_TASK_ATTEMPTS; attempt += 1) {
    try {
      resp = await fetch(`${BASE_URL}/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(body),
        // Re-created per attempt: an AbortSignal that has already fired cannot be reused.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (fetchErr) {
      const cause = fetchErr?.cause?.message || fetchErr?.cause?.code || fetchErr.message || 'unknown';
      log.error('muapi_fetch_failed', { message: fetchErr.message, cause: String(cause).slice(0, 500) });
      throw new AppError(`Muapi connection failed: ${String(cause).slice(0, 200)}`, 502, 'MUAPI_ERROR');
    }

    if (resp.ok || resp.status < 500 || attempt === MAX_TASK_ATTEMPTS) break;
    log.warn('muapi_task_5xx_retry', { model: modelId, status: resp.status, attempt });
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const message = extractErrorMessage(text);
    if (resp.status === 401 || resp.status === 403) throw new AppError('Muapi auth failed — check your API key', 401, 'INVALID_API_KEY');
    if (resp.status === 402) throw new AppError(`Muapi: ${message} — top up at https://muapi.ai/topup`, 402, 'INSUFFICIENT_CREDITS');
    if (resp.status === 404) throw new AppError(`Muapi model not found: ${slug}`, 404, 'MUAPI_MODEL_NOT_FOUND');
    if (resp.status === 429) throw new AppError('Muapi rate limited', 429, 'RATE_LIMITED');
    throw new AppError(`Muapi task creation failed (${resp.status}): ${String(message).slice(0, 300)}`, 502, 'MUAPI_TASK_ERROR');
  }

  const json = await resp.json();
  log.info('muapi_create_response', { model: modelId, response: JSON.stringify(json).slice(0, 1000) });

  const data = json?.data || json;
  const taskId = data?.request_id || data?.id;
  if (!taskId) throw new AppError('Muapi returned no request ID', 502, 'MUAPI_TASK_ERROR');

  log.info('muapi_task_created', { taskId, model: modelId });
  return { taskId, status: data.status || 'created' };
}

async function getTaskStatus(taskId) {
  const key = getApiKey();
  const resp = await fetch(`${BASE_URL}/predictions/${taskId}/result`, {
    method: 'GET',
    headers: { 'x-api-key': key },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const message = extractErrorMessage(text);
    if (resp.status === 401 || resp.status === 403) throw new AppError('Muapi auth failed — check your API key', 401, 'INVALID_API_KEY');
    if (resp.status === 404) throw new AppError(`Muapi: ${message}`, 404, 'MUAPI_NOT_FOUND');
    throw new AppError(`Muapi status check failed (${resp.status}): ${String(message).slice(0, 200)}`, 502, 'MUAPI_STATUS_ERROR');
  }

  const json = await resp.json();
  const data = json?.data || json;
  const rawStatus = String(data.status || '').toLowerCase();
  const errText = data.error || data.failure_reason || '';
  // A non-empty error means the job is DONE and failed, whatever the status says. Muapi returns
  // moderation rejections (e.g. "generated audio did not pass review") with a status that is
  // not 'failed'/'error', which mapped to 'processing' and left the card spinning forever.
  const status = String(errText).trim()
    ? 'failed'
    : ['completed', 'succeeded', 'success'].includes(rawStatus)
      ? 'completed'
      : ['failed', 'error', 'rejected', 'moderated', 'content_moderated'].includes(rawStatus)
        ? 'failed'
        : 'processing';

  // Output shape varies by underlying model — check the common spots (video AND image).
  let outputs = data.outputs || data.output || [];
  if (!Array.isArray(outputs)) outputs = [outputs].filter(Boolean);
  if (!outputs.length) {
    const single = data.video?.url || data.video_url || data.result?.video?.url
      || data.image?.url || data.image_url || data.result?.image?.url;
    if (single) outputs = [single];
    else if (Array.isArray(data.images)) outputs = data.images.map((i) => i?.url || i).filter(Boolean);
  }

  return { status, outputs, error: data.error || data.failure_reason || null };
}

// ── Seedream 5.0 Pro Edit (image-to-image) ───────────────────────────────────
// Ground truth from Muapi's Seedream5ProEditRequest schema — not guessed.
const SEEDREAM_EDIT_SLUG = 'seedream-5.0-pro-edit';
const SEEDREAM_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2'];
const SEEDREAM_RESOLUTIONS = ['1K', '2K'];
const SEEDREAM_MAX_IMAGES = 10;
const EDIT_POLL_INTERVAL_MS = 2000;
const EDIT_MAX_POLL_MS = 180_000;

async function _downloadAsBase64(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw new AppError(`Failed to download Muapi result image (${resp.status})`, 502, 'MUAPI_DOWNLOAD');
  const buf = Buffer.from(await resp.arrayBuffer());
  const mimeType = resp.headers.get('content-type')?.split(';')[0] || 'image/png';
  return { base64Data: buf.toString('base64'), mimeType };
}

/**
 * Edit 1–10 images with Seedream 5.0 Pro Edit. Submits, polls to completion, and
 * returns the resulting image(s) as base64 so the caller can store them.
 * @param {Array<{base64:string, mimeType:string}>} images
 */
async function submitSeedreamEdit(images, prompt, opts = {}) {
  // Validate before touching config: a bad request shouldn't report "no API key".
  if (!prompt?.trim()) throw new AppError('A prompt is required', 400, 'VALIDATION_ERROR');
  if (!Array.isArray(images) || !images.length) throw new AppError('At least one source image is required', 400, 'VALIDATION_ERROR');
  if (images.length > SEEDREAM_MAX_IMAGES) throw new AppError(`Maximum ${SEEDREAM_MAX_IMAGES} images allowed`, 400, 'VALIDATION_ERROR');
  const key = getApiKey();

  const imageUrls = [];
  for (const img of images) {
    imageUrls.push(await uploadBase64(img.base64, img.mimeType || 'image/png'));
  }

  const ratio = SEEDREAM_ASPECT_RATIOS.includes(opts.aspectRatio) ? opts.aspectRatio : '1:1';
  const resolution = SEEDREAM_RESOLUTIONS.includes(opts.resolution) ? opts.resolution : '1K';

  const body = { prompt: prompt.trim(), images_list: imageUrls, aspect_ratio: ratio, resolution };
  log.info('muapi_seedream_payload', {
    promptLen: prompt.trim().length, prompt: prompt.trim().slice(0, 300),
    aspect_ratio: ratio, resolution, imageCount: imageUrls.length,
  });

  let resp;
  try {
    resp = await fetch(`${BASE_URL}/${SEEDREAM_EDIT_SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (fetchErr) {
    const cause = fetchErr?.cause?.message || fetchErr?.cause?.code || fetchErr.message || 'unknown';
    throw new AppError(`Muapi connection failed: ${String(cause).slice(0, 200)}`, 502, 'MUAPI_ERROR');
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const message = extractErrorMessage(text);
    if (resp.status === 401 || resp.status === 403) throw new AppError('Muapi auth failed — check your API key', 401, 'INVALID_API_KEY');
    if (resp.status === 402) throw new AppError(`Muapi: ${message} — top up at https://muapi.ai/topup`, 402, 'INSUFFICIENT_CREDITS');
    throw new AppError(`Seedream edit failed (${resp.status}): ${String(message).slice(0, 300)}`, 502, 'MUAPI_TASK_ERROR');
  }

  const json = await resp.json();
  const data = json?.data || json;
  const taskId = data?.request_id || data?.id;
  if (!taskId) throw new AppError('Muapi returned no request ID', 502, 'MUAPI_TASK_ERROR');
  log.info('muapi_seedream_task_created', { taskId });
  return { taskId };
}

/**
 * Turn Muapi's outputs into base64 images. Its shape varies by model, hence the three branches.
 */
async function _seedreamOutputs(outputs) {
  if (!outputs.length) throw new AppError('Seedream returned no image', 502, 'MUAPI_EMPTY');
  return Promise.all(outputs.slice(0, 4).map(async (o) => {
    if (typeof o === 'string' && /^https?:/.test(o)) return await _downloadAsBase64(o);
    const m = typeof o === 'string' && o.match(/^data:([^;]+);base64,(.+)$/);
    if (m) return { base64Data: m[2], mimeType: m[1] };
    if (o?.url) return await _downloadAsBase64(o.url);
    throw new AppError('Unrecognised Seedream output format', 502, 'MUAPI_EMPTY');
  }));
}

/**
 * ONE look at a submitted task — no waiting.
 *
 * This is what makes a durable queue possible. generateSeedreamEdit below blocks until the render
 * finishes, which is fine while the app is open and useless after a restart: the caller is gone but
 * the task is still valid on Muapi's side. The worker polls with this instead, so a job interrupted
 * mid-render is simply picked up again on the next boot rather than lost and re-paid for.
 *
 * Returns { status: 'processing' } | { status: 'completed', images } | { status: 'failed', error }.
 * It does not throw on a FAILED task — that is an answer, and the queue records it as one. It still
 * throws on a broken connection or a bad key, which are not answers.
 */
async function pollSeedreamEdit(taskId) {
  const res = await getTaskStatus(taskId);
  if (res.status === 'completed') {
    return { status: 'completed', images: await _seedreamOutputs(res.outputs), modelUsed: SEEDREAM_EDIT_SLUG };
  }
  if (res.status === 'failed') {
    // Content-policy rejections surface here (Muapi enforces this account-side).
    return { status: 'failed', error: res.error || 'unknown error' };
  }
  return { status: 'processing' };
}

/**
 * Submit and wait — the original blocking call, unchanged in behaviour.
 *
 * `opts.onTaskId` is the one addition: it fires the moment Muapi accepts, so a caller that wants
 * the job to survive a crash can write the id down before the render starts. Without it the id
 * exists only inside this function's stack frame, which is exactly how a paid picture used to be
 * lost when the app closed.
 */
async function generateSeedreamEdit(images, prompt, opts = {}) {
  const { taskId } = await submitSeedreamEdit(images, prompt, opts);
  if (typeof opts.onTaskId === 'function') {
    try { opts.onTaskId(taskId); } catch { /* bookkeeping must never sink a live render */ }
  }

  const deadline = Date.now() + EDIT_MAX_POLL_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, EDIT_POLL_INTERVAL_MS));
    const res = await pollSeedreamEdit(taskId);
    if (res.status === 'completed') return { images: res.images, modelUsed: res.modelUsed };
    if (res.status === 'failed') throw new AppError(`Seedream edit failed: ${res.error}`, 502, 'MUAPI_FAILED');
  }
  throw new AppError('Seedream edit timed out after 3 minutes', 504, 'MUAPI_TIMEOUT');
}

// ── Seedance 2 Omni Reference ────────────────────────────────────────────────
// Reference up to 3 videos (@video1..3), 9 images (@image1..9), 3 audio (@audio1..3),
// plus trained characters via @omni-character:<id>. Ground truth from Muapi's OpenAPI spec;
// prices from Muapi's public model page (NOT guessed).
const OMNI_MODELS = {
  // Images-only reference variant (no video input). imagesOnly gates it: the images-only Seedance
  // Video page defaults to it; the video-reference Omni page hides it. Price is UNCONFIRMED — Muapi's
  // model/pricing pages are JS-gated — so it is set to the VIP fast rate as a conservative estimate
  // (over-, never under-reporting spend) until the real per-second price is read off the playground.
  'omni-no-video-fast': { slug: 'seedance-2-omni-reference-no-video-fast', pricePerSecond: 0.21, label: 'Omni No-Video Fast 720p', quality: false, imagesOnly: true },
  'omni-fast':        { slug: 'seedance-2-vip-omni-reference-fast',       pricePerSecond: 0.21,   label: 'Omni Fast 720p',  quality: false },
  'omni-best':        { slug: 'seedance-2.0-omni-reference',              pricePerSecond: 0.30,   label: 'Omni 720p (best)', quality: true },
  'omni-fast-1080p':  { slug: 'seedance-2-vip-omni-reference-fast-1080p', pricePerSecond: 0.4725, label: 'Omni Fast 1080p', quality: false },
  'omni-1080p':       { slug: 'seedance-2-vip-omni-reference-1080p',      pricePerSecond: 0.675,  label: 'Omni 1080p',      quality: false },
  'omni-4k':          { slug: 'seedance-2-vip-omni-reference-4k',         pricePerSecond: 1.35,   label: 'Omni 4K',         quality: false },
};
const OMNI_TRAIN_SLUG = 'seedance-2-omni-reference-train';
const OMNI_TRAIN_COST = 0.50;
const OMNI_MAX_VIDEOS = 3;
const OMNI_MAX_IMAGES = 9;

async function _postMuapi(slug, body, label) {
  const key = getApiKey();
  let resp;
  try {
    resp = await fetch(`${BASE_URL}/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (fetchErr) {
    const cause = fetchErr?.cause?.message || fetchErr?.cause?.code || fetchErr.message || 'unknown';
    throw new AppError(`Muapi connection failed: ${String(cause).slice(0, 200)}`, 502, 'MUAPI_ERROR');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const message = extractErrorMessage(text);
    if (resp.status === 401 || resp.status === 403) throw new AppError('Muapi auth failed — check your API key', 401, 'INVALID_API_KEY');
    if (resp.status === 402) throw new AppError(`Muapi: ${message} — top up at https://muapi.ai/topup`, 402, 'INSUFFICIENT_CREDITS');
    if (resp.status === 404) throw new AppError(`Muapi model not found: ${slug}`, 404, 'MUAPI_MODEL_NOT_FOUND');
    if (resp.status === 429) throw new AppError('Muapi rate limited', 429, 'RATE_LIMITED');
    throw new AppError(`${label} failed (${resp.status}): ${String(message).slice(0, 300)}`, 502, 'MUAPI_TASK_ERROR');
  }
  return await resp.json();
}

/**
 * Submit an Omni Reference video job. Assets are uploaded to Muapi first (images_list /
 * video_files want hosted URLs, max 2083 chars — a data URI is always rejected).
 */
async function createOmniTask(modelId, { prompt, images = [], videos = [], videoUrls = [], aspectRatio, duration, quality }) {
  const model = OMNI_MODELS[modelId];
  if (!model) throw new AppError(`Unknown Omni model: ${modelId}`, 400, 'INVALID_MODEL');
  if (!prompt?.trim()) throw new AppError('A prompt is required', 400, 'VALIDATION_ERROR');
  if (images.length > OMNI_MAX_IMAGES) throw new AppError(`Maximum ${OMNI_MAX_IMAGES} reference images`, 400, 'VALIDATION_ERROR');
  if (videos.length + videoUrls.length > OMNI_MAX_VIDEOS) throw new AppError(`Maximum ${OMNI_MAX_VIDEOS} reference videos`, 400, 'VALIDATION_ERROR');
  // The no-video variant's endpoint rejects video_files; fail fast with a clear message rather than
  // paying for a round-trip that 400s at Muapi.
  if (model.imagesOnly && (videos.length + videoUrls.length) > 0) {
    throw new AppError(`${model.label} takes reference images only — no reference video`, 400, 'VALIDATION_ERROR');
  }

  const imageUrls = [];
  for (const img of images) imageUrls.push(await uploadBase64(img.base64, img.mimeType || 'image/png'));
  const vidUrls = [...videoUrls];
  for (const v of videos) {
    // Strip audio so the model can't regenerate a soundtrack that fails moderation.
    let raw = v.base64;
    const m = String(raw).match(/^data:[^;]+;base64,(.+)$/);
    if (m) raw = m[1];
    const stripped = await stripAudio(Buffer.from(raw, 'base64'));
    const tmp = await _bufToTemp(stripped, '.mp4');
    try { vidUrls.push(await uploadFile(tmp)); }
    finally { try { fs.unlinkSync(tmp); } catch { /* best-effort */ } }
  }

  const ratio = ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '16:9';
  const dur = Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(Number(duration)) || 5));

  const body = { prompt: prompt.trim(), aspect_ratio: ratio, duration: dur };
  if (imageUrls.length) body.images_list = imageUrls;
  if (vidUrls.length) body.video_files = vidUrls;
  if (model.quality) body.quality = quality === 'basic' ? 'basic' : 'high';

  log.info('muapi_omni_payload', {
    model: modelId, slug: model.slug, promptLen: prompt.trim().length,
    prompt: prompt.trim().slice(0, 300), images: imageUrls.length, videos: vidUrls.length,
    aspect_ratio: ratio, duration: dur,
  });

  const json = await _postMuapi(model.slug, body, 'Omni Reference');
  const data = json?.data || json;
  const taskId = data?.request_id || data?.id;
  if (!taskId) throw new AppError('Muapi returned no request ID', 502, 'MUAPI_TASK_ERROR');
  log.info('muapi_omni_task_created', { taskId, model: modelId });
  return { taskId, status: data.status || 'created' };
}

/**
 * Train a reusable Omni character from one clear face portrait.
 * Returns a character_id used in prompts as @omni-character:<id>. $0.50 flat.
 */
async function trainOmniCharacter({ imageBase64, mimeType, characterName, description }) {
  if (!imageBase64) throw new AppError('A reference photo is required', 400, 'VALIDATION_ERROR');
  if (!characterName?.trim()) throw new AppError('A character name is required', 400, 'VALIDATION_ERROR');

  const imageUrl = await uploadBase64(imageBase64, mimeType || 'image/png');
  const body = { image_url: imageUrl, character_name: characterName.trim() };
  if (description?.trim()) body.description = description.trim();

  log.info('muapi_omni_train', { characterName: characterName.trim() });
  const json = await _postMuapi(OMNI_TRAIN_SLUG, body, 'Character training');
  const data = json?.data || json;
  // Training is async like everything else — the character_id arrives via the poll result.
  const requestId = data?.request_id || data?.id;
  const immediateId = data?.character_id || data?.characterId;
  if (!requestId && !immediateId) throw new AppError('Muapi returned no training request ID', 502, 'MUAPI_TASK_ERROR');
  return { requestId, characterId: immediateId || null };
}

module.exports = {
  createVideoTask,
  getTaskStatus,
  generateSeedreamEdit,
  submitSeedreamEdit,
  pollSeedreamEdit,
  createOmniTask,
  trainOmniCharacter,
  OMNI_MODELS,
  OMNI_TRAIN_COST,
  OMNI_MAX_VIDEOS,
  OMNI_MAX_IMAGES,
  // Exported for tests — pure helpers with no network.
  extForMime,
  extractErrorMessage,
  MODEL_SLUGS,
  ASPECT_RATIOS,
  DURATION_MIN,
  DURATION_MAX,
  SEEDREAM_ASPECT_RATIOS,
  SEEDREAM_RESOLUTIONS,
  SEEDREAM_MAX_IMAGES,
};
