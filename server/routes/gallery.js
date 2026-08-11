const express = require('express');
let _sharp; const sharp = (...a) => { if (!_sharp) _sharp = require('sharp'); return _sharp(...a); };
const galleryManager = require('../services/galleryManager');
const { parseImageUpload } = require('../middleware/upload');
const { AppError } = require('../middleware/errorHandler');
const { createMultipartParser } = require('../middleware/multipartParser');

const archiver = require('archiver');
const iosSpoofService = require('../services/iosSpoofService');

const router = express.Router();
const parseMultipartIfNeeded = createMultipartParser({ fallback: parseImageUpload });

router.get('/spoof-status', (_req, res) => {
  res.json({ success: true, data: { available: iosSpoofService.isAvailable() } });
});

router.get('/', (req, res, next) => {
  try {
    const result = galleryManager.list({
      page: req.query.page,
      limit: req.query.limit,
      tag: req.query.tag,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.post('/upload', parseMultipartIfNeeded, (req, res, next) => {
  try {
    const prompt = (req.body?.prompt && typeof req.body.prompt === 'string')
      ? req.body.prompt
      : 'External upload';
    const source = (req.body?.source && typeof req.body.source === 'string')
      ? req.body.source
      : 'upload';
    const characterId = (req.body?.characterId && typeof req.body.characterId === 'string')
      ? req.body.characterId
      : null;
    const aspectRatio = (req.body?.aspectRatio && typeof req.body.aspectRatio === 'string')
      ? req.body.aspectRatio
      : null;

    let base64Data;
    let mimeType;

    if (req.file && req.file.buffer) {
      mimeType = req.file.mimetype || 'image/png';
      base64Data = req.file.buffer.toString('base64');
    } else if (req.imageUpload && req.imageUpload.buffer) {
      mimeType = req.imageUpload.mimeType;
      base64Data = req.imageUpload.buffer.toString('base64');
    } else {
      throw new AppError('No image provided for upload', 400, 'VALIDATION_ERROR');
    }

    const entry = galleryManager.save({
      base64Data,
      mimeType,
      prompt,
      source,
      characterId,
      aspectRatio,
    });

    res.status(201).json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/favorite', (req, res, next) => {
  try {
    const entry = galleryManager.toggleFavorite(req.params.id);
    res.json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
});

router.delete('/bulk', (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('ids array is required', 400, 'VALIDATION_ERROR');
    }
    if (ids.length > 500) {
      throw new AppError('Cannot delete more than 500 images at once', 400, 'VALIDATION_ERROR');
    }
    const result = galleryManager.bulkRemove(ids);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.post('/bulk-download', async (req, res, next) => {
  const cleanups = [];
  try {
    const { ids, spoof } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('ids array is required', 400, 'VALIDATION_ERROR');
    }
    if (ids.length > 500) {
      throw new AppError('Cannot download more than 500 images at once', 400, 'VALIDATION_ERROR');
    }

    const files = galleryManager.getMultipleFilePaths(ids);
    if (files.length === 0) {
      throw new AppError('No valid images found', 404, 'NOT_FOUND');
    }

    const shouldSpoof = spoof !== false && iosSpoofService.isAvailable();
    let outputFiles = files;

    if (shouldSpoof) {
      const spoofed = await iosSpoofService.spoofBatch(files.map((f) => f.filePath));
      outputFiles = [];
      for (let i = 0; i < files.length; i++) {
        if (spoofed[i]) {
          outputFiles.push({ filePath: spoofed[i].filePath, filename: spoofed[i].filename });
          cleanups.push(spoofed[i].cleanup);
        } else {
          outputFiles.push(files[i]);
        }
      }
    }

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="gallery-${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', () => { if (!res.writableEnded) res.destroy(); });
    res.on('close', () => { if (!archive.pointer()) archive.abort(); });
    archive.pipe(res);

    for (const file of outputFiles) {
      const safeName = (file.filename || 'image').replace(/[\/\\:*?"<>|]/g, '_');
      archive.file(file.filePath, { name: safeName });
    }

    await archive.finalize();
    for (const fn of cleanups) fn();
  } catch (err) {
    for (const fn of cleanups) fn();
    next(err);
  }
});

router.post('/bulk-paths', (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('ids array is required', 400, 'VALIDATION_ERROR');
    }
    const files = galleryManager.getMultipleFilePaths(ids);
    res.json({
      success: true,
      data: files.map((f) => ({
        filePath: f.filePath,
        filename: f.filename,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/tags', (_req, res, next) => {
  try {
    const tags = galleryManager.getAllTags();
    res.json({ success: true, data: tags });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/tags', (req, res, next) => {
  try {
    const { tags } = req.body;
    const entry = galleryManager.updateTags(req.params.id, tags || []);
    res.json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/tags', (req, res, next) => {
  try {
    const { tag } = req.body;
    const entry = galleryManager.addTag(req.params.id, tag);
    res.json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/tags/:tag', (req, res, next) => {
  try {
    const entry = galleryManager.removeTag(req.params.id, decodeURIComponent(req.params.tag));
    res.json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/image', (req, res, next) => {
  try {
    const { filePath, mimeType } = galleryManager.getFilePath(req.params.id);
    res.set('Content-Type', mimeType);
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(filePath);
  } catch (err) {
    // Fallback: try imageStore (batch results may reference imageStore IDs)
    try {
      const imageStore = require('../services/imageStore');
      const entry = imageStore.get(req.params.id);
      if (entry?.image?.base64Data) {
        const buf = Buffer.from(entry.image.base64Data, 'base64');
        res.set('Content-Type', entry.image.mimeType || 'image/png');
        res.set('Cache-Control', 'private, max-age=3600');
        return res.send(buf);
      }
    } catch (fallbackErr) {
      if (!['IMAGE_NOT_FOUND', 'NOT_FOUND'].includes(fallbackErr.code)) {
        const log = require('../utils/logger');
        log.warn('gallery_image_fallback_failed', { id: req.params.id, error: fallbackErr.message });
      }
    }
    next(err);
  }
});

router.get('/:id/download-spoofed', async (req, res, next) => {
  let cleanup = null;
  try {
    if (!iosSpoofService.isAvailable()) {
      throw new AppError('iOS spoof tools not available', 503, 'SPOOF_UNAVAILABLE');
    }
    const { filePath } = galleryManager.getFilePath(req.params.id);
    const result = await iosSpoofService.spoofImage(filePath);
    cleanup = result.cleanup;
    res.set('Content-Type', 'image/jpeg');
    const safeName = result.filename.replace(/[^\w.\-]/g, '_');
    res.set('Content-Disposition', `attachment; filename="${safeName}"`);
    res.sendFile(result.filePath, () => { if (cleanup) cleanup(); });
  } catch (err) {
    if (cleanup) cleanup();
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const result = galleryManager.remove(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// open-folder removed — no desktop in Docker container

// Thumbnail endpoint — serves a small preview for mobile gallery pickers
router.get('/:id/thumb', async (req, res, next) => {
  try {
    const { filePath } = galleryManager.getFilePath(req.params.id);
    const buf = await sharp(filePath)
      .resize({ width: 400, withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

// --- Image Editor: server-side processing (worker thread) ---
//
// Worker lifecycle (pool size = 1):
//   1. New edit request arrives
//   2. If a worker is already running, terminate it (cancel in-flight job)
//   3. Spawn a fresh worker with the new job's workerData
//   4. Start a 30-second timeout timer
//   5. On success: resolve promise, clear timeout, set _activeWorker = null
//   6. On timeout: terminate worker, reject with timeout error
//   7. On error/non-zero exit: reject promise, clear timeout
//

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const WORKER_PATH = path.join(__dirname, '..', 'workers', 'imageEditWorker.js');
const WORKER_TIMEOUT_MS = 30_000;

let _activeWorker = null;

function runEditWorker(workerData) {
  // Cancel any in-flight worker before starting a new one
  if (_activeWorker) {
    try { _activeWorker.terminate(); } catch {}
    _activeWorker = null;
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData });
    _activeWorker = worker;
    let settled = false;

    const timeoutTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        _activeWorker = null;
        try { worker.terminate(); } catch {}
        reject(new Error('Image edit worker timed out after 30s'));
      }
    }, WORKER_TIMEOUT_MS);

    function settle(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (_activeWorker === worker) _activeWorker = null;
      fn();
    }

    worker.on('message', (msg) => {
      settle(() => {
        if (msg?.error) reject(new Error(msg.error));
        // postMessage transfers Uint8Array — convert back to Buffer so .toString('base64') works
        else resolve(Buffer.isBuffer(msg) ? msg : Buffer.from(msg));
      });
    });
    worker.on('error', (err) => settle(() => reject(err)));
    worker.on('exit', (code) => {
      settle(() => {
        if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
      });
    });
  });
}

/** Clamp a number to [min, max] */
function clamp(value, min, max) {
  const n = Number(value) || 0;
  return Math.min(Math.max(n, min), max);
}

router.post('/:id/edit', express.json({ limit: '1mb' }), async (req, res, next) => {
  try {
    const { filePath } = galleryManager.getFilePath(req.params.id);
    const body = req.body || {};
    const rgbSplitColor = body.rgbSplitColor || 'rc';
    const save = !!body.save;

    // Clamp all numeric inputs to their valid ranges
    const brightness       = clamp(body.brightness, -100, 100);
    const contrast         = clamp(body.contrast, -100, 100);
    const saturation       = clamp(body.saturation, -100, 100);
    const warmth           = clamp(body.warmth, -100, 100);
    const sharpness        = clamp(body.sharpness, 0, 100);
    const grain            = clamp(body.grain, 0, 100);
    const vignette         = clamp(body.vignette, 0, 100);
    const fade             = clamp(body.fade, 0, 100);
    const hueShift         = clamp(body.hueShift, -180, 180);
    const rgbSplitDistance = clamp(body.rgbSplitDistance, 0, 20);
    const rgbSplitDirection = clamp(body.rgbSplitDirection, 0, 360);

    const outputBuf = await runEditWorker({
      filePath, brightness, contrast, saturation, warmth, sharpness, grain,
      vignette, fade, hueShift, rgbSplitDistance, rgbSplitDirection, rgbSplitColor,
    });

    if (save) {
      const entry = galleryManager.save({
        base64Data: outputBuf.toString('base64'),
        mimeType: 'image/png',
        prompt: `Edited: brightness=${brightness} contrast=${contrast} saturation=${saturation} warmth=${warmth} grain=${grain} vignette=${vignette} fade=${fade}${rgbSplitDistance > 0 ? ` rgbSplit=${rgbSplitDistance}/${rgbSplitDirection}°/${rgbSplitColor}` : ''}`,
        source: 'edit',
        characterId: null,
        aspectRatio: null,
        seed: null,
        tags: ['edited'],
      });
      return res.json({ success: true, data: { saved: true, galleryId: entry.id } });
    }

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(outputBuf);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
