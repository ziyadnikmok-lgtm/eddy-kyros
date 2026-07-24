const express = require('express');
const galleryManager = require('../services/galleryManager');
const videoHistory = require('../services/videoHistoryStore');

const router = express.Router();

function normalizeImage(image) {
  return {
    id: `image:${image.id}`,
    originalId: image.id,
    mediaType: 'image',
    createdAt: image.createdAt,
    prompt: image.prompt || '',
    source: image.source || 'generate',
    status: 'completed',
    thumbnailUrl: `/api/gallery/${image.id}/thumb`,
    previewUrl: `/api/gallery/${image.id}/image`,
    downloadUrl: `/api/gallery/${image.id}/image`,
    favorite: !!image.isFavorite,
    tags: Array.isArray(image.tags) ? image.tags : [],
    characterId: image.characterId || null,
    aspectRatio: image.aspectRatio || null,
    sourceUrl: image.sourceUrl || null,
    metadata: {
      filename: image.filename || null,
      mimeType: image.mimeType || null,
      fileSize: image.fileSize || null,
      qualityScore: image.qualityScore ?? null,
      personaMode: image.personaMode || null,
      sessionId: image.sessionId || null,
    },
  };
}

function normalizeVideo(video) {
  const fileUrl = video.filename ? `/api/video/file/${encodeURIComponent(video.filename)}` : null;
  return {
    id: `video:${video.id}`,
    originalId: video.id,
    mediaType: 'video',
    createdAt: video.createdAt,
    prompt: video.prompt || '',
    source: video.provider || 'video',
    status: video.status || 'processing',
    thumbnailUrl: null,
    previewUrl: fileUrl,
    downloadUrl: fileUrl,
    favorite: false,
    tags: [],
    characterId: null,
    aspectRatio: video.aspectRatio || null,
    metadata: {
      filename: video.filename || null,
      provider: video.provider || null,
      model: video.model || null,
      duration: video.duration || null,
      resolution: video.resolution || null,
      error: video.error || null,
      sourceImageId: video.sourceImageId || null,
    },
  };
}

router.get('/', (_req, res, next) => {
  try {
    const images = galleryManager.list().images || [];
    const videos = videoHistory.list() || [];
    const items = [
      ...images.map(normalizeImage),
      ...videos.map(normalizeVideo),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const totals = {
      all: items.length,
      images: items.filter((item) => item.mediaType === 'image').length,
      videos: items.filter((item) => item.mediaType === 'video').length,
    };

    res.json({ success: true, data: { items, totals } });
  } catch (err) {
    next(err);
  }
});

const { UPLOADS_DIR } = require('../paths');
const fs = require('node:fs');
const path = require('node:path');

router.post('/bulk-paths', (req, res, next) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const results = [];
    for (const item of items) {
      if (item.mediaType === 'image') {
        try {
          const { filePath } = galleryManager.getFilePath(item.originalId);
          if (fs.existsSync(filePath)) {
            results.push({
              id: item.id,
              filePath,
              filename: path.basename(filePath),
            });
          }
        } catch {}
      } else if (item.mediaType === 'video' && item.metadata?.filename) {
        const videoDir = path.join(UPLOADS_DIR, 'videos');
        const filePath = path.join(videoDir, path.basename(item.metadata.filename));
        if (fs.existsSync(filePath)) {
          results.push({
            id: item.id,
            filePath,
            filename: path.basename(filePath),
          });
        }
      }
    }

    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
