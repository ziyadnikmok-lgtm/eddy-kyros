const express = require('express');
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
      archive.file(file.filePath, { name: file.filename });
    }

    await archive.finalize();
    for (const fn of cleanups) fn();
  } catch (err) {
    for (const fn of cleanups) fn();
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
    res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
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

router.post('/:id/open-folder', (req, res, next) => {
  try {
    const { filePath } = galleryManager.getFilePath(req.params.id);
    const folderPath = galleryManager.getFolderPath();

    const { execFile } = require('node:child_process');
    const platform = process.platform;

    if (platform === 'win32') {
      execFile('explorer', ['/select,', filePath], () => {});
    } else if (platform === 'darwin') {
      execFile('open', ['-R', filePath], () => {});
    } else {
      execFile('xdg-open', [folderPath], () => {});
    }

    res.json({ success: true, data: { opened: folderPath, selected: filePath } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// Thumbnail endpoint — serves a small preview for mobile gallery pickers
router.get('/:id/thumb', async (req, res, next) => {
  try {
    const { filePath } = galleryManager.getFilePath(req.params.id);
    const sharp = require('sharp');
    const buf = await sharp(filePath)
      .resize({ width: 300, withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch (err) {
    next(err);
  }
});
