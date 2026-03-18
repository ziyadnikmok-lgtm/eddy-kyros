const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const archiver = require('archiver');
const wavespeed = require('../services/wavespeedService');
const videoHistory = require('../services/videoHistoryStore');
const galleryManager = require('../services/galleryManager');
const apiKeyManager = require('../services/apiKeyManager');
const { AppError } = require('../middleware/errorHandler');
const { createMultipartParser } = require('../middleware/multipartParser');
const { UPLOADS_DIR } = require('../paths');
const log = require('../utils/logger');

const VIDEO_PRICES = {
  'kling-v2.5-turbo-std': { 5: 0.21, 10: 0.42 },
  'kling-v2.5-turbo-pro': { 5: 0.35, 10: 0.70 },
  'grok-imagine-video': { 6: 0.33, 10: 0.55 },
  'kling-v2.6-motion': { 5: 0.35 },
  'kling-v2.6-motion-pro': { 5: 0.56 },
};

const router = express.Router();
const VIDEO_DIR = path.join(UPLOADS_DIR, 'videos');
const parseMultipartIfNeeded = createMultipartParser({ maxBytes: 200 * 1024 * 1024 });

router.post('/generate', parseMultipartIfNeeded, async (req, res, next) => {
  try {
    const { model, prompt, duration, negativePrompt, guidanceScale, resolution, lastImage, motionSource, characterOrientation, keepOriginalSound } = req.body || {};

    if (!model) throw new AppError('model is required', 400, 'VALIDATION_ERROR');

    let imageUrl;
    const imageData = req.body.image;
    const galleryId = req.body.galleryId;

    if (galleryId) {
      const { filePath, mimeType } = galleryManager.getFilePath(galleryId);
      const buffer = fs.readFileSync(filePath);
      imageUrl = await wavespeed.uploadBase64(buffer.toString('base64'), mimeType);
    } else if (imageData) {
      imageUrl = await wavespeed.uploadBase64(imageData, req.body.imageMimeType || 'image/png');
    } else {
      throw new AppError('An image is required (image base64 or galleryId)', 400, 'VALIDATION_ERROR');
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
          try { fs.unlinkSync(videoPath); } catch {}
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
          try { fs.unlinkSync(tempPath); } catch {}
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
    next(err);
  }
});

router.get('/:taskId/status', async (req, res, next) => {
  try {
    const { taskId } = req.params;
    let result;
    try {
      result = await wavespeed.getTaskStatus(taskId);
    } catch (statusErr) {
      log.warn('video_status_check_error', { taskId, error: statusErr.message });
      return res.json({ success: true, data: { status: 'failed', error: statusErr.message } });
    }

    if (result.status === 'completed' && result.outputs?.length > 0) {
      const entry = videoHistory.findByTaskId(taskId);
      if (entry && !entry.localPath) {
        try {
          const { filename, filePath } = await wavespeed.downloadVideo(result.outputs[0], VIDEO_DIR);
          videoHistory.update(entry.id, {
            status: 'completed',
            videoUrl: result.outputs[0],
            localPath: filePath,
            filename,
          });
          result.localFilename = filename;
        } catch (dlErr) {
          log.warn('video_auto_download_failed', { taskId, error: dlErr.message });
          videoHistory.update(entry.id, { status: 'completed', videoUrl: result.outputs[0] });
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
      try { fs.unlinkSync(entry.localPath); } catch {}
    }
    res.json({ success: true, data: videoHistory.remove(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/bulk-download', (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('ids array is required', 400, 'VALIDATION_ERROR');
    }
    if (ids.length > 100) {
      throw new AppError('Cannot download more than 100 videos at once', 400, 'VALIDATION_ERROR');
    }

    const files = [];
    for (const id of ids) {
      const entry = videoHistory.get(id);
      if (entry?.localPath && fs.existsSync(entry.localPath)) {
        files.push({ filePath: entry.localPath, filename: entry.filename || path.basename(entry.localPath) });
      }
    }

    if (files.length === 0) {
      throw new AppError('No downloadable video files found', 404, 'NOT_FOUND');
    }

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="videos-${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', () => { if (!res.writableEnded) res.destroy(); });
    res.on('close', () => { if (!archive.pointer()) archive.abort(); });
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
