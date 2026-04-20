'use strict';

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeToneValue(value) {
  const tone = String(value || '').trim().toLowerCase();
  if (!tone || tone === '__default__') return null;
  return tone === 'sexy and flirty' ? 'sexy and engaging' : tone;
}

function normalizeTargetKind(value, fallback = 'subreddit') {
  return String(value || '').trim().toLowerCase() === 'user' ? 'user' : fallback;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, '/');
}

function parseRedditTargetInput(rawInput, preferredKind = 'subreddit') {
  const raw = String(rawInput || '').trim();
  if (!raw) return null;

  const normalizedKind = normalizeTargetKind(preferredKind, 'subreddit');
  const stripped = raw
    .replace(/^https?:\/\/(www\.|old\.|new\.)?reddit\.com\//i, '')
    .replace(/^\//, '')
    .split('?')[0]
    .split('#')[0]
    .trim();

  let kind = normalizedKind;
  let name = '';

  const subredditMatch = stripped.match(/^r\/([A-Za-z0-9_]+)\b/i);
  const userMatch = stripped.match(/^(u|user)\/([A-Za-z0-9_-]+)\b/i);

  if (subredditMatch) {
    kind = 'subreddit';
    name = subredditMatch[1];
  } else if (userMatch) {
    kind = 'user';
    name = userMatch[2];
  } else if (normalizedKind === 'user') {
    name = stripped.replace(/^(u|user)\//i, '').replace(/^@/, '');
  } else {
    name = stripped.replace(/^r\//i, '').replace(/^@/, '');
  }

  name = name.replace(/\/+$/, '').trim();
  if (!name) return null;

  return {
    rawInput: raw,
    kind,
    name,
    label: kind === 'user' ? `u/${name}` : `r/${name}`,
  };
}

function normalizeTargetProfiles(config = {}) {
  const source = Array.isArray(config.targetProfiles) && config.targetProfiles.length
    ? config.targetProfiles
    : (Array.isArray(config.targetAccounts) ? config.targetAccounts : []);
  const seen = new Set();
  const normalized = [];

  for (const item of source) {
    const rawInput = typeof item === 'object' && item
      ? (item.value ?? item.input ?? item.name ?? '')
      : item;
    const preferredKind = typeof item === 'object' && item ? item.kind : 'subreddit';
    const parsed = parseRedditTargetInput(rawInput, preferredKind);
    if (!parsed) continue;

    const key = `${parsed.kind}:${parsed.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const toneOverride = typeof item === 'object' && item
      ? normalizeToneValue(item.tone)
      : null;
    const personaNotes = typeof item === 'object' && item
      ? normalizeWhitespace(item.personaNotes ?? item.notes ?? '').slice(0, 240)
      : '';
    const postingAccountId = typeof item === 'object' && item
      ? String(item.postingAccountId ?? item.accountId ?? '__active__').trim() || '__active__'
      : '__active__';
    const postingAccountName = typeof item === 'object' && item
      ? normalizeWhitespace(item.postingAccountName ?? item.accountName ?? '').slice(0, 80)
      : '';

    normalized.push({
      ...parsed,
      toneOverride,
      personaNotes,
      postingAccountId,
      postingAccountName,
    });
  }

  return normalized;
}

function normalizePermalink(value) {
  const path = String(value || '').trim();
  if (!path) return '';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.replace(/\/+$/, '/');
}

function buildPostUrl(permalink) {
  return `https://www.reddit.com${normalizePermalink(permalink)}`;
}

function buildOldPostUrl(permalink) {
  return `https://old.reddit.com${normalizePermalink(permalink)}`;
}

function getPreviewImageUrl(data = {}) {
  const preview = data.preview?.images?.[0]?.source?.url
    || data.thumbnail
    || data.url_overridden_by_dest
    || data.url;
  if (!preview || /^self$|^default$|^nsfw$|^spoiler$/i.test(String(preview))) return null;
  return decodeHtml(preview);
}

function normalizePost(data = {}, target = null) {
  const permalink = normalizePermalink(data.permalink);
  const imageUrl = getPreviewImageUrl(data);
  const hasImage = !!(
    imageUrl ||
    data.post_hint === 'image' ||
    data.preview?.images?.length ||
    /\.(png|jpe?g|gif|webp)(\?|$)/i.test(String(data.url || ''))
  );

  return {
    postId: String(data.id || '').trim(),
    fullname: String(data.name || (data.id ? `t3_${data.id}` : '')).trim(),
    title: normalizeWhitespace(data.title || ''),
    body: String(data.selftext || '').trim(),
    author: String(data.author || '').trim(),
    subreddit: String(data.subreddit || '').trim(),
    permalink,
    postUrl: buildPostUrl(permalink),
    oldPostUrl: buildOldPostUrl(permalink),
    externalUrl: decodeHtml(data.url || ''),
    imageUrl,
    hasImage,
    isSelf: !!data.is_self,
    isVideo: !!data.is_video,
    over18: !!data.over_18,
    locked: !!data.locked,
    archived: !!data.archived,
    stickied: !!data.stickied,
    numComments: Number(data.num_comments) || 0,
    createdAt: data.created_utc ? new Date(Number(data.created_utc) * 1000).toISOString() : null,
    createdAtMs: data.created_utc ? Math.round(Number(data.created_utc) * 1000) : null,
    targetKind: target?.kind || null,
    targetName: target?.name || null,
    targetLabel: target?.label || null,
  };
}

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 RedditPostStudio/1.0 (+https://reddit.com)',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = new Error(`HTTP ${response.status} from Reddit`);
      err.statusCode = response.status;
      throw err;
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTargetPosts(target, limit = 10) {
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
  const encodedName = encodeURIComponent(target.name);
  const url = target.kind === 'user'
    ? `https://www.reddit.com/user/${encodedName}/submitted/.json?raw_json=1&limit=${safeLimit}`
    : `https://www.reddit.com/r/${encodedName}/new.json?raw_json=1&limit=${safeLimit}`;

  const payload = await fetchJson(url);
  const children = Array.isArray(payload?.data?.children) ? payload.data.children : [];
  return children
    .map((child) => normalizePost(child?.data || {}, target))
    .filter((post) => post.postId && post.postUrl);
}

function normalizePostUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!/reddit\.com$/i.test(url.hostname.replace(/^www\./i, '').replace(/^old\./i, '').replace(/^new\./i, ''))) {
    return null;
  }

  url.hash = '';
  url.search = '';
  url.hostname = 'www.reddit.com';
  return url.toString().replace(/\/+$/, '');
}

async function fetchPostDetailsByUrl(postUrl) {
  const normalizedUrl = normalizePostUrl(postUrl);
  if (!normalizedUrl) throw new Error('Invalid Reddit post URL');

  const jsonUrl = `${normalizedUrl}.json?raw_json=1&limit=1`;
  const payload = await fetchJson(jsonUrl, 18000);
  const postData = payload?.[0]?.data?.children?.[0]?.data;
  if (!postData) throw new Error('Could not load Reddit post details');

  return normalizePost(postData);
}

async function fetchImageAsBase64(url) {
  if (!url) return null;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 RedditPostStudio/1.0 (+https://reddit.com)',
      'Accept': 'image/*,*/*;q=0.8',
      'Referer': 'https://www.reddit.com/',
    },
  }).catch(() => null);

  if (!response || !response.ok) return null;

  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

module.exports = {
  fetchImageAsBase64,
  fetchPostDetailsByUrl,
  fetchTargetPosts,
  normalizeTargetProfiles,
  parseRedditTargetInput,
};
