// server/routes/gallery.js

const express = require('express');
const galleryManager = require('../services/galleryManager');
const { parseImageUpload } = require('../middleware/upload');
const { AppError } = require('../middleware/errorHandler');
const { createMultipartParser } = require('../middleware/multipartParser');

const archiver = require('archiver');

const router = express.Router();
const parseMultipartIfNeeded = createMultipartParser({ fallback: parseImageUpload });

/**
 * GET /api/gallery
 * List gallery images (newest first). Optional pagination: ?page=&limit=&tag=
 */
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

/**
 * POST /api/gallery/upload
 * Upload an external image into persistent gallery storage.
 * Supports multipart/form-data ("file") or JSON base64 payload.
 */
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

/**
 * PATCH /api/gallery/:id/favorite
 * Toggle the favorite status of a gallery image.
 */
router.patch('/:id/favorite', (req, res, next) => {
  try {
    const entry = galleryManager.toggleFavorite(req.params.id);
    res.json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/gallery/bulk
 * Delete multiple gallery images at once.
 * Body: { ids: string[] }
 */
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

/**
 * POST /api/gallery/bulk-download
 * Stream a ZIP file containing the requested gallery images.
 * Body: { ids: string[] }
 */
router.post('/bulk-download', (req, res, next) => {
  try {
    const { ids } = req.body;
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

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="gallery-${Date.now()}.zip"`);

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

/**
 * GET /api/gallery/tags
 * Get all unique tags across gallery images.
 */
router.get('/tags', (_req, res, next) => {
  try {
    const tags = galleryManager.getAllTags();
    res.json({ success: true, data: tags });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/gallery/:id/tags
 * Replace all tags on a gallery image.
 * Body: { tags: string[] }
 */
router.patch('/:id/tags', (req, res, next) => {
  try {
    const { tags } = req.body;
    const entry = galleryManager.updateTags(req.params.id, tags || []);
    res.json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gallery/:id/tags
 * Add a single tag to a gallery image.
 * Body: { tag: string }
 */
router.post('/:id/tags', (req, res, next) => {
  try {
    const { tag } = req.body;
    const entry = galleryManager.addTag(req.params.id, tag);
    res.json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/gallery/:id/tags/:tag
 * Remove a specific tag from a gallery image.
 */
router.delete('/:id/tags/:tag', (req, res, next) => {
  try {
    const entry = galleryManager.removeTag(req.params.id, decodeURIComponent(req.params.tag));
    res.json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/gallery/:id/image
 * Serve image file by gallery ID.
 */
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

/**
 * DELETE /api/gallery/:id
 * Delete a gallery image (file + metadata).
 */
router.delete('/:id', (req, res, next) => {
  try {
    const result = galleryManager.remove(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gallery/:id/open-folder
 * Open the gallery folder in the OS file explorer (localhost only).
 */
router.post('/:id/open-folder', (req, res, next) => {
  try {
    // Verify image exists and resolve file path
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
