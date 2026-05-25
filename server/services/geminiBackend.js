/**
 * Gemini hybrid backend — routes image generation to Vertex, text/analysis to direct Gemini.
 *
 * Image generation (generateImage, generateImagenImage, resolveImageModel):
 *   - If Vertex credentials are saved and selected → use geminiVertexService
 *   - Otherwise → use geminiService (direct Gemini API key)
 *
 * Text/analysis (generateText, analyzeImage, analyzeImagesWithPrompt, etc.):
 *   - Prefer geminiService (direct Gemini API key)
 *   - Automatically injects a fallback Gemini key when Vertex is active but the caller
 *     passed an empty/null key (which happens because getActiveKeyOrNull() returns null
 *     when Vertex is selected).
 *   - If the direct Gemini key is unavailable or rate-limited, fall back to OpenRouter
 *     vision analysis when configured, then Vertex text analysis.
 *
 * This lets users run Vertex for image gen while still using a Gemini key for scene
 * analysis, prompt building, carousel planning, and all other text operations.
 */

const cfg = require('../config');

function _imageService() {
  try {
    const apiKeyManager = require('./apiKeyManager');
    if (apiKeyManager.shouldUseVertexBackend()) {
      return require('./geminiVertexService');
    }
  } catch { /* ignore */ }

  if (cfg.GEMINI_BACKEND === 'vertex') {
    return require('./geminiVertexService');
  }

  return require('./geminiService');
}

function _textService() {
  return require('./geminiService');
}

function _vertexService() {
  return require('./geminiVertexService');
}

function _openRouterVisionService() {
  return require('./openRouterVisionService');
}

function _isVertexActive() {
  try {
    const apiKeyManager = require('./apiKeyManager');
    return apiKeyManager.shouldUseVertexBackend() || cfg.GEMINI_BACKEND === 'vertex';
  } catch {
    return cfg.GEMINI_BACKEND === 'vertex';
  }
}

function _injectGeminiKey(args) {
  // args[0] is typically the apiKey parameter
  if (args[0] && typeof args[0] === 'string' && args[0].trim()) {
    return args; // already have a key
  }
  try {
    const apiKeyManager = require('./apiKeyManager');
    const fallback = apiKeyManager.getFallbackGeminiKey();
    if (fallback) {
      const cloned = [...args];
      cloned[0] = fallback;
      return cloned;
    }
  } catch { /* ignore */ }
  return args;
}

// Methods that generate images → routed to Vertex when active
const IMAGE_METHODS = new Set([
  'generateImage',
  'generateImagenImage',
  '_generateImageInner',
  '_generateImagenImage',
  'resolveImageModel',
]);

// Methods that are text/analysis → always Gemini direct, with key injection
const TEXT_METHODS = new Set([
  'generateText',
  '_generateTextInner',
  'analyzeImage',
  'analyzeImageWithPrompt',
  'analyzeImagesWithPrompt',
  'generateTextWithSearch',
]);

const VISION_ANALYSIS_METHODS = new Set([
  'analyzeImage',
  'analyzeImageWithPrompt',
  'analyzeImagesWithPrompt',
]);

function _shouldFallbackTextError(err) {
  const code = String(err?.code || err?.name || '').toUpperCase();
  const message = String(err?.message || '').toLowerCase();
  return (
    code === 'RATE_LIMITED' ||
    code === 'NO_ACTIVE_KEY' ||
    code === 'CONFIG_ERROR' ||
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('api key is required') ||
    message.includes('no active api key')
  );
}

async function _runTextFallback(prop, args, originalErr) {
  if (VISION_ANALYSIS_METHODS.has(prop)) {
    try {
      const openRouter = _openRouterVisionService();
      if (openRouter.isConfigured?.()) {
        const fn = openRouter[prop];
        if (typeof fn === 'function') return await fn.apply(openRouter, args);
      }
    } catch (err) {
      if (!_isVertexActive()) throw err;
    }
  }

  if (!_isVertexActive()) throw originalErr;
  const vertex = _vertexService();
  const fallback = vertex[prop];
  if (typeof fallback !== 'function') throw originalErr;
  return fallback.apply(vertex, args);
}

module.exports = new Proxy({}, {
  get(_target, prop) {
    const isImage = IMAGE_METHODS.has(prop);
    const isText = TEXT_METHODS.has(prop) || !IMAGE_METHODS.has(prop);

    // Default: if not explicitly categorized, treat as text (safer)
    const svc = isImage && !isText ? _imageService() : _textService();
    const val = svc[prop];
    if (typeof val !== 'function') return val;

    return (...args) => {
      const finalArgs = isText ? _injectGeminiKey(args) : args;
      try {
        const out = val.apply(svc, finalArgs);
        if (!isText || !out || typeof out.then !== 'function') return out;
        return out.catch((err) => {
          if (!_isVertexActive() || !_shouldFallbackTextError(err)) throw err;
          return _runTextFallback(prop, args, err);
        });
      } catch (err) {
        if (!isText || !_isVertexActive() || !_shouldFallbackTextError(err)) throw err;
        return _runTextFallback(prop, args, err);
      }
    };
  },
});
