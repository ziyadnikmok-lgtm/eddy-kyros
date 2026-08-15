/**
 * The durable generation queue — the state machine, kept away from HTTP and away from Muapi.
 *
 * WHAT IT BUYS: today a Seedream run lives entirely inside one HTTP request. Close the app while it
 * renders and the picture is lost — but Muapi has already made it and already charged for it,
 * because Muapi is submit-then-poll and the request_id we threw away is still valid. Writing that
 * id down turns "lost" into "collected on the next boot".
 *
 * THE STATES, and who owns each transition:
 *
 *     queued --(claim)--> submitting --(muapi accepts)--> submitted --(poll)--> done --(client)--> filed
 *                              \                             \                   \
 *                               `--(definite send failure)----'-------------------'--> failed
 *                                        back to queued
 *
 *   * queued     the payload is on disk and nothing has been sent. Safe to resend after any crash:
 *               nothing has been billed yet.
 *   * submitting claimed by the worker, mid-send. Exists so a second tick cannot pick the same row
 *               up and send it twice — without it, claimNext hands the same job out on every pass.
 *   * submitted  Muapi has it and task_id is set. NEVER resend one of these — Muapi is already
 *               rendering it and a resend is a second charge for the same picture. On boot these
 *               are re-polled, not re-sent. This is the single most important rule in the file.
 *   * done       the image is in the gallery and gallery_id is set. Still not in a library.
 *   * failed     terminal. Carries the reason.
 *
 * THE ORPHAN WINDOW, and why it fails closed. Between "Muapi accepted" and "we wrote the task_id"
 * there is a moment where a crash leaves a `submitting` row with no id. That job MIGHT be rendering
 * and MIGHT have been billed, and there is no way to tell from here. Re-sending it risks paying
 * twice for one picture, silently, every time the app is closed at the wrong instant. So
 * resolveOrphans FAILS those jobs rather than resending them: a missed picture is visible and
 * costs one click, a duplicate charge is invisible. Same principle the posting side settled on —
 * fail toward the miss, never toward the duplicate.
 *
 * `filed` is deliberately NOT a status. The Eddy libraries are IndexedDB, in the browser, so the
 * server physically cannot put a picture in one. It gets the job to `done`; the client files it and
 * flips the flag. If the two were one field, a job would read as complete while its picture had
 * reached no library at all.
 */
const crypto = require('crypto');
const db = require('../db');
const jobBlobs = require('./jobBlobs');

const STATUS = Object.freeze({
  QUEUED: 'queued',
  SUBMITTING: 'submitting',
  SUBMITTED: 'submitted',
  DONE: 'done',
  FAILED: 'failed',
});

/**
 * Submit attempts before a job is given up on. Poll retries are separate and unbounded until the
 * stale window — see claimNext.
 *
 * Raised for mass runs: at three hundred lanes a job can lose its attempts to nothing but bad luck
 * — two rate limits and one dropped connection — and a job dropped for transient reasons is a
 * picture that simply never appears. A genuinely bad payload still fails, just after eight tries
 * instead of three, and every attempt after a 429 is refunded anyway.
 */
const MAX_SUBMIT_ATTEMPTS = 8;

const now = () => new Date().toISOString();

/**
 * Put work on the queue. Returns the row id.
 *
 * Writes BEFORE anything is sent anywhere, which is the point: a crash between this call and the
 * submit costs nothing but a resend, because nothing has been billed.
 */
function enqueue({ userId, feature, payload, destDb = null, destFolder = null, cardPrompt = null, cardName = null, tags = null }) {
  if (!userId) throw new Error('enqueue: userId is required');
  if (!feature) throw new Error('enqueue: feature is required');
  const id = crypto.randomUUID();
  const t = now();
  // The input pictures go to disk and the row keeps a reference. Inline base64 here is what took a
  // hundred-lane run's database to 479 MB; at three hundred lanes it is gigabytes. See jobBlobs.
  const stored = payload && Array.isArray(payload.images)
    ? { ...payload, images: jobBlobs.store(payload.images) }
    : payload;
  db.prepare(`
    INSERT INTO generation_jobs (id, user_id, feature, status, payload, dest_db, dest_folder, card_prompt, card_name, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, feature, STATUS.QUEUED, JSON.stringify(stored ?? {}), destDb, destFolder, cardPrompt, cardName,
    Array.isArray(tags) && tags.length ? JSON.stringify(tags) : null, t, t);
  return id;
}

/**
 * Take the oldest queued job and count the attempt, atomically.
 *
 * The UPDATE ... WHERE status='queued' is what makes it atomic: two workers racing here cannot both
 * claim the same row, because the second one's UPDATE matches nothing. Returns null when the queue
 * is empty.
 *
 * A job that has burned through MAX_SUBMIT_ATTEMPTS is failed rather than retried forever — a
 * payload Muapi rejects will be rejected identically next time, and an endless retry loop on a
 * paid API is worse than a visible failure.
 */
function claimNext() {
  const row = db.prepare(`
    SELECT * FROM generation_jobs WHERE status = ? ORDER BY created_at LIMIT 1
  `).get(STATUS.QUEUED);
  if (!row) return null;

  if (row.attempts >= MAX_SUBMIT_ATTEMPTS) {
    markFailed(row.id, `Gave up after ${MAX_SUBMIT_ATTEMPTS} attempts`);
    return null;
  }

  // Moving it OUT of `queued` is what makes this a claim rather than a peek: the next tick must not
  // hand the same job to a second sender. The WHERE status='queued' makes it atomic — a racing
  // worker's UPDATE matches nothing.
  const claimed = db.prepare(`
    UPDATE generation_jobs SET status = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = ?
  `).run(STATUS.SUBMITTING, now(), row.id, STATUS.QUEUED);
  if (claimed.changes !== 1) return null;   // someone else took it

  return hydrate({ ...row, status: STATUS.SUBMITTING, attempts: row.attempts + 1 });
}

/**
 * Boot sweep for jobs caught mid-send — see "THE ORPHAN WINDOW" above.
 *
 * A `submitting` row with no task_id may or may not have reached Muapi. It is failed, not resent,
 * because the cost of guessing wrong is an invisible double charge. Returns how many were closed
 * so the caller can say so out loud.
 */
function resolveOrphans() {
  const res = db.prepare(`
    UPDATE generation_jobs SET status = ?, error = ?, updated_at = ?
    WHERE status = ? AND task_id IS NULL
  `).run(
    STATUS.FAILED,
    'Interrupted while sending — not resent automatically, because it may already have been charged. Run it again if the picture never arrived.',
    now(),
    STATUS.SUBMITTING,
  );
  return res.changes;
}

/**
 * Muapi has it. Record the id that makes this job recoverable.
 *
 * From here the job must never be re-submitted, only re-polled — a resend is a second charge for a
 * picture that is already being rendered.
 */
function markSubmitted(id, taskId) {
  if (!taskId) throw new Error('markSubmitted: a taskId is required — without it the job cannot be resumed');
  db.prepare(`UPDATE generation_jobs SET status = ?, task_id = ?, updated_at = ? WHERE id = ?`)
    .run(STATUS.SUBMITTED, taskId, now(), id);
}

/**
 * The images exist in the gallery. Not yet in any library — that is the client's job.
 *
 * Takes a LIST. A single render can return several images (the blocking route has always saved
 * `result.images.map(...)`), and recording only the first quietly discarded the rest — images that
 * were generated and billed. gallery_id keeps the first so every existing reader still works;
 * gallery_ids carries all of them.
 */
function markDone(id, rows) {
  // Accepts either bare ids or full { galleryId, imageId, mimeType } rows. The rows are what let a
  // finished job answer in the SAME shape /api/seedream/edit does, so a page can swap one call for
  // the other rather than being rewritten around a different contract.
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean)
    .map((r) => (typeof r === 'string' ? { galleryId: r } : r))
    .filter((r) => r.galleryId);
  const ids = list.map((r) => r.galleryId);
  db.prepare(`
    UPDATE generation_jobs
    SET status = ?, gallery_id = ?, gallery_ids = ?, result_json = ?, error = NULL, updated_at = ?
    WHERE id = ?
  `).run(STATUS.DONE, ids[0] || null, ids.length ? JSON.stringify(ids) : null,
    list.length ? JSON.stringify(list) : null, now(), id);
}

function markFailed(id, message) {
  db.prepare(`UPDATE generation_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?`)
    .run(STATUS.FAILED, String(message || 'unknown error').slice(0, 500), now(), id);
}

/**
 * Put a submitted job back on the queue — ONLY valid when it never reached Muapi.
 *
 * Guarded rather than trusted: it refuses to requeue anything carrying a task_id, because that job
 * is rendering and resending it bills twice. The guard lives here rather than at the call sites so
 * that a future caller cannot get it wrong.
 */
function requeueUnsent(id, { refundAttempt = false } = {}) {
  const row = db.prepare('SELECT task_id FROM generation_jobs WHERE id = ?').get(id);
  if (!row) return false;
  if (row.task_id) return false;
  // refundAttempt is for a rate limit: the provider REFUSED the job, so nothing is rendering and
  // nothing is billed — and it is not the job's fault. Without the refund, three 429s in a row
  // would burn the whole retry budget of a perfectly good job and fail it permanently, which is the
  // opposite of what a backoff is for.
  const res = db.prepare(`
    UPDATE generation_jobs SET status = ?, attempts = MAX(0, attempts - ?), updated_at = ?
    WHERE id = ? AND task_id IS NULL
  `).run(STATUS.QUEUED, refundAttempt ? 1 : 0, now(), id);
  return res.changes === 1;
}

/**
 * What the boot sweep has to deal with: jobs Muapi is already rendering.
 *
 * These are re-polled, never re-sent. Anything left `queued` needs no sweep at all — the worker
 * picks it up on its next tick by definition.
 */
function listResumable() {
  return db.prepare(`
    SELECT * FROM generation_jobs WHERE status = ? AND task_id IS NOT NULL ORDER BY created_at
  `).all(STATUS.SUBMITTED).map(hydrate);
}

/** Finished work the client has not yet put into a library. The boot question, per user. */
function listUnfiled(userId) {
  return db.prepare(`
    SELECT * FROM generation_jobs WHERE user_id = ? AND status = ? AND filed = 0 AND gallery_id IS NOT NULL
    ORDER BY created_at
  `).all(userId, STATUS.DONE).map(hydrate);
}

/**
 * The client put it in a library. Scoped by user_id so one account cannot mark another's work
 * filed, which would make that picture invisible to the person who paid for it.
 */
function markFiled(id, userId) {
  const res = db.prepare('UPDATE generation_jobs SET filed = 1, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(now(), id, userId);
  return res.changes === 1;
}

/**
 * Put a FAILED job back on the queue as a fresh attempt.
 *
 * Clears task_id as well as the error, so the worker submits it anew rather than polling a
 * prediction that is already finished-and-failed. Attempts reset to zero — this is a deliberate
 * human decision, not the automatic retry the cap exists to bound.
 *
 * WORTH KNOWING, and why it is only ever reachable by an explicit click: a job failed as an ORPHAN
 * (interrupted between the provider accepting and the id being recorded) MIGHT already have been
 * rendered and billed. Retrying it can pay twice for one picture. The automatic path refuses to
 * make that call; a person looking at a missing image can.
 *
 * Scoped by user_id, and only from `failed` — retrying something still in flight would be a genuine
 * double submit.
 */
function retry(id, userId) {
  const res = db.prepare(`
    UPDATE generation_jobs
    SET status = ?, task_id = NULL, error = NULL, attempts = 0, updated_at = ?
    WHERE id = ? AND user_id = ? AND status = ?
  `).run(STATUS.QUEUED, now(), id, userId, STATUS.FAILED);
  return res.changes === 1;
}

/** Every failed job, newest first — what the panel lists and what "Retry all" acts on. */
function listFailed(userId) {
  return db.prepare(`
    SELECT * FROM generation_jobs WHERE user_id = ? AND status = ? ORDER BY created_at DESC
  `).all(userId, STATUS.FAILED).map(hydrate);
}

/** One click for the whole pile. Returns how many went back on. */
function retryAllFailed(userId) {
  const res = db.prepare(`
    UPDATE generation_jobs
    SET status = ?, task_id = NULL, error = NULL, attempts = 0, updated_at = ?
    WHERE user_id = ? AND status = ?
  `).run(STATUS.QUEUED, now(), userId, STATUS.FAILED);
  return res.changes;
}

/** Counts by status — the whole queue at a glance, in one query rather than five. */
function counts(userId) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n FROM generation_jobs WHERE user_id = ? GROUP BY status
  `).all(userId);
  const out = { queued: 0, submitting: 0, submitted: 0, done: 0, failed: 0, unfiled: 0 };
  for (const r of rows) if (r.status in out) out[r.status] = r.n;
  out.unfiled = db.prepare(`
    SELECT COUNT(*) AS n FROM generation_jobs
    WHERE user_id = ? AND status = ? AND filed = 0 AND gallery_id IS NOT NULL
  `).get(userId, STATUS.DONE).n;
  // What is actually moving right now — the number that answers "is it still working".
  out.active = out.queued + out.submitting + out.submitted;
  return out;
}

/**
 * Drop everything that has NOT been sent yet.
 *
 * Stop has to actually stop spending. It ends the client's loop, but jobs already on the queue keep
 * being submitted by the worker — at a hundred lanes that is a lot of money arriving after the
 * button was pressed.
 *
 * QUEUED only, and never `submitting` or `submitted`: those have either reached the provider or
 * might have, and cancelling one locally would not un-bill it — it would only lose the picture that
 * was paid for. Same rule as everywhere else here: fail toward the miss, never toward the loss.
 */
function cancelQueued(userId) {
  const res = db.prepare(`
    UPDATE generation_jobs SET status = ?, error = ?, updated_at = ?
    WHERE user_id = ? AND status = ?
  `).run(STATUS.FAILED, 'Cancelled before it was sent — nothing was charged.', now(), userId, STATUS.QUEUED);
  return res.changes;
}

/** Everything still moving, for the UI. */
function listActive(userId) {
  return db.prepare(`
    SELECT * FROM generation_jobs WHERE user_id = ? AND status IN (?, ?, ?) ORDER BY created_at
  `).all(userId, STATUS.QUEUED, STATUS.SUBMITTING, STATUS.SUBMITTED).map(hydrate);
}

function get(id) {
  const row = db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

/**
 * Delete the stored input pictures that no job references any more.
 *
 * Derived, never bookkept: the live set is read off the rows themselves, so a crash at any moment
 * cannot leave it wrong. The cost is one pass over every row's payload, which is why this runs at
 * boot and not on the hot path — and the payloads are references now, so the pass is cheap.
 */
function sweepBlobs() {
  const live = new Set();
  for (const row of db.prepare('SELECT payload FROM generation_jobs').all()) {
    let payload = null;
    try { payload = JSON.parse(row.payload); } catch { continue; }
    for (const name of jobBlobs.refsIn(payload)) live.add(name);
  }
  return jobBlobs.sweep(live);
}

/** JSON back out of the text column, and `filed` back to a boolean. */
function hydrate(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload); } catch { /* a corrupt payload must not take the queue down */ }
  let galleryIds = [];
  try { galleryIds = row.gallery_ids ? JSON.parse(row.gallery_ids) : []; } catch { galleryIds = []; }
  // Falls back to the single id for rows written before gallery_ids existed, so an older job still
  // hands the client something to file rather than nothing.
  if (!galleryIds.length && row.gallery_id) galleryIds = [row.gallery_id];
  let images = [];
  try { images = row.result_json ? JSON.parse(row.result_json) : []; } catch { images = []; }
  // Rows written before result_json existed still answer with something usable.
  if (!images.length) images = galleryIds.map((galleryId) => ({ galleryId }));
  let tags = [];
  try { tags = row.tags ? JSON.parse(row.tags) : []; } catch { tags = []; }
  return { ...row, payload, galleryIds, images, tags, filed: row.filed === 1 };
}

module.exports = {
  STATUS,
  MAX_SUBMIT_ATTEMPTS,
  enqueue,
  claimNext,
  resolveOrphans,
  markSubmitted,
  markDone,
  markFailed,
  requeueUnsent,
  listResumable,
  listUnfiled,
  markFiled,
  listActive,
  listFailed,
  retry,
  retryAllFailed,
  cancelQueued,
  counts,
  get,
  sweepBlobs,
};
