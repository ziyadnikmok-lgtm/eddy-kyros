const { AppError } = require('../middleware/errorHandler');
const cfg = require('../config');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = cfg.GEMINI_TEXT_TIMEOUT_MS || 120_000;

function _key() {
  return String(cfg.OPENROUTER_API_KEY || '').trim();
}

function _model() {
  return String(cfg.OPENROUTER_VISION_MODEL || 'qwen/qwen2.5-vl-72b-instruct:free').trim();
}

function _dataUrl(imageBase64, mimeType) {
  const raw = String(imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  return `data:${mimeType || 'image/png'};base64,${raw}`;
}

function _extractJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new AppError('OpenRouter returned non-JSON analysis', 502, 'PARSE_ERROR');
    return JSON.parse(match[0]);
  }
}

async function _chat(messages, label = 'OpenRouter vision analysis') {
  const apiKey = _key();
  if (!apiKey) throw new AppError('OpenRouter API key is not configured', 500, 'OPENROUTER_KEY_REQUIRED');

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://kyros-studio.xyz',
      'X-Title': 'Kyros Studio',
    },
    body: JSON.stringify({
      model: _model(),
      messages,
      temperature: 0.2,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const status = res.status === 429 ? 429 : 502;
    const code = res.status === 429 ? 'RATE_LIMITED' : 'OPENROUTER_ERROR';
    throw new AppError(`${label} failed (${res.status}): ${text.slice(0, 240)}`, status, code);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    throw new AppError('OpenRouter returned empty analysis', 502, 'GENERATION_EMPTY');
  }
  return text.trim();
}

const SCENE_ANALYSIS_PROMPT = `Analyze this image and extract scene details as structured JSON. Be concise, accurate, and visual. Return ONLY valid JSON, no markdown fences.

{
  "environment": "Setting, surfaces, furniture, and notable objects in one concise description.",
  "lighting": "Brightness X/10. Shadow coverage %. Key light source + direction + color temp. Shadow character. One-line mood.",
  "camera": "Angle, height, distance, framing style, perspective, selfie vs third-person. One concise line.",
  "composition": "Subject placement, layout, foreground/background layering, blur/bokeh if present.",
  "mood": "Emotional tone + time of day. One sentence.",
  "pose": "Full body position, posture, limb placement, hand positions, weight distribution. Directive tone.",
  "expression": "Gaze, mouth, brow, emotion. Directive tone.",
  "outfit": "Each garment: type, fabric, color, fit, neckline, length. Be accurate; do not make clothing more conservative than shown.",
  "format": "Describe as iPhone/candid/handheld/selfie style when appropriate. Mention grain, tones, filters."
}`;

class OpenRouterVisionService {
  isConfigured() {
    return !!_key();
  }

  async analyzeImage(_apiKey, imageBase64, mimeType) {
    if (!imageBase64 || !mimeType) throw new AppError('Image data and mime type required', 400, 'VALIDATION_ERROR');
    const text = await _chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: SCENE_ANALYSIS_PROMPT },
          { type: 'image_url', image_url: { url: _dataUrl(imageBase64, mimeType) } },
        ],
      },
    ], 'OpenRouter scene analysis');
    return _extractJson(text);
  }

  async analyzeImageWithPrompt(_apiKey, imageBase64, mimeType, prompt) {
    if (!imageBase64 || !mimeType) throw new AppError('Image data and mime type required', 400, 'VALIDATION_ERROR');
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) throw new AppError('Custom analysis prompt is required', 400, 'VALIDATION_ERROR');
    return _chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt.trim() },
          { type: 'image_url', image_url: { url: _dataUrl(imageBase64, mimeType) } },
        ],
      },
    ], 'OpenRouter image analysis');
  }

  async analyzeImagesWithPrompt(_apiKey, images, prompt) {
    if (!Array.isArray(images) || images.length === 0) throw new AppError('At least one image is required', 400, 'VALIDATION_ERROR');
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) throw new AppError('Custom analysis prompt is required', 400, 'VALIDATION_ERROR');
    const content = [{ type: 'text', text: prompt.trim() }];
    for (const img of images) {
      if (!img?.base64Data || !img?.mimeType) throw new AppError('Each image must include base64Data and mimeType', 400, 'VALIDATION_ERROR');
      content.push({ type: 'image_url', image_url: { url: _dataUrl(img.base64Data, img.mimeType) } });
    }
    return _chat([{ role: 'user', content }], 'OpenRouter multi-image analysis');
  }
}

module.exports = new OpenRouterVisionService();
