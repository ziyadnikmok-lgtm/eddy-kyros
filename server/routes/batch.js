const express = require('express');
const fs = require('node:fs');
const batchGenerator = require('../services/batchGenerator');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const { AppError } = require('../middleware/errorHandler');
const { createMultipartParser } = require('../middleware/multipartParser');
const { initSSE } = require('../utils/sse');

const router = express.Router();
const parseMultipartIfNeeded = createMultipartParser({ maxBytes: 50 * 1024 * 1024 });

router.post('/', parseMultipartIfNeeded, (req, res, next) => {
  try {
    let { mode, config } = req.body || {};
    if (typeof config === 'string') {
      try { config = JSON.parse(config); } catch {
        throw new AppError('Invalid JSON in config field', 400, 'VALIDATION_ERROR');
      }
    }
    const validRatios = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5'];
    const validSizes = ['1K', '2K', '4K'];

    const finalAspectRatio =
      validRatios.includes(req.body.aspectRatio)
        ? req.body.aspectRatio
        : '1:1';

    const finalImageSize =
      validSizes.includes(req.body.resolutionTier)
        ? req.body.resolutionTier
        : '2K';
    const imageModel =
      typeof req.body.imageModel === 'string' && req.body.imageModel.trim().length > 0
        ? req.body.imageModel.trim()
        : undefined;

    if (!mode || typeof mode !== 'string') {
      throw new AppError('"mode" is required', 400, 'VALIDATION_ERROR');
    }
    if (!config || typeof config !== 'object') {
      throw new AppError('"config" object is required', 400, 'VALIDATION_ERROR');
    }

    const requestIdentityValidation =
      typeof req.body.identityValidation === 'boolean'
        ? req.body.identityValidation
        : (typeof config.identityValidation === 'boolean' ? config.identityValidation : true);

    let normalizedConfig = config;
    const uploadedFile = req.file && req.file.buffer
      ? req.file
      : null;

    if (mode === 'edit') {
      if (uploadedFile) {
        const imported = imageStore.store({
          basePrompt: 'Uploaded base image',
          characterId: null,
          activeReferenceIds: null,
          sceneDescription: null,
          modelUsed: null,
          seed: null,
          parentImageId: null,
          variationIndex: null,
          image: {
            mimeType: uploadedFile.mimetype || 'image/png',
            base64Data: uploadedFile.buffer.toString('base64'),
          },
          source: 'generate',
        });
        normalizedConfig = { ...config, imageId: imported.imageId };
      } else if (config.imageBase64 && typeof config.imageBase64 === 'string') {
        let base64Data = config.imageBase64.trim();
        const dataUriMatch = base64Data.match(/^data:(image\/[\w.+-]+);base64,(.+)$/i);
        const mimeType = dataUriMatch ? dataUriMatch[1] : (config.imageMimeType || 'image/png');
        if (dataUriMatch) base64Data = dataUriMatch[2];
        const imported = imageStore.store({
          basePrompt: 'Uploaded base image',
          characterId: null,
          activeReferenceIds: null,
          sceneDescription: null,
          modelUsed: null,
          seed: null,
          parentImageId: null,
          variationIndex: null,
          image: { mimeType, base64Data },
          source: 'generate',
        });
        normalizedConfig = { ...config, imageId: imported.imageId };
        delete normalizedConfig.imageBase64;
        delete normalizedConfig.imageMimeType;
      } else if (config.imageId && typeof config.imageId === 'string') {
        let inMemory = false;
        try {
          imageStore.get(config.imageId);
          inMemory = true;
        } catch (storeErr) {
          if (!(storeErr instanceof AppError) || storeErr.code !== 'IMAGE_NOT_FOUND') {
            throw storeErr;
          }
        }
        if (!inMemory) {
          const galleryEntry = galleryManager.get(config.imageId);
          const { filePath, mimeType } = galleryManager.getFilePath(config.imageId);
          let buffer;
          try {
            buffer = fs.readFileSync(filePath);
          } catch {
            throw new AppError('Gallery image file not found on disk', 404, 'FILE_NOT_FOUND');
          }
          const imported = imageStore.store({
            basePrompt: galleryEntry.prompt || 'Gallery image',
            characterId: galleryEntry.characterId || null,
            activeReferenceIds: null,
            sceneDescription: galleryEntry.prompt || null,
            modelUsed: null,
            seed: galleryEntry.seed || null,
            parentImageId: null,
            variationIndex: null,
            image: {
              mimeType,
              base64Data: buffer.toString('base64'),
            },
            source: 'generate',
          });
          normalizedConfig = { ...config, imageId: imported.imageId };
        }
      } else {
        throw new AppError('No base image provided', 400, 'VALIDATION_ERROR');
      }
    }

    normalizedConfig = {
      ...normalizedConfig,
      identityValidation: requestIdentityValidation,
    };

    const job = batchGenerator.startBatch(mode, normalizedConfig, {
      aspectRatio: finalAspectRatio,
      imageSize: finalImageSize,
      imageModel,
    });
    res.status(202).json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

router.get('/stats', (req, res, next) => {
  try {
    const stats = batchGenerator.jobStats();
    const queue = batchGenerator.queueStatus();
    res.json({ success: true, data: { ...stats, ...queue } });
  } catch (err) {
    next(err);
  }
});

router.get('/', (req, res, next) => {
  try {
    const jobList = batchGenerator.listJobs(req.query.status || undefined);
    const lite = jobList.map(({ results, ...rest }) => rest);
    res.json({ success: true, data: lite });
  } catch (err) {
    next(err);
  }
});

router.get('/:jobId', (req, res, next) => {
  try {
    const job = batchGenerator.getJob(req.params.jobId);
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

router.get('/:jobId/progress', (req, res, next) => {
  try {
    const job = batchGenerator.getJob(req.params.jobId);

    const send = initSSE(res);

    send(null, { event: 'snapshot', ...job });

    if (job.status !== 'running') {
      send(null, { event: 'done', status: job.status, completed: job.completed, failed: job.failed, total: job.total });
      res.end();
      return;
    }

    const jobId = req.params.jobId;

    const onTask = (evt) => {
      if (evt.jobId !== jobId) return;
      send(null, { event: 'task', ...evt });
    };

    const onDone = (evt) => {
      if (evt.jobId !== jobId) return;
      send(null, { event: 'done', ...evt });
      cleanup();
      res.end();
    };

    function cleanup() {
      batchGenerator.removeListener('task', onTask);
      batchGenerator.removeListener('done', onDone);
    }

    req.on('close', cleanup);

    batchGenerator.on('task', onTask);
    batchGenerator.on('done', onDone);
  } catch (err) {
    next(err);
  }
});

router.post('/:jobId/cancel', (req, res, next) => {
  try {
    const job = batchGenerator.cancelJob(req.params.jobId);
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

router.post('/:jobId/retry', (req, res, next) => {
  try {
    const newJob = batchGenerator.retryFailed(req.params.jobId);
    res.status(202).json({ success: true, data: newJob });
  } catch (err) {
    next(err);
  }
});

router.delete('/:jobId', (req, res, next) => {
  try {
    const result = batchGenerator.removeJob(req.params.jobId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
