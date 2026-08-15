/**
 * The durable generation queue, over HTTP.
 *
 * Four things the client needs:
 *   POST   /api/jobs            put work on the queue (it is on disk before anything is sent)
 *   GET    /api/jobs/:id        watch one job — the page awaits this instead of awaiting Muapi
 *   GET    /api/jobs            what is still moving, and what finished while the app was closed
 *   POST   /api/jobs/:id/filed  the client put the picture in a library
 *
 * Every route is scoped to the calling user. A job carries a paid-for picture, so leaking one
 * across accounts leaks the work AND lets someone else mark it filed, which would hide it from the
 * person who paid.
 */
const express = require('express');
const jobQueue = require('../services/jobQueue');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

/** The shape the client sees. The payload is deliberately NOT returned — it holds the source images. */
function present(job) {
  return {
    id: job.id,
    feature: job.feature,
    status: job.status,
    galleryId: job.gallery_id,
    // Every image the render produced. galleryId stays as the first for older clients; this is
    // what the filer iterates, so a multi-image render reaches the library in full.
    galleryIds: job.galleryIds || (job.gallery_id ? [job.gallery_id] : []),
    // The SAME shape /api/seedream/edit answers with, so a page can swap one call for the other.
    images: job.images || [],
    provider: job.payload?.provider === 'wavespeed' ? 'wavespeed' : 'muapi',
    destDb: job.dest_db,
    destFolder: job.dest_folder,
    cardPrompt: job.card_prompt,
    cardName: job.card_name,
    filed: job.filed,
    error: job.error,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

function userIdOf(req) {
  const id = req.user?.id || req.userId || null;
  if (!id) throw new AppError('Not signed in', 401, 'UNAUTHENTICATED');
  return id;
}

router.post('/', (req, res, next) => {
  try {
    const userId = userIdOf(req);
    const { feature, payload, destDb, destFolder, cardPrompt, cardName, tags } = req.body || {};
    if (!feature) throw new AppError('"feature" is required', 400, 'VALIDATION_ERROR');
    if (!payload?.prompt) throw new AppError('"payload.prompt" is required', 400, 'VALIDATION_ERROR');
    if (!Array.isArray(payload?.images) || !payload.images.length) {
      throw new AppError('"payload.images" must hold at least one source image', 400, 'VALIDATION_ERROR');
    }
    const id = jobQueue.enqueue({ userId, feature, payload, destDb, destFolder, cardPrompt, cardName, tags });
    res.status(201).json({ success: true, data: present(jobQueue.get(id)) });
  } catch (err) { next(err); }
});

router.get('/', (req, res, next) => {
  try {
    const userId = userIdOf(req);
    res.json({
      success: true,
      data: {
        active: jobQueue.listActive(userId).map(present),
        // Finished while the app was closed and not yet in a library — the boot question.
        unfiled: jobQueue.listUnfiled(userId).map(present),
        // Everything that went wrong, so the panel can show it and offer one click to run it again.
        failed: jobQueue.listFailed(userId).map(present),
        counts: jobQueue.counts(userId),
      },
    });
  } catch (err) { next(err); }
});

/**
 * Run a failed job again.
 *
 * Deliberately a POST a human has to make. A job failed as an orphan may already have been rendered
 * and billed, so retrying it can pay twice — the automatic path refuses to make that call, and a
 * person looking at a missing picture can.
 */
router.post('/:id/retry', (req, res, next) => {
  try {
    const userId = userIdOf(req);
    const ok = jobQueue.retry(req.params.id, userId);
    // Same 404 for missing, not-yours, and not-failed: nothing here should reveal which.
    if (!ok) throw new AppError('No failed job with that id', 404, 'NOT_FOUND');
    res.json({ success: true, data: present(jobQueue.get(req.params.id)) });
  } catch (err) { next(err); }
});

/** The whole pile at once. */
router.post('/retry-failed', (req, res, next) => {
  try {
    const userId = userIdOf(req);
    const requeued = jobQueue.retryAllFailed(userId);
    res.json({ success: true, data: { requeued, counts: jobQueue.counts(userId) } });
  } catch (err) { next(err); }
});

router.get('/:id', (req, res, next) => {
  try {
    const userId = userIdOf(req);
    const job = jobQueue.get(req.params.id);
    // Same answer for "does not exist" and "belongs to someone else" — otherwise this endpoint
    // reports whether an id is real to anyone who asks.
    if (!job || job.user_id !== userId) throw new AppError('No such job', 404, 'NOT_FOUND');
    res.json({ success: true, data: present(job) });
  } catch (err) { next(err); }
});

router.post('/:id/filed', (req, res, next) => {
  try {
    const userId = userIdOf(req);
    const ok = jobQueue.markFiled(req.params.id, userId);
    if (!ok) throw new AppError('No such job', 404, 'NOT_FOUND');
    res.json({ success: true, data: present(jobQueue.get(req.params.id)) });
  } catch (err) { next(err); }
});

module.exports = router;
