const BASE = '/api';

// Default timeouts by operation type (ms)
const DEFAULT_TIMEOUT_MS = 30_000;       // 30s for standard CRUD
const LONG_TIMEOUT_MS = 5 * 60_000;     // 5 min for generation/clone ops
const PROFILE_TIMEOUT_MS = 15 * 60_000; // 15 min for profile scrape (many slides)

// Paths that are known long-running operations
const LONG_RUNNING_PATHS = [
  '/generate', '/batch', '/tweak',
  '/post-clone', '/reel-copy',
  '/carousel/execute', '/carousel/follow-up',
  '/scene/recreate', '/story/generate',
  '/auto/plan', '/auto/execute',
];

// Extra-long paths (profile scrape processes many carousels)
const EXTRA_LONG_PATHS = ['/profile-clone'];

function getTimeoutForPath(path, method) {
  if (method === 'GET') return DEFAULT_TIMEOUT_MS;
  for (const prefix of EXTRA_LONG_PATHS) {
    if (path.startsWith(prefix)) return PROFILE_TIMEOUT_MS;
  }
  for (const prefix of LONG_RUNNING_PATHS) {
    if (path.startsWith(prefix)) return LONG_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

// Retry config — only GET requests are retried (idempotent)
const RETRY_MAX = 2;
const RETRY_BASE_MS = 500;

function _isRetryable(err) {
  if (err.code === 'TIMEOUT') return true;
  if (err.name === 'TypeError' && err.message?.includes('fetch')) return true; // network failure only
  if (err.status >= 500) return true;
  return false;
}

async function request(path, options = {}) {
  const { method = 'GET', body, signal: externalSignal, timeoutMs } = options;
  const maxRetries = method === 'GET' ? RETRY_MAX : 0;

  for (let attempt = 0; ; attempt++) {
    try {
      return await _fetchOnce(path, method, body, externalSignal, timeoutMs);
    } catch (err) {
      if (attempt < maxRetries && _isRetryable(err) && !externalSignal?.aborted) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}

async function _fetchOnce(path, method, body, externalSignal, timeoutMs) {
  const resolvedTimeout = timeoutMs || getTimeoutForPath(path, method);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolvedTimeout);

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  const config = { method, headers: {}, signal: controller.signal };
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  if (isFormData) {
    config.body = body;
  } else if (body !== undefined) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(`${BASE}${path}`, config);
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message || `Request failed (${res.status})`;
      const err = new Error(msg);
      err.code = json?.error?.code || 'UNKNOWN';
      err.status = res.status;
      throw err;
    }
    return json?.data ?? json;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`Request timed out after ${Math.round(resolvedTimeout / 1000)}s`);
      timeoutErr.code = 'TIMEOUT';
      timeoutErr.status = 0;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- Keys ---
export const keys = {
  list: () => request('/keys'),
  add: (name, apiKey) => request('/keys', { method: 'POST', body: { name, apiKey } }),
  activate: (id) => request(`/keys/${id}/activate`, { method: 'PUT' }),
  remove: (id) => request(`/keys/${id}`, { method: 'DELETE' }),
  getApify: () => request('/keys/apify'),
  setApify: (apiKey) => request('/keys/apify', { method: 'PUT', body: { apiKey } }),
  clearApify: () => request('/keys/apify', { method: 'DELETE' }),
  getInstagramSession: () => request('/keys/instagram-session'),
  setInstagramSession: (sessionid) => request('/keys/instagram-session', { method: 'PUT', body: { sessionid } }),
  clearInstagramSession: () => request('/keys/instagram-session', { method: 'DELETE' }),
  getInstagramLogin: () => request('/keys/instagram-login'),
  setInstagramLogin: (username, password, twoFaSecret) => request('/keys/instagram-login', { method: 'PUT', body: { username, password, twoFaSecret: twoFaSecret || undefined } }),
  clearInstagramLogin: () => request('/keys/instagram-login', { method: 'DELETE' }),
  igAutoRefresh: () => request('/keys/ig-auto-refresh', { method: 'POST' }),
  healthCheck: () => request('/keys/health-check'),
};

// --- Characters ---
export const characters = {
  list: () => request('/characters'),
  get: (id) => request(`/characters/${id}`),
  create: (data) => request('/characters', { method: 'POST', body: data }),
  update: (id, data) => request(`/characters/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/characters/${id}`, { method: 'DELETE' }),
  addReference: (id, data) => request(`/characters/${id}/references`, { method: 'POST', body: data }),
  toggleReference: (id, refId) => request(`/characters/${id}/references/${refId}/toggle`, { method: 'PATCH' }),
  removeReference: (id, refId) => request(`/characters/${id}/references/${refId}`, { method: 'DELETE' }),
  addPrimaryImage: (id, data) => request(`/characters/${id}/primary-images`, { method: 'POST', body: data }),
  removePrimaryImage: (id, index) => request(`/characters/${id}/primary-images/${index}`, { method: 'DELETE' }),
  imageUrl: (id) => `${BASE}/characters/${id}/image`,
  primaryImageUrl: (id, index) => `${BASE}/characters/${id}/primary-images/${index}`,
  refImageUrl: (id, refId) => `${BASE}/characters/${id}/references/${refId}/image`,
};

// --- Generate ---
export const generate = {
  image: (body) => request('/generate', { method: 'POST', body }),
};

// --- Batch ---
export const batch = {
  list: (status) => request(`/batch${status ? `?status=${status}` : ''}`),
  start: (body) => request('/batch', { method: 'POST', body }),
  get: (jobId) => request(`/batch/${jobId}`),
  cancel: (jobId) => request(`/batch/${jobId}/cancel`, { method: 'POST' }),
  retry: (jobId) => request(`/batch/${jobId}/retry`, { method: 'POST' }),
  remove: (jobId) => request(`/batch/${jobId}`, { method: 'DELETE' }),
  stats: () => request('/batch/stats'),
  /** Returns an EventSource for real-time progress. Caller must close it. */
  progress: (jobId) => new EventSource(`${BASE}/batch/${jobId}/progress`),
};

// --- Tweak ---
export const tweak = {
  create: (body) => request('/tweak', { method: 'POST', body }),
};

// --- Images (in-memory store) ---
export const images = {
  list: () => request('/images'),
  get: (id) => request(`/images/${id}`),
  children: (id) => request(`/images/${id}/children`),
};

// --- Gallery (persistent) ---
export const gallery = {
  list: () => request('/gallery'),
  get: (id) => request(`/gallery/${id}`),
  remove: (id) => request(`/gallery/${id}`, { method: 'DELETE' }),
  toggleFavorite: (id) => request(`/gallery/${id}/favorite`, { method: 'PATCH' }),
  bulkRemove: (ids) => request('/gallery/bulk', { method: 'DELETE', body: { ids } }),
  bulkDownload: async (ids) => {
    const res = await fetch(`${BASE}/gallery/bulk-download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new Error(json?.error?.message || `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gallery-${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  },
  imageUrl: (id) => `${BASE}/gallery/${id}/image`,
  openFolder: (id) => request(`/gallery/${id}/open-folder`, { method: 'POST' }),
  listTags: () => request('/gallery/tags'),
  updateTags: (id, tags) => request(`/gallery/${id}/tags`, { method: 'PATCH', body: { tags } }),
  addTag: (id, tag) => request(`/gallery/${id}/tags`, { method: 'POST', body: { tag } }),
  removeTag: (id, tag) => request(`/gallery/${id}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' }),
};

// --- Scene ---
export const scene = {
  analyze: (image, mimeType) => request('/scene/analyze', { method: 'POST', body: { image, mimeType } }),
  recreate: (body) => request('/scene/recreate', { method: 'POST', body }),
};

// --- Niches ---
export const niches = {
  list: () => request('/niches'),
  get: (id) => request(`/niches/${id}`),
  create: (data) => request('/niches', { method: 'POST', body: data }),
  update: (id, data) => request(`/niches/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/niches/${id}`, { method: 'DELETE' }),
};

// --- Brand Voice ---
export const brandVoice = {
  get: () => request('/brand-voice'),
  update: (data) => request('/brand-voice', { method: 'PATCH', body: data }),
};

// --- Story ---
export const story = {
  generate: (body) => request('/story/generate', { method: 'POST', body }),
};

// --- Carousel ---
export const carousel = {
  plan: (body) => request('/carousel/plan', { method: 'POST', body }),
  execute: (body) => request('/carousel/execute', { method: 'POST', body }),
  followUp: (body) => request('/carousel/follow-up', { method: 'POST', body }),
  polls: (body) => request('/carousel/polls', { method: 'POST', body }),
};

// --- Reel Recreate ---
export const reel = {
  recreate: (body) => request('/reel-copy', { method: 'POST', body }),
};

// --- Post Clone ---
export const postClone = {
  clonePost: (body) => request('/post-clone', { method: 'POST', body }),
  cloneProfile: (body) => request('/profile-clone', { method: 'POST', body }),
  fetchProfile: (body) => request('/profile-clone/fetch', { method: 'POST', body }),
  recreateSelected: (body) => request('/profile-clone/recreate', { method: 'POST', body }),
  proxyImageUrl: (url) => `${BASE}/post-clone/proxy-image?url=${encodeURIComponent(url)}`,
  thumbUrl: (filename) => filename ? `${BASE}/post-clone/thumb/${filename}` : '',
};

// --- Clone History ---
export const postCloneHistory = {
  list: () => request('/post-clone/history'),
  remove: (id) => request(`/post-clone/history/${id}`, { method: 'DELETE' }),
  imageUrl: (galleryId) => `${BASE}/gallery/${galleryId}/image`,
};

// --- Style Focus ---
export const styleFocus = {
  list: () => request('/post-clone/style-focus'),
  get: (id) => request(`/post-clone/style-focus/${id}`),
  save: (data) => request('/post-clone/style-focus', { method: 'POST', body: data }),
  remove: (id) => request(`/post-clone/style-focus/${id}`, { method: 'DELETE' }),
};

// --- Prompt Knowledge ---
export const promptKnowledge = {
  list: (query = '') => request(`/prompt-knowledge${query ? `?${query}` : ''}`),
};

// --- Templates ---
export const templates = {
  list: (page) => request(`/templates${page ? `?page=${page}` : ''}`),
  get: (id) => request(`/templates/${id}`),
  create: (data) => request('/templates', { method: 'POST', body: data }),
  update: (id, data) => request(`/templates/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/templates/${id}`, { method: 'DELETE' }),
};

// --- Caption Templates ---
export const captionTemplates = {
  list: (category) => request(`/caption-templates${category ? `?category=${category}` : ''}`),
  get: (id) => request(`/caption-templates/${id}`),
  create: (data) => request('/caption-templates', { method: 'POST', body: data }),
  update: (id, data) => request(`/caption-templates/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/caption-templates/${id}`, { method: 'DELETE' }),
  suggest: (category, limit) => request(`/caption-templates/suggest?category=${encodeURIComponent(category || '')}&limit=${limit || 5}`),
  markUsed: (id) => request(`/caption-templates/${id}/use`, { method: 'POST' }),
};

// --- Instagram availability precheck ---
export const availability = {
  // Availability checks can be slow when Apify actor queues are busy.
  check: (url) => request('/availability/check', { method: 'POST', body: { url }, timeoutMs: LONG_TIMEOUT_MS }),
};

// --- Style Library ---
export const styleLibrary = {
  list: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    }
    const q = qs.toString();
    return request(`/style-library${q ? `?${q}` : ''}`);
  },
  get: (id) => request(`/style-library/${id}`),
  create: (data) => request('/style-library', { method: 'POST', body: data }),
  bulkCreate: (atoms) => request('/style-library/bulk', { method: 'POST', body: { atoms } }),
  update: (id, data) => request(`/style-library/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/style-library/${id}`, { method: 'DELETE' }),
  bulkDelete: (ids) => request('/style-library/bulk-delete', { method: 'POST', body: { ids } }),
  removeAll: () => request('/style-library/all', { method: 'DELETE' }),
  getDuplicateCount: () => request('/style-library/duplicates'),
  deleteDuplicates: () => request('/style-library/delete-duplicates', { method: 'POST' }),
  removeBySource: (username) => request(`/style-library/source/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  compose: (atomIds) => request('/style-library/compose', { method: 'POST', body: { atomIds } }),
  importJSON: (jsonData, sourceLabel) => request('/style-library/import-json', { method: 'POST', body: { jsonData, sourceLabel } }),
  backfill: () => request('/style-library/backfill', { method: 'POST' }),
  suggest: (atomIds, targetCategories) => request('/style-library/suggest', { method: 'POST', body: { atomIds, targetCategories } }),
  stats: () => request('/style-library/stats'),
  profiles: () => request('/style-library/profiles'),
  contentPresets: () => request('/style-library/content-presets'),
};

// --- Auto Plans ---
export const autoPlans = {
  list: () => request('/auto/plans'),
  get: (id) => request(`/auto/plans/${id}`),
  save: (data) => request('/auto/plans', { method: 'POST', body: data }),
  update: (id, data) => request(`/auto/plans/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/auto/plans/${id}`, { method: 'DELETE' }),
  executeDay: (id, dayNumber) => request(`/auto/plans/${id}/execute-day`, { method: 'POST', body: { dayNumber } }),
};

// --- Profile Analyzer ---
export const profileAnalyzer = {
  /** Returns an EventSource for SSE streaming. Caller must close it.
   *  @param {string} username
   *  @param {number} postLimit
   *  @param {object} opts - { sort?: 'newest'|'oldest', newerThan?: string }
   */
  analyze: (username, postLimit = 12, opts = {}) => {
    const params = { username, postLimit: String(postLimit) };
    if (opts.sort) params.sort = opts.sort;
    if (opts.newerThan) params.newerThan = opts.newerThan;
    const qs = new URLSearchParams(params);
    return new EventSource(`${BASE}/profile-analyzer/analyze?${qs}`);
  },
  save: (body) => request('/profile-analyzer/save', { method: 'POST', body }),
};
