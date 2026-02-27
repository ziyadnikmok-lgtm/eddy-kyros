// server/routes/batch.js

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

/**
 * POST /api/batch
 *
 * Start a batch generation job. Returns immediately with a job object.
 * Processing continues asynchronously.
 *
 * Body: {
 *   mode: "variation" | "multi" | "override",
 *   config: { ... mode-specific config ... }
 * }
 *
 * Variation config:
 *   { prompt, count?, randomizeSeed?, temperatureRange?: { min, max }, model?, characterId?, activeReferenceIds? }
 *
 * Multi config:
 *   { prompts: string[], temperature?, seed?, model? }
 *
 * Override config:
 *   { characterId, overrideSets: [{ referenceIds: string[] }], prompt?, model? }
 */
router.post('/', parseMultipartIfNeeded, (req, res, next) => {
  try {
    let { mode, config } = req.body || {};
    if (typeof config === 'string') {
      try { config = JSON.parse(config); } catch { /* use raw string */ }
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
        : '1K';
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

    // Edit mode now accepts gallery IDs. If incoming imageId isn't in imageStore,
    // load it from gallery disk and import into imageStore for batch edit pipeline.
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
          // Not in memory store — import from gallery
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

/**
 * GET /api/batch/stats
 *
 * Queue stats + job counts for the dashboard header.
 */
router.get('/stats', (req, res, next) => {
  try {
    const stats = batchGenerator.jobStats();
    const queue = batchGenerator.queueStatus();
    res.json({ success: true, data: { ...stats, ...queue } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/batch
 *
 * List all batch jobs (newest first). Optional ?status= filter.
 * Results omit image base64 data from persisted (non-running) jobs.
 */
router.get('/', (req, res, next) => {
  try {
    const jobList = batchGenerator.listJobs(req.query.status || undefined);
    // Strip results array for list view (keep lightweight)
    const lite = jobList.map(({ results, ...rest }) => rest);
    res.json({ success: true, data: lite });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/batch/:jobId
 *
 * Get current status and results of a batch job.
 */
router.get('/:jobId', (req, res, next) => {
  try {
    const job = batchGenerator.getJob(req.params.jobId);
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/batch/:jobId/progress
 *
 * Server-Sent Events stream for real-time batch progress.
 * Emits "task" events as each task completes, and a "done" event when the job finishes.
 */
router.get('/:jobId/progress', (req, res, next) => {
  try {
    const job = batchGenerator.getJob(req.params.jobId);

    const send = initSSE(res);

    // Send current snapshot immediately
    send(null, { event: 'snapshot', ...job });

    // If job is already finished, close immediately
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

    // Register close handler BEFORE listeners to prevent race condition
    req.on('close', cleanup);

    batchGenerator.on('task', onTask);
    batchGenerator.on('done', onDone);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/batch/:jobId/cancel
 *
 * Cancel a running batch job. Completed results are preserved.
 */
router.post('/:jobId/cancel', (req, res, next) => {
  try {
    const job = batchGenerator.cancelJob(req.params.jobId);
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/batch/:jobId/retry
 *
 * Retry failed tasks from a completed/failed job.
 * Creates a new job with only the failed tasks.
 */
router.post('/:jobId/retry', (req, res, next) => {
  try {
    const newJob = batchGenerator.retryFailed(req.params.jobId);
    res.status(202).json({ success: true, data: newJob });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/batch/:jobId
 *
 * Remove a finished job from history.
 */
router.delete('/:jobId', (req, res, next) => {
  try {
    const result = batchGenerator.removeJob(req.params.jobId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
