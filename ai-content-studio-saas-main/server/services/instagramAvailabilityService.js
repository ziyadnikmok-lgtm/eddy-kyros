const crypto = require('node:crypto');
const { ApifyClient } = require('apify-client');
const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const { buildLoginCookies } = require('../utils/instagramCookies');
const apiKeyManager = require('./apiKeyManager');
const cfg = require('../config');

const PROFILE_ACTOR_ID = process.env.APIFY_PROFILE_ACTOR_ID || 'apify/instagram-profile-scraper';
const QUICK_ACTOR_ID = process.env.APIFY_QUICK_ACTOR_ID || 'apify/instagram-scraper';

const AVAILABILITY_CACHE_TTL_MS = cfg.AVAILABILITY_CACHE_TTL_MS;
const _availabilityCache = new Map();

function authFingerprint(token, sessionid) {
  if (!token && !sessionid) return 'anon';
  const data = `${token || ''}:${sessionid || ''}`;
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 8);
}

function buildCacheKey(url, token, sessionid) {
  return `${url}|${authFingerprint(token, sessionid)}`;
}

function getCachedAvailability(key) {
  const entry = _availabilityCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > AVAILABILITY_CACHE_TTL_MS) {
    _availabilityCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCachedAvailability(key, result) {
  if (_availabilityCache.size > 100) {
    const oldest = _availabilityCache.keys().next().value;
    _availabilityCache.delete(oldest);
  }
  _availabilityCache.set(key, { result, ts: Date.now() });
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(asText(value));
}

async function tryActorCall(actor, payloads) {
  let lastErr = null;
  for (let i = 0; i < payloads.length; i++) {
    try {
      const run = await actor.call(payloads[i]);
      if (run?.defaultDatasetId) {
        console.log(`[availability] actor payload #${i + 1} succeeded — datasetId=${run.defaultDatasetId}`);
        return run;
      }
      console.warn(`[availability] actor payload #${i + 1} returned no datasetId`);
    } catch (err) {
      console.warn(`[availability] actor payload #${i + 1} failed: ${err.message}`);
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('Actor call failed');
}

function parseUsernameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const seg = parsed.pathname.split('/').filter(Boolean);
    const first = asText(seg[0]).toLowerCase();
    if (!first) return '';
    if (['p', 'reel', 'tv', 'stories'].includes(first)) return '';
    return seg[0];
  } catch {
    return '';
  }
}

function detectAgeRestricted(item) {
  if (!item || typeof item !== 'object') return false;
  const keys = Object.keys(item);
  for (const key of keys) {
    const low = key.toLowerCase();
    if (low.includes('age') || low.includes('restricted')) {
      const value = item[key];
      if (value === true) return true;
      if (typeof value === 'string' && /age|restricted|sensitive/i.test(value)) return true;
    }
  }
  const err = asText(item.errorDescription || item.error || '').toLowerCase();
  if (err.includes('age') || err.includes('restricted')) return true;
  return false;
}

function parseAvailabilityFromProfile(item, hasSession) {
  if (!item || typeof item !== 'object') {
    return {
      status: 'unknown',
      color: 'yellow',
      label: 'Could not verify profile - proceed with caution',
      allowed: true,
      is_private: null,
      is_verified: null,
      age_restricted: null,
      username: '',
    };
  }

  const isPrivate = item.is_private === true || item.isPrivate === true;
  const isVerified = item.is_verified === true || item.isVerified === true;
  const ageRestricted = detectAgeRestricted(item);
  const username = asText(item.username || item.userName || item.ownerUsername || '');

  if (isPrivate) {
    return {
      status: 'private',
      color: 'red',
      label: 'Private Account - cannot scrape',
      allowed: false,
      is_private: true,
      is_verified: isVerified,
      age_restricted: ageRestricted,
      username,
    };
  }
  if (ageRestricted && !hasSession) {
    return {
      status: 'age_restricted',
      color: 'yellow',
      label: 'Age-restricted - may need authenticated session',
      allowed: false,
      is_private: false,
      is_verified: isVerified,
      age_restricted: true,
      username,
    };
  }
  if (ageRestricted && hasSession) {
    return {
      status: 'age_restricted',
      color: 'yellow',
      label: 'Age-restricted - authenticated session detected, trying scrape',
      allowed: true,
      is_private: false,
      is_verified: isVerified,
      age_restricted: true,
      username,
    };
  }
  return {
    status: 'public',
    color: 'green',
    label: 'Public - ready to scrape',
    allowed: true,
    is_private: false,
    is_verified: isVerified,
    age_restricted: ageRestricted,
    username,
  };
}

async function resolveUsernameFromPostUrl(client, url, loginCookies) {
  const actor = client.actor(QUICK_ACTOR_ID);
  const payloads = [
    {
      directUrls: [url],
      startUrls: [{ url }],
      resultsType: 'posts',
      resultsLimit: 1,
      addParentData: false,
      ...(loginCookies ? { loginCookies } : {}),
    },
    {
      directUrls: [url],
      resultsType: 'posts',
      resultsLimit: 1,
      ...(loginCookies ? { loginCookies } : {}),
    },
  ];

  const run = await tryActorCall(actor, payloads);
  const listed = await client.dataset(run.defaultDatasetId).listItems({ limit: 3 });
  const items = Array.isArray(listed?.items) ? listed.items : [];
  const first = items[0] || {};
  return asText(first.ownerUsername || first.username || first.userName || first.owner?.username || '');
}

async function checkPostAvailability(url, options = {}) {
  const cleanUrl = asText(url);
  if (!cleanUrl || !isHttpUrl(cleanUrl)) {
    throw new AppError('A valid Instagram URL is required for availability check', 400, 'VALIDATION_ERROR');
  }

  const token = asText(options.apifyToken) || asText(apiKeyManager.getApifyKey()) || asText(process.env.APIFY_TOKEN);
  if (!token) {
    throw new AppError('Apify token is required', 400, 'CONFIG_ERROR');
  }
  const sessionid = asText(options.sessionid) || asText(apiKeyManager.getInstagramSessionId()) || asText(process.env.INSTAGRAM_SESSIONID);

  const cacheKey = buildCacheKey(cleanUrl, token, sessionid);
  const cached = getCachedAvailability(cacheKey);
  if (cached) {
    console.log(`[availability] cache HIT for "${cleanUrl}" → status=${cached.status}, allowed=${cached.allowed}`);
    return cached;
  }

  const loginCookies = buildLoginCookies(sessionid);
  const hasSession = !!sessionid;
  console.log(`[availability] checking: ${cleanUrl} | session=${hasSession}`);

  const client = new ApifyClient({ token });
  let username = parseUsernameFromUrl(cleanUrl);

  const unknownResult = (uname = '') => ({
    status: 'unknown',
    color: 'yellow',
    label: 'Could not verify availability - proceed with caution',
    allowed: true,
    is_private: null,
    is_verified: null,
    age_restricted: null,
    username: uname,
  });

  if (!username) {
    console.log('[availability] post/reel URL detected — skipping profile check, allowing proceed');
    return unknownResult();
  }

  const actor = client.actor(PROFILE_ACTOR_ID);
  const profileUrl = `https://www.instagram.com/${username}/`;
  const payloads = [
    { usernames: [username], resultsLimit: 1, ...(loginCookies ? { loginCookies } : {}) },
    { username, resultsLimit: 1, ...(loginCookies ? { loginCookies } : {}) },
    { directUrls: [profileUrl], startUrls: [{ url: profileUrl }], resultsLimit: 1, ...(loginCookies ? { loginCookies } : {}) },
    { directUrls: [profileUrl], resultsLimit: 1, ...(loginCookies ? { loginCookies } : {}) },
  ];

  try {
    const run = await tryActorCall(actor, payloads);
    const listed = await client.dataset(run.defaultDatasetId).listItems({ limit: 3 });
    const items = Array.isArray(listed?.items) ? listed.items : [];
    const profile = items[0] || null;
    console.log(`[availability] profile scraper returned ${items.length} item(s) for "${username}"`);
    if (profile) {
      console.log(`[availability] profile data: private=${profile.is_private ?? profile.isPrivate}, verified=${profile.is_verified ?? profile.isVerified}, username=${profile.username}`);
    } else {
      console.warn(`[availability] profile scraper returned EMPTY dataset for "${username}"`);
    }
    const result = parseAvailabilityFromProfile(profile, hasSession);
    console.log(`[availability] decision: status=${result.status}, allowed=${result.allowed}, label="${result.label}"`);
    if (result.status !== 'unknown') {
      setCachedAvailability(cacheKey, result);
    } else {
      console.log('[availability] NOT caching transient unknown result');
    }
    return result;
  } catch (profileErr) {
    console.warn(`[availability] profile scraper threw: ${profileErr.message}`);
    return unknownResult(username);
  }
}

module.exports = {
  checkPostAvailability,
  _authFingerprint: authFingerprint,
  _buildCacheKey: buildCacheKey,
  _getCachedAvailability: getCachedAvailability,
  _setCachedAvailability: setCachedAvailability,
  _clearCache: () => _availabilityCache.clear(),
};
