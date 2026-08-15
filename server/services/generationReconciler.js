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
const wavespeed = require('./wavespeedService');
const gallery = require('./galleryManager');
const log = require('../utils/logger');

const POLL_INTERVAL_MS = 6000;
// Seedream renders in seconds to a couple of minutes. Past this a task is not coming back, and
// asking forever on every tick would hammer the provider for nothing. Same reasoning, and the same
// number, as the video side.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * HOW MANY RENDERS MAY BE IN FLIGHT AT ONCE (owner, 2026-08-15: "wavespeed say can send up to 300
 * to generate at time not 6").
 *
 * The old ceiling of 6 was never WaveSpeed's. It was the BROWSER's: a render used to be awaited
 * inside one HTTP request, so each one held a socket from the renderer to the local server for ~3
 * minutes, and Chromium allows 6 per host over HTTP/1.1. Six renders saturated the pool and the
 * rest of the UI — thumbnails, /api calls — waited behind them. Raising the client-side constant
 * did nothing, because the queue was in the socket pool, not in our code.
 *
 * Now the server holds the renders, so the ceiling is a real one and this is where it lives.
 *
 * Set to 100 on the owner's instruction (2026-08-15: "just do the 100 at once if selected 100 we
 * dont care about money just make sure in backend we will receive all the images"). Cost is
 * explicitly not the constraint here; LOSING an image is. So the ceiling is high and every path
 * that could drop a paid render is closed instead: 429s refund the attempt and pause rather than
 * failing a job, poll failures retry for two hours before giving up, and a render returning several
 * images now records all of them rather than the first.
 *
 * Still a ceiling rather than "unlimited". Each submit uploads its source images before it returns,
 * so an unbounded fan-out would open thousands of uploads at once and fall over on sockets and
 * memory long before WaveSpeed objected. Raise it with KYROS_MAX_INFLIGHT.
 */
const MAX_INFLIGHT = Math.max(1, Number(process.env.KYROS_MAX_INFLIGHT) || 100);

/**
 * Rate-limit backoff, global rather than per job.
 *
 * A 429 is a statement about the ACCOUNT, not about one prediction — so pausing only the job that
 * got refused would send the next one straight into the same wall. Submissions stop entirely until
 * the window passes, doubling to a ceiling and resetting on the first success.
 */
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 120_000;
let backoffMs = BACKOFF_START_MS;
let pausedUntil = 0;

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

/** Which provider owns a job — recorded in the payload at enqueue, defaulting to the original one. */
function providerOf(job) {
  return job.payload?.provider === 'wavespeed' ? 'wavespeed' : 'muapi';
}

async function _pollJob(job) {
  const res = providerOf(job) === 'wavespeed'
    ? await wavespeed.pollNanoBanana2(job.task_id)
    : await muapi.pollSeedreamEdit(job.task_id);
  if (res.status === 'processing') return false;

  if (res.status === 'failed') {
    jobQueue.markFailed(job.id, res.error || 'The provider reported a failure');
    log.warn('generation_job_failed', { jobId: job.id, taskId: job.task_id, error: res.error });
    return true;
  }

  await _saveResult(job, res.images);
  return true;
}

/**
 * Put a finished render in the gallery and close the job.
 *
 * Shared by the poller and by the submit path, because WaveSpeed can hand back a cached edit as
 * already complete — two ways in, one way to record it.
 */
async function _saveResult(job, images) {
  const list = Array.isArray(images) ? images.filter(Boolean) : [];
  if (!list.length) {
    jobQueue.markFailed(job.id, 'The provider reported success but returned no image');
    return;
  }

  // EVERY image, not just the first. A render can return several, and keeping images[0] threw the
  // rest away — pictures that were generated and billed for. The blocking route has always saved
  // all of them; the queue was the path that quietly did not.
  const ids = [];
  for (const img of list) {
    const saved = gallery.save({
      base64Data: img.base64Data,
      mimeType: img.mimeType,
      prompt: job.card_prompt || job.payload?.prompt || 'Generated',
      source: job.feature,
      aspectRatio: job.payload?.aspectRatio || null,
    });
    const gid = saved?.id || saved?.galleryId || null;
    if (gid) ids.push(gid);
  }

  if (!ids.length) {
    // Do NOT mark done without an id: the client files by gallery id, so a done row without one is
    // a picture nobody can ever reach. Failing says so out loud instead.
    jobQueue.markFailed(job.id, 'Saved image but the gallery returned no id');
    return;
  }
  if (ids.length < list.length) {
    // Partial is still a success — the images that landed are real — but it must not pass silently,
    // because the difference is pictures that were paid for and are now nowhere.
    log.error('generation_job_partial_save', { jobId: job.id, returned: list.length, saved: ids.length });
  }

  jobQueue.markDone(job.id, ids);
  log.info('generation_job_done', { jobId: job.id, taskId: job.task_id, images: ids.length, galleryIds: ids });
}

/**
 * Send one queued job.
 *
 * The order here is the whole safety argument: Muapi is called, and the moment it answers with an
 * id that id is written down — BEFORE the render is waited on. A crash after this point is
 * recoverable. A crash before it leaves an orphan, which resolveOrphans fails rather than resends.
 */
/** A refusal that means "try again later", not "this job is bad". */
function isRateLimit(err) {
  return err?.status === 429
    || err?.code === 'RATE_LIMITED'
    || /\b429\b|rate limit/i.test(err?.message || '');
}

async function submitOne() {
  if (Date.now() < pausedUntil) return false;      // backing off — do not add to the pile
  const job = jobQueue.claimNext();
  if (!job) return false;
  const provider = providerOf(job);
  try {
    const images = job.payload?.images || [];
    const opts = { aspectRatio: job.payload?.aspectRatio, resolution: job.payload?.resolution };
    const sub = provider === 'wavespeed'
      ? await wavespeed.submitNanoBanana2Edit(images, job.payload?.prompt || '', opts)
      : await muapi.submitSeedreamEdit(images, job.payload?.prompt || '', opts);

    // WaveSpeed can answer a cached edit as already finished. File it here rather than making the
    // poller wait for a task that will never exist.
    if (sub.done) {
      await _saveResult(job, sub.done.images);
      backoffMs = BACKOFF_START_MS;
      return true;
    }

    jobQueue.markSubmitted(job.id, sub.taskId);
    backoffMs = BACKOFF_START_MS;                  // a success clears the penalty
    log.info('generation_job_submitted', { jobId: job.id, taskId: sub.taskId, provider });
  } catch (err) {
    if (isRateLimit(err)) {
      // The provider refused it: nothing is rendering, nothing is billed, and it is not this job's
      // fault — so the attempt is refunded and the whole queue pauses rather than marching the next
      // job into the same wall.
      jobQueue.requeueUnsent(job.id, { refundAttempt: true });
      pausedUntil = Date.now() + backoffMs;
      log.warn('generation_rate_limited', { provider, backoffMs, until: new Date(pausedUntil).toISOString() });
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      return false;
    }
    // A definite send failure — the provider refused, or the connection never landed — means
    // nothing is rendering and nothing was billed, so this is safe to put back. requeueUnsent
    // refuses anyway if a task_id somehow got recorded, which is the guard that matters.
    const back = jobQueue.requeueUnsent(job.id);
    if (!back) jobQueue.markFailed(job.id, err.message || 'Submit failed');
    log.warn('generation_job_submit_failed', { jobId: job.id, provider, error: err.message, requeued: back });
  }
  return true;
}

async function runOnce() {
  // Everything the provider is already rendering. The ceiling counts THESE, not submissions per
  // tick: a tick every 6s with a fixed budget would either crawl or overshoot depending on how long
  // renders take, whereas "keep N in flight" is the thing actually being limited.
  const running = jobQueue.listResumable();

  // Fill the free lanes, in parallel. Sequential submits at 24 lanes would spend most of a tick
  // just talking to the provider — each submit uploads the source images first.
  const room = Math.max(0, MAX_INFLIGHT - running.length);
  if (room > 0 && Date.now() >= pausedUntil) {
    await Promise.all(Array.from({ length: room }, () => submitOne().catch((err) => {
      log.warn('generation_submit_threw', { error: err?.message });
      return false;
    })));
  }

  // Poll everything in flight at once. This used to be a sequential await inside a for loop, which
  // was fine at one lane and is quadratic misery at 24: a slow status check would hold up every
  // other job's result behind it.
  await Promise.all(running.map(async (job) => {
    const age = Date.now() - new Date(job.created_at).getTime();
    try {
      await pollJob(job);
    } catch (err) {
      // At 100 lanes the STATUS calls are their own burst, and a 429 on a poll must never be read
      // as a dead job: the render is fine, we simply asked too often. Back off the whole tick and
      // leave it submitted.
      if (isRateLimit(err)) {
        pausedUntil = Date.now() + backoffMs;
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        log.warn('generation_poll_rate_limited', { jobId: job.id, backoffMs });
        return;
      }
      // A blip must not kill the job — leave it submitted and try again next tick. Only give up
      // once it is clearly never coming back, so the UI stops claiming it is still rendering.
      if (age > STALE_AFTER_MS) {
        log.warn('generation_job_abandoned', { jobId: job.id, taskId: job.task_id, error: err.message });
        jobQueue.markFailed(job.id, 'Task did not complete — the provider stopped reporting it.');
      }
    }
  }));
}

/** What the UI can show about throughput, and what the suite asserts against. */
function stats() {
  return {
    maxInflight: MAX_INFLIGHT,
    inFlight: jobQueue.listResumable().length,
    pausedForMs: Math.max(0, pausedUntil - Date.now()),
  };
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
  stats,
  MAX_INFLIGHT,
  POLL_INTERVAL_MS,
  STALE_AFTER_MS,
};
