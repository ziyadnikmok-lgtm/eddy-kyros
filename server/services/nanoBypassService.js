/**
 * Nano Banana 2 on Google's own API — the "bypass", callable from outside an HTTP route.
 *
 * WHAT THE BYPASS ACTUALLY IS: the same model reached directly through
 * generativelanguage.googleapis.com with a Gemini key, safety at BLOCK_ONLY_HIGH, and a retry
 * ladder whose last rung sends no safetySettings at all. Going through a reseller instead means
 * inheriting the reseller's refusals; this path has only Google's.
 *
 * WHY IT IS A SERVICE. It was inline in routes/nanoBypass.js, which is fine while the only caller
 * is a browser holding the connection — and useless the moment anything server-side wants it. The
 * generation queue is server-side: it survives the app closing, it runs hundreds of jobs in flight,
 * and it cannot POST to its own HTTP route to get work done. Photo Match NB2 needs both the bypass
 * and the queue, so the bypass had to stop being a route.
 *
 * The route now imports these and behaves exactly as before — nothing about the Nano Bypass page
 * changes.
 */
const { AppError } = require('../middleware/errorHandler');

/**
 * Loosest setting the API accepts on this path. Note the retry ladder in callGemini drops the block
 * entirely on the third attempt, which is the actual bypass — this is the first, politest rung.
 */
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_ONLY_HIGH' },
];

const MODEL_IDS = {
  // No "-preview" suffix: the Vertex backend's allow-list (geminiVertexService.ALLOWED_IMAGE_MODELS)
  // is `gemini-3.1-flash-image`, and resolveImageModel() throws "Unsupported image model" on the old
  // preview id — which is exactly the Nano Bypass error this fixes.
  flash: 'gemini-3.1-flash-image',
};

function estimateBase64Bytes(value) {
  const clean = String(value || '').replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function extractImageFromResponse(data) {
  const candidates = data?.candidates || [];
  if (!candidates.length) return null;
  const parts = candidates[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.thought) continue;
    if (part.inlineData?.data) return part.inlineData.data;
  }
  return null;
}

async function callGemini(apiKey, modelId, parts, aspectRatio, imageSize, temperature) {
  const imageConfig = {};
  if (aspectRatio && aspectRatio !== 'auto') imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;

  const genConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    temperature: temperature ?? 1.0,
  };
  if (Object.keys(imageConfig).length) genConfig.imageConfig = imageConfig;

  const payload = {
    contents: [{ parts }],
    generationConfig: genConfig,
    safetySettings: SAFETY_SETTINGS,
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  // Up to 3 attempts with progressive simplification (mirrors the ComfyUI node logic)
  for (let attempt = 1; attempt <= 3; attempt++) {
    let body = payload;
    if (attempt === 2) {
      body = { ...payload, generationConfig: { responseModalities: ['IMAGE'], temperature: temperature ?? 1.0 } };
    } else if (attempt === 3) {
      body = { ...payload, generationConfig: { responseModalities: ['IMAGE'], temperature: 0.8 } };
      delete body.safetySettings;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });

    if (!resp.ok && resp.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const err = new AppError(`Gemini API error (${resp.status}): ${text.slice(0, 200)}`, 502, 'NANO_BYPASS_ERROR');
      /**
       * The queue has to tell "come back later" apart from "this job is bad": a rate limit must be
       * retried and refunded, a rejected payload must not be. Without this a busy minute quietly
       * eats the retry budget of perfectly good jobs.
       *
       * `status`, NOT `statusCode`. AppError's constructor sets statusCode, and that is what the
       * error handler answers the HTTP request with — writing there would change what the Nano
       * Bypass page receives for an unrelated reason. This adds a field beside it, read only by
       * the queue.
       */
      err.status = resp.status;
      throw err;
    }

    const data = await resp.json();
    const b64 = extractImageFromResponse(data);
    if (b64) return b64;

    // Last attempt — surface a useful error
    if (attempt === 3) {
      const finishReason = data?.candidates?.[0]?.finishReason || 'UNKNOWN';
      const textParts = (data?.candidates?.[0]?.content?.parts || [])
        .filter((p) => !p.thought && p.text)
        .map((p) => p.text)
        .join(' ');
      throw new AppError(
        `Nano Bypass returned no image (reason: ${finishReason})${textParts ? ` — ${textParts.slice(0, 200)}` : ''}`,
        502,
        'NANO_BYPASS_NO_IMAGE'
      );
    }
  }
  return null;
}

/**
 * One edit, RAW: the caller's images in the caller's order, then the caller's prompt, and nothing
 * else added.
 *
 * Raw matters more than it looks. The route's wrapped mode prepends "Keep the original subject,
 * POSE, background, lighting and composition unless the instruction explicitly asks to change
 * them" and calls every image "the source image to edit". For a caller that writes its own
 * multi-image prompt — Photo Match says images 1-4 are the character and image 5 is a scene whose
 * person must be REPLACED — that wrapper states the opposite instruction first, and the model gets
 * two contradictory briefs in one request. Same failure Eddy hit on 2026-08-06 ("with nano it
 * doesn't work").
 *
 * Returns { images: [{ base64Data, mimeType }] } — the shape the queue's saver already expects, so
 * a bypass result files exactly like a WaveSpeed one.
 */
async function editRaw({ apiKey, images, prompt, aspectRatio, imageSize = '2K', temperature = 1.0, model = 'flash' }) {
  if (!apiKey) throw new AppError('Nano Bypass requires a Gemini API key — add one under API Keys.', 400, 'GEMINI_KEY_REQUIRED');
  if (!prompt || !String(prompt).trim()) throw new AppError('prompt is required', 400, 'VALIDATION_ERROR');
  if (!Array.isArray(images) || !images.length) throw new AppError('at least one image is required', 400, 'VALIDATION_ERROR');

  const modelId = MODEL_IDS[model] || MODEL_IDS.flash;
  const parts = [];
  for (const img of images) {
    // Accepts a data URL or bare base64, because both are in circulation: the client sends data
    // URLs and the queue stores whatever it was handed.
    const raw = String(img?.base64 ?? img?.base64Data ?? img ?? '').replace(/^data:[^;]+;base64,/, '');
    if (!raw) throw new AppError('each image must carry base64 data', 400, 'VALIDATION_ERROR');
    const mimeType = img?.mimeType || (/^data:([^;]+);/.exec(String(img?.base64 ?? img ?? '')) || [])[1] || 'image/png';
    parts.push({ inlineData: { mimeType, data: raw } });
  }
  parts.push({ text: String(prompt).trim() });

  const b64 = await callGemini(apiKey, modelId, parts, aspectRatio !== 'auto' ? aspectRatio : undefined, imageSize, temperature);
  if (!b64) throw new AppError('Nano Bypass returned no image', 502, 'NANO_BYPASS_NO_IMAGE');
  return { images: [{ base64Data: b64, mimeType: 'image/png' }] };
}

module.exports = { SAFETY_SETTINGS, MODEL_IDS, estimateBase64Bytes, extractImageFromResponse, callGemini, editRaw };
