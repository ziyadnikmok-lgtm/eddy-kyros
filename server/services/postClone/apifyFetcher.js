'use strict';
const axios = require('axios');
const { ApifyClient } = require('apify-client');
const { AppError } = require('../../middleware/errorHandler');
const { asText } = require('../../utils/helpers');
const { sharedHttpsAgent } = require('../../utils/httpAgent');
const { buildLoginCookies } = require('../../utils/instagramCookies');
const apiKeyManager = require('../apiKeyManager');
const { isHttpUrl, extractImageUrlFromMedia, extractPostImages } = require('./mediaUtils');
const log = require('../../utils/logger');

const DEFAULT_ACTOR_ID = process.env.APIFY_POST_ACTOR_ID || 'apify/instagram-post-scraper';
const FALLBACK_ACTOR_ID = process.env.APIFY_POST_FALLBACK_ACTOR_ID || 'apify/instagram-scraper';
const PROFILE_ACTOR_ID = process.env.APIFY_PROFILE_ACTOR_ID || 'apify/instagram-profile-scraper';
const PROFILE_POSTS_ACTOR_ID = 'apify/instagram-post-scraper';
const COMMUNITY_POSTS_ACTOR_ID = process.env.APIFY_COMMUNITY_POSTS_ACTOR_ID || 'shu8hvrXbJbY3Eb9W';

// ── Shortcode helpers ──────────────────────────────────────────────────────────

function getItemShortcode(item) {
  return asText(item?.shortCode || item?.shortcode || item?.code || '');
}

function groupItemsByShortcode(items) {
  const byCode = new Map();
  const noCode = [];
  for (const item of items) {
    const sc = getItemShortcode(item);
    if (!sc) { noCode.push(item); continue; }
    if (!byCode.has(sc)) byCode.set(sc, []);
    byCode.get(sc).push(item);
  }

  const merged = [];
  for (const [, group] of byCode) {
    if (group.length === 1) { merged.push(group[0]); continue; }
    const parent = { ...group[0] };
    const extraImages = [];
    for (let i = 1; i < group.length; i++) {
      const url = extractImageUrlFromMedia(group[i]);
      if (url) extraImages.push({ displayUrl: url, url });
    }
    if (extraImages.length > 0) {
      parent.images = [...(Array.isArray(parent.images) ? parent.images : []), ...extraImages];
      log.info('post_clone_carousel_merged', { shortCode: getItemShortcode(parent), merged: group.length });
    }
    merged.push(parent);
  }
  return [...merged, ...noCode];
}

// ── Instagram direct API ───────────────────────────────────────────────────────

async function fetchDirectIgProfilePosts(profileUsername, limit = 12) {
  const username = asText(profileUsername);
  const sessionid = asText(apiKeyManager.getInstagramSessionId());
  if (!username || !sessionid) return [];

  const response = await axios.get(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
    timeout: 12000,
    httpsAgent: sharedHttpsAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'X-IG-App-ID': '936619743392459',
      'Referer': `https://www.instagram.com/${username}/`,
      'Cookie': `sessionid=${sessionid}`,
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const edges = response?.data?.data?.user?.edge_owner_to_timeline_media?.edges;
  if (!Array.isArray(edges) || edges.length === 0) return [];

  const limitCount = Math.max(1, Math.min(50, Number(limit) || 12));
  return edges.slice(0, limitCount).map((e) => e?.node).filter(Boolean).map((n) => ({
    id: n.id,
    shortCode: n.shortcode,
    url: n.shortcode ? `https://www.instagram.com/p/${n.shortcode}/` : '',
    display_url: n.display_url,
    displayUrl: n.display_url,
    is_video: n.is_video,
    media_type: n.__typename === 'GraphSidecar' ? 8 : (n.__typename === 'GraphVideo' ? 2 : 1),
    edge_sidecar_to_children: n.edge_sidecar_to_children,
    edgeSidecarToChildren: n.edge_sidecar_to_children,
  }));
}

async function resolveUsernameFromPostUrl(postUrl, restrictedItems) {
  const IG_USERNAME_RE = /[A-Za-z0-9._]{1,30}/;
  const RESERVED_SEGS = ['p', 'reel', 'tv', 'explore', 'accounts', 'stories', 'direct', 'about'];
  const isValidUsername = (u) => u && IG_USERNAME_RE.test(u) && !RESERVED_SEGS.includes(u.toLowerCase());

  try {
    const oembed = await axios.get('https://api.instagram.com/oembed/', {
      params: { url: postUrl },
      timeout: 10000,
      httpsAgent: sharedHttpsAgent,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const authorName = asText(oembed.data?.author_name);
    if (isValidUsername(authorName)) {
      log.info('post_clone_username_resolved', { method: 'oembed', username: authorName });
      return authorName;
    }
  } catch (e) {
    log.warn('post_clone_oembed_failed', { message: e.message });
  }

  const sessionid = asText(apiKeyManager.getInstagramSessionId());
  if (sessionid) {
    try {
      const res = await axios.get(postUrl, {
        timeout: 15000,
        httpsAgent: sharedHttpsAgent,
        responseType: 'text',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Cookie': `sessionid=${sessionid}`,
        },
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const html = asText(res.data);
      const ownerMatch = html.match(/"owner"\s*:\s*\{[^}]*"username"\s*:\s*"([^"]+)"/);
      if (ownerMatch && isValidUsername(ownerMatch[1])) { log.info('post_clone_username_resolved', { method: 'html_owner', username: ownerMatch[1] }); return ownerMatch[1]; }
      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i);
      if (ogDesc) {
        const atMatch = ogDesc[1].match(/@([A-Za-z0-9._]+)/);
        if (atMatch && isValidUsername(atMatch[1])) { log.info('post_clone_username_resolved', { method: 'og_desc', username: atMatch[1] }); return atMatch[1]; }
      }
      const linkMatch = html.match(/instagram\.com\/([A-Za-z0-9._]+)\/?["'\s]/);
      if (linkMatch && isValidUsername(linkMatch[1])) { log.info('post_clone_username_resolved', { method: 'link', username: linkMatch[1] }); return linkMatch[1]; }
    } catch (e) {
      log.warn('post_clone_html_fetch_failed', { message: e.message });
    }
  }

  if (Array.isArray(restrictedItems)) {
    for (const item of restrictedItems) {
      for (const key of ['ownerUsername', 'username', 'owner', 'userName']) {
        const val = asText(typeof item[key] === 'object' ? item[key]?.username : item[key]);
        if (isValidUsername(val)) { log.info('post_clone_username_resolved', { method: key, username: val }); return val; }
      }
      for (const key of ['title', 'description']) {
        const text = asText(item[key]);
        if (!text) continue;
        const atMatch = text.match(/@([A-Za-z0-9._]+)/);
        if (atMatch && isValidUsername(atMatch[1])) { log.info('post_clone_username_resolved', { method: key, username: atMatch[1] }); return atMatch[1]; }
        const onIg = text.match(/([A-Za-z0-9._]+)\s+on\s+Instagram/i);
        if (onIg && isValidUsername(onIg[1])) { log.info('post_clone_username_resolved', { method: key + '_ig', username: onIg[1] }); return onIg[1]; }
      }
    }
  }

  return '';
}

// ── Apify actor runner ─────────────────────────────────────────────────────────

async function runPostActor({ url, limit, apifyToken, onlyPostsNewerThan }) {
  const token = asText(apifyToken) || asText(apiKeyManager.getApifyKey()) || asText(process.env.APIFY_TOKEN);
  if (!token) throw new AppError('Apify token is required (provide APIFY_TOKEN env)', 400, 'CONFIG_ERROR');

  const client = new ApifyClient({ token });
  const loginCookies = buildLoginCookies();
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 1));
  const parsedUrl = new URL(url);
  const segments = parsedUrl.pathname.split('/').filter(Boolean);
  const firstSeg = (segments[0] || '').toLowerCase();
  const isPostLike = ['p', 'reel', 'tv'].includes(firstSeg);
  const profileUsername = !isPostLike ? asText(segments[0]) : '';
  const shortCode = isPostLike && segments[1] ? asText(segments[1]) : '';

  log.info('post_clone_actor_start', { cookies: loginCookies ? 'present' : 'MISSING', shortCode: shortCode || null, profileUsername: profileUsername || null });

  if (profileUsername) {
    try {
      const directItems = await fetchDirectIgProfilePosts(profileUsername, boundedLimit);
      if (directItems.length > 0) {
        log.info('post_clone_direct_ig_success', { count: directItems.length });
        return directItems;
      }
    } catch (err) {
      log.warn('post_clone_direct_ig_failed', { message: err.message });
    }
  }

  const primaryActorId = profileUsername ? PROFILE_POSTS_ACTOR_ID : DEFAULT_ACTOR_ID;
  const fallbackActorId = profileUsername ? PROFILE_ACTOR_ID : FALLBACK_ACTOR_ID;
  let run;
  let actorUsed = primaryActorId;

  const primaryPayloads = [];
  if (profileUsername) {
    primaryPayloads.push({ usernames: [profileUsername], resultsType: 'posts', resultsLimit: boundedLimit, addParentData: false, ...(loginCookies ? { loginCookies } : {}), ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}) });
    primaryPayloads.push({ directUrls: [url], startUrls: [{ url }], resultsType: 'posts', resultsLimit: boundedLimit, addParentData: false, ...(loginCookies ? { loginCookies } : {}), ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}) });
    primaryPayloads.push({ usernames: [profileUsername], resultsLimit: boundedLimit, ...(loginCookies ? { loginCookies } : {}) });
  } else {
    if (shortCode) primaryPayloads.push({ shortcodes: [shortCode], resultsLimit: boundedLimit, expandSlideshowImages: true, ...(loginCookies ? { loginCookies } : {}) });
    primaryPayloads.push({ directUrls: [url], startUrls: [{ url }], resultsLimit: boundedLimit, resultsType: 'posts', expandSlideshowImages: true, ...(loginCookies ? { loginCookies } : {}) });
    primaryPayloads.push({ postUrls: [url], resultsLimit: boundedLimit, expandSlideshowImages: true, ...(loginCookies ? { loginCookies } : {}) });
  }

  let primaryErr = null;
  for (let i = 0; i < primaryPayloads.length; i++) {
    try {
      log.info('post_clone_actor_try', { actorId: primaryActorId, payloadIndex: i + 1 });
      run = await client.actor(primaryActorId).call(primaryPayloads[i]);
      log.info('post_clone_actor_succeeded', { actorId: primaryActorId, payloadIndex: i + 1 });
      break;
    } catch (err) {
      log.warn('post_clone_actor_payload_failed', { actorId: primaryActorId, payloadIndex: i + 1, message: err.message });
      primaryErr = err;
    }
  }

  if (!run) {
    log.warn('post_clone_primary_failed_using_fallback', { fallback: fallbackActorId });
    actorUsed = fallbackActorId;
    try {
      run = await client.actor(fallbackActorId).call(
        profileUsername
          ? { usernames: [profileUsername], resultsLimit: boundedLimit, ...(loginCookies ? { loginCookies } : {}), ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}) }
          : { directUrls: [url], startUrls: [{ url }], resultsType: 'posts', resultsLimit: boundedLimit, addParentData: false, ...(loginCookies ? { loginCookies } : {}) }
      );
    } catch (fallbackErr) {
      try {
        await client.actor(fallbackActorId).call(
          profileUsername
            ? { usernames: [profileUsername], resultsLimit: boundedLimit, ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}) }
            : { directUrls: [url], startUrls: [{ url }], resultsType: 'posts', resultsLimit: boundedLimit, addParentData: false }
        );
      } catch { }
      throw new AppError(
        `Apify actor run failed (${primaryActorId}): ${primaryErr?.message || 'unknown'} — fallback (${fallbackActorId}): ${fallbackErr.message}`,
        502,
        'APIFY_ERROR'
      );
    }
  }

  const datasetId = run?.defaultDatasetId;
  if (!datasetId) throw new AppError('Apify actor returned no dataset', 502, 'APIFY_ERROR');

  let items = [];
  try {
    const fetchLimit = Math.max(5, Number(limit) * 3 || 20);
    const listed = await client.dataset(datasetId).listItems({ limit: fetchLimit });
    items = Array.isArray(listed?.items) ? listed.items : [];
    log.info('post_clone_dataset_fetched', { datasetId, actor: actorUsed, count: items.length, fetchLimit });
  } catch (err) {
    throw new AppError(`Failed to read Apify dataset (${actorUsed}): ${err.message}`, 502, 'APIFY_ERROR');
  }

  if (profileUsername) {
    const hasPostSignals = (rows) => (Array.isArray(rows) ? rows : []).some((row) => {
      if (!row || typeof row !== 'object') return false;
      if (getItemShortcode(row)) return true;
      if (isHttpUrl(asText(row.displayUrl || row.display_url || row.imageUrl || row.image_url || row.videoUrl || row.video_url))) return true;
      if (Array.isArray(row.images) && row.images.length > 0) return true;
      if (Array.isArray(row.carouselMedia) && row.carouselMedia.length > 0) return true;
      if (Array.isArray(row.children) && row.children.length > 0) return true;
      return false;
    });

    if (!hasPostSignals(items)) {
      log.warn('post_clone_profile_container_only', { retrying: true });
      const retryPayloads = [{ directUrls: [url], startUrls: [{ url }], resultsType: 'posts', resultsLimit: boundedLimit, addParentData: false, ...(loginCookies ? { loginCookies } : {}), ...(onlyPostsNewerThan ? { onlyPostsNewerThan } : {}) }];

      let retryErr = null;
      for (let i = 0; i < retryPayloads.length; i++) {
        try {
          const retryRun = await client.actor(FALLBACK_ACTOR_ID).call(retryPayloads[i]);
          if (!retryRun?.defaultDatasetId) continue;
          const fetchLimit = Math.max(5, Number(limit) * 3 || 20);
          const listed = await client.dataset(retryRun.defaultDatasetId).listItems({ limit: fetchLimit });
          const retryItems = Array.isArray(listed?.items) ? listed.items : [];
          log.info('post_clone_dataset_fetched', { datasetId: retryRun.defaultDatasetId, actor: FALLBACK_ACTOR_ID, count: retryItems.length, payloadIndex: i + 1 });
          if (hasPostSignals(retryItems)) { items = retryItems; actorUsed = FALLBACK_ACTOR_ID; break; }
          const firstError = asText(retryItems?.[0]?.error).toLowerCase();
          log.warn('post_clone_retry_no_posts', { payloadIndex: i + 1, firstError: firstError || null });
        } catch (err) {
          retryErr = err;
        }
      }
      if (!hasPostSignals(items) && retryErr) log.warn('post_clone_retry_failed', { actor: FALLBACK_ACTOR_ID, message: retryErr.message });

      if (!hasPostSignals(items)) {
        try {
          const communityRun = await client.actor(COMMUNITY_POSTS_ACTOR_ID).call({ directUrls: [url], resultsType: 'posts', resultsLimit: Math.max(1, Math.min(200, boundedLimit)), addParentData: false, ...(loginCookies ? { loginCookies } : {}) });
          if (communityRun?.defaultDatasetId) {
            const listed = await client.dataset(communityRun.defaultDatasetId).listItems({ limit: Math.max(5, Number(limit) * 3 || 20) });
            const communityItems = Array.isArray(listed?.items) ? listed.items : [];
            log.info('post_clone_dataset_fetched', { datasetId: communityRun.defaultDatasetId, actor: COMMUNITY_POSTS_ACTOR_ID, count: communityItems.length });
            if (hasPostSignals(communityItems)) { items = communityItems; actorUsed = COMMUNITY_POSTS_ACTOR_ID; }
          }
        } catch (err) {
          log.warn('post_clone_community_actor_failed', { message: err.message });
        }
      }

      if (!hasPostSignals(items)) {
        try {
          const mapped = await fetchDirectIgProfilePosts(profileUsername, boundedLimit);
          if (mapped.length > 0) {
            log.info('post_clone_direct_ig_fallback_success', { count: mapped.length });
            items = mapped; actorUsed = 'direct-ig-web-profile';
          }
        } catch (err) {
          log.warn('post_clone_direct_ig_fallback_failed', { message: err.message });
        }
      }
    }
  }

  return items;
}

// ── Item normalization ─────────────────────────────────────────────────────────

function collectNestedPostsFromContainer(container) {
  if (!container || typeof container !== 'object') return [];
  const out = [];
  const pushArray = (arr) => { for (const entry of arr) { if (!entry) continue; out.push(entry?.node || entry); } };
  if (Array.isArray(container.latestPosts)) pushArray(container.latestPosts);
  if (Array.isArray(container.latest_posts)) pushArray(container.latest_posts);
  if (Array.isArray(container.posts)) pushArray(container.posts);
  if (Array.isArray(container.timelineMedia)) pushArray(container.timelineMedia);
  if (Array.isArray(container.timeline_media)) pushArray(container.timeline_media);
  if (container.latestPosts && typeof container.latestPosts === 'object') {
    if (Array.isArray(container.latestPosts.items)) pushArray(container.latestPosts.items);
    if (Array.isArray(container.latestPosts.edges)) pushArray(container.latestPosts.edges);
  }
  if (container.latest_posts && typeof container.latest_posts === 'object') {
    if (Array.isArray(container.latest_posts.items)) pushArray(container.latest_posts.items);
    if (Array.isArray(container.latest_posts.edges)) pushArray(container.latest_posts.edges);
  }
  const edgeTimeline = container.edge_owner_to_timeline_media?.edges;
  if (Array.isArray(edgeTimeline)) pushArray(edgeTimeline);
  const edgeTimelineAlt = container.edgeOwnerToTimelineMedia?.edges;
  if (Array.isArray(edgeTimelineAlt)) pushArray(edgeTimelineAlt);

  const isPostLikeNode = (value) => {
    if (!value || typeof value !== 'object') return false;
    const typeName = asText(value.__typename || value.type || value.media_type || '').toLowerCase();
    if (typeName.includes('graphimage') || typeName.includes('graphvideo') || typeName.includes('graphsidecar')) return true;
    const hasIdentity = !!(asText(value.shortCode || value.shortcode || value.code || value.id));
    const hasMediaHint = !!(asText(value.displayUrl || value.display_url || value.thumbnailSrc || value.thumbnail_src || value.imageUrl || value.image_url || value.videoUrl || value.video_url || value.url) || value.image_versions2 || value.edge_sidecar_to_children || value.edgeSidecarToChildren);
    return hasIdentity && hasMediaHint;
  };

  if (out.length === 0 && container.latestPosts !== undefined) {
    const stack = [{ value: container.latestPosts, depth: 0 }];
    const seen = new Set();
    const found = [];
    while (stack.length > 0) {
      const { value, depth } = stack.pop();
      if (value == null || depth > 5) continue;
      if (typeof value === 'string') {
        const text = value.trim();
        if (text.startsWith('{') || text.startsWith('[')) {
          try { stack.push({ value: JSON.parse(text), depth: depth + 1 }); } catch { }
        }
        continue;
      }
      if (Array.isArray(value)) { for (const entry of value) stack.push({ value: entry, depth: depth + 1 }); continue; }
      if (typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (isPostLikeNode(value)) found.push(value);
      for (const v of Object.values(value)) { if (v && (typeof v === 'object' || typeof v === 'string')) stack.push({ value: v, depth: depth + 1 }); }
    }
    if (found.length > 0) {
      out.push(...found);
      log.info('post_clone_nested_posts_recovered', { count: found.length });
    }
  }

  return out;
}

function expandProfileContainerItems(items) {
  const expanded = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const nested = collectNestedPostsFromContainer(item);
    if (nested.length > 0) { for (const n of nested) expanded.push(n); continue; }
    expanded.push(item);
  }
  const inputLen = Array.isArray(items) ? items.length : 0;
  if (expanded.length !== inputLen) log.info('post_clone_container_expanded', { before: inputLen, after: expanded.length });
  return expanded;
}

function normalizePostsFromItems(items) {
  const { buildLoginCookies: blc } = require('../../utils/instagramCookies');
  const normalizedInput = expandProfileContainerItems(items || []);

  log.info('post_clone_normalize_start', { count: normalizedInput.length });
  for (let i = 0; i < normalizedInput.length; i++) {
    const item = normalizedInput[i];
    if (!item || typeof item !== 'object') continue;
    const typeName = asText(item.type || item.__typename || item.productType || '');
    const shortCode = getItemShortcode(item);
    const mediaCount = item.mediaCount || item.carousel_media_count || '';
    log.info('post_clone_item_debug', {
      index: i,
      typeName, shortCode: shortCode || null, mediaCount: mediaCount || null,
      images: Array.isArray(item.images) ? item.images.length : 0,
      carouselMedia: Array.isArray(item.carouselMedia) ? item.carouselMedia.length : 0,
      children: Array.isArray(item.children) ? item.children.length : 0,
      edgeSidecar: !!(item.edgeSidecarToChildren?.edges?.length) || !!(item.edge_sidecar_to_children?.edges?.length),
    });
  }

  const errorItem = normalizedInput.find((item) => {
    if (item?.restricted === true || item?.isRestricted === true) return true;
    return !!asText(item?.error).toLowerCase();
  });
  if (errorItem) {
    const err = asText(errorItem?.error).toLowerCase();
    const desc = asText(errorItem?.errorDescription || errorItem?.error || '');
    const url = asText(errorItem?.url || errorItem?.inputUrl || '');
    const isRestricted = err.includes('restricted') || errorItem?.restricted === true || errorItem?.isRestricted === true;
    log.warn('post_clone_apify_error_item', { error: err, desc, url });

    if (isRestricted) {
      const hasSession = !!blc();
      throw new AppError(
        hasSession
          ? `Post is restricted${url ? ` (${url})` : ''}. Session cookies were sent but the post-scraper returned only a thumbnail. Will retry via profile scrape.`
          : `Post is restricted${url ? ` (${url})` : ''}. Add your Instagram sessionid in API Keys to access age-restricted or sensitive content.`,
        422,
        'INSTAGRAM_RESTRICTED'
      );
    } else {
      const hasImage = extractImageUrlFromMedia(errorItem);
      if (!hasImage) {
        throw new AppError(
          `Instagram scraper error: ${desc || err || 'unknown'}${url ? ` (${url})` : ''}. Try a different URL or check your IG session cookies.`,
          422,
          'INSTAGRAM_SCRAPER_ERROR'
        );
      }
    }
  }

  const grouped = groupItemsByShortcode(normalizedInput || []);
  const posts = [];
  for (const item of grouped) {
    const extracted = extractPostImages(item);
    if (!extracted) continue;
    posts.push(extracted);
  }
  if (posts.length === 0 && normalizedInput.length > 0) {
    log.warn('post_clone_no_extractable_images', { itemCount: normalizedInput.length });
  }
  return posts;
}

module.exports = {
  getItemShortcode, groupItemsByShortcode,
  fetchDirectIgProfilePosts, resolveUsernameFromPostUrl,
  runPostActor,
  collectNestedPostsFromContainer, expandProfileContainerItems, normalizePostsFromItems,
};
