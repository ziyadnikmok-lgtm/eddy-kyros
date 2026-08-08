const BASE = '/api';

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 5 * 60_000;
const VIDEO_ANALYZE_TIMEOUT_MS = 3 * 60_000;
const PROFILE_TIMEOUT_MS = 15 * 60_000;

const LONG_RUNNING_PATHS = [
  '/generate', '/batch', '/tweak',
  '/post-clone', '/reel-copy',
  '/carousel/execute', '/carousel/follow-up',
  '/scene/recreate', '/scene/analyze', '/pose-remix/suggest', '/pinterest/recreate', '/story/generate',
  '/auto/plan', '/auto/execute',
  '/video/generate', '/reformat',
  '/nsfw-generate', '/photo-match', '/nano-bypass', '/lora-datasets/generate',
  // '/seedream' (Muapi Seedream 5) holds the request while polling Muapi (up to 180s
  // server-side), so it must NOT use the 30s default.
  '/seedream',
  // Omni uploads up to 3 videos + 9 images to Muapi before submitting — well past 30s.
  '/seedance-omni',
  '/outfit-swap', '/pose-fix',
  // Instagram-reel ingest runs yt-dlp (120s server timeout) and analyze runs ffmpeg scene
  // detection + one Gemini call per shot — both routinely exceed the 30s default and would
  // otherwise abort mid-flight.
  '/instagram-reel',
];

const EXTRA_LONG_PATHS = ['/profile-clone'];

const USAGE_MUTATION_PATHS = [
  '/generate',
  '/batch',
  '/tweak',
  '/post-clone',
  '/reel-copy',
  '/carousel/execute',
  '/carousel/follow-up',
  '/carousel/polls',
  '/scene/recreate',
  '/pinterest/recreate',
  '/story/generate',
  '/auto/plan',
  '/auto/execute',
  '/auto/plans/',
  '/video/generate',
  '/video-compose',
  '/reformat',
  '/nsfw-generate',
  '/photo-match',
  '/nano-bypass',
  '/lora-datasets/generate',
  '/profile-clone',
];

function affectsUsage(path, method) {
  if (method === 'GET') return false;
  return USAGE_MUTATION_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(prefix));
}

function notifyUsageChanged(detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('kyros:usage-changed', { detail }));
}

function getTimeoutForPath(path, method) {
  if (method === 'GET') return DEFAULT_TIMEOUT_MS;
  if (path.startsWith('/pinterest/analyze-video')) return VIDEO_ANALYZE_TIMEOUT_MS;
  for (const prefix of EXTRA_LONG_PATHS) {
    if (path.startsWith(prefix)) return PROFILE_TIMEOUT_MS;
  }
  for (const prefix of LONG_RUNNING_PATHS) {
    if (path.startsWith(prefix)) return LONG_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

const RETRY_MAX = 2;
const RETRY_BASE_MS = 500;

function _isRetryable(err) {
  if (err.code === 'TIMEOUT') return true;
  if (err.name === 'TypeError' && err.message?.includes('fetch')) return true;
  if (err.status >= 500) return true;
  return false;
}

async function request(path, options = {}) {
  const { method = 'GET', body, signal: externalSignal, timeoutMs, cache } = options;
  const maxRetries = method === 'GET' ? RETRY_MAX : 0;

  for (let attempt = 0; ; attempt++) {
    try {
      return await _fetchOnce(path, method, body, externalSignal, timeoutMs, cache);
    } catch (err) {
      if (attempt < maxRetries && _isRetryable(err) && !externalSignal?.aborted) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}

async function _fetchOnce(path, method, body, externalSignal, timeoutMs, cache) {
  const resolvedTimeout = timeoutMs || getTimeoutForPath(path, method);
  const shouldRefreshUsage = affectsUsage(path, method);
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
  if (cache) {
    config.cache = cache;
  }
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
      // Most routes error with { error: { message, code } }. A few (the instagram-reel ingest
      // 422, whose route documents "the client renders that message inline") send a plain
      // { error: "string" } — surface that verbatim so a real fallback message reaches the user
      // instead of a generic "Request failed (422)".
      const msg = json?.error?.message
        || (typeof json?.error === 'string' ? json.error : null)
        || `Request failed (${res.status})`;
      const err = new Error(msg);
      err.code = json?.error?.code || 'UNKNOWN';
      err.status = res.status;
      if (shouldRefreshUsage && err.code === 'PLAN_LIMIT_EXCEEDED') {
        notifyUsageChanged({ path, status: res.status, code: err.code });
      }
      throw err;
    }
    if (shouldRefreshUsage) {
      notifyUsageChanged({ path, status: res.status });
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
  getWavespeed: () => request('/keys/wavespeed'),
  setWavespeed: (apiKey) => request('/keys/wavespeed', { method: 'PUT', body: { apiKey } }),
  clearWavespeed: () => request('/keys/wavespeed', { method: 'DELETE' }),
  getMuapi: () => request('/keys/muapi'),
  setMuapi: (apiKey) => request('/keys/muapi', { method: 'PUT', body: { apiKey } }),
  clearMuapi: () => request('/keys/muapi', { method: 'DELETE' }),
  getVertex: () => request('/keys/vertex'),
  setVertex: (credentialsJson) => request('/keys/vertex', { method: 'PUT', body: { credentialsJson } }),
  clearVertex: () => request('/keys/vertex', { method: 'DELETE' }),
  setActiveBackend: (backend) => request('/keys/active-backend', { method: 'PUT', body: { backend } }),
  healthCheck: () => request('/keys/health-check'),
  getSpend: () => request('/keys/spend'),
  resetSpend: () => request('/keys/spend/reset', { method: 'POST' }),
};

export const seedream = {
  // `opts` passes through to request() — Base uses it to raise timeoutMs, because Nano Banana 2
  // shares this route and runs far longer than Seedream (a measured 182.8s of inference against
  // the 5-minute default is close enough to the edge that a slow queue would abort a job that has
  // already been billed).
  edit: (body, opts) => request('/seedream/edit', { method: 'POST', body, ...opts }),
};

export const instagramReel = {
  // Multipart video upload → { runId, videoPath, source }. Same FormData style as gallery.upload:
  // request() detects the FormData body and lets the browser set the multipart boundary header,
  // so no Content-Type is set by hand here.
  ingestFile: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return request('/instagram-reel/ingest', { method: 'POST', body: formData });
  },
  // JSON { url } → { runId, videoPath, source }. A failed download is a 422 whose plain-string
  // { error } is surfaced by request()'s error unwrap above, so the page can show it inline.
  ingestUrl: (url) => request('/instagram-reel/ingest', { method: 'POST', body: { url } }),
  // { runId } → { shots: [{ index, startSec, durationSec, analysis, onScreenText,
  // analysisFailed, recreatePrompt, keyframeDataUrl }], textTrack: [{ startSec, endSec, text }] }.
  // The per-shot on-screen text (analysis.onScreenText) is the editable static overlay; textTrack is
  // the whole-reel TIMED overlay track (the counter ticking) that assembly animates — both are data
  // the page threads to /assemble, so there is no separate caption/overlay API call.
  analyze: (runId) => request('/instagram-reel/analyze', { method: 'POST', body: { runId } }),
  // { runId, segments: [{ galleryId, startSec, durationSec, black, bw, overlayText, textTrack }] } →
  // { galleryId, filename }. Pure-ffmpeg stitch (no paid API) that lays the recreated base images
  // over the original audio into the finished MP4, ANIMATING each segment's textTrack (timed
  // drawtext) or burning the static overlayText when no track — saved to the Video Library,
  // downloadable
  // metadata-stripped via videoApi.cleanFileUrl(filename). Uses the shared instagram-reel LONG
  // timeout (ffmpeg per-segment encodes exceed the 30s default), matching ingest/analyze.
  assemble: (runId, segments) => request('/instagram-reel/assemble', { method: 'POST', body: { runId, segments } }),
};

export const seedanceOmni = {
  analyzeVideo: (videoBase64, mimeType, imageBase64, imageMimeType) => request('/seedance-omni/analyze-video', { method: 'POST', body: { videoBase64, mimeType, imageBase64, imageMimeType } }),
  generate: (body) => request('/seedance-omni/generate', { method: 'POST', body }),
  trainCharacter: (body) => request('/seedance-omni/train-character', { method: 'POST', body }),
  trainStatus: (requestId) => request(`/seedance-omni/train-status/${requestId}?_=${Date.now()}`, { cache: 'no-store' }),
};

export const video = {
  generate: (body) => request('/video/generate', { method: 'POST', body }),
  status: (taskId) => request(`/video/${taskId}/status?_=${Date.now()}`, { cache: 'no-store' }),
  history: () => request('/video/history'),
  removeHistory: (id) => request(`/video/history/${id}`, { method: 'DELETE' }),
  clearHistory: () => request('/video/history', { method: 'DELETE' }),
  fileUrl: (filename) => `${BASE}/video/file/${filename}`,
  // Strips the x264 SEI block and the Lavc/Lavf stamps. Downloads only — it costs an audio
  // re-encode, which playback should not pay.
  cleanFileUrl: (filename) => `${BASE}/video/file/${filename}/clean`,
  bulkDownload: async (ids) => {
    const res = await fetch(`${BASE}/video/bulk-download`, {
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
    a.download = `videos-${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  },
};

export const videoEdit = {
  // Multipart: sourceFilename + overlay_<i> PNGs + JSON fields. The server caps ffmpeg at 5 min;
  // the client waits LONGER (7 min) so a near-cap encode is still received as success instead of the
  // client aborting first and falsely reporting "failed" while the clip actually saved to the gallery.
  export: (formData) => request('/video-edit', { method: 'POST', body: formData, timeoutMs: 7 * 60_000 }),
};

export const videoCompose = {
  compose: (formData) => request('/video-compose', { method: 'POST', body: formData, timeoutMs: LONG_TIMEOUT_MS }),
  extractTextOverlay: (formData) => request('/video-compose/extract-text-overlay', { method: 'POST', body: formData, timeoutMs: VIDEO_ANALYZE_TIMEOUT_MS }),
};

export const characters = {
  list: () => request(`/characters?_=${Date.now()}`, { cache: 'no-store' }),
  get: (id) => request(`/characters/${id}`),
  create: (data) => request('/characters', { method: 'POST', body: data }),
  update: (id, data) => request(`/characters/${id}`, { method: 'PATCH', body: data }),
  duplicate: (id) => request(`/characters/${id}/duplicate`, { method: 'POST' }),
  remove: (id) => request(`/characters/${id}`, { method: 'DELETE' }),
  addReference: (id, data) => request(`/characters/${id}/references`, { method: 'POST', body: data }),
  toggleReference: (id, refId) => request(`/characters/${id}/references/${refId}/toggle`, { method: 'PATCH' }),
  removeReference: (id, refId) => request(`/characters/${id}/references/${refId}`, { method: 'DELETE' }),
  addPrimaryImage: (id, data) => request(`/characters/${id}/primary-images`, { method: 'POST', body: data }),
  removePrimaryImage: (id, index) => request(`/characters/${id}/primary-images/${index}`, { method: 'DELETE' }),
  reorderPrimaryImages: (id, order) => request(`/characters/${id}/primary-images/order`, { method: 'PUT', body: { order } }),
  imageUrl: (id) => `${BASE}/characters/${id}/image`,
  primaryImageUrl: (id, index) => `${BASE}/characters/${id}/primary-images/${index}`,
  refImageUrl: (id, refId) => `${BASE}/characters/${id}/references/${refId}/image`,
};

export const generate = {
  image: (body) => request('/generate', { method: 'POST', body }),
  enhancePrompt: (body) => request('/generate/enhance-prompt', { method: 'POST', body }),
};

export const nsfwGenerate = {
  image: (body) => request('/nsfw-generate', { method: 'POST', body }),
  vary: (body) => request('/nsfw-generate/vary', { method: 'POST', body }),
};

export const loraPresets = {
  list: () => request('/lora-presets'),
  create: (body) => request('/lora-presets', { method: 'POST', body }),
  update: (id, body) => request(`/lora-presets/${id}`, { method: 'PATCH', body }),
  remove: (id) => request(`/lora-presets/${id}`, { method: 'DELETE' }),
};

export const loraDatasets = {
  list: () => request('/lora-datasets'),
  get: (id) => request(`/lora-datasets/${id}`),
  generate: (body) => request('/lora-datasets/generate', { method: 'POST', body }),
  progress: (id) => new EventSource(`${BASE}/lora-datasets/${id}/progress`),
  imageUrl: (galleryId) => `${BASE}/gallery/${galleryId}/image`,
  download: async (id) => {
    const res = await fetch(`${BASE}/lora-datasets/${id}/download`);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new Error(json?.error?.message || `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lora-dataset-${id}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
export const batch = {
  list: (status) => request(`/batch${status ? `?status=${status}` : ''}`),
  start: (body) => request('/batch', { method: 'POST', body }),
  get: (jobId) => request(`/batch/${jobId}`),
  cancel: (jobId) => request(`/batch/${jobId}/cancel`, { method: 'POST' }),
  retry: (jobId) => request(`/batch/${jobId}/retry`, { method: 'POST' }),
  remove: (jobId) => request(`/batch/${jobId}`, { method: 'DELETE' }),
  stats: () => request('/batch/stats'),
  progress: (jobId) => new EventSource(`${BASE}/batch/${jobId}/progress`),
  scorePicks: (jobId) => request(`/batch/${jobId}/score-picks`, { method: 'POST' }),
  notifications: () => request('/batch/notifications/list'),
  markNotificationsRead: () => request('/batch/notifications/read-all', { method: 'POST' }),
  clearNotifications: () => request('/batch/notifications', { method: 'DELETE' }),
  notificationStream: () => new EventSource(`${BASE}/batch/notifications`),
};

export const tweak = {
  create: (body) => request('/tweak', { method: 'POST', body }),
};

export const images = {
  list: () => request('/images'),
  get: (id) => request(`/images/${id}`),
  children: (id) => request(`/images/${id}/children`),
};

export const gallery = {
  list: () => request('/gallery'),
  upload: async (file, fields = {}) => {
    const formData = new FormData();
    formData.append('file', file);
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && value !== '') formData.append(key, value);
    }
    return request('/gallery/upload', { method: 'POST', body: formData });
  },
  get: (id) => request(`/gallery/${id}`),
  remove: (id) => request(`/gallery/${id}`, { method: 'DELETE' }),
  toggleFavorite: (id) => request(`/gallery/${id}/favorite`, { method: 'PATCH' }),
  bulkRemove: (ids) => request('/gallery/bulk', { method: 'DELETE', body: { ids } }),
  spoofStatus: () => request('/gallery/spoof-status'),
  bulkDownload: async (ids, { spoof = true } = {}) => {
    const res = await fetch(`${BASE}/gallery/bulk-download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, spoof }),
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
  spoofedDownloadUrl: (id) => `${BASE}/gallery/${id}/download-spoofed`,
  thumbUrl: (id) => `${BASE}/gallery/${id}/thumb`,
  listTags: () => request('/gallery/tags'),
  updateTags: (id, tags) => request(`/gallery/${id}/tags`, { method: 'PATCH', body: { tags } }),
  addTag: (id, tag) => request(`/gallery/${id}/tags`, { method: 'POST', body: { tag } }),
  removeTag: (id, tag) => request(`/gallery/${id}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' }),
  saveEdit: (id, params) => request(`/gallery/${id}/edit`, { method: 'POST', body: { ...params, save: true } }),
};

export const library = {
  list: () => request('/library'),
  bulkPaths: (items) => request('/library/bulk-paths', { method: 'POST', body: { items } }),
};

export const eddyVision = {
  describe: (body) => request('/eddy/describe', { method: 'POST', body }),
  classifyPoseView: (body) => request('/eddy/classify-pose-view', { method: 'POST', body }),
};

export const poseRemix = {
  suggest: (image, mimeType, vibe) => request('/pose-remix/suggest', { method: 'POST', body: { image, mimeType, vibe } }),
};

export const scene = {
  analyze: (image, mimeType) => request('/scene/analyze', { method: 'POST', body: { image, mimeType } }),
  recreate: (body) => request('/scene/recreate', { method: 'POST', body }),
};

export const photoMatch = {
  recreate: (body) => request('/photo-match/recreate', { method: 'POST', body }),
};

export const pinterest = {
  fetch: (body) => request('/pinterest', { method: 'POST', body }),
  push: (urlOrBody, feature = 'pinterest', imageUrl = null) => {
    const body = typeof urlOrBody === 'string'
      ? { url: urlOrBody, feature, imageUrl }
      : urlOrBody;
    return request('/pinterest/push', { method: 'POST', body });
  },
  pending: (params = {}) => {
    if (typeof params === 'string') {
      return request(`/pinterest/pending${params ? `?feature=${encodeURIComponent(params)}` : ''}`);
    }
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
    }
    const query = qs.toString();
    return request(`/pinterest/pending${query ? `?${query}` : ''}`);
  },
  proxyUrl: (url) => `${BASE}/pinterest/proxy?url=${encodeURIComponent(url)}`,
  analyze: (image, mimeType) => request('/pinterest/analyze', { method: 'POST', body: { image, mimeType } }),
  recreate: (body) => request('/pinterest/recreate', { method: 'POST', body }),
  recreateVideoFrame: (body) => request('/pinterest/recreate-video-frame', { method: 'POST', body }),
  analyzeVideo: (videoUrl) => request('/pinterest/analyze-video', { method: 'POST', body: { url: videoUrl } }),
};

export const nanoBypass = {
  edit: (body) => request('/nano-bypass/edit', { method: 'POST', body }),
};

export const outfitSwap = {
  swap: (body) => request('/outfit-swap/swap', { method: 'POST', body }),
};

export const xReply = {
  start: (body) => request('/x-reply/start', { method: 'POST', body }),
  stop: () => request('/x-reply/stop', { method: 'POST' }),
  status: () => request('/x-reply/status'),
};

export const niches = {
  list: () => request('/niches'),
  get: (id) => request(`/niches/${id}`),
  create: (data) => request('/niches', { method: 'POST', body: data }),
  update: (id, data) => request(`/niches/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/niches/${id}`, { method: 'DELETE' }),
};

export const brandVoice = {
  get: () => request('/brand-voice'),
  update: (data) => request('/brand-voice', { method: 'PATCH', body: data }),
};

export const story = {
  generate: (body) => request('/story/generate', { method: 'POST', body }),
};

export const carousel = {
  plan: (body) => request('/carousel/plan', { method: 'POST', body }),
  execute: (body) => request('/carousel/execute', { method: 'POST', body }),
  followUp: (body) => request('/carousel/follow-up', { method: 'POST', body }),
  polls: (body) => request('/carousel/polls', { method: 'POST', body }),
};

export const reel = {
  recreate: (body) => request('/reel-copy', { method: 'POST', body }),
};

export const postClone = {
  clonePost: (body) => request('/post-clone', { method: 'POST', body }),
  cloneProfile: (body) => request('/profile-clone', { method: 'POST', body }),
  fetchProfile: (body) => request('/profile-clone/fetch', { method: 'POST', body }),
  recreateSelected: (body) => request('/profile-clone/recreate', { method: 'POST', body }),
  proxyImageUrl: (url) => `${BASE}/post-clone/proxy-image?url=${encodeURIComponent(url)}`,
  thumbUrl: (filename) => filename ? `${BASE}/post-clone/thumb/${filename}` : '',
};

export const postCloneHistory = {
  list: () => request('/post-clone/history'),
  remove: (id) => request(`/post-clone/history/${id}`, { method: 'DELETE' }),
  imageUrl: (galleryId) => `${BASE}/gallery/${galleryId}/image`,
};

export const styleFocus = {
  list: () => request('/post-clone/style-focus'),
  get: (id) => request(`/post-clone/style-focus/${id}`),
  save: (data) => request('/post-clone/style-focus', { method: 'POST', body: data }),
  remove: (id) => request(`/post-clone/style-focus/${id}`, { method: 'DELETE' }),
};

export const promptKnowledge = {
  list: (query = '') => request(`/prompt-knowledge${query ? `?${query}` : ''}`),
};

export const templates = {
  list: (page) => request(`/templates${page ? `?page=${page}` : ''}`),
  get: (id) => request(`/templates/${id}`),
  create: (data) => request('/templates', { method: 'POST', body: data }),
  update: (id, data) => request(`/templates/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/templates/${id}`, { method: 'DELETE' }),
};

export const captionTemplates = {
  list: (category) => request(`/caption-templates${category ? `?category=${category}` : ''}`),
  get: (id) => request(`/caption-templates/${id}`),
  create: (data) => request('/caption-templates', { method: 'POST', body: data }),
  update: (id, data) => request(`/caption-templates/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/caption-templates/${id}`, { method: 'DELETE' }),
  suggest: (category, limit) => request(`/caption-templates/suggest?category=${encodeURIComponent(category || '')}&limit=${limit || 5}`),
  markUsed: (id) => request(`/caption-templates/${id}/use`, { method: 'POST' }),
};

export const outfits = {
  list: (characterId) => request(`/outfits${characterId ? `?characterId=${characterId}` : ''}`),
  create: (data) => request('/outfits', { method: 'POST', body: data }),
  update: (id, data) => request(`/outfits/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/outfits/${id}`, { method: 'DELETE' }),
};

export const availability = {
  check: (url) => request('/availability/check', { method: 'POST', body: { url }, timeoutMs: LONG_TIMEOUT_MS }),
};

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

export const autoPlans = {
  list: () => request('/auto/plans'),
  get: (id) => request(`/auto/plans/${id}`),
  save: (data) => request('/auto/plans', { method: 'POST', body: data }),
  update: (id, data) => request(`/auto/plans/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => request(`/auto/plans/${id}`, { method: 'DELETE' }),
  executeDay: (id, dayNumber) => request(`/auto/plans/${id}/execute-day`, { method: 'POST', body: { dayNumber } }),
};

export const profileAnalyzer = {
  analyze: (username, postLimit = 12, opts = {}) => {
    const params = { username, postLimit: String(postLimit) };
    if (opts.sort) params.sort = opts.sort;
    if (opts.newerThan) params.newerThan = opts.newerThan;
    const qs = new URLSearchParams(params);
    return new EventSource(`${BASE}/profile-analyzer/analyze?${qs}`);
  },
  save: (body) => request('/profile-analyzer/save', { method: 'POST', body }),
};

export const reformat = {
  convert: (body) => request('/reformat', { method: 'POST', body }),
};

export const backgrounds = {
  list: () => request('/backgrounds'),
  upload: (body) => request('/backgrounds', { method: 'POST', body }),
  remove: (id) => request(`/backgrounds/${id}`, { method: 'DELETE' }),
  imageUrl: (id) => `${BASE}/backgrounds/${id}/image`,
};

export const admin = {
  overview: () => request('/admin/overview'),
  analytics: (days = 14) => request(`/admin/analytics?days=${days}`),
  users: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const query = qs.toString();
    return request(`/admin/users${query ? `?${query}` : ''}`);
  },
  user: (id) => request(`/admin/users/${id}`),
  userActivity: (id) => request(`/admin/users/${id}/activity`),
  userSupportNotes: (id) => request(`/admin/users/${id}/support-notes`),
  addUserSupportNote: (id, body) => request(`/admin/users/${id}/support-notes`, { method: 'POST', body: { body } }),
  auditLogs: (limit = 50) => request(`/admin/audit-logs?limit=${limit}`),
  actOnUser: (id, body) => request(`/admin/users/${id}/action`, { method: 'POST', body }),
  system: () => request('/admin/system'),
  retention: () => request('/admin/analytics/retention'),
  featureTrend: () => request('/admin/analytics/feature-trend'),
  signupsByDay: () => request('/admin/analytics/signups-by-day'),
  exportUsersUrl: () => '/api/admin/users/export.csv',
  forceReset: (id) => request(`/admin/users/${id}/force-reset`, { method: 'POST' }),
  deleteUser: (id, note) => request(`/admin/users/${id}`, { method: 'DELETE', body: { note } }),
  setOwner: (id, grant) => request(`/admin/users/${id}/owner`, { method: 'PATCH', body: { grant } }),
  userLibraryAll: (id) => request(`/admin/users/${id}/library/all`),
  sendMessage: (id, subject, body) => request(`/admin/users/${id}/messages`, { method: 'POST', body: { subject, body } }),
  getUserMessages: (id) => request(`/admin/users/${id}/messages`),
  referrals: () => request('/admin/referrals'),
  markReferralPaid: (id, notes) => request(`/referral/admin/mark-paid/${id}`, { method: 'POST', body: { notes } }),
  mrrTrend: () => request('/admin/analytics/mrr-trend'),
  trialFunnel: () => request('/admin/analytics/trial-funnel'),
  newVsReturning: () => request('/admin/analytics/new-vs-returning'),
  featureStickiness: () => request('/admin/analytics/feature-stickiness'),
  geo: () => request('/admin/analytics/geo'),
  bulkMessage: (userIds, subject, body) => request('/admin/users/bulk-message', { method: 'POST', body: { userIds, subject, body } }),
};

export const notifications = {
  list: () => request('/notifications'),
  readAll: () => request('/notifications/read-all', { method: 'POST' }),
  readOne: (id) => request(`/notifications/${id}/read`, { method: 'POST' }),
};
