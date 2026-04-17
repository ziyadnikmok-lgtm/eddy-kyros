const express = require('express');
const { ApifyClient } = require('apify-client');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiService');
const { AppError } = require('../middleware/errorHandler');
const { sharedHttpsAgent } = require('../utils/httpAgent');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.KEY_HEALTH_TIMEOUT_MS, 10) || 12000;

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} check timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sanitizeErrorMessage(err) {
  const raw = (err && err.message) ? String(err.message) : 'Unknown error';
  return raw.replace(/\s+/g, ' ').slice(0, 180);
}

async function checkGeminiHealth() {
  const started = Date.now();
  let apiKey = '';
  try {
    apiKey = apiKeyManager.getActiveKey();
  } catch (err) {
    if (err?.code === 'NO_ACTIVE_KEY') {
      return {
        configured: false,
        live: false,
        status: 'missing',
        latencyMs: Date.now() - started,
        model: geminiService.constructor.TEXT_MODEL,
        message: 'No active Gemini key set',
      };
    }
    return {
      configured: false,
      live: false,
      status: 'error',
      latencyMs: Date.now() - started,
      model: geminiService.constructor.TEXT_MODEL,
      message: sanitizeErrorMessage(err),
    };
  }

  try {
    const text = await withTimeout(
      geminiService.generateText(apiKey, 'Reply with exactly: OK'),
      HEALTH_TIMEOUT_MS,
      'Gemini'
    );
    const normalized = String(text || '').trim().toUpperCase();
    const looksHealthy = normalized.includes('OK');
    return {
      configured: true,
      live: looksHealthy,
      status: looksHealthy ? 'ok' : 'degraded',
      latencyMs: Date.now() - started,
      model: geminiService.constructor.TEXT_MODEL,
      message: looksHealthy ? 'Gemini responded successfully' : `Unexpected response: ${String(text || '').slice(0, 50)}`,
    };
  } catch (err) {
    return {
      configured: true,
      live: false,
      status: 'error',
      latencyMs: Date.now() - started,
      model: geminiService.constructor.TEXT_MODEL,
      message: sanitizeErrorMessage(err),
    };
  }
}

async function checkApifyHealth() {
  const started = Date.now();
  const token = (apiKeyManager.getApifyKey() || '').trim();
  if (!token) {
    return {
      configured: false,
      live: false,
      status: 'missing',
      latencyMs: Date.now() - started,
      message: 'No Apify key stored',
    };
  }

  try {
    const client = new ApifyClient({ token });
    const user = await withTimeout(client.user().get(), HEALTH_TIMEOUT_MS, 'Apify');
    return {
      configured: true,
      live: true,
      status: 'ok',
      latencyMs: Date.now() - started,
      username: user?.username || null,
      message: user?.username ? `Connected as ${user.username}` : 'Apify token is valid',
    };
  } catch (err) {
    return {
      configured: true,
      live: false,
      status: 'error',
      latencyMs: Date.now() - started,
      message: sanitizeErrorMessage(err),
    };
  }
}

router.post('/', (req, res, next) => {
  try {
    const { name, apiKey } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new AppError('"name" is required and must be a non-empty string', 400, 'VALIDATION_ERROR');
    }
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new AppError('"apiKey" is required and must be a non-empty string', 400, 'VALIDATION_ERROR');
    }
    if (apiKey.trim().length > 200) {
      throw new AppError('"apiKey" must be 200 characters or fewer', 400, 'VALIDATION_ERROR');
    }

    const result = apiKeyManager.addKey(name, apiKey);
    invalidateHealthCache();
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/', (_req, res, next) => {
  try {
    const keys = apiKeyManager.listKeys();
    res.json({ success: true, data: keys });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/activate', (req, res, next) => {
  try {
    const { id } = req.params;
    const result = apiKeyManager.setActiveKey(id);
    invalidateHealthCache();
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/apify', (_req, res, next) => {
  try {
    const data = apiKeyManager.getApifyKeyInfo();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.put('/apify', (req, res, next) => {
  try {
    const { apiKey } = req.body || {};
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new AppError('"apiKey" is required and must be a non-empty string', 400, 'VALIDATION_ERROR');
    }
    const data = apiKeyManager.setApifyKey(apiKey);
    invalidateHealthCache();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.delete('/apify', (_req, res, next) => {
  try {
    const data = apiKeyManager.clearApifyKey();
    invalidateHealthCache();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.get('/wavespeed', (_req, res, next) => {
  try {
    const data = apiKeyManager.getWavespeedKeyInfo();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.put('/wavespeed', (req, res, next) => {
  try {
    const { apiKey } = req.body || {};
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new AppError('"apiKey" is required and must be a non-empty string', 400, 'VALIDATION_ERROR');
    }
    const data = apiKeyManager.setWavespeedKey(apiKey);
    invalidateHealthCache();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.delete('/wavespeed', (_req, res, next) => {
  try {
    const data = apiKeyManager.clearWavespeedKey();
    invalidateHealthCache();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ── Vertex AI credentials ────────────────────────────────────────────────────

router.get('/vertex', (_req, res, next) => {
  try {
    const data = apiKeyManager.getVertexCredentialsInfo();
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.put('/vertex', (req, res, next) => {
  try {
    const { credentialsJson } = req.body || {};
    if (!credentialsJson || typeof credentialsJson !== 'string' || credentialsJson.trim().length === 0) {
      throw new AppError('"credentialsJson" is required — paste the full contents of your service account JSON file', 400, 'VALIDATION_ERROR');
    }
    const data = apiKeyManager.setVertexCredentials(credentialsJson);
    invalidateHealthCache();
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.delete('/vertex', (_req, res, next) => {
  try {
    const data = apiKeyManager.clearVertexCredentials();
    invalidateHealthCache();
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.put('/active-backend', (req, res, next) => {
  try {
    const { backend } = req.body || {};
    const data = apiKeyManager.setBackendPreference(backend);
    invalidateHealthCache();
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/instagram-session', (_req, res, next) => {
  try {
    const data = apiKeyManager.getInstagramSessionInfo();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

async function checkInstagramSessionHealth() {
  const started = Date.now();
  const info = apiKeyManager.getInstagramSessionInfo();
  if (!info?.hasInstagramSession) {
    return {
      configured: false,
      live: false,
      status: 'missing',
      latencyMs: Date.now() - started,
      message: 'No Instagram session stored',
      maskedValue: '',
      updatedAt: null,
    };
  }

  const sessionid = apiKeyManager.getInstagramSessionId();
  if (!sessionid) {
    return {
      configured: true,
      live: false,
      status: 'error',
      latencyMs: Date.now() - started,
      message: 'Session stored but could not decrypt',
      maskedValue: info.maskedValue || '',
      updatedAt: info.updatedAt || null,
    };
  }

  try {
    const axios = require('axios');
    const resp = await withTimeout(
      axios.get('https://www.instagram.com/accounts/edit/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Cookie': `sessionid=${sessionid}`,
          'Accept': 'text/html',
        },
        timeout: 8000,
        httpsAgent: sharedHttpsAgent,
        maxRedirects: 0,
        validateStatus: () => true,
      }),
      HEALTH_TIMEOUT_MS,
      'Instagram session'
    );

    const status = resp.status;
    const body = typeof resp.data === 'string' ? resp.data : '';
    const usernameMatch = body.match(/"username":"([^"]+)"/);

    if (status === 200 && body.length > 1000) {
      const username = usernameMatch ? usernameMatch[1] : '';
      return {
        configured: true,
        live: true,
        status: 'active',
        latencyMs: Date.now() - started,
        message: `Session active${username ? ` (@${username})` : ''}`,
        maskedValue: info.maskedValue || '',
        updatedAt: info.updatedAt || null,
      };
    }

    if (status === 302 || status === 301 || status === 401 || status === 403) {
      return {
        configured: true,
        live: false,
        status: 'expired',
        latencyMs: Date.now() - started,
        message: 'Session expired — please update your sessionid',
        maskedValue: info.maskedValue || '',
        updatedAt: info.updatedAt || null,
      };
    }

    return {
      configured: true,
      live: false,
      status: 'expired',
      latencyMs: Date.now() - started,
      message: `Session likely expired (HTTP ${status}, no user data)`,
      maskedValue: info.maskedValue || '',
      updatedAt: info.updatedAt || null,
    };
  } catch (err) {
    return {
      configured: true,
      live: false,
      status: 'error',
      latencyMs: Date.now() - started,
      message: `Could not verify session: ${sanitizeErrorMessage(err)}`,
      maskedValue: info.maskedValue || '',
      updatedAt: info.updatedAt || null,
    };
  }
}

async function checkVertexHealth() {
  const started = Date.now();
  const info = apiKeyManager.getVertexCredentialsInfo();
  if (!info?.hasVertexCredentials) {
    return {
      configured: false,
      live: false,
      status: 'missing',
      latencyMs: Date.now() - started,
      projectId: '',
      message: 'No Vertex credentials stored',
    };
  }

  try {
    const geminiVertexService = require('../services/geminiVertexService');
    const text = await withTimeout(
      geminiVertexService.generateText(null, 'Reply with exactly: OK'),
      HEALTH_TIMEOUT_MS,
      'Vertex'
    );
    const normalized = String(text || '').trim().toUpperCase();
    const looksHealthy = normalized.includes('OK');
    return {
      configured: true,
      live: looksHealthy,
      status: looksHealthy ? 'ok' : 'degraded',
      latencyMs: Date.now() - started,
      projectId: info.projectId,
      clientEmail: info.clientEmail,
      message: looksHealthy ? `Vertex AI connected (${info.projectId})` : `Unexpected response: ${String(text || '').slice(0, 50)}`,
    };
  } catch (err) {
    return {
      configured: true,
      live: false,
      status: 'error',
      latencyMs: Date.now() - started,
      projectId: info.projectId,
      message: sanitizeErrorMessage(err),
    };
  }
}

async function checkWavespeedHealth() {
  const started = Date.now();
  const token = (apiKeyManager.getWavespeedKey() || '').trim();
  if (!token) {
    return {
      configured: false,
      live: false,
      status: 'missing',
      latencyMs: Date.now() - started,
      message: 'No WaveSpeed key stored',
    };
  }

  try {
    const resp = await withTimeout(
      fetch('https://api.wavespeed.ai/api/v3/predictions/health-ping', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }),
      HEALTH_TIMEOUT_MS,
      'WaveSpeed'
    );
    const ok = resp.status === 200 || resp.status === 404;
    return {
      configured: true,
      live: resp.status !== 401 && resp.status !== 403,
      status: resp.status === 401 || resp.status === 403 ? 'invalid' : 'ok',
      latencyMs: Date.now() - started,
      message: resp.status === 401 ? 'Invalid API key' : resp.status === 403 ? 'Key restricted' : 'WaveSpeed connected',
    };
  } catch (err) {
    return {
      configured: true,
      live: false,
      status: 'error',
      latencyMs: Date.now() - started,
      message: sanitizeErrorMessage(err),
    };
  }
}

const HEALTH_CACHE_TTL_MS = 30_000;
let _healthSnapshot = { cache: null, ts: 0 };

function invalidateHealthCache() {
  _healthSnapshot = { cache: null, ts: 0 };
}

router.get('/health-check', async (_req, res, next) => {
  try {
    const snap = _healthSnapshot;
    if (snap.cache && Date.now() - snap.ts < HEALTH_CACHE_TTL_MS) {
      return res.json({ success: true, data: { ...snap.cache, cached: true } });
    }

    const [gemini, apify, ig, wavespeed, vertex] = await Promise.all([
      checkGeminiHealth(),
      checkApifyHealth(),
      checkInstagramSessionHealth(),
      checkWavespeedHealth(),
      checkVertexHealth(),
    ]);

    const allMissing = [gemini, apify].every((item) => item.status === 'missing');
    const allLive = [gemini, apify].every((item) => item.live);
    const overall = allMissing ? 'not_configured' : (allLive ? 'ok' : 'degraded');

    const result = {
      checkedAt: new Date().toISOString(),
      overall,
      gemini,
      apify,
      instagramSession: ig,
      wavespeed,
      vertex,
    };
    _healthSnapshot = { cache: result, ts: Date.now() };

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.put('/instagram-session', (req, res, next) => {
  try {
    const { sessionid } = req.body || {};
    if (!sessionid || typeof sessionid !== 'string' || sessionid.trim().length === 0) {
      throw new AppError('"sessionid" is required and must be a non-empty string', 400, 'VALIDATION_ERROR');
    }
    const data = apiKeyManager.setInstagramSessionId(sessionid);
    invalidateHealthCache();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.delete('/instagram-session', (_req, res, next) => {
  try {
    const data = apiKeyManager.clearInstagramSessionId();
    invalidateHealthCache();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.get('/instagram-login', (_req, res, next) => {
  try {
    const data = apiKeyManager.getInstagramLoginInfo();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.put('/instagram-login', (req, res, next) => {
  try {
    const { username, password, twoFaSecret } = req.body || {};
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      throw new AppError('"username" is required', 400, 'VALIDATION_ERROR');
    }
    if (!password || typeof password !== 'string' || password.trim().length === 0) {
      throw new AppError('"password" is required', 400, 'VALIDATION_ERROR');
    }
    const data = apiKeyManager.setInstagramLogin(username, password, twoFaSecret || null);
    invalidateHealthCache();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.delete('/instagram-login', (_req, res, next) => {
  try {
    const data = apiKeyManager.clearInstagramLogin();
    invalidateHealthCache();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post('/ig-auto-refresh', async (req, res, next) => {
  try {
    const { refreshInstagramSession } = require('../services/igAutoLogin');
    const result = await refreshInstagramSession();
    invalidateHealthCache();
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/budget', (req, res, next) => {
  try {
    const { id } = req.params;
    const { budgetUsd } = req.body || {};
    if (typeof budgetUsd !== 'number') throw new AppError('"budgetUsd" must be a number', 400, 'VALIDATION_ERROR');
    const result = apiKeyManager.setBudget(id, budgetUsd);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const { id } = req.params;
    const result = apiKeyManager.removeKey(id);
    invalidateHealthCache();
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// --- Spend tracking ---

router.get('/spend', (_req, res, next) => {
  try {
    res.json({ success: true, data: apiKeyManager.getSpendInfo() });
  } catch (err) { next(err); }
});

router.post('/spend/reset', (_req, res, next) => {
  try {
    res.json({ success: true, data: apiKeyManager.resetSpend() });
  } catch (err) { next(err); }
});

// --- Key access audit log (admin only) ---

router.get('/access-log', requireAdmin, (_req, res, next) => {
  try {
    const n = 100;
    const entries = apiKeyManager.getKeyAccessLog(n);
    res.json({ success: true, data: entries });
  } catch (err) { next(err); }
});

module.exports = router;
