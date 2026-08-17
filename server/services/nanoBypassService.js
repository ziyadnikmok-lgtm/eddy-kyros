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
const crypto = require('crypto');
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
      /**
       * SAY WHAT ACTUALLY HAPPENED, because "reason: IMAGE_OTHER" tells nobody anything.
       *
       * IMAGE_OTHER is how this API refuses on content. There is no blockReason and no message —
       * it simply answers with no image, and the raw finishReason was the only thing reaching the
       * card. Owner, 2026-08-17: "why i click say every gneeration failed", with 11 of 11 bypass
       * jobs that day ending exactly here.
       *
       * It matters that this reads as a REFUSAL rather than a fault, because the two have different
       * fixes: a refusal means run it on WaveSpeed, where the guard draws the line elsewhere — the
       * queue's own fallback does that automatically, so the message names it as what to expect.
       * The raw reason is kept in the text, in brackets, for anyone diagnosing.
       */
      const REFUSALS = new Set(['IMAGE_OTHER', 'IMAGE_SAFETY', 'SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST']);
      throw new AppError(
        REFUSALS.has(finishReason)
          ? `Google refused this image — its content filter, not an error (${finishReason}). Seedream 5 Pro on WaveSpeed takes over automatically; if that account is out of credits the job stops here.${textParts ? ` — ${textParts.slice(0, 160)}` : ''}`
          : `Nano Bypass returned no image (reason: ${finishReason})${textParts ? ` — ${textParts.slice(0, 200)}` : ''}`,
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
async function editRaw({ apiKey, images, prompt, aspectRatio, imageSize = '2K', temperature = 1.0, model = 'flash', identityCount = 0, labels = null }) {
  if (!apiKey) throw new AppError('Nano Bypass requires a Gemini API key — add one under API Keys.', 400, 'GEMINI_KEY_REQUIRED');
  if (!prompt || !String(prompt).trim()) throw new AppError('prompt is required', 400, 'VALIDATION_ERROR');
  if (!Array.isArray(images) || !images.length) throw new AppError('at least one image is required', 400, 'VALIDATION_ERROR');

  const modelId = MODEL_IDS[model] || MODEL_IDS.flash;
  const asPart = (img) => {
    // Accepts a data URL or bare base64, because both are in circulation: the client sends data
    // URLs and the queue stores whatever it was handed.
    const raw = String(img?.base64 ?? img?.base64Data ?? img ?? '').replace(/^data:[^;]+;base64,/, '');
    if (!raw) throw new AppError('each image must carry base64 data', 400, 'VALIDATION_ERROR');
    const mimeType = img?.mimeType || (/^data:([^;]+);/.exec(String(img?.base64 ?? img ?? '')) || [])[1] || 'image/png';
    return { inlineData: { mimeType, data: raw } };
  };

  const parts = [];

  /**
   * A LABEL PER IMAGE, for callers whose images are not one identity block and one scene.
   *
   * identityCount below solved this for Photo Match, where the payload really is "these are her,
   * that is the scene". Eddy's is not: base photo, pose diagram, face close-up, garment — four
   * different jobs, in an order the caller decides.
   *
   * Its prompt names them by number ("image 2 is a POSE DIAGRAM"), and on WaveSpeed that is enough.
   * On this API it is not, and the comment below already says why: sent as an undifferentiated pile
   * followed by a wall of text, there is nothing tying a number in the prose to the bytes that
   * arrived, so the model edits whatever photo is most salient. That is exactly what "in max nano it
   * using the background of the pose image not of the base image" looks like from the outside — the
   * pose diagram is a full photograph of a room and a person, and the base photo is one too.
   *
   * Positional only, like the identity labels: the caller's prompt states every RULE, and repeating
   * rules here would be two briefs in one request.
   *
   * MEASURED, on the real API with the owner's key (2026-08-17). Base photo: a bright pink bedroom.
   * Pose diagram: outdoors at night beside a white car. Same prompt, one variable:
   *
   *     labels ON   -> she is in the PINK BEDROOM, with the pose and boots taken from the diagram
   *     labels OFF  -> she is OUTDOORS BESIDE THE CAR, wearing the other woman's clothes
   *
   * That is the whole bug, reproduced and then removed by this one field — and it explains why the
   * same prompt was fine on WaveSpeed and wrong here ("from wavespeed the background is perfect but
   * from gemini it using the pose photo as background").
   */
  const n = Math.max(0, Math.min(Number(identityCount) || 0, images.length - 1));
  if (Array.isArray(labels) && labels.length && !n) {
    images.forEach((img, i) => {
      const label = String(labels[i] || '').trim();
      if (label) parts.push({ text: `[Image ${i + 1} — ${label}]` });
      parts.push(asPart(img));
    });
  } else if (n > 0) {
    /**
     * THE IMAGES ARE LABELLED WHERE THEY SIT, and this is the difference between getting your
     * character back and getting the stand-in with an invented face.
     *
     * Sent as one undifferentiated pile followed by a wall of text, Gemini has nothing tying "images
     * 1-3 = Grace" in the prompt to the actual bytes it received — so it does the obvious thing with
     * an edit request and edits the most salient photo, which is the scene. The result is the
     * stand-in's body and hair with a face invented from nowhere, and the identity references
     * ignored entirely (owner, 2026-08-16: 'wtf didnt use my model i select').
     *
     * routes/nanoBypass.js already knew this — its identity branch puts a text part BEFORE each
     * group of images, and that is the shape that works on this API. The labels here are positional
     * ONLY: the caller's prompt states every rule about identity, and repeating them would be two
     * briefs in one request, which is the failure raw mode exists to avoid.
     */
    const refLabel = n === 1 ? 'Image 1' : `Images 1-${n}`;
    parts.push({ text: `[${refLabel} — IDENTITY REFERENCE PHOTOS] ${refLabel} ${n === 1 ? 'is' : 'are'} the person to render. They are not the scene.` });
    for (const img of images.slice(0, n)) parts.push(asPart(img));

    const from = n + 1;
    const to = images.length;
    const srcLabel = from === to ? `Image ${from}` : `Images ${from}-${to}`;
    parts.push({ text: `[${srcLabel} — SCENE PHOTOGRAPH] ${srcLabel} ${from === to ? 'is' : 'are'} the scene to rebuild. The person in it is a stand-in and is not in the output.` });
    for (const img of images.slice(n)) parts.push(asPart(img));
  } else {
    for (const img of images) parts.push(asPart(img));
  }
  parts.push({ text: String(prompt).trim() });

  const b64 = await callGemini(apiKey, modelId, parts, aspectRatio !== 'auto' ? aspectRatio : undefined, imageSize, temperature);
  if (!b64) throw new AppError('Nano Bypass returned no image', 502, 'NANO_BYPASS_NO_IMAGE');

  /**
   * DID IT JUST HAND BACK WHAT WE SENT?
   *
   * An edit model can satisfy "reproduce this photograph exactly" the lazy way — by returning the
   * photograph. It is a real failure mode on this API, and the worst kind: the job succeeds, the
   * picture files, the tile goes green, and what you have is your own source photo with the blurred
   * face still in it, sitting in the library under the character's name.
   *
   * Byte-identical is the whole test. A genuine render is never bit-for-bit one of its inputs — even
   * an exact recreate re-encodes every pixel — so this cannot fire on good work. Cheap too: one
   * hash per input, against bytes already in memory.
   *
   * Thrown rather than returned, so the queue treats it as a failed attempt: it retries, and after
   * NB2_ATTEMPTS hands the job to Seedream, which is exactly what you want when this engine has
   * decided to echo.
   */
  const outHash = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  for (const p of parts) {
    if (!p.inlineData?.data) continue;
    if (crypto.createHash('sha256').update(Buffer.from(p.inlineData.data, 'base64')).digest('hex') === outHash) {
      throw new AppError('Nano Bypass returned one of the input images unchanged rather than a new render.', 502, 'NANO_BYPASS_ECHO');
    }
  }

  return { images: [{ base64Data: b64, mimeType: 'image/png' }] };
}

module.exports = { SAFETY_SETTINGS, MODEL_IDS, estimateBase64Bytes, extractImageFromResponse, callGemini, editRaw };
