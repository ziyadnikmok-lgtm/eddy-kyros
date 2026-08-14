/**
 * Finish Seedream image jobs that nobody is waiting for any more.
 *
 * The image twin of videoReconciler, and it exists for the same reason that file states in its own
 * header: generation must not depend on a browser tab staying mounted. On the image side the
 * dependency was worse — the render was awaited inside a single HTTP request, so closing the app
 * mid-render lost a picture that Muapi had already produced and already charged for. The request_id
 * was the only handle on it and it lived in a stack frame.
 *
 * Now the queue writes that id down, and this drains the queue:
 *
 *   queued jobs      -> submitted to Muapi, id recorded immediately
 *   submitted jobs   -> polled; on completion the image is saved to the gallery and marked done
 *   orphans          -> failed, never resent (see resolveOrphans in jobQueue)
 *
 * Deliberately NOT here: putting the picture in an Eddy library. Those are IndexedDB, inside the
 * browser. The server gets the job to `done` with a gallery id and the client files it on load.
 */
const jobQueue = require('./jobQueue');
const muapi = require('./muapiService');
const gallery = require('./galleryManager');
const log = require('../utils/logger');

const POLL_INTERVAL_MS = 6000;
// Seedream renders in seconds to a couple of minutes. Past this a task is not coming back, and
// asking forever on every tick would hammer Muapi for nothing. Same reasoning, and the same
// number, as the video side.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
// One submit per tick. These are billed calls: a burst is both a cost spike and a rate-limit risk,
// and the queue exists precisely so work can wait its turn safely.
const SUBMITS_PER_TICK = 1;

/**
 * One reconcile per task at a time.
 *
 * Copied deliberately from videoReconciler, where the comment explains the cost of getting it
 * wrong: a live caller and the poller can both reach the same task, both see "not done yet", and
 * both download AND both bill. Sharing the promise means one execution and two happy callers.
 */
const inFlight = new Map();

function pollJob(job) {
  const existing = inFlight.get(job.task_id);
  if (existing) return existing;
  const p = _pollJob(job).finally(() => inFlight.delete(job.task_id));
  inFlight.set(job.task_id, p);
  return p;
}

async function _pollJob(job) {
  const res = await muapi.pollSeedreamEdit(job.task_id);
  if (res.status === 'processing') return false;

  if (res.status === 'failed') {
    jobQueue.markFailed(job.id, res.error || 'Seedream failed');
    log.warn('generation_job_failed', { jobId: job.id, taskId: job.task_id, error: res.error });
    return true;
  }

  const first = (res.images || [])[0];
  if (!first) {
    jobQueue.markFailed(job.id, 'Seedream reported success but returned no image');
    return true;
  }

  const saved = gallery.save({
    base64Data: first.base64Data,
    mimeType: first.mimeType,
    prompt: job.card_prompt || job.payload?.prompt || 'Generated',
    source: job.feature,
    aspectRatio: job.payload?.aspectRatio || null,
  });
  const galleryId = saved?.id || saved?.galleryId || null;
  if (!galleryId) {
    // Do NOT mark done without an id: the client files by gallery id, so a done row without one is
    // a picture nobody can ever reach. Failing says so out loud instead.
    jobQueue.markFailed(job.id, 'Saved image but the gallery returned no id');
    return true;
  }

  jobQueue.markDone(job.id, galleryId);
  log.info('generation_job_recovered', { jobId: job.id, taskId: job.task_id, galleryId });
  return true;
}

/**
 * Send one queued job.
 *
 * The order here is the whole safety argument: Muapi is called, and the moment it answers with an
 * id that id is written down — BEFORE the render is waited on. A crash after this point is
 * recoverable. A crash before it leaves an orphan, which resolveOrphans fails rather than resends.
 */
async function submitOne() {
  const job = jobQueue.claimNext();
  if (!job) return false;
  try {
    const images = job.payload?.images || [];
    const { taskId } = await muapi.submitSeedreamEdit(images, job.payload?.prompt || '', {
      aspectRatio: job.payload?.aspectRatio,
      resolution: job.payload?.resolution,
    });
    jobQueue.markSubmitted(job.id, taskId);
    log.info('generation_job_submitted', { jobId: job.id, taskId });
  } catch (err) {
    // A definite send failure — Muapi refused, or the connection never landed — means nothing is
    // rendering and nothing was billed, so this is safe to put back. requeueUnsent refuses anyway
    // if a task_id somehow got recorded, which is the guard that matters.
    const back = jobQueue.requeueUnsent(job.id);
    if (!back) jobQueue.markFailed(job.id, err.message || 'Submit failed');
    log.warn('generation_job_submit_failed', { jobId: job.id, error: err.message, requeued: back });
  }
  return true;
}

async function runOnce() {
  for (let i = 0; i < SUBMITS_PER_TICK; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await submitOne())) break;
  }

  for (const job of jobQueue.listResumable()) {
    const age = Date.now() - new Date(job.created_at).getTime();
    try {
      // eslint-disable-next-line no-await-in-loop
      await pollJob(job);
    } catch (err) {
      // A blip must not kill the job — leave it submitted and try again next tick. Only give up
      // once it is clearly never coming back, so the UI stops claiming it is still rendering.
      if (age > STALE_AFTER_MS) {
        log.warn('generation_job_abandoned', { jobId: job.id, taskId: job.task_id, error: err.message });
        jobQueue.markFailed(job.id, 'Task did not complete — Muapi stopped reporting it.');
      }
    }
  }
}

let timer = null;

function startGenerationReconciler() {
  if (timer) return;
  // Close out anything caught mid-send by the last shutdown BEFORE the first pass, so the sweep
  // never picks up a job whose fate is unknown.
  try {
    const orphans = jobQueue.resolveOrphans();
    if (orphans) log.warn('generation_jobs_orphaned', { count: orphans });
  } catch (err) {
    log.warn('generation_orphan_sweep_failed', { error: err.message });
  }
  // Immediate pass so a run interrupted by a close, an update or a crash is picked up at startup
  // rather than waiting for the first tick.
  runOnce().catch((err) => log.warn('generation_reconciler_startup_pass_failed', { error: err.message }));
  timer = setInterval(() => {
    runOnce().catch((err) => log.warn('generation_reconciler_tick_failed', { error: err.message }));
  }, POLL_INTERVAL_MS);
  if (timer.unref) timer.unref();
  log.info('generation_reconciler_started', { intervalMs: POLL_INTERVAL_MS });
}

function stopGenerationReconciler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  startGenerationReconciler,
  stopGenerationReconciler,
  runOnce,
  submitOne,
  pollJob,
  POLL_INTERVAL_MS,
  STALE_AFTER_MS,
};
