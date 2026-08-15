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
const jobBlobs = require('./jobBlobs');
const muapi = require('./muapiService');
const wavespeed = require('./wavespeedService');
const gallery = require('./galleryManager');
const imageStore = require('./imageStore');
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
 * Set to WaveSpeed's own stated ceiling on the owner's instruction (2026-08-15: "we dont care about
 * money we wanna do mass generation"). Spend is explicitly not a constraint here; LOSING an image
 * is. So the lane count is the provider's, and every path that could drop a render is closed
 * instead: a 429 refunds the attempt and pauses rather than failing a job, poll failures retry for
 * two hours before giving up, and a render returning several images records all of them.
 *
 * Still a number rather than "unlimited", and the reason is not caution: each submit UPLOADS its
 * source images before it returns, so an unbounded fan-out opens thousands of uploads at once and
 * dies on sockets and memory long before WaveSpeed objects. The upload cache keeps this cheap in
 * practice — a character's references upload once and every later job reuses them.
 *
 * KYROS_MAX_INFLIGHT overrides it either way.
 */
const MAX_INFLIGHT = Math.max(1, Number(process.env.KYROS_MAX_INFLIGHT) || 300);

/**
 * Rate-limit backoff, global rather than per job.
 *
 * A 429 is a statement about the ACCOUNT, not about one prediction — so pausing only the job that
 * got refused would send the next one straight into the same wall. Submissions stop entirely until
 * the window passes, doubling to a ceiling and resetting on the first success.
 *
 * The ceiling is deliberately SHORT. This exists to get past a rate limit, not to ration a run: a
 * long pause at three hundred lanes idles the whole fleet, and the queue's job is to keep the pipe
 * full. Thirty seconds is enough for a limiter to clear and cheap to retry if it has not.
 */
const BACKOFF_START_MS = 3_000;
const BACKOFF_MAX_MS = 30_000;
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

/**
 * Which engine a job runs on.
 *
 * IMAGES ARE WAVESPEED. seedreamEdit.js says it plainly -- "Muapi still serves Seedance/Omni; only
 * Seedream moved" -- and Muapi is reached only when no WaveSpeed key is configured. So the two live
 * image engines are Nano Banana 2 and Seedream 5 Pro, both on WaveSpeed.
 *
 * This defaulted to muapi, which was backwards: with a WaveSpeed key present -- the normal case --
 * every Seedream job on the queue would have gone to a DIFFERENT PROVIDER, with its own key and its
 * own pricing, and succeeded while doing it. That is the worst shape of bug: no error, right-looking
 * picture, wrong account billed.
 *
 * 'nano2' | 'seedream5' | 'muapi'. Jobs enqueued before this carry no model and are read as nano2,
 * which is what the queue actually ran at the time.
 */
function engineOf(job) {
  const model = job.payload?.model;
  if (model === 'seedream5' || model === 'seedream') return 'seedream5';
  if (model === 'muapi') return 'muapi';
  if (model === 'nano2') return 'nano2';
  // No model recorded: older rows, all of which ran on Nano Banana 2.
  return job.payload?.provider === 'muapi' ? 'muapi' : 'nano2';
}

async function _pollJob(job) {
  // pollNanoBanana2 is model-agnostic -- it reads a WaveSpeed prediction, whichever model made it.
  const res = engineOf(job) === 'muapi'
    ? await muapi.pollSeedreamEdit(job.task_id)
    : await wavespeed.pollNanoBanana2(job.task_id);
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
  /**
   * Mirrors what /api/seedream/edit does per image — imageStore.store AND galleryManager.save —
   * so a queued job produces the IDENTICAL row a direct call does: { galleryId, imageId, mimeType }.
   *
   * That identity is the point. A page swapping seedreamApi.edit for the queued call then changes
   * one line, instead of being rewritten around a different response contract.
   *
   * base64Data is deliberately NOT carried. Every consumer treats it as the fallback for when there
   * is no server copy (`galleryId ? galleryUrl : base64 ? dataUrl : null`), and a queued job always
   * has a galleryId — markDone refuses without one. Returning megabytes of base64 per image through
   * a status poll would cost a great deal to be ignored.
   */
  const rows = [];
  for (const img of list) {
    let imageId = null;
    try {
      imageId = imageStore.store({
        basePrompt: job.card_prompt || job.payload?.prompt || '',
        modelUsed: job.payload?.model || job.feature,
        image: { mimeType: img.mimeType, base64Data: img.base64Data },
        source: 'generate',
      })?.imageId || null;
    } catch { /* the gallery row below is what the client actually files by */ }

    const saved = gallery.save({
      base64Data: img.base64Data,
      mimeType: img.mimeType,
      prompt: job.card_prompt || job.payload?.prompt || 'Generated',
      source: job.feature,
      aspectRatio: job.payload?.aspectRatio || null,
      // Provenance, so "Recover missing" can identify a stranded picture by character exactly as it
      // does for a direct call. Without these a recovered image is unattributable.
      tags: job.tags?.length ? job.tags : undefined,
    });
    const gid = saved?.id || saved?.galleryId || null;
    if (gid) rows.push({ galleryId: gid, imageId, mimeType: img.mimeType });
  }
  const ids = rows.map((r) => r.galleryId);

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

  jobQueue.markDone(job.id, rows);
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
  const engine = engineOf(job);
  try {
    // The row holds references; the bytes are read here, at the last possible moment, so a queue
    // three hundred deep is three hundred small rows rather than gigabytes held in memory.
    const images = jobBlobs.load(job.payload?.images || []);
    const opts = { aspectRatio: job.payload?.aspectRatio, resolution: job.payload?.resolution };
    let sub;
    if (engine === 'seedream5') {
      /**
       * Seedream 5 Pro on WaveSpeed. If the submit half has not been split out yet, FAIL the job
       * rather than fall through to Muapi: silently running someone's Seedream work on a different
       * provider -- different key, different price -- is far worse than a job that stops and says so.
       */
      if (typeof wavespeed.submitSeedream5Edit !== 'function') {
        jobQueue.markFailed(job.id, 'Seedream 5 is not available on the queue yet (submitSeedream5Edit missing) — not run on another provider.');
        log.error('generation_seedream5_unavailable', { jobId: job.id });
        return true;
      }
      sub = await wavespeed.submitSeedream5Edit(images, job.payload?.prompt || '', opts);
    } else if (engine === 'muapi') {
      sub = await muapi.submitSeedreamEdit(images, job.payload?.prompt || '', opts);
    } else {
      sub = await wavespeed.submitNanoBanana2Edit(images, job.payload?.prompt || '', opts);
    }

    // WaveSpeed can answer a cached edit as already finished. File it here rather than making the
    // poller wait for a task that will never exist.
    if (sub.done) {
      await _saveResult(job, sub.done.images);
      backoffMs = BACKOFF_START_MS;
      return true;
    }

    jobQueue.markSubmitted(job.id, sub.taskId);
    backoffMs = BACKOFF_START_MS;                  // a success clears the penalty
    log.info('generation_job_submitted', { jobId: job.id, taskId: sub.taskId, engine });
  } catch (err) {
    if (isRateLimit(err)) {
      // The provider refused it: nothing is rendering, nothing is billed, and it is not this job's
      // fault — so the attempt is refunded and the whole queue pauses rather than marching the next
      // job into the same wall.
      jobQueue.requeueUnsent(job.id, { refundAttempt: true });
      pausedUntil = Date.now() + backoffMs;
      log.warn('generation_rate_limited', { engine, backoffMs, until: new Date(pausedUntil).toISOString() });
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      return false;
    }
    // A definite send failure — the provider refused, or the connection never landed — means
    // nothing is rendering and nothing was billed, so this is safe to put back. requeueUnsent
    // refuses anyway if a task_id somehow got recorded, which is the guard that matters.
    const back = jobQueue.requeueUnsent(job.id);
    if (!back) jobQueue.markFailed(job.id, err.message || 'Submit failed');
    log.warn('generation_job_submit_failed', { jobId: job.id, engine, error: err.message, requeued: back });
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
  // Collect the input pictures of jobs that no longer exist. At boot specifically: nothing is
  // mid-send yet, so every reference in the database is one this pass can see. Failing it is not
  // worth refusing to start over — the cost of skipping is disk, not correctness.
  try {
    const { removed, bytes } = jobQueue.sweepBlobs();
    if (removed) log.info('generation_blobs_swept', { removed, mb: +(bytes / 1048576).toFixed(1) });
  } catch (err) {
    log.warn('generation_blob_sweep_failed', { error: err.message });
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
