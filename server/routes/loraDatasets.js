const express = require('express');
const archiver = require('archiver');
const galleryManager = require('../services/galleryManager');
const loraDatasetManager = require('../services/loraDatasetManager');
const { AppError } = require('../middleware/errorHandler');
const { requirePlanCapacity } = require('../middleware/planLimits');
const { initSSE } = require('../utils/sse');

const router = express.Router();

function safeSlug(input, fallback = 'dataset') {
  const normalized = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

router.get('/', (_req, res, next) => {
  try {
    res.json({ success: true, data: loraDatasetManager.listRuns() });
  } catch (err) {
    next(err);
  }
});

router.post('/generate', requirePlanCapacity({
  costResolver: (req) => {
    const face = Number.parseInt(req.body?.faceCount, 10);
    const full = Number.parseInt(req.body?.fullBodyCount, 10);
    const safeFace = Number.isFinite(face) ? Math.min(15, Math.max(1, face)) : 15;
    const safeFull = Number.isFinite(full) ? Math.min(15, Math.max(1, full)) : 15;
    return safeFace + safeFull;
  },
}), (req, res, next) => {
  try {
    const run = loraDatasetManager.startRun(req.body || {});
    res.status(202).json({ success: true, data: run });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    res.json({ success: true, data: loraDatasetManager.getRun(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/progress', (req, res, next) => {
  try {
    const run = loraDatasetManager.getRun(req.params.id);
    const send = initSSE(res);

    send(null, { event: 'snapshot', ...run });

    if (run.status !== 'running') {
      send(null, { event: 'done', id: run.id, status: run.status, stage: run.stage, progress: run.progress });
      res.end();
      return;
    }

    const onUpdate = (evt) => {
      if (evt.datasetId !== req.params.id) return;
      try {
        const latest = loraDatasetManager.getRun(req.params.id);
        send(null, { event: latest.status === 'running' ? 'update' : 'done', ...latest });
        if (latest.status !== 'running') {
          cleanup();
          res.end();
        }
      } catch {
        cleanup();
        res.end();
      }
    };

    function cleanup() {
      loraDatasetManager.removeListener('update', onUpdate);
    }

    req.on('close', cleanup);
    loraDatasetManager.on('update', onUpdate);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/download', async (req, res, next) => {
  try {
    const dataset = loraDatasetManager.getRun(req.params.id);
    if (!Array.isArray(dataset.items) || dataset.items.length === 0) {
      throw new AppError('Dataset has no generated images to export', 400, 'VALIDATION_ERROR');
    }

    const baseName = safeSlug(`${dataset.characterName}-${dataset.triggerWord}`, 'lora-dataset');
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${baseName}.zip"`);

    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', () => { if (!res.writableEnded) res.destroy(); });
    res.on('close', () => { if (!archive.pointer()) archive.abort(); });
    archive.pipe(res);

    const manifest = {
      id: dataset.id,
      name: dataset.name,
      characterId: dataset.characterId,
      characterName: dataset.characterName,
      triggerWord: dataset.triggerWord,
      imageModel: dataset.imageModel,
      status: dataset.status,
      stage: dataset.stage,
      requested: dataset.requested,
      progress: dataset.progress,
      createdAt: dataset.createdAt,
      items: dataset.items,
      failures: dataset.failures || [],
    };

    for (const item of dataset.items) {
      const { filePath, mimeType } = galleryManager.getFilePath(item.galleryId);
      const ext = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
      const prefix = `${String(item.index).padStart(2, '0')}-${safeSlug(item.shotType)}-${safeSlug(item.label, 'image')}`;
      archive.file(filePath, { name: `${prefix}${ext}` });
      archive.append(item.caption || '', { name: `${prefix}.txt` });
    }

    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
