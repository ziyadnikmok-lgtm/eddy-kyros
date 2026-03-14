const { GoogleGenAI, Modality, ThinkingLevel, HarmCategory, HarmBlockThreshold } = require('@google/genai');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { AppError } = require('../middleware/errorHandler');
const { dedupRequest } = require('../utils/dedup');
const cfg = require('../config');

const IMAGE_MODEL = 'gemini-3-pro-image-preview';
const IMAGE_MODEL_ALTERNATES = ['gemini-3.1-flash-image-preview'];
const ALLOWED_IMAGE_MODELS = [IMAGE_MODEL, ...IMAGE_MODEL_ALTERNATES];
const MINIMAL_THINKING_IMAGE_MODELS = new Set(['gemini-3.1-flash-image-preview']);
const TEXT_MODEL = 'gemini-3-flash-preview';

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

function isTransientError(err) {
  const msg = (err && err.message) ? err.message : '';
  return (
    msg.includes('503') ||
    msg.includes('500') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('INTERNAL') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('upstream') ||
    msg.includes('Timed out')
  );
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const _clientCache = new Map();
function getClient(apiKey) {
  let client = _clientCache.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    if (_clientCache.size > 5) {
      const oldest = _clientCache.keys().next().value;
      _clientCache.delete(oldest);
    }
    _clientCache.set(apiKey, client);
  }
  return client;
}

class GeminiService {
  async generateImage(apiKey, prompt, options = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new AppError('API key is required for generation', 500, 'CONFIG_ERROR');
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new AppError('A text prompt is required', 400, 'VALIDATION_ERROR');
  }
  if (prompt.trim().length > cfg.PROMPT_MAX_LENGTH) {
    throw new AppError(`Prompt must be ${cfg.PROMPT_MAX_LENGTH.toLocaleString()} characters or fewer`, 400, 'VALIDATION_ERROR');
  }

  const refSig = Array.isArray(options.referenceImages) && options.referenceImages.length > 0
    ? `:refs${options.referenceImages.length}:${(options.referenceImages[0]?.base64Data || '').length}`
    : ':noref';
  const dedupKey = `img:${crypto.createHash('sha256').update(prompt.trim() + (options.aspectRatio || '') + (options.imageSize || '') + refSig).digest('hex')}`;
  return dedupRequest(dedupKey, () => this._generateImageInner(apiKey, prompt, options));
  }

  async _generateImageInner(apiKey, prompt, options) {
  try {
    const genAI = getClient(apiKey);
    const selectedImageModel = this.resolveImageModel(options.model);
    const config = {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
      safetySettings: SAFETY_SETTINGS,
      personGeneration: 'ALLOW_ALL',
      imageConfig: {
        aspectRatio: options.aspectRatio || "1:1",
        imageSize: options.imageSize || "2K",
      },
    };
    if (MINIMAL_THINKING_IMAGE_MODELS.has(selectedImageModel)) {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
    }

    const maxAttempts = 3;
    let currentPrompt = prompt;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const retryPrompt = this._buildRetryPrompt(currentPrompt, attempt);
        const contentParts = this._buildImageGenerationParts(retryPrompt, options);
        const response = await withTimeout(
          genAI.models.generateContent({
            model: selectedImageModel,
            contents: [{ role: 'user', parts: contentParts }],
            config,
          }),
          GENERATE_TIMEOUT_MS,
          'Gemini image generation'
        );

        const parsed = this._parseImageResponse(response);

        if (parsed.imageResult) {
          // Convert to lossless PNG if Gemini returned JPEG/WebP
          if (parsed.imageResult.mimeType !== 'image/png') {
            const inputBuf = Buffer.from(parsed.imageResult.base64Data, 'base64');
            const pngBuf = await sharp(inputBuf).png({ compressionLevel: 6 }).toBuffer();
            parsed.imageResult.base64Data = pngBuf.toString('base64');
            parsed.imageResult.mimeType = 'image/png';
          }
          return { image: parsed.imageResult, text: parsed.textResult || null, modelUsed: selectedImageModel };
        }

        if (parsed.blockReason || parsed.hasNoParts) {
          const reason = parsed.blockReason ? 'safety_block' : parsed.isImageOther ? 'IMAGE_OTHER' : 'empty_response';
          console.warn(`[gemini] attempt ${attempt}/${maxAttempts} failed: ${reason}`);
          if (attempt < maxAttempts) {
            currentPrompt = this._sanitizePromptForRetry(currentPrompt, attempt);
            await this._sleep(500 * attempt);
            continue;
          }
          throw new AppError(
            parsed.blockReason
              ? `Prompt blocked by safety filters after ${maxAttempts} attempts with progressive sanitization.`
              : `No content returned from Gemini after ${maxAttempts} attempts.`,
            parsed.blockReason ? 400 : 502,
            parsed.blockReason ? 'SAFETY_BLOCKED' : 'GENERATION_EMPTY'
          );
        }

        throw new AppError(
          parsed.textResult
            ? `Gemini returned text instead of an image: "${parsed.textResult.slice(0, 200)}"`
            : 'No image was generated. Try a different prompt.',
          422,
          'NO_IMAGE_GENERATED'
        );
      } catch (innerErr) {
        if (innerErr instanceof AppError) throw innerErr;
        if (isTransientError(innerErr) && attempt < maxAttempts) {
          await this._sleep(TRANSIENT_RETRY_BASE_MS * attempt);
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

  _buildRetryPrompt(prompt, attempt) {
    const base = prompt.trim().slice(0, cfg.PROMPT_MAX_LENGTH);
    if (attempt <= 1) return base;
    if (attempt === 2) {
      return `${base}\n\nOutput requirement: return exactly one image.`;
    }
    if (attempt === 3) {
      return `${base}\n\nOutput requirement: photorealistic single image output only, no text response.`;
    }
    return `${base}\n\nOutput requirement: single clear photoreal image, no text.`;
  }

  _sanitizePromptForRetry(prompt, attempt) {
    let text = prompt;

    const swaps = [
      [/\bsexy\b/gi, 'stylish'],
      [/\bsensual\b/gi, 'elegant'],
      [/\bseductive\b/gi, 'confident'],
      [/\bprovocative\b/gi, 'bold'],
      [/\brevealing\b/gi, 'fitted'],
      [/\bskin-?tight\b/gi, 'form-fitting'],
      [/\bskinny\b/gi, 'slim'],
      [/\bbikini\b/gi, 'summer outfit'],
      [/\blingerie\b/gi, 'sleepwear'],
      [/\bunderwear\b/gi, 'loungewear'],
      [/\bcleavage\b/gi, 'neckline'],
      [/\blow[- ]cut\b/gi, 'open-neck'],
      [/\bbra\b/gi, 'top'],
      [/\bthong\b/gi, 'bottoms'],
      [/\bnude\b/gi, 'bare'],
      [/\bnaked\b/gi, 'unclothed'],
      [/\bsheer\b/gi, 'light fabric'],
      [/\btight\b/gi, 'fitted'],
      [/\bbody-?hugging\b/gi, 'form-fitting'],
      [/\bcurvy\b/gi, 'full-figured'],
      [/\bvoluptuous\b/gi, 'full-figured'],
      [/\bmidriff\b/gi, 'waist'],
      [/\bcrop[- ]top\b/gi, 'short top'],
      [/\bmini[- ]?skirt\b/gi, 'short skirt'],
    ];
    for (const [pattern, replacement] of swaps) {
      text = text.replace(pattern, replacement);
    }

    if (attempt >= 2) {
      text = text
        .replace(/\b(bare|exposed|showing)\s+(skin|legs|stomach|chest|shoulders|back|arms)\b/gi, 'visible $2')
        .replace(/\b(tiny|micro|barely[- ]there)\b/gi, 'small');
      text = `Professional fashion photography editorial.\n${text}\nStyle: tasteful, editorial, magazine-quality composition.`;
    }

    console.log(`[gemini] sanitized prompt for retry attempt ${attempt + 1} (${prompt.length} → ${text.length} chars)`);
    return text;
  }

  _parseImageResponse(response) {
    const firstCandidate = Array.isArray(response?.candidates) ? response.candidates[0] : null;
    const parts = firstCandidate?.content?.parts;
    const hasNoParts = !Array.isArray(parts) || parts.length === 0;
    const finishReason = firstCandidate?.finishReason || 'unknown';
    const blockReason =
      response?.promptFeedback?.blockReason
      || finishReason === 'SAFETY'
      || finishReason === 'PROHIBITED_CONTENT';
    const isImageOther = finishReason === 'IMAGE_OTHER';

    if (hasNoParts) {
      const feedbackBlock = response?.promptFeedback?.blockReason || 'none';
      console.warn(`[gemini] empty response — finishReason=${finishReason}, promptFeedback.blockReason=${feedbackBlock}, candidates=${response?.candidates?.length ?? 0}`);
      return {
        hasNoParts: true,
        blockReason,
        isImageOther,
        imageResult: null,
        textResult: null,
      };
    }

    let imageResult = null;
    let textResult = null;
    for (const part of parts) {
      if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
        imageResult = {
          mimeType: part.inlineData.mimeType,
          base64Data: part.inlineData.data,
        };
      }
      if (part.text) {
        textResult = `${textResult || ''}${part.text}`;
      }
    }

    return {
      hasNoParts: false,
      blockReason,
      imageResult,
      textResult,
    };
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _buildImageGenerationParts(prompt, options) {
    if (Array.isArray(options.parts) && options.parts.length > 0) {
      for (const part of options.parts) {
        if (!part || typeof part !== 'object') {
          throw new AppError('Invalid part in options.parts — each entry must be an object', 400, 'VALIDATION_ERROR');
        }
        if (!part.text && !part.inlineData) {
          throw new AppError('Each part must have "text" or "inlineData"', 400, 'VALIDATION_ERROR');
        }
        if (part.inlineData && (!part.inlineData.mimeType || !part.inlineData.data)) {
          throw new AppError('inlineData parts must include mimeType and data', 400, 'VALIDATION_ERROR');
        }
      }
      return options.parts;
    }

    const parts = [];
    const referenceImages = Array.isArray(options.referenceImages) ? options.referenceImages : [];
    for (const ref of referenceImages) {
      if (!ref || typeof ref !== 'object') continue;
      if (!ref.base64Data || typeof ref.base64Data !== 'string') continue;
      if (!ref.mimeType || typeof ref.mimeType !== 'string' || !ref.mimeType.startsWith('image/')) continue;
      parts.push({
        inlineData: {
          mimeType: ref.mimeType,
          data: ref.base64Data,
        },
      });
    }

    parts.push({ text: prompt.trim() });
    return parts;
  }

  resolveImageModel(model) {
    const requested = typeof model === 'string' ? model.trim() : '';
    if (!requested) return IMAGE_MODEL;
    if (!ALLOWED_IMAGE_MODELS.includes(requested)) {
      throw new AppError(
        `Unsupported image model "${requested}". Allowed: ${ALLOWED_IMAGE_MODELS.join(', ')}`,
        400,
        'VALIDATION_ERROR'
      );
    }
    return requested;
  }

  async generateText(apiKey, prompt, options = {}) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new AppError('API key is required for generation', 500, 'CONFIG_ERROR');
    }
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new AppError('A text prompt is required', 400, 'VALIDATION_ERROR');
    }
    if (prompt.trim().length > 15000) {
      throw new AppError('Prompt must be 15,000 characters or fewer', 400, 'VALIDATION_ERROR');
    }

    try {
      const genAI = getClient(apiKey);
      let lastErr = null;
      for (let attempt = 1; attempt <= TRANSIENT_RETRY_COUNT + 1; attempt += 1) {
        try {
          const response = await withTimeout(
            genAI.models.generateContent({
              model: TEXT_MODEL,
              contents: [{ role: 'user', parts: [{ text: prompt.trim() }] }],
              config: { responseModalities: [Modality.TEXT], safetySettings: SAFETY_SETTINGS },
            }),
            TEXT_TIMEOUT_MS,
            'Gemini text generation'
          );

          const parts = response.candidates?.[0]?.content?.parts;
          if (!parts || parts.length === 0) {
            throw new AppError('No content returned from Gemini', 502, 'GENERATION_EMPTY');
          }

          const text = parts.filter((p) => p.text).map((p) => p.text).join('');
          if (!text || text.trim().length === 0) {
            throw new AppError('Gemini returned empty text response', 502, 'GENERATION_EMPTY');
          }
          return text.trim();
        } catch (innerErr) {
          if (innerErr instanceof AppError) throw innerErr;
          if (isTransientError(innerErr) && attempt <= TRANSIENT_RETRY_COUNT) {
            lastErr = innerErr;
            await this._sleep(TRANSIENT_RETRY_BASE_MS * attempt);
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

  async analyzeImage(apiKey, imageBase64, mimeType) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new AppError('API key is required', 500, 'CONFIG_ERROR');
    }
    if (!imageBase64 || !mimeType) {
      throw new AppError('Image data and mime type required', 400, 'VALIDATION_ERROR');
    }

    try {
      const genAI = getClient(apiKey);

      const prompt = `Analyze this image and extract scene details as structured JSON. Be concise — no filler, no repetition across fields. Directive tone (NOT "she is"). Return ONLY valid JSON, no markdown fences.

{
  "environment": "Setting, surfaces, furniture, and notable objects (jewelry, phone, drinks, decor) — all in one concise description. Don't repeat items across fields.",
  "lighting": "Brightness X/10. Shadow coverage %. Key light source + direction + color temp. Shadow character (hard/soft). One-line mood. Example: 'Brightness 3/10. 65% shadow. Camera flash, cool 5500K. Hard shadows, crushed blacks. Dark gritty nighttime.'",
  "camera": "Angle, height, distance, framing style (centered/off-center/environmental), perspective (wide/medium/close-up), selfie vs third-person. One concise line.",
  "composition": "Subject placement, layout, visual flow, foreground/background layering, blur/bokeh if present.",
  "mood": "Emotional tone + time of day. One sentence.",
  "pose": "Full body position — posture, limb placement, hand positions, weight distribution. Directive tone. Example: 'Recline on sofa, right hand holding glass, left arm behind body, head tilted back, legs extended.'",
  "expression": "Gaze, mouth, brow, emotion. Directive tone. Example: 'Eyes closed, soft smile, chin tilted up, serene.'",
  "outfit": "Each garment: type, fabric, color, fit, neckline, length. Be accurate — do NOT make clothing more conservative than shown.",
  "format": "Always describe as iPhone photo. Note the vibe: casual selfie, candid, handheld snapshot, etc. Mention any visible grain, warm/cool tones, or filters. Do NOT say professional, studio, high-ISO, or DSLR."
}`;

      const response = await withTimeout(
        genAI.models.generateContent({
          model: TEXT_MODEL,
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { mimeType, data: imageBase64 } },
              { text: prompt },
            ],
          }],
          config: { responseModalities: [Modality.TEXT] },
        }),
        TEXT_TIMEOUT_MS,
        'Gemini image analysis'
      );

      const parts = response.candidates?.[0]?.content?.parts;
      if (!parts || parts.length === 0) {
        throw new AppError('No analysis returned', 502, 'GENERATION_EMPTY');
      }

      const text = parts.filter((p) => p.text).map((p) => p.text).join('');
      let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
          parsed = JSON.parse(match[0]);
        } else {
          throw new AppError('Failed to parse scene analysis', 502, 'PARSE_ERROR');
        }
      }

      return parsed;
    } catch (err) {
      if (err instanceof AppError) throw err;
      this._handleApiError(err);
    }
  }

  async analyzeImageWithPrompt(apiKey, imageBase64, mimeType, prompt) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new AppError('API key is required', 500, 'CONFIG_ERROR');
    }
    if (!imageBase64 || !mimeType) {
      throw new AppError('Image data and mime type required', 400, 'VALIDATION_ERROR');
    }
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new AppError('Custom analysis prompt is required', 400, 'VALIDATION_ERROR');
    }

    try {
      const genAI = getClient(apiKey);
      const response = await withTimeout(
        genAI.models.generateContent({
          model: TEXT_MODEL,
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { mimeType, data: imageBase64 } },
              { text: prompt.trim() },
            ],
          }],
          config: { responseModalities: [Modality.TEXT] },
        }),
        TEXT_TIMEOUT_MS,
        'Gemini image analysis'
      );

      const parts = response.candidates?.[0]?.content?.parts;
      if (!parts || parts.length === 0) {
        throw new AppError('No analysis returned', 502, 'GENERATION_EMPTY');
      }
      const text = parts.filter((p) => p.text).map((p) => p.text).join('').trim();
      if (!text) {
        throw new AppError('Gemini returned empty analysis text', 502, 'GENERATION_EMPTY');
      }
      return text;
    } catch (err) {
      if (err instanceof AppError) throw err;
      this._handleApiError(err);
    }
  }

  async analyzeImagesWithPrompt(apiKey, images, prompt) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new AppError('API key is required', 500, 'CONFIG_ERROR');
    }
    if (!Array.isArray(images) || images.length === 0) {
      throw new AppError('At least one image is required', 400, 'VALIDATION_ERROR');
    }
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new AppError('Custom analysis prompt is required', 400, 'VALIDATION_ERROR');
    }

    const parts = [];
    for (const img of images) {
      if (!img || typeof img !== 'object' || !img.base64Data || !img.mimeType) {
        throw new AppError('Each image must include base64Data and mimeType', 400, 'VALIDATION_ERROR');
      }
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64Data } });
    }
    parts.push({ text: prompt.trim() });

    try {
      const genAI = getClient(apiKey);
      const response = await withTimeout(
        genAI.models.generateContent({
          model: TEXT_MODEL,
          contents: [{ role: 'user', parts }],
          config: { responseModalities: [Modality.TEXT] },
        }),
        TEXT_TIMEOUT_MS,
        'Gemini multi-image analysis'
      );
      const responseParts = response.candidates?.[0]?.content?.parts;
      if (!responseParts || responseParts.length === 0) {
        throw new AppError('No analysis returned', 502, 'GENERATION_EMPTY');
      }
      const text = responseParts.filter((p) => p.text).map((p) => p.text).join('').trim();
      if (!text) {
        throw new AppError('Gemini returned empty analysis text', 502, 'GENERATION_EMPTY');
      }
      return text;
    } catch (err) {
      if (err instanceof AppError) throw err;
      this._handleApiError(err);
    }
  }

  _handleApiError(err) {
    const message = err.message || 'Unknown Gemini API error';
    if (message.includes('API_KEY_INVALID') || message.includes('401')) {
      throw new AppError('Invalid Gemini API key.', 401, 'INVALID_API_KEY');
    }
    if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
      throw new AppError('Rate limit reached. Wait and try again.', 429, 'RATE_LIMITED');
    }
    if (message.includes('SAFETY')) {
      throw new AppError('Prompt blocked by safety filters. Try rephrasing.', 400, 'SAFETY_BLOCKED');
    }
    if (message.includes('Timed out')) {
      throw new AppError(`Gemini request timed out: ${message}`, 504, 'GEMINI_TIMEOUT');
    }
    if (isTransientError(err)) {
      throw new AppError(`Gemini transient error (retries exhausted): ${message}`, 502, 'GEMINI_TRANSIENT');
    }
    throw new AppError(`Gemini API error: ${message}`, 502, 'GEMINI_ERROR');
  }
}

GeminiService.IMAGE_MODEL = IMAGE_MODEL;
GeminiService.IMAGE_MODEL_ALTERNATES = IMAGE_MODEL_ALTERNATES;
GeminiService.ALLOWED_IMAGE_MODELS = ALLOWED_IMAGE_MODELS;
GeminiService.TEXT_MODEL = TEXT_MODEL;

module.exports = new GeminiService();
