/**
 * Pinterest SEARCH, for the browse tab.
 *
 * Deliberately separate from routes/pinterest.js. That file takes ONE pin URL and scrapes it
 * through a third-party downloader to pull video variants; this one asks Pinterest's own search
 * resource for a page of pins. Different upstream, different shape, different failure mode —
 * keeping them apart means a change at one end cannot break the other.
 *
 * VERIFIED AGAINST THE LIVE ENDPOINT:
 *   BaseSearchResource      -> 200, results, bookmark for paging
 *   RelatedPinFeedResource  -> 200 with { pin }   <-- see the CORRECTION below
 *   RelatedModulesResource  -> 404
 *   BoardFeedResource       -> 400
 *
 * CORRECTION, 2026-08-12. This header said RelatedPinFeedResource returned 404 and the tab was
 * built on that belief for months. It does not: it was being called with `pin_id`, and the
 * parameter is `pin`. With `{ pin }`, a `/pin/<id>/` referer and the `www/pin/[id].js` handler it
 * returns 200 — 100 related pins in 1.9s, three seeds in parallel in 2.5s. That is Pinterest's own
 * related-pins algorithm, and it is what POST /related below serves.
 *
 * The lesson is kept because it is the expensive kind: a wrong parameter name and a 404 look
 * exactly like a feature that does not exist.
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
/**
 * How many pins one request may ask for.
 *
 * Was 50, which silently clamped the client's request for 100 and made "Load more" feel broken --
 * one click added a handful of usable tiles. Measured against the live endpoint 2026-08-11, same
 * query, one request each:
 *
 *   page_size=25  -> 20 pins     page_size=100 -> 92 pins
 *   page_size=50  -> 45 pins     page_size=250 -> 237 pins (234 at >=600px)
 *
 * So Pinterest honours it and 250 is one request, not five. Kept as a ceiling rather than removed:
 * the response is parsed and normalised in memory, and an unbounded page_size is a request for an
 * unbounded response.
 */
const MAX_PAGE_SIZE = 250;

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
    // action reuses.
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

  /**
   * ONE RETRY ON A 5xx.
   *
   * The owner hit "Pinterest refused the search (500)" mid-session on a query that worked before
   * and worked again immediately after -- five identical requests in a row at page_size 250 all
   * returned 200 when it was tested. A 500 here is Pinterest having a moment, not a verdict on the
   * request, and it is worth one retry before an error banner replaces a grid of results.
   *
   * 429 is NOT retried here: it carries a Retry-After measured in tens of seconds, and the client
   * already turns it into a visible countdown.
   */
  const attempt = () => axios.get(url, {
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/javascript, */*, q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Pinterest-PWS-Handler': PWS_HANDLER,
      Referer: `${PIN_BASE}${sourceUrl}`,
    },
  });

  let resp;
  try {
    resp = await attempt();
    if (resp.status >= 500) {
      log.error('pinterest_search_5xx_retry', { status: resp.status });
      await new Promise((r) => { setTimeout(r, 700); });
      resp = await attempt();
    }
  } catch (err) {
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

/**
 * How many pins one Refresh may be tuned to.
 *
 * Capped here as well as in the UI: the UI cap is a courtesy, this one is the guarantee. Eight
 * simultaneous requests is already a burst at a service that rate-limits.
 */
const MAX_SEEDS = 8;

/**
 * POST /api/pinterest-feed/related
 * body: { pins: [id, ...], pageSize?, bookmarks?: { [id]: bookmark } }
 *  -> { sets: [{ pin, pins: [...], bookmark }], failed: [id, ...] }
 *
 * Pinterest's own "more like this", one call per seed, in parallel.
 *
 * THE PARAMETER IS `pin`. `pin_id` returns 404, and that single mistake is why this repo recorded
 * RelatedPinFeedResource as broken when the tab was built. Measured live 2026-08-12: page_size 100
 * returns 100 pins in 1.9s, and three seeds in parallel took 2.5s for 140 usable tiles. The overlap
 * between two seeds' sets was 1 of 48, which is what makes mixing worth doing rather than just
 * returning the same pins several times.
 *
 * A seed that fails is reported by id and skipped; the others still return. Losing a whole Refresh
 * because one pin went private is the failure worth avoiding.
 */
router.post('/related', async (req, res) => {
  const seeds = (Array.isArray(req.body?.pins) ? req.body.pins : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .slice(0, MAX_SEEDS);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.body?.pageSize) || 100));
  const bookmarks = req.body?.bookmarks && typeof req.body.bookmarks === 'object' ? req.body.bookmarks : {};

  if (!seeds.length) throw new AppError('At least one pin is required', 400, 'VALIDATION_ERROR');

  const failed = [];
  const sets = await Promise.all(seeds.map(async (id) => {
    const sourceUrl = `/pin/${id}/`;
    const options = {
      pin: id,
      page_size: pageSize,
      bookmarks: bookmarks[id] ? [bookmarks[id]] : [],
    };
    const url = `${PIN_BASE}/resource/RelatedPinFeedResource/get/`
      + `?source_url=${encodeURIComponent(sourceUrl)}`
      + `&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}`;
    try {
      const r = await axios.get(url, {
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/javascript, */*, q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Pinterest-PWS-Handler': 'www/pin/[id].js',
          Referer: `${PIN_BASE}${sourceUrl}`,
        },
      });
      if (r.status !== 200) {
        log.error('pinterest_related_status', { status: r.status, pin: id });
        failed.push(id);
        return { pin: id, pins: [], bookmark: null };
      }
      const body = typeof r.data === 'string' ? safeJson(r.data) : r.data;
      const data = body?.resource_response?.data;
      const results = Array.isArray(data) ? data : (data?.results || []);
      if (!Array.isArray(results)) {
        log.error('pinterest_related_shape', { pin: id });
        failed.push(id);
        return { pin: id, pins: [], bookmark: null };
      }
      return {
        pin: id,
        pins: results.map(normalisePin).filter(Boolean),
        bookmark: body?.resource_response?.bookmark || null,
      };
    } catch (err) {
      log.error('pinterest_related_unreachable', { pin: id, message: String(err?.message || '').slice(0, 200) });
      failed.push(id);
      return { pin: id, pins: [], bookmark: null };
    }
  }));

  // Every seed failing is a real failure, not an empty feed — say so with a code the client can read.
  if (failed.length === seeds.length) {
    throw new AppError('Pinterest returned nothing related to those pins', 502, 'PINTEREST_RELATED_FAILED');
  }
  res.json({ sets, failed });
});

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

module.exports = router;
module.exports.normalisePin = normalisePin;
