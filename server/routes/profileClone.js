const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const apiKeyManager = require('../services/apiKeyManager');
const referenceManager = require('../services/referenceManager');
const galleryManager = require('../services/galleryManager');
const postCloneHistoryStore = require('../services/postCloneHistoryStore');
const postCloneRoute = require('./postClone');

const router = express.Router();
const TEMP_DIR = path.join(process.cwd(), 'temp');
const RECREATE_TIMEOUT_MS = 15 * 60_000; // 15 min for recreate (matches profile timeout)

/**
 * POST /api/profile-clone
 * Body: { profileUrl, characterId, postLimit, mode: "exact" | "creative", apifyApiKey? }
 * Original endpoint — kept for backwards compat.
 */
router.post('/', async (req, res, next) => {
  try {
    const { profileUrl, characterId, postLimit = 5, mode = 'exact', apifyApiKey } = req.body || {};
    const data = await postCloneRoute.handleClone({
      url: profileUrl,
      characterId,
      mode: (typeof mode === 'string' ? mode.trim().toLowerCase() : 'exact') || 'exact',
      apifyApiKey,
      postLimit: Math.max(1, Math.min(20, Number(postLimit) || 5)),
      profileMode: true,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/profile-clone/fetch
 * Scrape-only: runs Apify + normalizes posts, returns lightweight previews.
 * Body: { profileUrl, postLimit?, apifyApiKey? }
 */
router.post('/fetch', async (req, res, next) => {
  try {
    const { profileUrl, postLimit = 9, apifyApiKey } = req.body || {};
    const cleanUrl = asText(profileUrl);
    if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
      throw new AppError('A valid Instagram profile URL is required', 400, 'VALIDATION_ERROR');
    }

    const limit = Math.max(1, Math.min(30, Number(postLimit) || 9));
    const items = await postCloneRoute.runPostActor({
      url: cleanUrl,
      limit,
      apifyToken: apifyApiKey,
    });

    const posts = postCloneRoute.normalizePostsFromItems(items);
    // Match back to raw items to get accurate mediaCount
    const rawByUrl = new Map();
    for (const raw of (items || [])) {
      const u = asText(raw?.url || raw?.inputUrl || raw?.shortCodeUrl || '');
      if (u) rawByUrl.set(u, raw);
    }

    // Download thumbnails server-side while CDN URLs are still fresh
    postCloneRoute.ensureThumbDir();
    const thumbPromises = posts.map(async (p) => {
      const urls = p.imageUrls || [];
      // Try each slide URL until one succeeds
      for (const url of urls) {
        const filename = await postCloneRoute.cacheThumbnail(url);
        if (filename) return filename;
      }
      return '';
    });
    const thumbFilenames = await Promise.all(thumbPromises);

    const previews = posts.map((p, i) => {
      const raw = rawByUrl.get(p.sourceUrl);
      const rawSlideCount = raw?.mediaCount || raw?.carousel_media_count || 0;
      return {
        type: p.type,
        sourceUrl: p.sourceUrl || '',
        imageUrls: p.imageUrls || [],
        slideCount: rawSlideCount > 1 ? rawSlideCount : (p.imageUrls || []).length,
        thumbnail: thumbFilenames[i] || '', // cached local filename
      };
    });

    console.log(`[profile-clone/fetch] ${previews.length} post(s), ${thumbFilenames.filter(Boolean).length} thumbnails cached`);
    res.json({ success: true, data: previews });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/profile-clone/recreate
 * Process pre-fetched posts through Gemini — no Apify scrape needed.
 * Body: { posts: [{ type, sourceUrl, imageUrls }], characterId, mode }
 */
router.post('/recreate', async (req, res, next) => {
  try {
    const { posts, characterId, mode = 'exact' } = req.body || {};

    if (!Array.isArray(posts) || posts.length === 0) {
      throw new AppError('"posts" array is required and must not be empty', 400, 'VALIDATION_ERROR');
    }
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
    }
    const cleanMode = (typeof mode === 'string' ? mode.trim().toLowerCase() : 'exact') || 'exact';
    if (!['exact', 'creative'].includes(cleanMode)) {
      throw new AppError('"mode" must be "exact" or "creative"', 400, 'VALIDATION_ERROR');
    }

    // Cap at 20 posts
    const selected = posts.slice(0, 20).map((p) => ({
      type: p.type || 'single',
      sourceUrl: asText(p.sourceUrl),
      imageUrls: Array.isArray(p.imageUrls) ? p.imageUrls.filter((u) => typeof u === 'string') : [],
    })).filter((p) => p.imageUrls.length > 0);

    if (selected.length === 0) {
      throw new AppError('No valid posts with image URLs provided', 400, 'VALIDATION_ERROR');
    }

    const character = referenceManager.getCharacter(characterId);
    const activeRefs = referenceManager.getActiveReferences(characterId, null);
    const apiKey = apiKeyManager.getActiveKey();

    // Build reference images — includes primary image + active refs (same as single post clone)
    const baseReferenceImages = postCloneRoute.buildCharacterReferenceImages(characterId, activeRefs);

    const deadline = Date.now() + RECREATE_TIMEOUT_MS;
    const tempFiles = [];
    postCloneRoute.ensureTempDir();

    const results = [];
    const errors = [];
    const CONCURRENCY = 2;

    for (let batchStart = 0; batchStart < selected.length; batchStart += CONCURRENCY) {
      if (Date.now() > deadline) {
        const remaining = selected.slice(batchStart);
        for (let r = 0; r < remaining.length; r++) {
          errors.push({ index: batchStart + r, error: `Timed out after ${RECREATE_TIMEOUT_MS / 1000}s` });
        }
        break;
      }

      const batch = selected.slice(batchStart, batchStart + CONCURRENCY);
      const batchPromises = batch.map((post, bi) => {
        const idx = batchStart + bi;
        return postCloneRoute.processPostClone({
          post,
          characterId,
          mode: cleanMode,
          apiKey,
          character,
          activeRefs,
          baseReferenceImages,
          tempFiles,
        }).then((processed) => ({ ok: true, idx, processed }))
          .catch((err) => {
            console.warn(`[profile-clone/recreate] post ${idx + 1}/${selected.length} failed: ${err.message}`);
            return { ok: false, idx, error: err.message };
          });
      });

      const settled = await Promise.all(batchPromises);
      for (const r of settled) {
        if (r.ok) {
          results.push(r.processed);
        } else {
          errors.push({ index: r.idx, error: r.error });
        }
      }
    }

    // Cleanup temp files
    for (const filePath of tempFiles) {
      try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best-effort */ }
    }

    if (results.length === 0 && errors.length > 0) {
      throw new AppError(
        `All ${errors.length} post(s) failed. Last error: ${errors[errors.length - 1].error}`,
        502,
        'ALL_POSTS_FAILED'
      );
    }

    // Save history entries
    for (const processed of results) {
      try {
        postCloneHistoryStore.save({
          sourceUrl: processed.sourceUrl || '',
          type: processed.type || 'single',
          mode: cleanMode,
          characterId,
          galleryIds: processed.galleryIds || [],
        });
      } catch (histErr) {
        console.warn('[profile-clone/recreate] history save failed:', histErr.message);
      }
    }

    console.log(`[profile-clone/recreate] done: ${results.length} succeeded, ${errors.length} failed`);
    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
