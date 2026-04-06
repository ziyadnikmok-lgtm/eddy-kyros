'use strict';
const { ApifyClient } = require('apify-client');
const { AppError } = require('../../middleware/errorHandler');
const log = require('../../utils/logger');

const PINTEREST_ACTOR_ID = process.env.APIFY_PINTEREST_ACTOR_ID || 'apify/pinterest-scraper';

function normalizePinterestItems(items) {
  const posts = [];
  for (const item of items) {
    // Apify pinterest-scraper returns items with various image fields
    const imageUrl =
      item.images?.orig?.url ||
      item.images?.['736x']?.url ||
      item.images?.['474x']?.url ||
      item.imageUrl ||
      item.image_url ||
      item.imgUrl ||
      null;

    if (!imageUrl) continue;

    const pinUrl = item.url || item.link || (item.id ? `https://www.pinterest.com/pin/${item.id}/` : null);

    posts.push({
      type: 'single',
      sourceUrl: pinUrl || '',
      thumbnailUrl: imageUrl,
      images: [{ url: imageUrl, displayUrl: imageUrl }],
      description: item.description || item.title || '',
    });
  }
  return posts;
}

async function runPinterestActor({ url, limit = 10, apifyToken }) {
  if (!apifyToken) throw new AppError('Apify API key required for Pinterest scraping', 400, 'APIFY_KEY_MISSING');

  const client = new ApifyClient({ token: apifyToken });

  const isPinUrl = /pinterest\.[a-z]+\/pin\//i.test(url);
  const input = isPinUrl
    ? { startUrls: [{ url }], maxPins: limit }
    : { startUrls: [{ url }], maxPins: limit, maxBoards: 1 };

  log.info('pinterest_actor_start', { url, limit, actor: PINTEREST_ACTOR_ID });

  let run;
  try {
    run = await client.actor(PINTEREST_ACTOR_ID).call(input, { waitSecs: 120 });
  } catch (err) {
    throw new AppError(`Pinterest scraper failed: ${err.message}`, 502, 'APIFY_ERROR');
  }

  const datasetId = run?.defaultDatasetId;
  if (!datasetId) throw new AppError('Pinterest scraper returned no dataset', 502, 'APIFY_ERROR');

  let items;
  try {
    const result = await client.dataset(datasetId).listItems({ limit: Math.max(limit * 3, 50) });
    items = result.items || [];
  } catch (err) {
    throw new AppError(`Failed to read Pinterest dataset: ${err.message}`, 502, 'APIFY_ERROR');
  }

  log.info('pinterest_actor_done', { count: items.length, url });

  const posts = normalizePinterestItems(items);
  if (posts.length === 0) throw new AppError('No images found from that Pinterest URL', 404, 'NO_POSTS_FOUND');

  return posts;
}

module.exports = { runPinterestActor };
