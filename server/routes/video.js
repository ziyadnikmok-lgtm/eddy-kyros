const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const archiver = require('archiver');
const wavespeed = require('../services/wavespeedService');
const muapi = require('../services/muapiService');
const geminiVideo = require('../services/geminiVideoService');
const videoHistory = require('../services/videoHistoryStore');
const galleryManager = require('../services/galleryManager');
const apiKeyManager = require('../services/apiKeyManager');
const { AppError } = require('../middleware/errorHandler');
const videoStripper = require('../services/videoMetadataStripper');
const { requirePlanCapacity } = require('../middleware/planLimits');
const { createMultipartParser } = require('../middleware/multipartParser');
const { UPLOADS_DIR } = require('../paths');
const { logUsageEvent, startGenerationRun, finishGenerationRun } = require('../services/eventLogger');
const { reconcileMuapiEntry } = require('../services/videoReconciler');
const { MUAPI_VIDEO_MODELS } = require('../config/muapiVideoModels');
const log = require('../utils/logger');

const VIDEO_PRICES = {
  'kling-v2.5-turbo-std': { 5: 0.21, 10: 0.42 },
  'kling-v2.5-turbo-pro': { 5: 0.35, 10: 0.70 },
  'grok-imagine-video': { 6: 0.33, 10: 0.55 },
  'kling-v2.6-motion': { 5: 0.35 },
  'kling-v2.6-motion-pro': { 5: 0.56 },
};
const GEMINI_VIDEO_MODELS = new Set(['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview']);
const GEMINI_VIDEO_PRICES_PER_SECOND = {
  'veo-3.1-generate-preview': 0.40,
  'veo-3.1-fast-generate-preview': 0.15,
};


const router = express.Router();
const VIDEO_DIR = path.join(UPLOADS_DIR, 'videos');
const parseMultipartIfNeeded = createMultipartParser({ maxBytes: 200 * 1024 * 1024 });

router.post('/generate', parseMultipartIfNeeded, requirePlanCapacity(), async (req, res, next) => {
  let runId = null;
  try {
    const {
      model,
      prompt,
      duration,
      negativePrompt,
      guidanceScale,
      resolution,
      lastImage,
      motionSource,
      characterOrientation,
      keepOriginalSound,
      aspectRatio,
      generateAudio,
    } = req.body || {};

    if (!model) throw new AppError('model is required', 400, 'VALIDATION_ERROR');

    const isGeminiVideo = GEMINI_VIDEO_MODELS.has(model);
    const isMuapiVideo = MUAPI_VIDEO_MODELS.has(model);
    let imageUrl;
    let imageBase64;
    let imageMimeType;
    // A caller may send ONE image (`image`) or SEVERAL (`images`). When only the list is sent, its
    // first entry is also the primary image, so the single-image path below (and the "an image is
    // required" guard) keeps working unchanged instead of rejecting a perfectly valid request.
    const imageList = Array.isArray(req.body.images)
      ? req.body.images.filter((im) => im && typeof im.image === 'string' && im.image)
      : [];
    const imageData = req.body.image || imageList[0]?.image;
    const galleryId = req.body.galleryId;

    if (galleryId) {
      const { filePath, mimeType } = galleryManager.getFilePath(galleryId);
      const buffer = fs.readFileSync(filePath);
      imageBase64 = buffer.toString('base64');
      imageMimeType = mimeType;
      if (!isGeminiVideo && !isMuapiVideo) {
        imageUrl = await wavespeed.uploadBase64(imageBase64, mimeType);
      }
    } else if (imageData) {
      imageBase64 = imageData;
      imageMimeType = req.body.imageMimeType || 'image/png';
      if (!isGeminiVideo && !isMuapiVideo) {
        imageUrl = await wavespeed.uploadBase64(imageData, imageMimeType);
      }
    } else if (!isGeminiVideo) {
      throw new AppError('An image is required (image base64 or galleryId)', 400, 'VALIDATION_ERROR');
    }

    if (isMuapiVideo) {
      // Multiple source images: images_list is an array in Muapi's schema — the first is the frame
      // the clip starts from, the rest ride along as extra reference. Falls back to the single
      // image resolved above (upload / gallery) when the caller sends only one, so nothing else
      // that posts here has to change.
      let extraImages = imageList.map((im) => ({ base64: im.image, mimeType: im.imageMimeType || 'image/png' }));
      // A gallery-sourced primary has no inline bytes in `images` (the client only sends galleryId),
      // so it must be put back at the FRONT of the list — otherwise the picture the user actually
      // chose as the first frame is silently dropped and an extra takes its place.
      if (extraImages.length && galleryId && imageBase64) {
        extraImages = [{ base64: imageBase64, mimeType: imageMimeType }, ...extraImages];
      }
      const { taskId, status } = await muapi.createVideoTask(model, {
        images: extraImages.length ? extraImages : undefined,
        imageBase64,
        imageMimeType,
        prompt: prompt ? String(prompt).slice(0, 2500) : '',
        aspectRatio: aspectRatio || '16:9',
        duration: Number(duration) || 5,
      });

      runId = startGenerationRun({
        id: taskId,
        userId: req.session?.userId,
        feature: 'video',
        provider: 'muapi',
        model,
        status: status || 'processing',
      });
      logUsageEvent({
        userId: req.session?.userId,
        eventType: 'generation.started',
        entityType: 'generation_run',
        entityId: runId,
        source: 'video',
        payload: { feature: 'video', provider: 'muapi', model, duration: Number(duration) || null },
      });

      const historyEntry = videoHistory.add({
        taskId,
        provider: 'muapi',
        model,
        prompt: prompt ? String(prompt).slice(0, 2500) : '',
        sourceImageId: galleryId || null,
        status: status || 'processing',
        duration: Number(duration) || null,
      });

      return res.json({ success: true, data: { taskId, historyId: historyEntry.id, status: status || 'processing' } });
    }

    if (isGeminiVideo) {
      if (!imageBase64 && !prompt) {
        throw new AppError('Veo requires at least a prompt or source image', 400, 'VALIDATION_ERROR');
      }
      const apiKey = apiKeyManager.getActiveKey();
      if (!apiKey) {
        throw new AppError('Video generation requires a Gemini API key. Go to API Keys and add one — Vertex AI is not supported for video.', 400, 'GEMINI_KEY_REQUIRED');
      }
      const operation = await geminiVideo.createVideoOperation(apiKey, {
        model,
        prompt: prompt ? String(prompt).slice(0, 2500) : '',
        imageBase64,
        imageMimeType,
        durationSeconds: Number(duration) || undefined,
        aspectRatio: aspectRatio === '9:16' ? '9:16' : '16:9',
        resolution: resolution === '1080p' ? '1080p' : '720p',
        negativePrompt: negativePrompt ? String(negativePrompt) : undefined,
        generateAudio: generateAudio !== false,
        lastImageBase64: lastImage || undefined,
        lastImageMimeType: req.body.lastImageMimeType || 'image/png',
      });

      const taskId = Buffer.from(operation.operationName, 'utf8').toString('base64url');
      runId = startGenerationRun({
        id: taskId,
        userId: req.session?.userId,
        feature: 'video',
        provider: 'gemini',
        model,
        status: operation.done ? 'succeeded' : 'processing',
      });
      logUsageEvent({
        userId: req.session?.userId,
        eventType: operation.done ? 'generation.succeeded' : 'generation.started',
        entityType: 'generation_run',
        entityId: runId,
        source: 'video',
        payload: { feature: 'video', provider: 'gemini', model, duration: Number(duration) || null },
      });
      if (operation.done) {
        finishGenerationRun(runId, { status: 'succeeded', outputCount: 1, provider: 'gemini', model });
      }
      const historyEntry = videoHistory.add({
        taskId,
        provider: 'gemini',
        operationName: operation.operationName,
        model,
        prompt: prompt ? String(prompt).slice(0, 2500) : '',
        sourceImageId: galleryId || null,
        status: operation.done ? 'completed' : 'processing',
        duration: Number(duration) || null,
        aspectRatio: aspectRatio === '9:16' ? '9:16' : '16:9',
        resolution: resolution === '1080p' ? '1080p' : '720p',
      });

      return res.json({
        success: true,
        data: {
          taskId,
          historyId: historyEntry.id,
          status: operation.done ? 'completed' : 'processing',
        },
      });
    }

    const params = { image: imageUrl };

    if (prompt) params.prompt = String(prompt).slice(0, 2500);
    else params.prompt = '';

    if (negativePrompt) params.negative_prompt = String(negativePrompt);

    if (model === 'kling-v2.6-motion' || model === 'kling-v2.6-motion-pro') {
      if (!motionSource) throw new AppError('Motion Control requires a video source (motionSource)', 400, 'VALIDATION_ERROR');

      let videoUrl;
      if (motionSource.type === 'url' && motionSource.url) {
        const { getReelVideoUrlFromApify, downloadVideoToTemp } = require('../services/reelReferenceService');
        const result = await getReelVideoUrlFromApify(motionSource.url);
        const videoPath = await downloadVideoToTemp(result.videoUrl);
        try {
          videoUrl = await wavespeed.uploadFile(videoPath);
        } finally {
          try { fs.unlinkSync(videoPath); } catch { /* ignore temp cleanup errors */ }
        }
      } else if (motionSource.type === 'upload' && motionSource.videoBase64) {
        const tempPath = path.join(os.tmpdir(), `motion-${crypto.randomUUID()}.mp4`);
        try {
          let raw = motionSource.videoBase64;
          const match = raw.match(/^data:[^;]+;base64,(.+)$/);
          if (match) raw = match[1];
          fs.writeFileSync(tempPath, Buffer.from(raw, 'base64'));
          videoUrl = await wavespeed.uploadFile(tempPath);
        } finally {
          try { fs.unlinkSync(tempPath); } catch { /* ignore temp cleanup errors */ }
        }
      } else {
        throw new AppError('motionSource must have type "url" with url, or type "upload" with videoBase64', 400, 'VALIDATION_ERROR');
      }

      params.video = videoUrl;
      params.character_orientation = characterOrientation || 'image';
      if (keepOriginalSound !== undefined) {
        params.keep_original_sound = !!keepOriginalSound;
      }
    } else {
      if (model === 'kling-v2.5-turbo-std' || model === 'kling-v2.5-turbo-pro') {
        params.duration = Number(duration) === 10 ? 10 : 5;
        if (guidanceScale !== undefined) params.guidance_scale = Math.max(0, Math.min(1, Number(guidanceScale) || 0.5));
      }

      if (model === 'kling-v2.5-turbo-pro' && lastImage) {
        params.last_image = await wavespeed.uploadBase64(lastImage, req.body.lastImageMimeType || 'image/png');
      }

      if (model === 'grok-imagine-video') {
        params.duration = Number(duration) === 10 ? 10 : 6;
        params.resolution = resolution === '480p' ? '480p' : '720p';
      }
    }

    const { taskId, status } = await wavespeed.createVideoTask(model, params);
    runId = startGenerationRun({
      id: taskId,
      userId: req.session?.userId,
      feature: 'video',
      provider: 'wavespeed',
      model,
      status: status || 'processing',
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.started',
      entityType: 'generation_run',
      entityId: runId,
      source: 'video',
      payload: { feature: 'video', provider: 'wavespeed', model, duration: params.duration || null },
    });

    const historyEntry = videoHistory.add({
      taskId,
      model,
      prompt: params.prompt,
      sourceImageId: galleryId || null,
      status: status || 'processing',
      duration: params.duration || null,
    });

    res.json({ success: true, data: { taskId, historyId: historyEntry.id, status } });
  } catch (err) {
    finishGenerationRun(runId, {
      status: 'failed',
      outputCount: 0,
      errorCode: err.code || err.name || 'UNKNOWN',
      errorMessage: err.message || 'Video generation failed',
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.failed',
      entityType: 'generation_run',
      entityId: runId,
      source: 'video',
      payload: { feature: 'video', errorCode: err.code || err.name || 'UNKNOWN', message: err.message || 'Video generation failed' },
    });
    next(err);
  }
});

router.get('/:taskId/status', async (req, res, next) => {
  try {
    const { taskId } = req.params;
    const entry = videoHistory.findByTaskId(taskId);
    if (entry?.provider === 'gemini') {
      const apiKey = apiKeyManager.getActiveKey();
      if (!apiKey) throw new AppError('Gemini API key required to check video status.', 400, 'GEMINI_KEY_REQUIRED');
      const result = await geminiVideo.getVideoOperation(apiKey, entry.operationName);

      if (!result.done) {
        return res.json({ success: true, data: { status: 'processing' } });
      }

      const generatedVideo = result.operation?.response?.generatedVideos?.[0]?.video || null;
      const videoUri = generatedVideo?.uri || null;
      if (!videoUri) {
        videoHistory.update(entry.id, { status: 'failed', error: 'Veo completed without a downloadable video URI' });
        finishGenerationRun(taskId, {
          status: 'failed',
          outputCount: 0,
          provider: 'gemini',
          model: entry.model,
          errorCode: 'NO_VIDEO_URI',
          errorMessage: 'Veo completed without a downloadable video URI',
        });
        logUsageEvent({
          userId: req.session?.userId,
          eventType: 'generation.failed',
          entityType: 'generation_run',
          entityId: taskId,
          source: 'video',
          payload: { feature: 'video', provider: 'gemini', errorCode: 'NO_VIDEO_URI' },
        });
        return res.json({ success: true, data: { status: 'failed', error: 'Veo returned no downloadable video' } });
      }

      if (!entry.localPath) {
        let filename, filePath;
        try {
          ({ filename, filePath } = await geminiVideo.downloadVideo(apiKey, videoUri, VIDEO_DIR));
        } catch (dlErr) {
          log.warn('veo_download_failed', { taskId, error: dlErr.message });
          videoHistory.update(entry.id, { status: 'failed', error: `Video download failed: ${dlErr.message}` });
          finishGenerationRun(taskId, {
            status: 'failed',
            outputCount: 0,
            provider: 'gemini',
            model: entry.model,
            errorCode: 'DOWNLOAD_FAILED',
            errorMessage: dlErr.message,
          });
          logUsageEvent({
            userId: req.session?.userId,
            eventType: 'generation.failed',
            entityType: 'generation_run',
            entityId: taskId,
            source: 'video',
            payload: { feature: 'video', provider: 'gemini', errorCode: 'DOWNLOAD_FAILED', message: dlErr.message },
          });
          return res.json({ success: true, data: { status: 'failed', error: 'Video download failed — please regenerate' } });
        }
        if (!entry.spendTracked) {
          const perSecond = GEMINI_VIDEO_PRICES_PER_SECOND[entry.model] || 0;
          const totalCost = perSecond * (entry.duration || 0);
          if (totalCost > 0) {
            apiKeyManager.addExternalSpend(totalCost, 'video');
          }
        }
        videoHistory.update(entry.id, {
          status: 'completed',
          videoUrl: videoUri,
          localPath: filePath,
          filename,
          spendTracked: true,
        });
        finishGenerationRun(taskId, {
          status: 'succeeded',
          outputCount: 1,
          provider: 'gemini',
          model: entry.model,
        });
        logUsageEvent({
          userId: req.session?.userId,
          eventType: 'generation.succeeded',
          entityType: 'generation_run',
          entityId: taskId,
          source: 'video',
          payload: { feature: 'video', provider: 'gemini', localFilename: filename },
        });
        return res.json({ success: true, data: { status: 'completed', localFilename: filename } });
      }

      return res.json({
        success: true,
        data: {
          status: 'completed',
          localFilename: entry.filename,
        },
      });
    }

    if (entry?.provider === 'muapi') {
      // Same code path the background reconciler uses, and it de-dupes by taskId — a live page
      // polling a task the reconciler already has in flight joins that pass instead of racing
      // it into a double download and a double charge.
      let result;
      try {
        result = await reconcileMuapiEntry(entry, { userId: req.session?.userId });
      } catch (statusErr) {
        // A failed STATUS CHECK is not a failed render. This used to return 'failed', so one
        // network blip killed the job and the feed card while Muapi carried on rendering — and
        // still charged for it. Only Muapi actually saying the task failed, or the task being
        // unknown/unauthorised, is terminal. Everything else stays 'processing': the background
        // reconciler keeps retrying and will land the video (it gives up after 2h).
        const terminal = statusErr.code === 'MUAPI_NOT_FOUND' || statusErr.code === 'INVALID_API_KEY';
        log.warn('muapi_status_check_error', { taskId, error: statusErr.message, terminal });
        return res.json({
          success: true,
          data: terminal ? { status: 'failed', error: statusErr.message } : { status: 'processing' },
        });
      }
      return res.json({ success: true, data: result });
    }

    let result;
    try {
      result = await wavespeed.getTaskStatus(taskId);
    } catch (statusErr) {
      log.warn('video_status_check_error', { taskId, error: statusErr.message });
      return res.json({ success: true, data: { status: 'failed', error: statusErr.message } });
    }

    if (result.status === 'completed' && result.outputs?.length > 0) {
      if (entry && !entry.localPath) {
        try {
          const { filename, filePath } = await wavespeed.downloadVideo(result.outputs[0], VIDEO_DIR);
          videoHistory.update(entry.id, {
            status: 'completed',
            videoUrl: result.outputs[0],
            localPath: filePath,
            filename,
          });
          finishGenerationRun(taskId, {
            status: 'succeeded',
            outputCount: 1,
            provider: 'wavespeed',
            model: entry.model,
          });
          logUsageEvent({
            userId: req.session?.userId,
            eventType: 'generation.succeeded',
            entityType: 'generation_run',
            entityId: taskId,
            source: 'video',
            payload: { feature: 'video', provider: 'wavespeed', localFilename: filename },
          });
          result.localFilename = filename;
        } catch (dlErr) {
          log.warn('video_auto_download_failed', { taskId, error: dlErr.message });
          videoHistory.update(entry.id, { status: 'completed', videoUrl: result.outputs[0] });
          finishGenerationRun(taskId, {
            status: 'succeeded',
            outputCount: 1,
            provider: 'wavespeed',
            model: entry?.model,
          });
          logUsageEvent({
            userId: req.session?.userId,
            eventType: 'generation.succeeded',
            entityType: 'generation_run',
            entityId: taskId,
            source: 'video',
            payload: { feature: 'video', provider: 'wavespeed', localFilename: null },
          });
        }
        // Track WaveSpeed spend on first completion (guard against double-count)
        if (entry && !entry.spendTracked) {
          try {
            const prices = VIDEO_PRICES[entry.model];
            const dur = entry.duration || Object.keys(prices || {})[0];
            const cost = prices?.[dur];
            if (cost) {
              apiKeyManager.addExternalSpend(cost, 'video');
              videoHistory.update(entry.id, { spendTracked: true });
            }
          } catch (e) { log.warn('video_spend_track_failed', { taskId, error: e.message }); }
        }
      } else if (entry?.filename) {
        result.localFilename = entry.filename;
      }
    }

    if (result.status === 'failed') {
      const entry = videoHistory.findByTaskId(taskId);
      if (entry) videoHistory.update(entry.id, { status: 'failed', error: result.error || 'Generation failed' });
      finishGenerationRun(taskId, {
        status: 'failed',
        outputCount: 0,
        provider: entry?.provider || 'wavespeed',
        model: entry?.model || null,
        errorCode: 'TASK_FAILED',
        errorMessage: result.error || 'Generation failed',
      });
      logUsageEvent({
        userId: req.session?.userId,
        eventType: 'generation.failed',
        entityType: 'generation_run',
        entityId: taskId,
        source: 'video',
        payload: { feature: 'video', provider: entry?.provider || 'wavespeed', errorCode: 'TASK_FAILED', message: result.error || 'Generation failed' },
      });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/file/:filename', (req, res, next) => {
  try {
    const { filename } = req.params;
    const safeName = path.basename(filename);
    const filePath = path.join(VIDEO_DIR, safeName);
    if (!fs.existsSync(filePath)) throw new AppError('Video file not found', 404, 'NOT_FOUND');
    res.setHeader('Content-Type', 'video/mp4');
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

router.get('/history', (_req, res, next) => {
  try {
    res.json({ success: true, data: videoHistory.list() });
  } catch (err) {
    next(err);
  }
});

router.delete('/history/:id', (req, res, next) => {
  try {
    const entry = videoHistory.get(req.params.id);
    if (entry.localPath) {
      try { fs.unlinkSync(entry.localPath); } catch { /* ignore missing local file */ }
    }
    res.json({ success: true, data: videoHistory.remove(req.params.id) });
  } catch (err) {
    next(err);
  }
});


/**
 * Serve a clip with its tooling fingerprints removed.
 *
 * Separate from /file/:filename rather than stripping there, because stripping costs an audio
 * re-encode and the player should not pay it on every scrub. Downloads use this; playback does
 * not.
 *
 * A strip failure serves the ORIGINAL and says so in a header. Failing the download outright
 * would be worse — the file is still wanted, and the caller can see it was not cleaned.
 */
router.get('/file/:filename/clean', async (req, res, next) => {
  let cleanup = null;
  try {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(VIDEO_DIR, safeName);
    if (!fs.existsSync(filePath)) throw new AppError('Video file not found', 404, 'NOT_FOUND');

    let sendPath = filePath;
    let stripped = false;
    try {
      const out = await videoStripper.stripFile(filePath);
      sendPath = out.filePath;
      cleanup = out.cleanup;
      stripped = true;
      res.setHeader('X-Metadata-Stripped', 'yes');
    } catch {
      res.setHeader('X-Metadata-Stripped', 'failed');
    }

    // The filename states the outcome. A strip failure serves the original, and calling that
    // file "cleaned" would be a lie you could not see — so it is named NOT-cleaned instead.
    const ext = path.extname(safeName) || '.mp4';
    const stem = path.basename(safeName, ext);
    const outName = `${stem}${stripped ? '_metadatacleaned' : '_NOT-cleaned'}${ext}`;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.sendFile(sendPath, (err) => {
      if (cleanup) cleanup();
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    if (cleanup) cleanup();
    next(err);
  }
});

router.post('/bulk-download', async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('ids array is required', 400, 'VALIDATION_ERROR');
    }
    if (ids.length > 100) {
      throw new AppError('Cannot download more than 100 videos at once', 400, 'VALIDATION_ERROR');
    }

    const files = [];
    const cleanups = [];
    for (const id of ids) {
      const entry = videoHistory.get(id);
      if (!entry?.localPath || !fs.existsSync(entry.localPath)) continue;
      const original = entry.filename || path.basename(entry.localPath);
      const ext = path.extname(original) || '.mp4';
      const stem = path.basename(original, ext);
      // Cleaned on the way into the archive. Without this the ZIP is the one route that still
      // ships the x264 settings block, which is worse than not offering bulk download at all —
      // it looks covered.
      try {
        const out = await videoStripper.stripFile(entry.localPath);
        cleanups.push(out.cleanup);
        files.push({ filePath: out.filePath, filename: `${stem}_metadatacleaned${ext}` });
      } catch {
        // A strip failure still gets the file, named honestly.
        files.push({ filePath: entry.localPath, filename: `${stem}_NOT-cleaned${ext}` });
      }
    }

    if (files.length === 0) {
      throw new AppError('No downloadable video files found', 404, 'NOT_FOUND');
    }

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="videos-${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 1 } });
    // Temp copies live until the archive is written; removing them earlier truncates the ZIP.
    const sweep = () => { for (const c of cleanups) { try { c(); } catch { /* already gone */ } } };
    archive.on('error', () => { sweep(); if (!res.writableEnded) res.destroy(); });
    archive.on('end', sweep);
    res.on('close', () => { if (!archive.pointer()) archive.abort(); sweep(); });
    archive.pipe(res);

    for (const file of files) {
      archive.file(file.filePath, { name: file.filename });
    }

    archive.finalize();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
