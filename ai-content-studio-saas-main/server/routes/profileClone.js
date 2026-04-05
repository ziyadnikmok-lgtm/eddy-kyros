const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const log = require('../utils/logger');
const apiKeyManager = require('../services/apiKeyManager');
const referenceManager = require('../services/referenceManager');
const galleryManager = require('../services/galleryManager');
const postCloneHistoryStore = require('../services/postCloneHistoryStore');
const postCloneRoute = require('./postClone');

const router = express.Router();
const { TEMP_DIR } = require('../paths');
const RECREATE_TIMEOUT_MS = 15 * 60_000;

router.post('/', async (req, res, next) => {
  try {
    const { profileUrl, characterId, postLimit = 5, mode = 'exact', apifyApiKey, imageModel } = req.body || {};
    const data = await postCloneRoute.handleClone({
      url: profileUrl,
      characterId,
      mode: (typeof mode === 'string' ? mode.trim().toLowerCase() : 'exact') || 'exact',
      apifyApiKey,
      imageModel,
      postLimit: Math.max(1, Math.min(20, Number(postLimit) || 5)),
      profileMode: true,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

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
    const rawByUrl = new Map();
    for (const raw of (items || [])) {
      const u = asText(raw?.url || raw?.inputUrl || raw?.shortCodeUrl || '');
      if (u) rawByUrl.set(u, raw);
    }

    postCloneRoute.ensureThumbDir();
    const thumbPromises = posts.map(async (p) => {
      const urls = p.imageUrls || [];
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
        thumbnail: thumbFilenames[i] || '',
      };
    });

    log.info('profile_clone_fetch_done', { posts: previews.length, thumbnails: thumbFilenames.filter(Boolean).length });
    res.json({ success: true, data: previews });
  } catch (err) {
    next(err);
  }
});

router.post('/recreate', async (req, res, next) => {
  try {
    const { posts, characterId, mode = 'exact', cosplayMode = false, imageModel } = req.body || {};

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

    const selected = posts.slice(0, 20).map((p) => ({
      type: p.type || 'single',
      sourceUrl: asText(p.sourceUrl),
      imageUrls: Array.isArray(p.imageUrls) ? p.imageUrls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) : [],
    })).filter((p) => p.imageUrls.length > 0);

    if (selected.length === 0) {
      throw new AppError('No valid posts with image URLs provided', 400, 'VALIDATION_ERROR');
    }

    const character = referenceManager.getCharacter(characterId);
    const activeRefs = referenceManager.getActiveReferences(characterId, null);
    const apiKey = apiKeyManager.getActiveKey();

    const baseReferenceImages = postCloneRoute.buildCharacterReferenceImages(characterId, activeRefs);

    const deadline = Date.now() + RECREATE_TIMEOUT_MS;
    const tempFiles = [];
    postCloneRoute.ensureTempDir();

    const results = [];
    const errors = [];
    const CONCURRENCY = 2;

    try {
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
            cosplayMode: !!cosplayMode,
            apiKey,
            character,
            activeRefs,
            baseReferenceImages,
            tempFiles,
            imageModel,
          }).then((processed) => ({ ok: true, idx, processed }))
            .catch((err) => {
              log.warn('profile_clone_post_failed', { index: idx + 1, total: selected.length, message: err.message });
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
    } finally {
      for (const filePath of tempFiles) {
        try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
      }
    }

    if (results.length === 0 && errors.length > 0) {
      throw new AppError(
        `All ${errors.length} post(s) failed. Last error: ${errors[errors.length - 1].error}`,
        502,
        'ALL_POSTS_FAILED'
      );
    }

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
        log.warn('profile_clone_history_save_failed', { message: histErr.message });
      }
    }

    log.info('profile_clone_recreate_done', { succeeded: results.length, failed: errors.length });
    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
