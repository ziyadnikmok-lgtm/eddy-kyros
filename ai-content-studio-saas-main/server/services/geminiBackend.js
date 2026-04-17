/**
 * Gemini backend selector — runtime proxy.
 *
 * Automatically picks the right service on every call:
 *   - If Vertex credentials are saved in apiKeyManager → use geminiVertexService (GCP billing)
 *   - If GEMINI_BACKEND=vertex env var is set → use geminiVertexService (ADC/env auth)
 *   - Otherwise → use geminiService (direct Gemini API key)
 *
 * Drop-in replacement for geminiService in any route:
 *   const gemini = require('../services/geminiBackend');
 *   await gemini.generateImage(apiKey, prompt, options); // same call, right backend
 *
 * When Vertex is active, the apiKey parameter is ignored — auth comes from
 * the stored service account JSON or GOOGLE_APPLICATION_CREDENTIALS env var.
 */

const cfg = require('../config');

function _activeService() {
  try {
    const apiKeyManager = require('./apiKeyManager');
    if (apiKeyManager.hasVertexCredentials()) {
      return require('./geminiVertexService');
    }
  } catch { /* ignore */ }

  if (cfg.GEMINI_BACKEND === 'vertex') {
    return require('./geminiVertexService');
  }

  return require('./geminiService');
}

module.exports = new Proxy({}, {
  get(_target, prop) {
    const svc = _activeService();
    const val = svc[prop];
    return typeof val === 'function' ? val.bind(svc) : val;
  },
});
