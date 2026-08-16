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
const nanoBypass = require('./nanoBypassService');
const apiKeys = require('./apiKeyManager');
const muapi = require('./muapiService');
const wavespeed = require('./wavespeedService');
const gallery = require('./galleryManager');
const imageStore = require('./imageStore');
const log = require('../utils/logger');
const { runWithUser } = require('../userContext');

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
  // Nano Banana 2 on Google's own API instead of through WaveSpeed — same model, but only Google's
  // refusals rather than a reseller's on top. Reached with the Gemini key. See nanoBypassService.
  if (model === 'nb2') return 'nanobypass';
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
/**
 * SAVED AS THE JOB'S OWNER, not as nobody.
 *
 * getUserId() is AsyncLocalStorage, set by requireAuth on the way in from a request. The
 * reconciler is a setInterval tick — there is no request, so the store is empty and every service
 * that scopes by user saw '__anon__'.
 *
 * What that looked like: galleryManager keeps its entries in a PER-USER in-memory store, so a
 * queued render wrote its file correctly, appended its entry to the anonymous store, and
 * persisted it — while the browser, authenticated as the real user, looked up the id in ITS store,
 * did not find it, and answered 404. The picture existed on disk the whole time and the Library
 * showed 'Image not on this machine'. It also risked the reverse: the user's state persisting its
 * own snapshot back over gallery.json and dropping the worker's entries.
 *
 * runWithUser is the same helper admin.js already uses to act as another user. The job row has
 * carried user_id since the queue was built; it just was not being put back on.
 *
 * Wrapped HERE rather than at the call sites so neither the poller nor the submit path can forget.
 */
async function _saveResult(job, images) {
  return runWithUser(job.user_id, () => _saveResultAsUser(job, images));
}

async function _saveResultAsUser(job, images) {
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
/**
 * Tries on the bypass before the job is handed to Seedream 5 Pro instead.
 *
 * Three, not more, because each one is expensive in TIME rather than money: a single call runs
 * Google's own three-rung retry ladder inside it, each rung with a 180-second ceiling. Three queue
 * attempts is therefore up to nine API calls before the engine swap. That is fine across 300 lanes
 * and would be painful as a serial number.
 *
 * Rate limits do not count against it — those are refunded before this is consulted, the same way
 * they are for every other engine.
 */
const NB2_ATTEMPTS = 3;

/**
 * Failures that will fail identically no matter which engine runs them, so an engine swap is a
 * wasted call rather than a second chance.
 *
 * Everything here is a CONFIGURATION or REQUEST problem, not a generation problem. A content
 * refusal is deliberately NOT in this list: that is exactly the case worth swapping for, because
 * the two guards draw the line in different places — the owner's note on 2026-08-09 is that the
 * images nano refuses are often ones Seedream passes.
 *
 * A dead or unpaid GEMINI key is terminal here even though Seedream bills a DIFFERENT key and would
 * therefore succeed. Falling back would work, and that is the problem: every NB2 job would quietly
 * run on Seedream and the tab would look healthy while the bypass was dead. A key problem has to be
 * visible, so it fails with a reason that names it.
 */
// NO_ACTIVE_KEY and KEY_CORRUPTED are apiKeyManager's own throws. They are handled before the call
// now, but listed here as belt and braces: a key problem must never be answered by silently moving
// the work to a different provider on a different account.
const NB2_TERMINAL_CODES = new Set(['VALIDATION_ERROR', 'GEMINI_KEY_REQUIRED', 'NO_ACTIVE_KEY', 'KEY_CORRUPTED']);
function isTerminalForFallback(err) {
  if (NB2_TERMINAL_CODES.has(err?.code)) return true;
  if (err?.status === 401 || err?.status === 403) return true;
  /**
   * A DEAD KEY ARRIVES AS 400, NOT 401. generativelanguage.googleapis.com answers a revoked or
   * mistyped key with 400 INVALID_ARGUMENT and "API key not valid. Please pass a valid API key."
   * Checking only 401 meant the exact case this list was written for slipped through: every job
   * would burn three attempts and then quietly run on Seedream, one toast, tab looking healthy.
   *
   * Matched on the message rather than on 400 alone, because 400 also covers ordinary request
   * problems — an aspect ratio or an image Google dislikes and Seedream may not — and those are
   * worth the second engine.
   */
  if (err?.status === 400 && /api key not valid|api_key_invalid|invalid_argument.*api key/i.test(err?.message || '')) return true;
  return false;
}

/**
 * Consecutive rate limits per job, in memory.
 *
 * WHY IT EXISTS: a 429 refunds the attempt — correctly, since the provider refused and it is not
 * the job's fault — which means `attempts` never grows and a rate-limited job can never reach the
 * fallback. Gemini reports an exhausted daily quota as 429 for hours, so the single most likely
 * reason the bypass "cannot finish" was also the one case the fallback could not serve: those jobs
 * would retry forever instead of being handed to an engine that would take them.
 *
 * In memory rather than a column because losing the count on restart costs nothing — the job simply
 * gets its patience back — and a migration to store a number that is meaningless an hour later is
 * not worth the schema.
 */
const rateLimitHits = new Map();
const NB2_RATE_LIMIT_TOLERANCE = 5;

/**
 * A FALLBACK ALWAYS RENDERS AT 2K.
 *
 * The job is already going to be billed at Seedream's rate, and the gap between its 1K and its 2K
 * is a few cents — while the gap in the picture is not. A fallback is also the run you were least
 * likely to get at all, so it is worth having at full size (owner, 2026-08-16).
 */
const FALLBACK_PATCH = { resolution: '2K' };

/**
 * THE ACCOUNT IS EMPTY — which is not a transient failure and must not be treated as one.
 *
 * Both providers say so plainly: WaveSpeed answers 400 'insufficient credit' and muapi answers
 * 402, and both are already turned into AppError(402, 'INSUFFICIENT_CREDITS') with a message that
 * names the top-up. The queue then ignored all of that, requeued, and retried up to eight times
 * before failing with 'Gave up after 8 attempts' — a message that says nothing about the actual
 * problem. On a three-hundred image batch that is 2,400 requests to an account that cannot pay for
 * one of them (owner, 2026-08-16: 'should fail and say balance low').
 *
 * The message check is there because the same condition arrives worded differently depending on
 * which call refused: an upload, a submit, and a poll do not all normalise to the same code.
 */
function isOutOfCredit(err) {
  if (err?.code === 'INSUFFICIENT_CREDITS') return true;
  if (err?.status === 402 || err?.statusCode === 402) return true;
  return /insufficients+credit|out of credits|top up|balance too low|billing/i.test(err?.message || '');
}

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
    } else if (engine === 'nanobypass') {
      /**
       * The bypass finishes IN ONE STEP — there is no task id to poll, because Google's API returns
       * the picture on the same request. `sub.done` is the existing door for exactly this: WaveSpeed
       * uses it to hand back a cached edit that is already complete. So a synchronous provider needs
       * no new state, no new poller, and no special case anywhere downstream.
       *
       * The cost is that this call holds its worker for up to three minutes. That is what the lane
       * ceiling is for, and why this belongs on the queue rather than in the browser: a page doing
       * it directly would be capped at six by Chromium's per-host socket limit.
       */
      /**
       * THE KEY, and both ways it can be absent — neither of which may reach the catch below.
       *
       * getActiveKey THROWS when no key is set (NO_ACTIVE_KEY) rather than returning null. Read
       * without this try, that throw skipped the check underneath it, landed in the outer catch as
       * an ordinary submit failure, and after three attempts handed the job to Seedream. So with no
       * Gemini key at all, every NB2 job would have quietly run on WaveSpeed while the tab looked
       * healthy — precisely the outcome the terminal-code list exists to prevent.
       *
       * It returns NULL, separately, when Vertex is the selected backend: auth then comes from a
       * service account and there is no key string to send. The bypass talks to
       * generativelanguage.googleapis.com directly and cannot use those credentials, so that is a
       * real limitation and is named as one — reported as "no key", it would send someone hunting
       * for a key they already have.
       */
      let apiKey = null;
      try {
        apiKey = apiKeys.getActiveKey?.() || null;
      } catch (keyErr) {
        jobQueue.markFailed(job.id, `Photo Match NB2 needs a Gemini API key — ${keyErr.message}`);
        log.error('generation_nb2_no_key', { jobId: job.id, error: keyErr.message });
        return true;
      }
      if (!apiKey) {
        const onVertex = !!apiKeys.shouldUseVertexBackend?.();
        jobQueue.markFailed(job.id, onVertex
          ? 'Photo Match NB2 needs a direct Gemini API key. Vertex credentials are selected, and the bypass calls Google\'s API directly rather than through Vertex — add a Gemini key under API Keys, or use Photo Match SD.'
          : 'Photo Match NB2 needs a Gemini API key — add one under API Keys.');
        log.error('generation_nb2_no_key', { jobId: job.id, onVertex });
        return true;
      }
      sub = {
        done: await nanoBypass.editRaw({
          apiKey,
          images,
          prompt: job.payload?.prompt || '',
          aspectRatio: opts.aspectRatio,
          // The page speaks in 1K/2K, same vocabulary the bypass route takes.
          imageSize: job.payload?.resolution === '1K' ? '1K' : '2K',
          // How many of the images are HER, so the bypass can label them where they sit. Without
          // it Gemini gets one undifferentiated pile and edits the scene photo instead.
          identityCount: Number(job.payload?.identityCount) || 0,
        }),
      };
    } else if (engine === 'muapi') {
      sub = await muapi.submitSeedreamEdit(images, job.payload?.prompt || '', opts);
    } else {
      sub = await wavespeed.submitNanoBanana2Edit(images, job.payload?.prompt || '', opts);
    }

    /**
     * WaveSpeed can answer a cached edit as already finished, and the bypass ALWAYS does. File it
     * here rather than making the poller wait for a task that will never exist.
     *
     * SAVED IN ITS OWN TRY, and this is not tidiness — it is the duplicate-charge guard.
     *
     * By this line the provider has produced the picture and billed for it. _saveResult writes a
     * file and persists the gallery, either of which can throw (a full disk, a locked file, three
     * hundred lanes writing at once). Left inside the outer try, that throw reaches the catch below,
     * which reads every failure as "the send did not land" — so it requeues, and for a bypass job it
     * now hands the SAME already-paid picture to Seedream. One image, two providers, two bills, and
     * no error anyone would connect to a disk problem.
     *
     * A save failure is terminal instead. The picture is in the gallery or it is not; either way it
     * has been paid for once and must not be made again. Fail toward the visible miss.
     */
    if (sub.done) {
      try {
        await _saveResult(job, sub.done.images);
      } catch (saveErr) {
        jobQueue.markFailed(job.id, `Generated, but could not be saved: ${saveErr.message}`);
        log.error('generation_save_failed', { jobId: job.id, engine, error: saveErr.message });
      }
      rateLimitHits.delete(job.id);
      backoffMs = BACKOFF_START_MS;
      return true;
    }

    jobQueue.markSubmitted(job.id, sub.taskId);
    backoffMs = BACKOFF_START_MS;                  // a success clears the penalty
    log.info('generation_job_submitted', { jobId: job.id, taskId: sub.taskId, engine });
  } catch (err) {
    /**
     * Out of credit is TERMINAL, and it is checked before everything else.
     *
     * Not a rate limit (waiting does not add money), not a retry (the next attempt fails
     * identically), and not a fallback — Seedream is billed to the very account that just said
     * no, so moving the job there buys a second refusal. The provider's own wording is kept
     * because it already names which account and where to top it up.
     *
     * Every queued job fails the same way within a tick or two, which is the point: one glance at
     * the panel says 'balance', and 'Retry N failed' picks them all back up after a top-up.
     */
    if (isOutOfCredit(err)) {
      jobQueue.markFailed(job.id, err.message || 'Balance too low — top up your provider account.');
      rateLimitHits.delete(job.id);
      log.error('generation_out_of_credit', { jobId: job.id, engine, error: err.message });
      return true;
    }
    if (isRateLimit(err)) {
      /**
       * The provider refused it: nothing is rendering, nothing is billed, and it is not this job's
       * fault — so the attempt is refunded and the queue backs off rather than marching the next
       * job into the same wall.
       *
       * But a refunded attempt never grows, so on its own this is an infinite wait: Gemini reports
       * a spent daily quota as 429 for hours. A bypass job that keeps being refused is counted
       * separately here and handed to Seedream once its patience runs out — the fallback exists for
       * "the bypass cannot finish this", and a quota wall is the commonest form of that.
       */
      if (engine === 'nanobypass') {
        const hits = (rateLimitHits.get(job.id) || 0) + 1;
        rateLimitHits.set(job.id, hits);
        if (hits >= NB2_RATE_LIMIT_TOLERANCE && jobQueue.switchEngine(job.id, 'seedream5', { tag: 'fallback', patch: FALLBACK_PATCH })) {
          rateLimitHits.delete(job.id);
          log.warn('generation_nb2_fallback_rate_limited', { jobId: job.id, hits });
          return true;
        }
      }
      jobQueue.requeueUnsent(job.id, { refundAttempt: true });
      /**
       * KNOWN LIMITATION: this clock is global, so a rate limit on one engine also holds back jobs
       * bound for the others — a Gemini quota wall pausing Seedream work on a different account's
       * key. It is bounded (30s at most per pause) and the counter above stops it compounding into
       * an indefinite stall, which is what actually mattered.
       *
       * Not made per-engine here on purpose: the pause is consulted BEFORE a job is claimed, and
       * the engine is only known after, so per-engine pausing means teaching claimNext to skip
       * paused engines. Claiming-then-requeueing instead would just move the stall — the oldest
       * paused job would be picked, put back and picked again, blocking the queue head. That is a
       * change to the claim logic and belongs in its own commit, not bolted onto a fallback.
       */
      pausedUntil = Date.now() + backoffMs;
      log.warn('generation_rate_limited', { engine, backoffMs, until: new Date(pausedUntil).toISOString() });
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      return false;
    }
    /**
     * THE BYPASS RAN OUT OF TRIES — give the job to Seedream rather than to the bin.
     *
     * `job.attempts` is already this attempt (claimNext counts it before handing the job over), so
     * at NB2_ATTEMPTS the third try has just failed. A rate limit never reaches here — it returned
     * above with the attempt refunded — so this counts real failures only.
     *
     * The swap is one-way by construction: switchEngine rewrites payload.model to seedream5, and
     * engineOf reads that, so the job cannot bounce back to the bypass and loop.
     */
    if (engine === 'nanobypass' && job.attempts >= NB2_ATTEMPTS && !isTerminalForFallback(err)) {
      if (jobQueue.switchEngine(job.id, 'seedream5', { tag: 'fallback', patch: FALLBACK_PATCH })) {
        log.warn('generation_nb2_fallback', { jobId: job.id, attempts: job.attempts, error: err.message });
        return true;
      }
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

// How many submissions may START in the same tick, distinct from MAX_INFLIGHT (how many may be
// RENDERING at once). Each submitOne() upload-cache entry is now single-use (2026-08-16 fix for
// the CloudFront-403 bug — a cached URL used to be handed to every job sharing an image, which is
// what caused it), so a big batch that reuses the same pose/outfit photos across many jobs no
// longer gets to skip re-uploading them. Firing all of `room` (up to MAX_INFLIGHT) at once then
// means up to MAX_INFLIGHT x 4 images uploading in the same instant — observed taking down the
// local process's own outbound connections (mass "operation was aborted due to timeout" on the
// upload call, not on WaveSpeed's side). This does not lower the render ceiling, only how fast new
// submissions ramp up toward it — ticks 6s apart still reach MAX_INFLIGHT within a few ticks.
const SUBMIT_BURST_CAP = 20;

async function runOnce() {
  // Everything the provider is already rendering. The ceiling counts THESE, not submissions per
  // tick: a tick every 6s with a fixed budget would either crawl or overshoot depending on how long
  // renders take, whereas "keep N in flight" is the thing actually being limited.
  const running = jobQueue.listResumable();

  // Fill the free lanes, in parallel, but no faster than SUBMIT_BURST_CAP per tick — see above.
  const room = Math.min(SUBMIT_BURST_CAP, Math.max(0, MAX_INFLIGHT - running.length));
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

/**
 * Start a pass NOW, because something was just queued.
 *
 * The loop ticks every 6 seconds, so a job enqueued a moment after a tick sat doing nothing for
 * up to six before anyone even tried to send it. On the bypass — where the render itself is about
 * eight seconds — that is most of the wait, spent idle, and it reads as 'generate is slow'
 * (owner, 2026-08-16).
 *
 * Coalesced: a batch of two hundred enqueues fires ONE pass, not two hundred. runOnce already
 * fills every free lane, so a second concurrent pass would find nothing and only add contention.
 */
let kickTimer = null;
function kickGenerationReconciler() {
  if (!timer || kickTimer) return;            // not started, or a kick is already pending
  kickTimer = setTimeout(() => {
    kickTimer = null;
    runOnce().catch((err) => log.warn('generation_reconciler_kick_failed', { error: err.message }));
  }, 150);
  if (kickTimer.unref) kickTimer.unref();
}

function stopGenerationReconciler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  startGenerationReconciler,
  kickGenerationReconciler,
  stopGenerationReconciler,
  runOnce,
  submitOne,
  pollJob,
  stats,
  MAX_INFLIGHT,
  POLL_INTERVAL_MS,
  STALE_AFTER_MS,
};
