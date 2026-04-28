/**
 * Gemini backend selector — runtime proxy.
 *
 * Automatically picks the right service on every call:
 *   - If Vertex credentials are saved and selected in apiKeyManager → use geminiVertexService (GCP billing)
 *   - If GEMINI_BACKEND=vertex env var is set → use geminiVertexService (ADC/env auth)
 *   - Otherwise → use geminiService (direct Gemini API key)
 *
 * Drop-in replacement for geminiService in any route:
 *   const gemini = require('../services/geminiBackend');
 *   await gemini.generateImage(apiKey, prompt, options); // same call, right backend
 *
 * When Vertex is selected, the apiKey parameter is ignored — auth comes from
 * the stored service account JSON or GOOGLE_APPLICATION_CREDENTIALS env var.
 */

const cfg = require('../config');
const log = require('../utils/logger');

function _activeService() {
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

function _isVertexService(svc) {
  return !!svc && String(svc.constructor?.name || '').toLowerCase().includes('geminivertexservice');
}

function _isRateLimitError(err) {
  if (!err) return false;
  if (err.code === 'RATE_LIMITED') return true;
  if (Number(err.statusCode) === 429) return true;
  const text = String(err.message || '').toLowerCase();
  return text.includes('rate limit') || text.includes('resource_exhausted') || text.includes('429');
}

function _getGeminiFallbackKey() {
  try {
    const apiKeyManager = require('./apiKeyManager');
    const key = typeof apiKeyManager.getFallbackGeminiKey === 'function'
      ? apiKeyManager.getFallbackGeminiKey()
      : apiKeyManager.getActiveKey();
    return typeof key === 'string' && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

module.exports = new Proxy({}, {
  get(_target, prop) {
    const svc = _activeService();
    const val = svc[prop];
    if (typeof val !== 'function') return val;

    return (...args) => {
      try {
        const out = val.apply(svc, args);
        if (!out || typeof out.then !== 'function') return out;
        return out.catch(async (err) => {
          // Fallback: if active backend is Vertex and request is rate limited,
          // retry once through direct Gemini API key (if user has one saved).
          // NOTE: This is intentional fallback — we log it clearly so the user
          // knows Vertex was rate-limited and Gemini key was used instead.
          if (!_isVertexService(svc) || !_isRateLimitError(err)) {
            throw err;
          }

          const fallbackKey = _getGeminiFallbackKey();
          if (!fallbackKey) {
            log.warn('vertex_rate_limited_no_gemini_fallback_key', { method: String(prop) });
            throw err;
          }

          const geminiService = require('./geminiService');
          const fallbackFn = geminiService[prop];
          if (typeof fallbackFn !== 'function') {
            throw err;
          }

          try {
            const retryArgs = [...args];
            retryArgs[0] = fallbackKey;
            log.warn('vertex_rate_limited_fallback_to_gemini_key', {
              method: String(prop),
              note: 'Vertex hit rate limit (429). Retrying with saved Gemini API key. To prevent this, remove Gemini keys if you only want Vertex.',
            });
            return await fallbackFn.apply(geminiService, retryArgs);
          } catch {
            throw err;
          }
        });
      } catch (err) {
        throw err;
      }
    };
  },
});
