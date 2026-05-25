/**
 * Gemini via Google Cloud Service Account (OAuth) — same interface as geminiService.js.
 *
 * Uses a service account JSON to get OAuth Bearer tokens, then calls the
 * Vertex AI publisher Gemini endpoint (aiplatform.googleapis.com) so usage is
 * billed through the selected Google Cloud project.
 *
 * Required setup (one-time per GCP project):
 *   1. Enable "Vertex AI API" at console.cloud.google.com/apis/library/aiplatform.googleapis.com
 *   2. Create a service account with any basic role (even no role works)
 *   3. Download the service account JSON key
 *   4. Paste it in Settings → API Keys → Vertex AI Credentials
 */

const { GoogleGenAI, Modality, ThinkingLevel, HarmCategory, HarmBlockThreshold } = require('@google/genai');
const { GoogleAuth } = require('google-auth-library');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { AppError } = require('../middleware/errorHandler');
const { dedupRequest } = require('../utils/dedup');
const cfg = require('../config');

try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 60_000 } }));
} catch {
  // Older runtimes may not expose undici; fetch will use its default timeout.
}

const IMAGE_MODEL = 'gemini-3-pro-image-preview';
const VERTEX_IMAGEN_MODEL = process.env.VERTEX_IMAGEN_MODEL || 'imagen-3.0-generate-002';
const IMAGE_MODEL_ALTERNATES = ['gemini-3.1-flash-image-preview'];
const EXPERIMENTAL_IMAGE_MODEL_ALIASES = {
  'nano-bypass-experimental': 'gemini-3.1-flash-image-preview',
};
const ALLOWED_IMAGE_MODELS = [IMAGE_MODEL, ...IMAGE_MODEL_ALTERNATES];
const MINIMAL_THINKING_IMAGE_MODELS = new Set(['gemini-3.1-flash-image-preview']);
const TEXT_MODEL = process.env.VERTEX_TEXT_MODEL || 'gemini-2.5-flash';

const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.OFF },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.OFF },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.OFF },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.OFF },
  { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.OFF },
];

const GENERATE_TIMEOUT_MS = cfg.GEMINI_GENERATE_TIMEOUT_MS;
const TEXT_TIMEOUT_MS = cfg.GEMINI_TEXT_TIMEOUT_MS;
const TRANSIENT_RETRY_COUNT = cfg.GEMINI_TRANSIENT_RETRIES;
const TRANSIENT_RETRY_BASE_MS = cfg.GEMINI_TRANSIENT_BASE_MS;

const OAUTH_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

// Cache the GoogleAuth client per credential set (avoids re-parsing JSON)
const _authCache = new Map();

function _getAuthClient(credentials) {
  const cacheKey = credentials.private_key_id || credentials.client_email || 'default';
  if (_authCache.has(cacheKey)) return _authCache.get(cacheKey);
  const auth = new GoogleAuth({ credentials, scopes: OAUTH_SCOPES });
  _authCache.set(cacheKey, auth);
  return auth;
}


// --- Raw HTTP client (bypasses SDK's ?key= query param which breaks OAuth Bearer auth) ---

const TOP_LEVEL_FIELDS = new Set(['safetySettings', 'systemInstruction', 'tools', 'toolConfig', 'cachedContent']);
const SDK_ONLY_FIELDS  = new Set(['httpOptions', 'signal', 'audioTimestamp', 'personGeneration']);
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || cfg.VERTEX_LOCATION || 'global';
const VERTEX_API_VERSION = process.env.VERTEX_API_VERSION || 'v1';

function _normalizeImagenAspectRatio(aspectRatio = '1:1') {
  const ratio = String(aspectRatio || '1:1').trim();
  const supported = new Set(['1:1', '3:4', '4:3', '9:16', '16:9']);
  if (supported.has(ratio)) return ratio;
  const fallback = {
    '4:5': '3:4',
    '5:4': '4:3',
    '2:3': '3:4',
    '3:2': '4:3',
    '1:2': '9:16',
    '2:1': '16:9',
  };
  return fallback[ratio] || '1:1';
}

function _buildRawRequest(contents, config) {
  const body = { contents };
  const generationConfig = {};
  if (config) {
    for (const [key, value] of Object.entries(config)) {
      if (SDK_ONLY_FIELDS.has(key) || value === undefined) continue;
      if (TOP_LEVEL_FIELDS.has(key)) { body[key] = value; }
      else { generationConfig[key] = value; }
    }
  }
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  return body;
}

function _buildHttpClient(credentials, token) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const projectId = credentials.project_id;

  return {
    models: {
      generateContent: async ({ model, contents, config }) => {
        const url = `https://aiplatform.googleapis.com/${VERTEX_API_VERSION}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(VERTEX_LOCATION)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
        const body = _buildRawRequest(contents, config);
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(JSON.stringify(data));
        return data;
      },
    },
  };
}

async function _getGeminiClient(credentials) {
  const auth = _getAuthClient(credentials);
  const tokenResponse = await auth.getClient().then(c => c.getAccessToken());
  const token = tokenResponse.token || tokenResponse;
  if (!token) throw new AppError('Failed to get OAuth token from service account credentials', 500, 'CONFIG_ERROR');
  return _buildHttpClient(credentials, token);
}

async function _getVertexAccessToken(credentials) {
  const auth = _getAuthClient(credentials);
  const tokenResponse = await auth.getClient().then(c => c.getAccessToken());
  const token = tokenResponse.token || tokenResponse;
  if (!token) throw new AppError('Failed to get OAuth token from service account credentials', 500, 'CONFIG_ERROR');
  return token;
}

function _getStoredCredentials() {
  try {
    const apiKeyManager = require('./apiKeyManager');
    return apiKeyManager.getVertexCredentials();
  } catch {
    return null;
  }
}

async function getClient() {
  const creds = _getStoredCredentials();
  if (!creds) {
    throw new AppError(
      'No Vertex/GCP credentials saved. Go to Settings → API Keys → Vertex AI Credentials and paste your service account JSON.',
      500,
      'CONFIG_ERROR'
    );
  }
  return _getGeminiClient(creds);
}

function _buildInlineDataSignature(inlineData) {
  if (!inlineData || typeof inlineData.data !== 'string') return '';
  const data = inlineData.data;
  return [inlineData.mimeType || '', data.length, data.slice(0, 64), data.slice(-64)].join(':');
}

function _buildGenerationInputSignature(options = {}) {
  const parts = Array.isArray(options.parts) ? options.parts : null;
  if (parts && parts.length > 0) {
    const summary = parts.map((p) => {
      if (p?.inlineData) return `i:${_buildInlineDataSignature(p.inlineData)}`;
      if (typeof p?.text === 'string') return `t:${p.text.length}:${p.text.slice(0, 120)}`;
      return 'x';
    }).join('|');
    return `:parts:${crypto.createHash('sha256').update(summary).digest('hex')}`;
  }
  const refs = Array.isArray(options.referenceImages) ? options.referenceImages : [];
  if (refs.length === 0) return ':noref';
  const summary = refs.map((r) => `r:${_buildInlineDataSignature({ mimeType: r?.mimeType, data: r?.base64Data || '' })}`).join('|');
  return `:refs:${crypto.createHash('sha256').update(summary).digest('hex')}`;
}

function _resolveVariationSeed(options = {}) {
  const explicitSeed = Number.parseInt(options.variationSeed ?? options.seed, 10);
  if (Number.isSafeInteger(explicitSeed) && explicitSeed > 0) return explicitSeed;
  return crypto.randomInt(1, 2147483647);
}

function _buildVariationSeedSuffix(seed) {
  if (!Number.isSafeInteger(seed) || seed <= 0) return '';
  return `\n\n[INTERNAL VARIATION SEED: ${seed}. Use this only to randomize composition and sampling. Do not render this seed or any text in the image.]`;
}

function _appendVariationSeedToPrompt(prompt, seed) {
  const suffix = _buildVariationSeedSuffix(seed);
  if (!suffix) return prompt;
  const maxBaseLength = Math.max(0, cfg.PROMPT_MAX_LENGTH - suffix.length);
  return `${String(prompt || '').trim().slice(0, maxBaseLength)}${suffix}`;
}

function _appendVariationSeedToParts(parts, seed) {
  const suffix = _buildVariationSeedSuffix(seed);
  if (!suffix) return parts;

  const cloned = parts.map((part) => {
    if (!part || typeof part !== 'object') return part;
    if (part.inlineData) return { ...part, inlineData: { ...part.inlineData } };
    return { ...part };
  });

  for (let index = cloned.length - 1; index >= 0; index -= 1) {
    if (typeof cloned[index]?.text === 'string') {
      const maxBaseLength = Math.max(0, cfg.PROMPT_MAX_LENGTH - suffix.length);
      cloned[index] = {
        ...cloned[index],
        text: `${cloned[index].text.trim().slice(0, maxBaseLength)}${suffix}`,
      };
      return cloned;
    }
  }

  cloned.push({ text: suffix.trim() });
  return cloned;
}

function isTransientError(err) {
  const msg = (err && err.message) ? err.message : '';
  const cause = (err && err.cause) ? `${err.cause.code || ''} ${err.cause.message || ''}` : '';
  const text = `${msg} ${cause}`;
  return (
    text.includes('503') || text.includes('500') || text.includes('UNAVAILABLE') ||
    text.includes('INTERNAL') || text.includes('ECONNRESET') || text.includes('ETIMEDOUT') ||
    text.includes('UND_ERR_CONNECT_TIMEOUT') || text.includes('fetch failed') ||
    text.includes('ENOTFOUND') || text.includes('socket hang up') || text.includes('network') ||
    text.includes('upstream') || text.includes('Timed out')
  );
}

function classifyVertexRuntimeError(message = '') {
  const m = String(message || '').toLowerCase();
  if (m.includes('service_disabled') || m.includes('api has not been used') || m.includes('is disabled')) {
    return { code: 'VERTEX_API_DISABLED', message: 'Vertex/Gemini API is disabled in your GCP project. Enable both APIs in Google Cloud console.' };
  }
  if (m.includes('serviceusage.services.use') || m.includes('iam') || m.includes('permission_denied') || m.includes('403')) {
    return { code: 'VERTEX_IAM_MISSING', message: 'GCP IAM issue: service account needs "Vertex AI User" and "Service Usage Consumer" roles.' };
  }
  if (m.includes('quota project') || m.includes('consumer_invalid') || m.includes('billing')) {
    return { code: 'VERTEX_BILLING', message: 'GCP billing/quota issue: enable billing (or trial) and ensure project_id matches your billed project.' };
  }
  if (m.includes('invalid_grant') || m.includes('invalid_client') || m.includes('authentication') || m.includes('credentials')) {
    return { code: 'INVALID_CREDENTIALS', message: 'Service account JSON/key is invalid or revoked. Create a new JSON key and paste it again.' };
  }
  return null;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class GeminiVertexService {
  _checkBudget() {
    const apiKeyManager = require('./apiKeyManager');
    apiKeyManager.checkBudget();
  }

  _trackTextSpend(response, characterId) {
    try {
      const usage = response?.usageMetadata;
      if (usage) {
        const apiKeyManager = require('./apiKeyManager');
        apiKeyManager.addTextSpend(usage.promptTokenCount || 0, usage.candidatesTokenCount || 0, characterId || undefined);
      }
    } catch (err) { console.error('[vertex] Text spend tracking failed:', err.message); }
  }

  _trackImageSpend(model, resolution, refImageCount, response, characterId) {
    try {
      const apiKeyManager = require('./apiKeyManager');
      const usage = response?.usageMetadata;
      apiKeyManager.addImageSpend(
        model || IMAGE_MODEL, resolution || '2K', refImageCount || 0,
        usage?.promptTokenCount || 0, usage?.candidatesTokenCount || 0, characterId || undefined,
      );
    } catch (err) { console.error('[vertex] Image spend tracking failed:', err.message); }
  }

  async generateImage(_apiKey, prompt, options = {}) {
    this._checkBudget();
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new AppError('A text prompt is required', 400, 'VALIDATION_ERROR');
    }
    if (prompt.trim().length > cfg.PROMPT_MAX_LENGTH) {
      throw new AppError(`Prompt must be ${cfg.PROMPT_MAX_LENGTH.toLocaleString()} characters or fewer`, 400, 'VALIDATION_ERROR');
    }
    const variationSeed = _resolveVariationSeed(options);
    const generationOptions = { ...options, variationSeed };
    const inputSig = _buildGenerationInputSignature(generationOptions);
    const dedupKey = `vtx:img:${crypto.createHash('sha256').update(prompt.trim() + (options.aspectRatio || '') + (options.imageSize || '') + inputSig + `:seed:${variationSeed}`).digest('hex')}`;
    return dedupRequest(dedupKey, () => this._generateImageInner(prompt, generationOptions));
  }

  async _generateImageInner(prompt, options) {
    try {
      const genAI = await getClient();
      const selectedImageModel = this.resolveImageModel(options.model);
      const config = {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
        safetySettings: SAFETY_SETTINGS,
        personGeneration: 'ALLOW_ALL',
        imageConfig: {
          aspectRatio: options.aspectRatio || '1:1',
          imageSize: options.imageSize || '2K',
          safetySetting: 'BLOCK_NONE',
        },
      };
      if (typeof options.temperature === 'number') {
        config.temperature = options.temperature;
      }
      if (MINIMAL_THINKING_IMAGE_MODELS.has(selectedImageModel)) {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
      }

      const maxAttempts = 3;
      let currentPrompt = prompt;
      let currentParts = Array.isArray(options.parts) && options.parts.length > 0
        ? options.parts
        : null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const retryOptions = currentParts ? { ...options, parts: currentParts } : options;
          const retryPrompt = this._buildRetryPrompt(_appendVariationSeedToPrompt(currentPrompt, options.variationSeed), attempt);
          const contentParts = this._buildImageGenerationParts(retryPrompt, retryOptions);
          const response = await withTimeout(
            genAI.models.generateContent({
              model: selectedImageModel,
              contents: [{ role: 'user', parts: contentParts }],
              config,
            }),
            GENERATE_TIMEOUT_MS,
            'Vertex image generation'
          );

          const parsed = this._parseImageResponse(response);

          if (parsed.imageResult) {
            if (parsed.imageResult.mimeType !== 'image/png') {
              const inputBuf = Buffer.from(parsed.imageResult.base64Data, 'base64');
              const pngBuf = await sharp(inputBuf).png({ compressionLevel: 6 }).toBuffer();
              parsed.imageResult.base64Data = pngBuf.toString('base64');
              parsed.imageResult.mimeType = 'image/png';
            }
            const refCount = contentParts.filter((p) => p.inlineData).length;
            this._trackImageSpend(selectedImageModel, options.imageSize || '2K', refCount, response, options.characterId);
            return { image: parsed.imageResult, text: parsed.textResult || null, modelUsed: selectedImageModel, seed: options.variationSeed || null };
          }

          if (parsed.blockReason || parsed.hasNoParts) {
            const reason = parsed.blockReason ? 'safety_block' : parsed.isImageOther ? 'IMAGE_OTHER' : 'empty_response';
            console.warn(`[vertex] attempt ${attempt}/${maxAttempts} failed: ${reason}`);
            if (attempt < maxAttempts) {
              if (currentParts) {
                currentParts = this._sanitizePartsForRetry(currentParts, attempt);
              } else {
                currentPrompt = this._sanitizePromptForRetry(currentPrompt, attempt);
              }
              await this._sleep(500 * attempt);
              continue;
            }
            throw new AppError(
              parsed.blockReason
                ? `Prompt blocked by safety filters after ${maxAttempts} attempts.`
                : `No content returned from Vertex after ${maxAttempts} attempts.`,
              parsed.blockReason ? 400 : 502,
              parsed.blockReason ? 'SAFETY_BLOCKED' : 'GENERATION_EMPTY'
            );
          }

          throw new AppError(
            parsed.textResult
              ? `Vertex returned text instead of an image: "${parsed.textResult.slice(0, 200)}"`
              : 'No image was generated. Try a different prompt.',
            422, 'NO_IMAGE_GENERATED'
          );
        } catch (innerErr) {
          if (innerErr instanceof AppError) throw innerErr;
          if (isTransientError(innerErr) && attempt < maxAttempts) {
            await this._sleep(Math.min(TRANSIENT_RETRY_BASE_MS * (2 ** (attempt - 1)), 30000));
            continue;
          }
          throw innerErr;
        }
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      this._handleApiError(err);
    }
  }

  async _generateImagenImage(prompt, options = {}) {
    const credentials = _getStoredCredentials();
    if (!credentials) throw new AppError('No Vertex/GCP credentials saved.', 500, 'CONFIG_ERROR');
    const token = await _getVertexAccessToken(credentials);
    const aspectRatio = _normalizeImagenAspectRatio(options.aspectRatio || '1:1');
    const promptForImagen = await this._buildVertexOnlyImagePrompt(prompt, options);
    const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/${VERTEX_API_VERSION}/projects/${encodeURIComponent(credentials.project_id)}/locations/${encodeURIComponent(VERTEX_LOCATION)}/publishers/google/models/${encodeURIComponent(VERTEX_IMAGEN_MODEL)}:predict`;
    const body = {
      instances: [{ prompt: _appendVariationSeedToPrompt(promptForImagen, options.variationSeed) }],
      parameters: {
        sampleCount: 1,
        aspectRatio,
        safetyFilterLevel: 'block_few',
        personGeneration: 'allow_adult',
      },
    };
    let res;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        break;
      } catch (err) {
        if (!isTransientError(err) || attempt === 3) throw err;
        await this._sleep(Math.min(TRANSIENT_RETRY_BASE_MS * attempt, 5000));
      }
    }
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    const prediction = Array.isArray(data.predictions) ? data.predictions[0] : null;
    const base64 = prediction?.bytesBase64Encoded || prediction?.image?.bytesBase64Encoded;
    if (!base64) throw new AppError('Vertex Imagen returned no image.', 502, 'GENERATION_EMPTY');

    const inputBuf = Buffer.from(base64, 'base64');
    const pngBuf = await sharp(inputBuf).png({ compressionLevel: 6 }).toBuffer();
    this._trackImageSpend(VERTEX_IMAGEN_MODEL, options.imageSize || '2K', 0, null, options.characterId);
    return {
      image: { mimeType: 'image/png', base64Data: pngBuf.toString('base64') },
      text: null,
      modelUsed: VERTEX_IMAGEN_MODEL,
      seed: options.variationSeed || null,
    };
  }

  async _buildVertexOnlyImagePrompt(prompt, options = {}) {
    const inlineParts = [];
    if (Array.isArray(options.parts)) {
      inlineParts.push(...options.parts.filter((part) => part?.inlineData?.data && part?.inlineData?.mimeType));
    }
    if (Array.isArray(options.referenceImages)) {
      for (const ref of options.referenceImages) {
        if (ref?.base64Data && ref?.mimeType) {
          inlineParts.push({ inlineData: { mimeType: ref.mimeType, data: ref.base64Data } });
        }
      }
    }
    if (inlineParts.length === 0) return prompt;

    const limitedInlineParts = inlineParts.slice(0, 6);
    const analysisPrompt = `You are preparing a prompt for Vertex Imagen. Analyze the attached images and convert them into a detailed visual brief.

Rules:
- If there is a source/photo-match image, describe its environment, camera angle, framing, pose, lighting, background, clothing, and composition.
- If there are character/reference images, describe the recurring identity traits: face shape, hair, skin tone, eyes, brows, lips, body type, tattoos, styling, and vibe.
- Be concrete and visual. Avoid saying "from the image". Do not mention policies or limitations.
- Return one compact but detailed prompt paragraph that can be used by an image generator.

User generation request:
${String(prompt || '').slice(0, 6000)}`;

    try {
      const parts = [...limitedInlineParts, { text: analysisPrompt }];
      const visualBrief = await this._generateTextInner(
        null,
        parts,
        { temperature: 0.2 },
        'Vertex reference image prompt extraction',
        options.characterId
      );
      return [
        'Generate one photorealistic image using this visual brief.',
        'Preserve the described character identity, pose, environment, camera framing, lighting, outfit, and mood as closely as possible.',
        'No text, no watermark, no collage, no extra people unless explicitly requested.',
        '',
        visualBrief,
      ].join('\n');
    } catch (err) {
      console.warn('[vertex] Reference prompt extraction failed; continuing with original prompt:', err.message);
      return prompt;
    }
  }

  _buildRetryPrompt(prompt, attempt) {
    const base = prompt.trim().slice(0, cfg.PROMPT_MAX_LENGTH);
    if (attempt <= 1) return base;
    if (attempt === 2) return `${base}\n\nOutput requirement: return exactly one image.`;
    if (attempt === 3) return `${base}\n\nOutput requirement: photorealistic single image output only, no text response.`;
    return `${base}\n\nOutput requirement: single clear photoreal image, no text.`;
  }

  _sanitizePromptForRetry(prompt, attempt) {
    let text = prompt;
    const swaps = [
      [/\bsexy\b/gi, 'stylish'], [/\bsensual\b/gi, 'elegant'], [/\bseductive\b/gi, 'confident'],
      [/\bprovocative\b/gi, 'bold'], [/\brevealing\b/gi, 'fitted'], [/\bskin-?tight\b/gi, 'form-fitting'],
      [/\bskinny\b/gi, 'slim'], [/\bbikini\b/gi, 'summer outfit'], [/\blingerie\b/gi, 'sleepwear'],
      [/\bunderwear\b/gi, 'loungewear'], [/\bcleavage\b/gi, 'neckline'], [/\blow[- ]cut\b/gi, 'open-neck'],
      [/\bbra\b/gi, 'top'], [/\bthong\b/gi, 'bottoms'], [/\bnude\b/gi, 'bare'],
      [/\bnaked\b/gi, 'unclothed'], [/\bsheer\b/gi, 'light fabric'], [/\btight\b/gi, 'fitted'],
      [/\bbody-?hugging\b/gi, 'form-fitting'], [/\bcurvy\b/gi, 'full-figured'],
      [/\bvoluptuous\b/gi, 'full-figured'], [/\bmidriff\b/gi, 'waist'],
      [/\bcrop[- ]top\b/gi, 'short top'], [/\bmini[- ]?skirt\b/gi, 'short skirt'],
      [/\bbreast\b/gi, 'curves'], [/\bbreasts\b/gi, 'curves'], [/\bboob\b/gi, 'curves'],
      [/\bboobs\b/gi, 'curves'], [/\bass\b/gi, 'hips'], [/\bbutt\b/gi, 'hips'],
      [/\bchest\b/gi, 'torso'], [/\bnaughty\b/gi, 'playful']
    ];
    for (const [pattern, replacement] of swaps) text = text.replace(pattern, replacement);
    if (attempt >= 2) {
      text = text
        .replace(/\b(bare|exposed|showing)\s+(skin|legs|stomach|chest|shoulders|back|arms)\b/gi, 'visible $2')
        .replace(/\b(tiny|micro|barely[- ]there)\b/gi, 'small');
      text = `Professional fashion photography editorial.\n${text}\nStyle: tasteful, editorial, magazine-quality composition.`;
    }
    return text;
  }

  _sanitizePartsForRetry(parts, attempt) {
    return parts.map((part) => {
      if (!part || typeof part.text !== 'string') return part;
      return { ...part, text: this._sanitizePromptForRetry(part.text, attempt) };
    });
  }

  _parseImageResponse(response) {
    const firstCandidate = Array.isArray(response?.candidates) ? response.candidates[0] : null;
    const parts = firstCandidate?.content?.parts;
    const hasNoParts = !Array.isArray(parts) || parts.length === 0;
    const finishReason = firstCandidate?.finishReason || 'unknown';
    const blockReason = response?.promptFeedback?.blockReason || 
      finishReason === 'SAFETY' || 
      finishReason === 'PROHIBITED_CONTENT' || 
      finishReason === 'IMAGE_OTHER';
    const isImageOther = finishReason === 'IMAGE_OTHER';

    if (hasNoParts) {
      console.warn(`[vertex] empty response — finishReason=${finishReason}`);
      return { hasNoParts: true, blockReason, isImageOther, imageResult: null, textResult: null };
    }

    let imageResult = null;
    let textResult = null;
    for (const part of parts) {
      if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
        imageResult = { mimeType: part.inlineData.mimeType, base64Data: part.inlineData.data };
      }
      if (part.text) textResult = `${textResult || ''}${part.text}`;
    }
    return { hasNoParts: false, blockReason, imageResult, textResult };
  }

  _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  _buildImageGenerationParts(prompt, options) {
    if (Array.isArray(options.parts) && options.parts.length > 0) {
      for (const part of options.parts) {
        if (!part || typeof part !== 'object') throw new AppError('Invalid part in options.parts', 400, 'VALIDATION_ERROR');
        if (!part.text && !part.inlineData) throw new AppError('Each part must have "text" or "inlineData"', 400, 'VALIDATION_ERROR');
        if (part.inlineData && (!part.inlineData.mimeType || !part.inlineData.data)) throw new AppError('inlineData parts must include mimeType and data', 400, 'VALIDATION_ERROR');
      }
      return _appendVariationSeedToParts(options.parts, options.variationSeed);
    }
    const parts = [];
    const referenceImages = Array.isArray(options.referenceImages) ? options.referenceImages : [];
    for (const ref of referenceImages) {
      if (!ref || typeof ref !== 'object' || !ref.base64Data || !ref.mimeType?.startsWith('image/')) continue;
      parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.base64Data } });
    }
    parts.push({ text: prompt.trim() });
    return parts;
  }

  resolveImageModel(model) {
    const requested = typeof model === 'string' ? model.trim() : '';
    if (!requested) return IMAGE_MODEL;
    if (EXPERIMENTAL_IMAGE_MODEL_ALIASES[requested]) return EXPERIMENTAL_IMAGE_MODEL_ALIASES[requested];
    if (!ALLOWED_IMAGE_MODELS.includes(requested)) {
      throw new AppError(
        `Unsupported image model "${requested}". Allowed: ${[...ALLOWED_IMAGE_MODELS, ...Object.keys(EXPERIMENTAL_IMAGE_MODEL_ALIASES)].join(', ')}`,
        400, 'VALIDATION_ERROR'
      );
    }
    return requested;
  }

  async _generateTextInner(_apiKey, contentParts, extraConfig = {}, label = 'Vertex text generation', characterId) {
    try {
      const genAI = await getClient();
      let lastErr = null;
      for (let attempt = 1; attempt <= TRANSIENT_RETRY_COUNT + 1; attempt += 1) {
        try {
          const response = await withTimeout(
            genAI.models.generateContent({
              model: TEXT_MODEL,
              contents: [{ role: 'user', parts: contentParts }],
              config: { responseModalities: [Modality.TEXT], safetySettings: SAFETY_SETTINGS, ...extraConfig },
            }),
            TEXT_TIMEOUT_MS,
            label
          );
          const parts = response.candidates?.[0]?.content?.parts;
          if (!parts || parts.length === 0) throw new AppError('No content returned from Vertex', 502, 'GENERATION_EMPTY');
          const text = parts.filter((p) => p.text).map((p) => p.text).join('');
          if (!text || text.trim().length === 0) throw new AppError('Vertex returned empty text', 502, 'GENERATION_EMPTY');
          this._trackTextSpend(response, characterId);
          return text.trim();
        } catch (innerErr) {
          if (innerErr instanceof AppError) throw innerErr;
          if (isTransientError(innerErr) && attempt <= TRANSIENT_RETRY_COUNT) {
            lastErr = innerErr;
            await this._sleep(Math.min(TRANSIENT_RETRY_BASE_MS * (2 ** (attempt - 1)), 30000));
            continue;
          }
          throw innerErr;
        }
      }
      if (lastErr) this._handleApiError(lastErr);
    } catch (err) {
      if (err instanceof AppError) throw err;
      this._handleApiError(err);
    }
  }

  async generateText(apiKey, prompt, options = {}) {
    this._checkBudget();
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) throw new AppError('A text prompt is required', 400, 'VALIDATION_ERROR');
    if (prompt.trim().length > 15000) throw new AppError('Prompt must be 15,000 characters or fewer', 400, 'VALIDATION_ERROR');
    return this._generateTextInner(apiKey, [{ text: prompt.trim() }], {
      ...(options.temperature != null && { temperature: options.temperature }),
      ...(options.responseMimeType && { responseMimeType: options.responseMimeType }),
    }, 'Vertex text generation', options.characterId);
  }

  async generateTextWithSearch(apiKey, prompt, options = {}) {
    this._checkBudget();
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) throw new AppError('A text prompt is required', 400, 'VALIDATION_ERROR');
    return this._generateTextInner(apiKey, [{ text: prompt.trim() }], {
      tools: [{ googleSearch: {} }],
      ...(options.temperature != null && { temperature: options.temperature }),
      ...(options.responseMimeType && { responseMimeType: options.responseMimeType }),
    }, 'Vertex text generation with search', options.characterId);
  }

  async analyzeImage(apiKey, imageBase64, mimeType) {
    this._checkBudget();
    if (!imageBase64 || !mimeType) throw new AppError('Image data and mime type required', 400, 'VALIDATION_ERROR');

    const analyzePrompt = `Analyze this image and extract scene details as structured JSON. Be concise — no filler, no repetition across fields. Directive tone (NOT "she is"). Return ONLY valid JSON, no markdown fences.

{
  "environment": "Setting, surfaces, furniture, and notable objects (jewelry, phone, drinks, decor) — all in one concise description. Don't repeat items across fields.",
  "lighting": "Brightness X/10. Shadow coverage %. Key light source + direction + color temp. Shadow character (hard/soft). One-line mood.",
  "camera": "Angle, height, distance, framing style, perspective, selfie vs third-person. One concise line.",
  "composition": "Subject placement, layout, visual flow, foreground/background layering, blur/bokeh if present.",
  "mood": "Emotional tone + time of day. One sentence.",
  "pose": "Full body position — posture, limb placement, hand positions, weight distribution. Directive tone.",
  "expression": "Gaze, mouth, brow, emotion. Directive tone.",
  "outfit": "Each garment: type, fabric, color, fit, neckline, length. Be accurate — do NOT make clothing more conservative than shown.",
  "format": "Always describe as iPhone photo. Note the vibe: casual selfie, candid, handheld snapshot, etc."
}`;

    const maxAttempts = TRANSIENT_RETRY_COUNT + 1;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const genAI = await getClient();
        const response = await withTimeout(
          genAI.models.generateContent({
            model: TEXT_MODEL,
            contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: analyzePrompt }] }],
            config: { responseModalities: [Modality.TEXT] },
          }),
          TEXT_TIMEOUT_MS, 'Vertex image analysis'
        );
        const parts = response.candidates?.[0]?.content?.parts;
        if (!parts || parts.length === 0) throw new AppError('No analysis returned', 502, 'GENERATION_EMPTY');
        const text = parts.filter((p) => p.text).map((p) => p.text).join('');
        this._trackTextSpend(response);
        let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        let parsed;
        try { parsed = JSON.parse(cleaned); }
        catch { const m = cleaned.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else throw new AppError('Failed to parse scene analysis', 502, 'PARSE_ERROR'); }
        return parsed;
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (isTransientError(err) && attempt < maxAttempts) { lastErr = err; await this._sleep(Math.min(TRANSIENT_RETRY_BASE_MS * (2 ** (attempt - 1)), 30000)); continue; }
        this._handleApiError(err);
      }
    }
    if (lastErr) this._handleApiError(lastErr);
  }

  async analyzeImageWithPrompt(apiKey, imageBase64, mimeType, prompt) {
    this._checkBudget();
    if (!imageBase64 || !mimeType) throw new AppError('Image data and mime type required', 400, 'VALIDATION_ERROR');
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) throw new AppError('Custom analysis prompt is required', 400, 'VALIDATION_ERROR');
    try {
      const genAI = await getClient();
      const response = await withTimeout(
        genAI.models.generateContent({
          model: TEXT_MODEL,
          contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: prompt.trim() }] }],
          config: { responseModalities: [Modality.TEXT] },
        }),
        TEXT_TIMEOUT_MS, 'Vertex image analysis'
      );
      const parts = response.candidates?.[0]?.content?.parts;
      if (!parts || parts.length === 0) throw new AppError('No analysis returned', 502, 'GENERATION_EMPTY');
      const text = parts.filter((p) => p.text).map((p) => p.text).join('').trim();
      if (!text) throw new AppError('Vertex returned empty analysis', 502, 'GENERATION_EMPTY');
      this._trackTextSpend(response);
      return text;
    } catch (err) {
      if (err instanceof AppError) throw err;
      this._handleApiError(err);
    }
  }

  async analyzeImagesWithPrompt(apiKey, images, prompt) {
    this._checkBudget();
    if (!Array.isArray(images) || images.length === 0) throw new AppError('At least one image is required', 400, 'VALIDATION_ERROR');
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) throw new AppError('Custom analysis prompt is required', 400, 'VALIDATION_ERROR');
    const parts = [];
    for (const img of images) {
      if (!img || !img.base64Data || !img.mimeType) throw new AppError('Each image must include base64Data and mimeType', 400, 'VALIDATION_ERROR');
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64Data } });
    }
    parts.push({ text: prompt.trim() });
    try {
      const genAI = await getClient();
      const response = await withTimeout(
        genAI.models.generateContent({
          model: TEXT_MODEL,
          contents: [{ role: 'user', parts }],
          config: { responseModalities: [Modality.TEXT] },
        }),
        TEXT_TIMEOUT_MS, 'Vertex multi-image analysis'
      );
      const rParts = response.candidates?.[0]?.content?.parts;
      if (!rParts || rParts.length === 0) throw new AppError('No analysis returned', 502, 'GENERATION_EMPTY');
      const text = rParts.filter((p) => p.text).map((p) => p.text).join('').trim();
      if (!text) throw new AppError('Vertex returned empty analysis', 502, 'GENERATION_EMPTY');
      this._trackTextSpend(response);
      return text;
    } catch (err) {
      if (err instanceof AppError) throw err;
      this._handleApiError(err);
    }
  }

  async enhancePrompt(apiKey, rawPrompt, context = {}) {
    this._checkBudget();
    if (!rawPrompt || typeof rawPrompt !== 'string' || rawPrompt.trim().length < 5) return rawPrompt;
    const systemPrompt = `You are a professional photography prompt engineer. Enhance the user's image generation prompt by adding technical photography details that will make the result more photorealistic and visually compelling.

ADD these details where missing (only if not already specified):
- Camera/lens specifics (e.g. "shot on 35mm f/1.4", "85mm portrait lens")
- Lighting details (e.g. "golden hour side-lighting", "soft diffused window light")
- Skin/texture realism cues (e.g. "natural skin texture with subtle pores")
- Composition notes (e.g. "rule of thirds framing", "shallow depth of field")
- Color/mood details (e.g. "warm amber tones", "desaturated cool palette")

RULES:
- Keep the original intent and subject exactly as described
- Do NOT change clothing, pose, expression, scene, or character details
- Do NOT wrap in quotes or add explanations — return ONLY the enhanced prompt text
- Keep it concise — add 1-3 sentences of technical detail, not a paragraph

${context.characterName ? `Character: ${context.characterName}` : ''}
${context.hasReferences ? 'Reference images will be provided alongside this prompt.' : ''}

User prompt:
${rawPrompt.trim()}`;
    return this._generateTextInner(apiKey, [{ text: systemPrompt }], { temperature: 0.3 }, 'Vertex prompt enhancement', context.characterId);
  }

  async scoreImageQuality(apiKey, imageBase64, mimeType, context = {}) {
    this._checkBudget();
    if (!imageBase64 || !mimeType) return null;
    const prompt = `Rate this AI-generated image on a scale of 0-100 for overall quality. Evaluate: COMPOSITION, REALISM, AESTHETIC APPEAL, TECHNICAL QUALITY${context.characterName ? `, IDENTITY CONSISTENCY (character: "${context.characterName}")` : ''}.
Return ONLY valid JSON: {"score": <number 0-100>, "reasons": ["<reason1>", "<reason2>", "<reason3>"]}`;
    try {
      const text = await this._generateTextInner(apiKey,
        [{ inlineData: { mimeType, data: imageBase64 } }, { text: prompt }],
        { temperature: 0.2, responseMimeType: 'application/json' },
        'Vertex image quality scoring', context.characterId
      );
      let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      let parsed;
      try { parsed = JSON.parse(cleaned); }
      catch { const m = cleaned.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else return null; }
      const score = Number(parsed.score);
      if (!Number.isFinite(score)) return null;
      return { score: Math.min(100, Math.max(0, Math.round(score))), reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5).map(String) : [] };
    } catch (err) {
      console.warn('[vertex] Quality scoring failed:', err.message);
      return null;
    }
  }

  _handleApiError(err) {
    const cause = err?.cause ? ` (${err.cause.code || ''} ${err.cause.message || ''})`.trim() : '';
    const message = `${err.message || 'Unknown Vertex/GCP error'}${cause ? ` ${cause}` : ''}`;
    console.error('[vertex] RAW ERROR:', message);
    const diagnosed = classifyVertexRuntimeError(message);
    if (diagnosed) {
      throw new AppError(diagnosed.message, 401, diagnosed.code);
    }
    if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
      throw new AppError('Rate limit reached. Wait and try again.', 429, 'RATE_LIMITED');
    }
    if (message.includes('SAFETY')) {
      throw new AppError('Prompt blocked by safety filters. Try rephrasing.', 400, 'SAFETY_BLOCKED');
    }
    if (message.includes('Timed out')) {
      throw new AppError(`Request timed out: ${message}`, 504, 'GEMINI_TIMEOUT');
    }
    if (isTransientError(err)) {
      throw new AppError('Transient error (retries exhausted): ' + message, 502, 'GEMINI_TRANSIENT');
    }
    throw new AppError(`Vertex/GCP error: ${message}`, 502, 'GEMINI_ERROR');
  }
}

GeminiVertexService.IMAGE_MODEL = IMAGE_MODEL;
GeminiVertexService.IMAGE_MODEL_ALTERNATES = IMAGE_MODEL_ALTERNATES;
GeminiVertexService.ALLOWED_IMAGE_MODELS = ALLOWED_IMAGE_MODELS;
GeminiVertexService.TEXT_MODEL = TEXT_MODEL;

module.exports = new GeminiVertexService();
