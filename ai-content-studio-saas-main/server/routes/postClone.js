'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const { AppError } = require('../middleware/errorHandler');
const { requirePlanCapacity } = require('../middleware/planLimits');
const { asText } = require('../utils/helpers');
const { sharedHttpsAgent } = require('../utils/httpAgent');
const { buildLoginCookies } = require('../utils/instagramCookies');
const apiKeyManager = require('../services/apiKeyManager');
const referenceManager = require('../services/referenceManager');
const geminiService = require('../services/geminiBackend');
const galleryManager = require('../services/galleryManager');
const postCloneHistoryStore = require('../services/postCloneHistoryStore');
const styleFocusStore = require('../services/styleFocusStore');
const { checkPostAvailability } = require('../services/instagramAvailabilityService');
const log = require('../utils/logger');

const {
  TEMP_DIR, THUMB_DIR, ensureTempDir, ensureThumbDir, cacheThumbnail,
  isHttpUrl, downloadImageToTemp, resolveDownloadableImageUrl, mimeFromExt, safeJpegFromAnyImage,
} = require('../services/postClone/mediaUtils');
const {
  buildCharacterReferenceImages, buildGenerationPrompt,
  analyzeImageStructured, analyzeCarouselDelta,
  parseStructuredAnalysis, buildStructuredAnalysisPrompt,
} = require('../services/postClone/analysisEngine');
const {
  getItemShortcode, runPostActor, normalizePostsFromItems,
  resolveUsernameFromPostUrl,
} = require('../services/postClone/apifyFetcher');

const router = express.Router();
const ROUTE_TIMEOUT_MS = 5 * 60_000;
const PROFILE_ROUTE_TIMEOUT_MS = 15 * 60_000;

// ── Slide & post processing ────────────────────────────────────────────────────

async function processOneSlide({
  post, i, apiKey, character, activeRefs, mode, cosplayMode = false, baseReferenceImages,
  characterId, tempFiles, firstSlideOriginal, firstSlideRecreated, imageModel, aspectRatio = '4:5', resolutionTier = '2K',
}) {
  const rawUrl = post.imageUrls[i];
  const imageUrl = await resolveDownloadableImageUrl(rawUrl);
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${i}`;
  const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
  const filePath = path.join(TEMP_DIR, `post-clone-${unique}${ext}`);
  tempFiles.push(filePath);
  await downloadImageToTemp(imageUrl, filePath);

  let resolvedPath = filePath;
  let buffer = fs.readFileSync(resolvedPath);
  let mimeType = mimeFromExt(resolvedPath);
  let base64Data = buffer.toString('base64');
  const original = { url: imageUrl || rawUrl, mimeType, base64Data };

  const sourceMeta = {
    source_url: post.sourceUrl || imageUrl || rawUrl,
    source_type: post.type,
    carousel_position: post.type === 'carousel' ? i + 1 : null,
  };

  let structured;
  let referenceImages = [...baseReferenceImages];
  let generationPrompt = '';

  if (post.type === 'carousel' && i > 0 && firstSlideOriginal && firstSlideRecreated) {
    let delta;
    try {
      delta = await analyzeCarouselDelta(apiKey, firstSlideOriginal.base64Data, firstSlideOriginal.mimeType, base64Data, mimeType, mode, sourceMeta, characterId);
    } catch (err) {
      const msg = asText(err?.message).toLowerCase();
      if (!msg.includes('unable to process input image') && !msg.includes('invalid_argument')) throw err;
      resolvedPath = await safeJpegFromAnyImage(filePath, tempFiles);
      buffer = fs.readFileSync(resolvedPath);
      mimeType = 'image/jpeg';
      base64Data = buffer.toString('base64');
      delta = await analyzeCarouselDelta(apiKey, firstSlideOriginal.base64Data, firstSlideOriginal.mimeType, base64Data, mimeType, mode, sourceMeta, characterId);
    }
    structured = delta.parsed;
    generationPrompt = buildGenerationPrompt({ character, activeRefs, mode, cosplayMode, structured, isDelta: true });
    referenceImages = [{ mimeType: firstSlideRecreated.mimeType, base64Data: firstSlideRecreated.base64Data }];
  } else {
    let analysis;
    try {
      analysis = await analyzeImageStructured(apiKey, base64Data, mimeType, mode, sourceMeta, characterId, cosplayMode);
    } catch (err) {
      const msg = asText(err?.message).toLowerCase();
      if (!msg.includes('unable to process input image') && !msg.includes('invalid_argument')) throw err;
      resolvedPath = await safeJpegFromAnyImage(filePath, tempFiles);
      buffer = fs.readFileSync(resolvedPath);
      mimeType = 'image/jpeg';
      base64Data = buffer.toString('base64');
      analysis = await analyzeImageStructured(apiKey, base64Data, mimeType, mode, sourceMeta, characterId, cosplayMode);
    }
    structured = analysis.parsed;
    generationPrompt = buildGenerationPrompt({ character, activeRefs, mode, cosplayMode, structured, isDelta: false });
  }

  const generated = await geminiService.generateImage(apiKey, generationPrompt, {
    aspectRatio,
    imageSize: resolutionTier,
    referenceImages,
    model: imageModel,
  });
  const galleryEntry = galleryManager.save({
    base64Data: generated.image.base64Data,
    mimeType: generated.image.mimeType,
    prompt: generationPrompt || structured.full_prompt || 'Post Clone recreation',
    source: 'post-clone',
    characterId,
    aspectRatio: aspectRatio || null,
    seed: null,
  });

  return {
    original,
    recreated: { mimeType: generated.image.mimeType, base64Data: generated.image.base64Data, text: generated.text || null, prompt: generationPrompt, structured },
    slideOriginal: { mimeType, base64Data },
    slideRecreated: { mimeType: generated.image.mimeType, base64Data: generated.image.base64Data },
    galleryId: galleryEntry?.id || null,
  };
}

async function processPostClone({ post, characterId, mode, cosplayMode = false, apiKey, character, activeRefs, baseReferenceImages, tempFiles, imageModel, aspectRatio = '4:5', resolutionTier = '2K' }) {
  const recreatedImages = [];
  const originalImages = [];
  const galleryIds = [];
  const isCarousel = post.type === 'carousel' && post.imageUrls.length > 1;
  const slideArgs = { post, apiKey, character, activeRefs, mode, cosplayMode, baseReferenceImages, characterId, tempFiles, imageModel, aspectRatio, resolutionTier };

  let firstSlideOriginal = null;
  let firstSlideRecreated = null;

  try {
    const r0 = await processOneSlide({ ...slideArgs, i: 0, firstSlideOriginal: null, firstSlideRecreated: null });
    originalImages.push(r0.original);
    recreatedImages.push(r0.recreated);
    if (r0.galleryId) galleryIds.push(r0.galleryId);
    firstSlideOriginal = r0.slideOriginal;
    firstSlideRecreated = r0.slideRecreated;
  } catch (slideErr) {
    if (isCarousel) {
      log.warn('post_clone_slide_failed', { slide: 1, total: post.imageUrls.length, message: slideErr.message });
    } else {
      throw slideErr;
    }
  }

  if (post.imageUrls.length > 1) {
    const remainingIndices = [];
    for (let i = 1; i < post.imageUrls.length; i++) remainingIndices.push(i);
    log.info('post_clone_processing_slides', { remaining: remainingIndices.length });

    const settled = await Promise.all(
      remainingIndices.map((i) =>
        processOneSlide({ ...slideArgs, i, firstSlideOriginal, firstSlideRecreated })
          .then((r) => ({ ok: true, i, r }))
          .catch((err) => {
            log.warn('post_clone_slide_failed', { slide: i + 1, total: post.imageUrls.length, message: err.message });
            return { ok: false, i };
          })
      )
    );
    settled.sort((a, b) => a.i - b.i);
    for (const s of settled) {
      if (s.ok) {
        originalImages.push(s.r.original);
        recreatedImages.push(s.r.recreated);
        if (s.r.galleryId) galleryIds.push(s.r.galleryId);
      }
    }
  }

  return { type: post.type, sourceUrl: post.sourceUrl || null, originalImages, recreatedImages, galleryIds };
}

// ── Main handler ───────────────────────────────────────────────────────────────

async function handleClone({ url, characterId, mode, cosplayMode = false, postLimit = 1, apifyApiKey, profileMode = false, imageModel, aspectRatio = '4:5', resolutionTier = '2K' }) {
  const deadline = Date.now() + (profileMode ? PROFILE_ROUTE_TIMEOUT_MS : ROUTE_TIMEOUT_MS);
  const cleanUrl = asText(url);
  if (!cleanUrl || !isHttpUrl(cleanUrl)) throw new AppError('A valid Instagram URL is required', 400, 'VALIDATION_ERROR');
  if (!characterId || typeof characterId !== 'string') throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
  if (!['exact', 'creative'].includes(mode)) throw new AppError('"mode" must be "exact" or "creative"', 400, 'VALIDATION_ERROR');

  const character = referenceManager.getCharacter(characterId);
  const activeRefs = referenceManager.getActiveReferences(characterId, null);
  const baseReferenceImages = buildCharacterReferenceImages(characterId, activeRefs);
  const apiKey = apiKeyManager.getActiveKey();

  const tempFiles = [];
  ensureTempDir();
  try {
    const availability = await checkPostAvailability(cleanUrl, { apifyToken: apifyApiKey });
    if (!availability.allowed) throw new AppError(availability.label, 422, 'INSTAGRAM_UNAVAILABLE');

    let items = await runPostActor({ url: cleanUrl, limit: profileMode ? postLimit : 10, apifyToken: apifyApiKey });

    let posts;
    try {
      posts = normalizePostsFromItems(items);
    } catch (normErr) {
      if (normErr.code === 'INSTAGRAM_RESTRICTED' && buildLoginCookies()) {
        log.info('post_clone_restricted_profile_fallback', { url: cleanUrl });
        const ownerUsername = await resolveUsernameFromPostUrl(cleanUrl, items);
        if (ownerUsername) {
          const segs = new URL(cleanUrl).pathname.split('/').filter(Boolean);
          const targetShortcode = ['p', 'reel', 'tv'].includes(segs[0]?.toLowerCase()) ? segs[1] || '' : '';
          const profileUrl = `https://www.instagram.com/${ownerUsername}/`;
          log.info('post_clone_profile_fallback', { profileUrl, shortcode: targetShortcode || null });
          const profileItems = await runPostActor({ url: profileUrl, limit: 30, apifyToken: apifyApiKey });

          if (targetShortcode && profileItems.length > 0) {
            let matching = profileItems.filter((it) => getItemShortcode(it) === targetShortcode);
            if (matching.length === 0) matching = profileItems.filter((it) => asText(it?.url || it?.inputUrl || '').includes(targetShortcode));
            if (matching.length > 0) {
              log.info('post_clone_shortcode_found', { count: matching.length, shortcode: targetShortcode });
              items = matching;
            } else {
              log.warn('post_clone_shortcode_not_found', { shortcode: targetShortcode, retrying: true });
              const retryItems = await runPostActor({ url: profileUrl, limit: 50, apifyToken: apifyApiKey });
              matching = retryItems.filter((it) => getItemShortcode(it) === targetShortcode || asText(it?.url || it?.inputUrl || '').includes(targetShortcode));
              if (matching.length > 0) {
                log.info('post_clone_shortcode_found_retry', { count: matching.length, shortcode: targetShortcode });
                items = matching;
              } else {
                throw new AppError(
                  `Could not find post ${targetShortcode} in @${ownerUsername}'s profile (${retryItems.length} posts scraped). The post may have been deleted or the scraper missed it — try again.`,
                  422, 'POST_NOT_FOUND_IN_PROFILE'
                );
              }
            }
          } else {
            items = profileItems;
          }
          posts = normalizePostsFromItems(items);
        } else {
          log.warn('post_clone_username_resolve_failed', { url: cleanUrl });
          throw normErr;
        }
      } else {
        throw normErr;
      }
    }

    const selected = profileMode ? posts.slice(0, Math.max(1, Math.min(20, Number(postLimit) || 1))) : posts.slice(0, 1);
    if (selected.length === 0) throw new AppError('No static image posts found to clone', 422, 'NO_IMAGE_POSTS');

    const results = [];
    const errors = [];
    const timeoutSec = profileMode ? PROFILE_ROUTE_TIMEOUT_MS / 1000 : ROUTE_TIMEOUT_MS / 1000;
    const CONCURRENCY = profileMode ? 2 : 1;

    for (let batchStart = 0; batchStart < selected.length; batchStart += CONCURRENCY) {
      if (Date.now() > deadline) {
        const remaining = selected.slice(batchStart);
        for (let r = 0; r < remaining.length; r++) errors.push({ index: batchStart + r, sourceUrl: remaining[r].sourceUrl || '', error: `Timed out after ${timeoutSec}s` });
        break;
      }
      const batch = selected.slice(batchStart, batchStart + CONCURRENCY);
      const settled = await Promise.all(
        batch.map((post, bi) => {
          const idx = batchStart + bi;
          return processPostClone({ post, characterId, mode, cosplayMode, apiKey, character, activeRefs, baseReferenceImages, tempFiles, imageModel, aspectRatio, resolutionTier })
            .then((processed) => ({ ok: true, idx, processed }))
            .catch((postErr) => {
              log.warn('post_clone_post_failed', { index: idx + 1, total: selected.length, message: postErr.message });
              return { ok: false, idx, sourceUrl: post.sourceUrl || '', error: postErr.message };
            });
        })
      );
      for (const r of settled) {
        if (r.ok) {
          results.push(r.processed);
        } else {
          errors.push({ index: r.idx, sourceUrl: r.sourceUrl, error: r.error });
          if (!profileMode) throw new AppError(r.error, 502, 'POST_CLONE_FAILED');
        }
      }
    }

    if (results.length === 0 && errors.length > 0) {
      throw new AppError(`All ${errors.length} post(s) failed to clone. Last error: ${errors[errors.length - 1].error}`, 502, 'ALL_POSTS_FAILED');
    }

    log.info('post_clone_done', { succeeded: results.length, failed: errors.length });
    for (const processed of results) {
      try {
        postCloneHistoryStore.save({ sourceUrl: processed.sourceUrl || cleanUrl, type: processed.type || 'single', mode, characterId, galleryIds: processed.galleryIds || [] });
      } catch (histErr) {
        log.warn('post_clone_history_save_failed', { message: histErr.message });
      }
    }

    return results;
  } finally {
    for (const filePath of tempFiles) {
      try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
    }
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

router.post('/', requirePlanCapacity(), async (req, res, next) => {
  try {
    const {
      postUrl, characterId, mode = 'exact', cosplayMode = false, apifyApiKey, imageModel,
      aspectRatio = '4:5', resolutionTier = '2K',
    } = req.body || {};

    const cleanUrl = asText(postUrl);
    const cleanMode = asText(mode).toLowerCase() || 'exact';
    const data = await handleClone({
      url: cleanUrl,
      characterId,
      mode: cleanMode,
      cosplayMode: !!cosplayMode,
      apifyApiKey: apifyApiKey || apiKeyManager.getApifyKey(),
      imageModel,
      aspectRatio,
      resolutionTier,
      postLimit: 1,
      profileMode: false,
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/style-focus', (_req, res, next) => {
  try { res.json({ success: true, data: styleFocusStore.list() }); }
  catch (err) { next(err); }
});

router.get('/style-focus/:id', (req, res, next) => {
  try { res.json({ success: true, data: styleFocusStore.get(req.params.id) }); }
  catch (err) { next(err); }
});

router.post('/style-focus', (req, res, next) => {
  try { res.status(201).json({ success: true, data: styleFocusStore.save(req.body) }); }
  catch (err) { next(err); }
});

router.delete('/style-focus/:id', (req, res, next) => {
  try { res.json({ success: true, data: styleFocusStore.remove(req.params.id) }); }
  catch (err) { next(err); }
});

router.get('/history', (_req, res, next) => {
  try { res.json({ success: true, data: postCloneHistoryStore.list() }); }
  catch (err) { next(err); }
});

router.delete('/history/:id', (req, res, next) => {
  try { res.json({ success: true, data: postCloneHistoryStore.remove(req.params.id) }); }
  catch (err) { next(err); }
});

router.get('/proxy-image', async (req, res, next) => {
  try {
    const url = asText(req.query.url);
    if (!url || !isHttpUrl(url)) return res.status(400).json({ error: 'Missing or invalid url param' });
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const domainParts = host.split('.');
    const top2 = domainParts.slice(-2).join('.');
    const top3 = domainParts.slice(-3).join('.');
    const isAllowed = (top2 === 'fbcdn.net' && (host === 'fbcdn.net' || host.endsWith('.fbcdn.net')))
      || (top2 === 'instagram.com' && (host === 'instagram.com' || host.endsWith('.instagram.com')))
      || (top3 === 'cdninstagram.com' && (host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com')));
    if (!isAllowed) return res.status(403).json({ error: 'Only Instagram CDN URLs can be proxied' });
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000,
      httpsAgent: sharedHttpsAgent,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*,*/*;q=0.8', 'Referer': 'https://www.instagram.com/' },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const ct = (response.headers['content-type'] || '').toLowerCase();
    if (ct && !ct.startsWith('image/') && !ct.includes('octet-stream')) {
      response.data.destroy();
      return res.status(502).json({ error: `Upstream returned non-image: ${ct}` });
    }
    res.set('Content-Type', ct || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    response.data.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.end(); });
    response.data.pipe(res);
  } catch (err) {
    next(new AppError(`Image proxy failed: ${err.message}`, 502, 'PROXY_ERROR'));
  }
});

router.get('/thumb/:filename', (req, res, next) => {
  try {
    const filename = path.basename(req.params.filename);
    if (!/^[a-f0-9-]+\.jpg$/i.test(filename)) return res.status(400).json({ error: 'Invalid thumbnail filename' });
    const filePath = path.join(THUMB_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Thumbnail not found or expired' });
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=1800');
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => { if (!res.headersSent) next(err); else res.end(); });
    stream.pipe(res);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.handleClone = handleClone;
module.exports.runPostActor = runPostActor;
module.exports.normalizePostsFromItems = normalizePostsFromItems;
module.exports.processPostClone = processPostClone;
module.exports.downloadImageToTemp = downloadImageToTemp;
module.exports.parseStructuredAnalysis = parseStructuredAnalysis;
module.exports.buildStructuredAnalysisPrompt = buildStructuredAnalysisPrompt;
module.exports.mimeFromExt = mimeFromExt;
module.exports.ensureTempDir = ensureTempDir;
module.exports.cacheThumbnail = cacheThumbnail;
module.exports.ensureThumbDir = ensureThumbDir;
module.exports.buildCharacterReferenceImages = buildCharacterReferenceImages;
