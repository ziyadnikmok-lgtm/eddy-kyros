/**
 * Gemini hybrid backend — routes image generation to Vertex, text/analysis to direct Gemini.
 *
 * Image generation (generateImage, generateImagenImage, resolveImageModel):
 *   - If options.provider === 'gemini' → force geminiService (direct API key), no Vertex fallback
 *   - If options.provider === 'vertex' → force geminiVertexService, no Gemini fallback
 *   - If Vertex credentials are saved and selected → use geminiVertexService
 *   - Otherwise → use geminiService (direct Gemini API key)
 *
 * Text/analysis (generateText, analyzeImage, analyzeImagesWithPrompt, etc.):
 *   - Prefer geminiService (direct Gemini API key)
 *   - Automatically injects a fallback Gemini key when Vertex is active but the caller
 *     passed an empty/null key.
 *   - If the direct Gemini key is unavailable or rate-limited, fall back to OpenRouter
 *     vision analysis when configured, then Vertex text analysis.
 */

const cfg = require('../config');

function _geminiService() {
  return require('./geminiService');
}

function _vertexService() {
  return require('./geminiVertexService');
}

function _imageService(provider) {
  if (provider === 'gemini') return _geminiService();
  if (provider === 'vertex') return _vertexService();

  try {
    const apiKeyManager = require('./apiKeyManager');
    if (apiKeyManager.shouldUseVertexBackend()) {
      return _vertexService();
    }
  } catch { /* ignore */ }

  if (cfg.GEMINI_BACKEND === 'vertex') {
    return _vertexService();
  }

  return _geminiService();
}

function _textService() {
  return _geminiService();
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

function _limitPinnedImageAttempts(args) {
  const cloned = [...args];
  const lastIndex = cloned.length - 1;
  const options = cloned[lastIndex] && typeof cloned[lastIndex] === 'object' ? cloned[lastIndex] : {};
  cloned[lastIndex] = { ...options, maxAttempts: 1 };
  return cloned;
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

    return (...args) => {
      // Detect explicit provider override from the last argument (options object)
      let explicitProvider = null;
      const lastArg = args[args.length - 1];
      if (lastArg && typeof lastArg === 'object' && lastArg.provider) {
        explicitProvider = lastArg.provider;
      }

      // Default: if not explicitly categorized, treat as text (safer)
      const svc = isImage && !isText
        ? _imageService(explicitProvider)
        : _textService();
      const val = svc[prop];
      if (typeof val !== 'function') return val;

      const pinnedProvider = explicitProvider === 'gemini' || explicitProvider === 'vertex';
      let finalArgs = args;
      if (isImage && pinnedProvider) finalArgs = _limitPinnedImageAttempts(finalArgs);
      if (isText || (isImage && explicitProvider === 'gemini')) finalArgs = _injectGeminiKey(finalArgs);
      try {
        const out = val.apply(svc, finalArgs);
        if (!isText || !out || typeof out.then !== 'function') return out;
        return out.catch((err) => {
          if (pinnedProvider || !_isVertexActive() || !_shouldFallbackTextError(err)) throw err;
          return _runTextFallback(prop, args, err);
        });
      } catch (err) {
        if (!isText || pinnedProvider || !_isVertexActive() || !_shouldFallbackTextError(err)) throw err;
        return _runTextFallback(prop, args, err);
      }
    };
  },
});
