'use strict';
const { ApifyClient } = require('apify-client');
const { AppError } = require('../../middleware/errorHandler');
const log = require('../../utils/logger');

const PINTEREST_ACTOR_ID = process.env.APIFY_PINTEREST_ACTOR_ID || 'automation-lab/pinterest-scraper';

// Normalize any Pinterest locale domain to www.pinterest.com
// e.g. fr.pinterest.com, es.pinterest.com, co.pinterest.com → www.pinterest.com
function normalizePinterestUrl(url) {
  try {
    const u = new URL(url);
    if (/pinterest\.[a-z.]+$/i.test(u.hostname)) {
      u.hostname = 'www.pinterest.com';
    }
    return u.toString();
  } catch {
    return url;
  }
}

function isPinterestUrl(url) {
  return /pinterest\.[a-z.]+/i.test(url);
}

function isPinUrl(url) {
  return /pinterest\.[a-z.]+\/pin\//i.test(url);
}

function extractImageUrl(item) {
  // automation-lab/pinterest-scraper fields
  if (typeof item.image === 'string' && item.image.startsWith('http')) return item.image;
  if (typeof item.imageUrl === 'string' && item.imageUrl.startsWith('http')) return item.imageUrl;
  if (typeof item.image_url === 'string' && item.image_url.startsWith('http')) return item.image_url;
  if (typeof item.imgUrl === 'string' && item.imgUrl.startsWith('http')) return item.imgUrl;
  if (typeof item.src === 'string' && item.src.startsWith('http')) return item.src;
  // Nested images object (original Pinterest API format)
  const nested = item.images?.orig?.url || item.images?.['736x']?.url || item.images?.['474x']?.url || item.images?.['236x']?.url;
  if (nested) return nested;
  // media.images
  const media = item.media?.images?.originals?.url || item.media?.images?.['736x']?.url;
  if (media) return media;
  // Array of images
  if (Array.isArray(item.images) && item.images.length > 0) {
    const first = item.images[0];
    if (typeof first === 'string') return first;
    if (typeof first?.url === 'string') return first.url;
    if (typeof first?.src === 'string') return first.src;
  }
  return null;
}

function normalizePinterestItems(items) {
  const posts = [];
  for (const item of items) {
    const imageUrl = extractImageUrl(item);
    if (!imageUrl) continue;

    const pinId = item.id || item.pinId || null;
    const pinUrl = item.url || item.link || (pinId ? `https://www.pinterest.com/pin/${pinId}/` : null);

    posts.push({
      type: 'single',
      sourceUrl: pinUrl || '',
      thumbnailUrl: imageUrl,
      imageUrls: [imageUrl],
      images: [{ url: imageUrl, displayUrl: imageUrl }],
      description: item.description || item.title || '',
    });
  }
  return posts;
}

async function runPinterestActor({ url, limit = 10, apifyToken }) {
  if (!apifyToken) throw new AppError('Apify API key required for Pinterest scraping', 400, 'APIFY_KEY_MISSING');

  const normalizedUrl = normalizePinterestUrl(url);
  const client = new ApifyClient({ token: apifyToken });

  const isPin = isPinUrl(normalizedUrl);
  const input = {
    startUrls: [{ url: normalizedUrl }],
    maxItems: isPin ? Math.max(limit, 1) : limit,
    ...(isPin ? {} : { maxBoards: 1 }),
  };

  log.info('pinterest_actor_start', { url: normalizedUrl, limit, actor: PINTEREST_ACTOR_ID, isPin });

  let run;
  try {
    run = await client.actor(PINTEREST_ACTOR_ID).call(input, { waitSecs: 180 });
  } catch (err) {
    throw new AppError(`Pinterest scraper failed: ${err.message}`, 502, 'APIFY_ERROR');
  }

  const datasetId = run?.defaultDatasetId;
  if (!datasetId) throw new AppError('Pinterest scraper returned no dataset',502, 'APIFY_ERROR');

  let items;
  try {
    const result = await client.dataset(datasetId).listItems({ limit: Math.max(limit * 3, 50) });
    items = result.items || [];
  } catch (err) {
    throw new AppError(`Failed to read Pinterest dataset: ${err.message}`, 502, 'APIFY_ERROR');
  }

  log.info('pinterest_actor_done', { count: items.length, url: normalizedUrl });

  const posts = normalizePinterestItems(items);
  if (posts.length === 0) throw new AppError('No images found from that Pinterest URL', 404, 'NO_POSTS_FOUND');

  // For a single pin URL, return only the first result
  return isPin ? posts.slice(0, 1) : posts;
}

module.exports = { runPinterestActor, isPinterestUrl, normalizePinterestUrl };
