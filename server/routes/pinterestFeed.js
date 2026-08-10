/**
 * Pinterest SEARCH, for the browse tab.
 *
 * Deliberately separate from routes/pinterest.js. That file takes ONE pin URL and scrapes it
 * through a third-party downloader to pull video variants; this one asks Pinterest's own search
 * resource for a page of pins. Different upstream, different shape, different failure mode —
 * keeping them apart means a change at one end cannot break the other.
 *
 * VERIFIED BEFORE BEING WRITTEN, against the live endpoint:
 *   BaseSearchResource      -> 200, results, bookmark for paging
 *   RelatedModulesResource  -> 404
 *   RelatedPinFeedResource  -> 404
 *   BoardFeedResource       -> 400
 * So this file offers search and nothing else. Guessing at resource names would produce features
 * that work today and die silently later.
 *
 * No cookies and no API key. Public search does not need them; they would only reach a user's own
 * private boards.
 *
 * THIS IS A SCRAPE. Pinterest can change or gate the endpoint without notice. Every failure below
 * is named explicitly rather than collapsing to an empty list, because an empty grid reads as "no
 * matches" and sends the user off to retype a query that was never the problem.
 */
const express = require('express');
const axios = require('axios');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');

const router = express.Router();

const PIN_BASE = 'https://www.pinterest.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Pinterest 403s the resource endpoint without this header — it identifies which page-handler the
// request is pretending to come from. Not optional.
const PWS_HANDLER = 'www/search/[scope].js';
const TIMEOUT_MS = 12_000;
const MAX_PAGE_SIZE = 50;

/**
 * One Pinterest result -> the shape the client renders, or null.
 *
 * Pinterest's payload is deeply nested and varies by pin type: a video pin, a promoted pin and a
 * plain image pin all carry different keys. Normalising at this boundary means the client never
 * learns any of that, and a shape change breaks one function instead of a page.
 *
 * Returns null for anything with no usable original image — video pins, ads, and story pins. Those
 * cannot be used as a Photo Match source, so a tile for one is a tile that can only disappoint.
 */
function normalisePin(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const images = raw.images || {};
  const orig = images.orig || images['736x'] || null;
  if (!orig || !orig.url) return null;

  // The grid renders the small one and only fetches the original on send. A masonry page of
  // 1200px originals is tens of megabytes and janks the scroll.
  const thumb = images['236x']?.url || images['474x']?.url || orig.url;
  const w = Number(orig.width) || 0;
  const h = Number(orig.height) || 0;

  return {
    id: String(raw.id || ''),
    thumb,
    orig: orig.url,
    w,
    h,
    // Alt text is the only description most pins carry, and it is what the "search this pin"
    // action reuses — the closest thing available to related-pins, which does not work.
    alt: String(raw.grid_title || raw.description || raw.alt_text || '').trim().slice(0, 200),
    domain: String(raw.domain || '').slice(0, 80),
  };
}

/**
 * POST /api/pinterest-feed/search
 * body: { query, bookmark?, pageSize?, safe? }
 *  -> { pins: [...], bookmark: string|null }
 */
router.post('/search', async (req, res, next) => {
  const query = String(req.body?.query || '').trim();
  const bookmark = req.body?.bookmark ? String(req.body.bookmark) : '';
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.body?.pageSize) || 25));
  // Safe search ON by default. Turning it off is an explicit act, not a default this route picks.
  const safe = req.body?.safe !== false;

  if (!query) throw new AppError('A search term is required', 400, 'VALIDATION_ERROR');

  const options = {
    query,
    scope: 'pins',
    page_size: pageSize,
    // Pinterest expects the previous page's bookmark in an ARRAY. An empty array is page one.
    bookmarks: bookmark ? [bookmark] : [],
    ...(safe ? {} : { filters: 'no_filter' }),
  };
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}`;
  const url = `${PIN_BASE}/resource/BaseSearchResource/get/`
    + `?source_url=${encodeURIComponent(sourceUrl)}`
    + `&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}`;

  let resp;
  try {
    resp = await axios.get(url, {
      timeout: TIMEOUT_MS,
      // Handled below rather than thrown, so a 429 can be reported AS a rate limit.
      validateStatus: () => true,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/javascript, */*, q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Pinterest-PWS-Handler': PWS_HANDLER,
        Referer: `${PIN_BASE}${sourceUrl}`,
      },
    });
  } catch (err) {
    // A timeout or a DNS failure is not "no results" -- say which it was.
    log.error('pinterest_search_unreachable', { message: String(err?.message || '').slice(0, 200) });
    throw new AppError('Could not reach Pinterest — check your connection and try again', 502, 'PINTEREST_UNREACHABLE');
  }

  /**
   * A RATE LIMIT IS NOT AN EMPTY RESULT.
   *
   * Returned with its own code so the client can pause paging and show a countdown. Collapsing it
   * to zero pins would read as "no pins for that search" and send the user off to retype a query
   * that was never the problem.
   */
  if (resp.status === 429) {
    const retryAfter = Number(resp.headers?.['retry-after']) || 30;
    log.error('pinterest_rate_limited', { retryAfter });
    throw new AppError(`Pinterest is rate-limiting — wait ${retryAfter}s`, 429, 'PINTEREST_RATE_LIMITED');
  }
  if (resp.status !== 200) {
    log.error('pinterest_search_status', { status: resp.status });
    throw new AppError(`Pinterest refused the search (${resp.status}) — it may have changed its API`, 502, 'PINTEREST_BLOCKED');
  }

  const body = typeof resp.data === 'string' ? safeJson(resp.data) : resp.data;
  const data = body?.resource_response?.data;
  const results = Array.isArray(data) ? data : (data?.results || null);

  /**
   * A missing results array means the SHAPE changed, which is a different problem from a search
   * that genuinely matched nothing — and the two need different reactions from the user. An empty
   * array really is no matches, and passes through as such.
   */
  if (!Array.isArray(results)) {
    log.error('pinterest_shape_changed', { keys: Object.keys(body?.resource_response || {}).slice(0, 8) });
    throw new AppError('Pinterest changed its search response — the tab needs updating', 502, 'PINTEREST_SHAPE');
  }

  const pins = results.map(normalisePin).filter(Boolean);
  res.json({
    pins,
    // null, not '', so the client can test it plainly for "is there another page".
    bookmark: body?.resource_response?.bookmark || null,
    // What was dropped and why, so a page that looks short is explained rather than suspicious.
    dropped: results.length - pins.length,
  });
});

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

module.exports = router;
module.exports.normalisePin = normalisePin;
