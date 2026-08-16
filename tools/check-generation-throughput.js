// Concurrency and rate-limit handling for the generation queue.
//
// WHY THIS EXISTS (owner, 2026-08-15: "wavespeed say can send up to 300 to generate at time not 6").
//
// The old ceiling of 6 was never WaveSpeed's — it was Chromium's. A render was awaited inside one
// HTTP request, so each held a socket from the renderer to the local server for ~3 minutes, and
// browsers allow 6 per host over HTTP/1.1. Six renders saturated the pool and everything else in
// the UI queued behind them. Raising the client-side constant did nothing at all, because the queue
// was in the socket pool rather than in our code.
//
// Moving the wait to the server makes the ceiling real. The assertions here are about the two ways
// that goes wrong: overshooting into 429s (which burn money and lose images, since a refused job
// that is not put back is a job you paid to discover), and undershooting because the poller is
// serial.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const rec = read('server/services/generationReconciler.js');
const ws = read('server/services/wavespeedService.js');
const q = read('server/services/jobQueue.js');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- 1. WaveSpeed submit and poll are separable ----------------------------------------------------
// Without this split there is nowhere to put the wait except the client's connection.
check('submitNanoBanana2Edit exists', ws.includes('async function submitNanoBanana2Edit('));
check('and returns a task id rather than a finished image', ws.includes('return { taskId: data.id };'));
check('a cached instant result is still handled', ws.includes('return { done: await _extractSeedDreamResults(data) };'));
check('pollNanoBanana2 checks once without waiting', ws.includes('async function pollNanoBanana2(taskId)'));
check('a failed prediction is an ANSWER, not a throw', /return \{ status: 'failed', error: res\.error \|\| 'unknown' \};/.test(ws));
check('both are exported', ws.includes('submitNanoBanana2Edit,') && ws.includes('pollNanoBanana2,'));

// The blocking call must behave exactly as before — the existing pages still use it.
check('generateNanoBanana2Edit still exists', ws.includes('async function generateNanoBanana2Edit('));
check('and is now built on the two halves', ws.includes('const sub = await submitNanoBanana2Edit(imageInputs, prompt, opts);'));
check('it still polls to completion for its callers', ws.includes('_pollSeedDreamResult(key, sub.taskId'));
check('onTaskId lets a caller record the id before the wait', ws.includes("if (typeof opts.onTaskId === 'function')"));
check('the browser socket ceiling is written down where the number lives',
  /Chromium allows 6 per host over HTTP\/1\.1/.test(rec));

// --- 2. the ceiling is a REAL one now --------------------------------------------------------------
check('there is a concurrency ceiling', rec.includes('const MAX_INFLIGHT ='));
const dflt = Number((rec.match(/Number\(process\.env\.KYROS_MAX_INFLIGHT\) \|\| (\d+)/) || [])[1]);
check(`its default is well above the old browser-bound 6 (${dflt})`, dflt >= 300);
// Bounded, but no longer for cost — the owner ruled cost out explicitly. Each submit uploads its
// source images before returning, so an unbounded fan-out dies on sockets and memory long before
// the provider objects.
// Bounded, and NOT for thrift — the owner ruled spend out. Each submit uploads its source images
// before returning, so an unbounded fan-out dies on sockets and memory before the provider objects.
check('it is still a number, so a fan-out cannot exhaust sockets', Number.isFinite(dflt) && dflt > 0);
check('and it is overridable for a deliberate run', rec.includes('process.env.KYROS_MAX_INFLIGHT'));
check('it can never be zero, which would stall the queue silently', rec.includes('Math.max(1, Number(process.env.KYROS_MAX_INFLIGHT)'));

// It counts what is IN FLIGHT, not submissions per tick. A per-tick budget either crawls or
// overshoots depending on render time; "keep N running" is the thing actually being limited.
//
// room is now MIN'd with SUBMIT_BURST_CAP too (2026-08-16) — a real second constraint, not a
// revival of the old per-tick budget: it caps how fast NEW submissions ramp up, not how many may
// render at once. Added after per-job upload caching went single-use (the CloudFront-403 fix,
// same day) meant a big batch reusing one pose/outfit photo across many jobs stopped skipping
// re-uploads, and firing all of `room` at once could mean MAX_INFLIGHT x 4 images uploading in the
// same instant — enough to take down the process's own outbound connections. Pinning the exact
// old expression here would fail on that fix the same way it just did; check for both constraints
// instead of the literal line.
check('the ceiling counts jobs in flight, not submits per tick',
  rec.includes('MAX_INFLIGHT - running.length'));
check('submissions are also capped per tick, separately from the render ceiling',
  rec.includes('SUBMIT_BURST_CAP') && /Math\.min\(SUBMIT_BURST_CAP,/.test(rec));
check('the burst cap does not lower the render ceiling, only ramp speed',
  rec.includes('does not lower the render ceiling'));
check('the old per-tick budget is gone', !rec.includes('SUBMITS_PER_TICK'));
check('lanes are filled in parallel — sequential submits would spend the tick uploading',
  /await Promise\.all\(Array\.from\(\{ length: room \}/.test(rec));
check('polling is parallel too — one slow status check must not hold up the other 99',
  /await Promise\.all\(running\.map\(async \(job\)/.test(rec));
check('a throwing submit cannot take the whole tick down', /submitOne\(\)\.catch\(/.test(rec));

// --- 3. THE MONEY RULE still holds at 100 lanes --------------------------------------------------------
const submitIdx = rec.indexOf('await wavespeed.submitNanoBanana2Edit(');
const markIdx = rec.indexOf('jobQueue.markSubmitted(job.id, sub.taskId)');
check('the task id is recorded immediately after the provider accepts', submitIdx > -1 && markIdx > submitIdx);
check('submitted jobs are polled, never re-submitted',
  !/listResumable\(\)[\s\S]{0,600}submitNanoBanana2Edit/.test(rec));

// --- 4. a 429 costs a wait, not a job ---------------------------------------------------------------------
check('rate limits are recognised', rec.includes('function isRateLimit(err)'));
check('by status, by code, and by message — the three shapes it arrives in',
  /err\?\.status === 429/.test(rec) && /err\?\.code === 'RATE_LIMITED'/.test(rec) && /rate limit/i.test(rec));
check('WaveSpeed throws the code this looks for', ws.includes("throw new AppError('WaveSpeed rate limited', 429, 'RATE_LIMITED')"));

// A 429 means the provider REFUSED it: nothing rendering, nothing billed, and not the job's fault.
// Without the refund three 429s would exhaust a good job's retry budget and fail it for good.
check('a rate-limited job goes back on the queue', rec.includes("jobQueue.requeueUnsent(job.id, { refundAttempt: true })"));
check('and its attempt is refunded, so a backoff cannot exhaust a good job',
  q.includes('function requeueUnsent(id, { refundAttempt = false } = {})'));
check('the refund cannot drive attempts negative', q.includes('attempts = MAX(0, attempts - ?)'));
check('the refund still refuses a job that reached the provider — that one is billed',
  /requeueUnsent[\s\S]{0,600}if \(row\.task_id\) return false;/.test(q));

// The pause is global: a 429 is about the ACCOUNT, so pausing one job sends the next into the same
// wall.
check('the whole queue pauses, not just the refused job', rec.includes('pausedUntil = Date.now() + backoffMs'));
check('submits are skipped while paused', rec.includes('if (Date.now() < pausedUntil) return false;'));
check('and the tick does not even try to fill lanes while paused', rec.includes('if (room > 0 && Date.now() >= pausedUntil)'));
check('the backoff doubles', rec.includes('backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)'));
// Short on purpose: a long pause at three hundred lanes idles the whole fleet, and this exists to
// clear a limiter, not to ration a run.
check('the backoff cap is short, so a run is never rationed', /BACKOFF_MAX_MS = 30_000/.test(rec));
check('a success clears the penalty', (rec.match(/backoffMs = BACKOFF_START_MS;/g) || []).length >= 2);

// --- 5. both providers, one queue -------------------------------------------------------------------------
check('a job knows which engine it runs on', rec.includes('function engineOf(job)'));
// THE ONE THAT MATTERS. Images are WaveSpeed: seedreamEdit.js states "Muapi still serves
// Seedance/Omni; only Seedream moved", and Muapi is reached only when no WaveSpeed key exists.
// Defaulting to muapi meant every Seedream job on the queue would have run on a DIFFERENT provider
// -- own key, own pricing -- and succeeded while doing it. No error, right-looking picture, wrong
// account billed.
check('an unmodelled job defaults to WaveSpeed, never Muapi',
  rec.includes("return job.payload?.provider === 'muapi' ? 'muapi' : 'nano2';"));
check('seedream5 is its own engine', rec.includes("if (model === 'seedream5' || model === 'seedream') return 'seedream5';"));
check('and Muapi is only reached when explicitly asked for', rec.includes("if (model === 'muapi') return 'muapi';"));
check('polling sends only explicit Muapi jobs to Muapi', rec.includes("engineOf(job) === 'muapi'"));
check('everything else polls WaveSpeed, which is model-agnostic', rec.includes('await wavespeed.pollNanoBanana2(job.task_id)'));
check('submitting routes seedream5 to WaveSpeed', rec.includes('await wavespeed.submitSeedream5Edit('));
check('and nano2 to Nano Banana 2', rec.includes('await wavespeed.submitNanoBanana2Edit('));
// A missing split must never fall through to another provider. Silently running Seedream work on
// Muapi -- different key, different price -- is far worse than a job that stops and says so.
check('a missing Seedream 5 submit FAILS the job rather than switching provider',
  rec.includes("typeof wavespeed.submitSeedream5Edit !== 'function'")
  && rec.includes('not run on another provider.'));
check('one save path for both, including the instant-cache case',
  rec.includes('async function _saveResult(job, images)') && rec.includes('await _saveResult(job, sub.done.images)'));
check('and it still refuses to mark done without a gallery id',
  rec.includes("jobQueue.markFailed(job.id, 'Saved image but the gallery returned no id')"));

// --- 6. replay: lanes stay full, and a 429 does not lose work ------------------------------------------------
// Same finish pattern, two ceilings, so the comparison is like for like rather than against a
// number picked to pass.
const replay = (max, ticks = 10) => {
  let inflight = 0, submitted = 0, peak = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    const room = Math.max(0, max - inflight);
    inflight += room; submitted += room;
    peak = Math.max(peak, inflight);
    if (tick % 3 === 2) inflight -= Math.floor(inflight / 2);   // half finish
  }
  return { submitted, peak };
};
const now = replay(dflt);
const before = replay(6);
check(`the pool never exceeds the ceiling (peak ${now.peak} of ${dflt})`, now.peak <= dflt);
check(`the old 6-lane ceiling stayed under 6 too (peak ${before.peak})`, before.peak <= 6);
check(`same conditions, more work through: ${now.submitted} vs ${before.submitted}`,
  now.submitted > before.submitted);
check(`throughput scales with the ceiling — ~${(now.submitted / before.submitted).toFixed(1)}x`,
  now.submitted / before.submitted >= dflt / 6 - 0.01);

// --- 7. NOTHING IS LOST AT 100 LANES ---------------------------------------------------------------
// Owner, 2026-08-15: "just do the 100 at once ... we dont care about money just make sure in
// backend we will receive all the images". Cost stopped being the constraint; a dropped render is
// the only thing that matters now. Each assertion below closes one way an image could vanish.
const q2 = read('server/services/jobQueue.js');
const routes = read('server/routes/jobs.js');
const cli = read('client/src/lib/generationQueue.js');
const dbjs = read('server/db.js');

check('the ceiling is the provider maximum', /KYROS_MAX_INFLIGHT\) \|\| 300/.test(rec));

// LOSS #1: a render returning several images, with only the first recorded. The blocking route has
// always saved result.images.map(...) — the queue was the path that quietly kept one.
check('every returned image is saved, not just the first', rec.includes('for (const img of list) {'));
check('and all their rows are recorded', rec.includes('jobQueue.markDone(job.id, rows)'));
check('markDone takes a list of rows', q2.includes('function markDone(id, rows)'));
check('the first id is still written to gallery_id for older readers', q2.includes('ids[0] || null'));
// The row shape is what makes the queued call a drop-in for seedreamApi.edit.
check('rows carry galleryId, imageId and mimeType', rec.includes('rows.push({ galleryId: gid, imageId, mimeType: img.mimeType })'));
check('and the job stores them', q2.includes('result_json = ?'));
check('a partial save is logged at ERROR, never passed over in silence',
  rec.includes("log.error('generation_job_partial_save'"));
check('the column exists for fresh databases', dbjs.includes('gallery_ids  TEXT,'));
check('and a migration adds it to an existing one — CREATE TABLE IF NOT EXISTS never alters',
  dbjs.includes("db.exec('ALTER TABLE generation_jobs ADD COLUMN gallery_ids TEXT')"));
check('older rows fall back to their single id rather than reading as empty',
  q2.includes('if (!galleryIds.length && row.gallery_id) galleryIds = [row.gallery_id];'));

// LOSS #2: images saved to the gallery but never filed into a library.
check('the route exposes every id', routes.includes('galleryIds: job.galleryIds'));
check('the client files every id', cli.includes('for (const [i, gid] of ids.entries())'));
check('and only marks the job filed once ALL of them landed',
  cli.indexOf('for (const [i, gid] of ids.entries())') < cli.indexOf('await jobsApi.markFiled(job.id)'));
check('a single-image job keeps its exact name', cli.includes("(i ? `-${i + 1}` : '')"));

// LOSS #3: a 429 on the POLL path read as a dead job. At 100 lanes the status calls are their own
// burst, and the render is fine — we simply asked too often.
check('a poll-side rate limit backs off instead of failing the job',
  rec.includes("log.warn('generation_poll_rate_limited'"));
check('a poll failure only gives up after the stale window', rec.includes('if (age > STALE_AFTER_MS)'));

// Replay at the real ceiling: a burst of 100 all reach a terminal state, none stranded.
const MAXR = 100;
let queued = 100, running = 0, done = 0;
for (let tick = 0; tick < 40 && (queued || running); tick += 1) {
  const room = Math.max(0, MAXR - running);
  const take = Math.min(room, queued);
  queued -= take; running += take;
  const finish = Math.ceil(running / 3);
  running -= finish; done += finish;
}
check(`a burst of 100 all reach a terminal state (${done} done)`, done === 100);
check('none stranded in flight', running === 0 && queued === 0);
check('and none lost along the way', 100 - done - queued - running === 0);

// --- 8. SEEING IT, AND RETRYING IT ------------------------------------------------------------------
// "That mean we can see all of them, and just click retry failed" (owner, 2026-08-15). Until this
// the queue was real but invisible: work survived a close, resumed on boot and filed itself, and
// the only evidence was pictures appearing. At 100 lanes that is not enough — you need to know what
// is moving and what fell over.
const panel = read('client/src/components/GenerationQueuePanel.jsx');
const appjs = read('client/src/App.jsx');

check('the queue reports counts by status in one query', q2.includes('function counts(userId)'));
check('including what is actively moving', q2.includes('out.active = out.queued + out.submitting + out.submitted;'));
check('and the failures themselves, with their reasons', q2.includes('function listFailed(userId)'));
check('the list route returns all of it', routes.includes('failed: jobQueue.listFailed(userId).map(present)') && routes.includes('counts: jobQueue.counts(userId)'));

// Retry clears the task id: without that the worker would poll a prediction that is already
// finished-and-failed and the job would fail again instantly.
check('retry exists', q2.includes('function retry(id, userId)'));
check('and clears the task id so the job is SENT again, not re-polled', /SET status = \?, task_id = NULL, error = NULL, attempts = 0/.test(q2));
check('only a FAILED job can be retried — anything in flight would be a real double submit',
  q2.includes('.run(STATUS.QUEUED, now(), id, userId, STATUS.FAILED)'));
check('and only your own', /WHERE id = \? AND user_id = \? AND status = \?/.test(q2));
check('there is a one-click retry for the whole pile', q2.includes('function retryAllFailed(userId)'));
check('both are exposed', routes.includes("router.post('/:id/retry'") && routes.includes("router.post('/retry-failed'"));
check('a retry of something that is not failed 404s like a missing one', routes.includes("throw new AppError('No failed job with that id', 404, 'NOT_FOUND')"));

// The one thing a person must be told: a retry can pay twice for an orphan.
check('the double-charge risk of a manual retry is written down',
  q2.includes('Retrying it can pay twice for one picture'));

check('the panel exists and is mounted on every page', appjs.includes('<GenerationQueuePanel className="mb-3" />'));
check('it shows what is waiting, rendering, to file and failed',
  panel.includes('label="waiting"') && panel.includes('label="rendering"') && panel.includes('label="to file"') && panel.includes('label="failed"'));
check('it offers the bulk retry', panel.includes('jobsApi.retryAllFailed()'));
check('and a per-job one', panel.includes('jobsApi.retry(id)'));
check('failures show their REASON, not just a count', panel.includes('j.error ?') && panel.includes('j.cardName || j.feature'));
check('it hides entirely when the queue is empty', panel.includes('if (!counts || (!counts.active && !counts.failed && !counts.unfiled)) return null;'));
check('and polls slowly when nothing is moving', panel.includes('active ? BUSY_MS : IDLE_MS'));
check('a failed poll keeps the last view rather than flashing an error',
  panel.includes('// Signed out, offline, or the server is restarting.'));

// --- 9. NO NEEDLESS RE-ENCODE ON THE WAY TO WAVESPEED -------------------------------------------------
// Owner, 2026-08-15: "i feel like it not the same we had in gemini". Part of the answer was that
// every input — identity references included — was pushed through sharp().jpeg({ quality: 95 })
// before upload. Nothing required it: no comment gave a reason, and WaveSpeed accepts PNG, JPEG and
// WebP. It cost a lossy generation of loss on exactly the photos whose job is to pin down a face,
// and the Gemini path being compared against never paid it — it sent the original bytes inline.
check('there is one shared preparer for uploads', ws.includes('async function _prepareUpload(raw)'));
check('PNG passes through untouched', ws.includes("return { buf, ext: '.png' };"));
check('JPEG passes through untouched', ws.includes("return { buf, ext: '.jpg' };"));
check('WebP passes through untouched', ws.includes("return { buf, ext: '.webp' };"));
check('anything else is still converted — an unknown container is worse than a re-encode',
  ws.includes("const converted = await sharp(buf).jpeg({ quality: 95 }).toBuffer();"));
check('and that conversion is logged, so it is never invisible', ws.includes("log.info('wavespeed_input_converted'"));
check('the format is sniffed from magic bytes, not the declared mimeType',
  ws.includes('const is = (sig, at = 0) => sig.every((b, i) => buf[at + i] === b);'));
check('nano2 uses it', ws.includes("return await _uploadPrepared(raw, 'nb2');"));
check('seedream5 uses it too', ws.includes("return await _uploadPrepared(raw, 'sd5');"));
check('neither re-encodes on its own any more',
  !ws.includes("const jpegBuf = await sharp(Buffer.from(raw, 'base64')).jpeg({ quality: 95 }).toBuffer();"));
check('the temp file always gets cleaned up', ws.includes('try { fs.unlinkSync(tempPath); } catch {}'));

// The sniffer, run for real rather than asserted about.
const sniff = (bytes) => {
  const buf = Buffer.from(bytes);
  const is = (sig, at = 0) => sig.every((b, i) => buf[at + i] === b);
  if (buf.length > 8 && is([0x89, 0x50, 0x4e, 0x47])) return '.png';
  if (buf.length > 3 && is([0xff, 0xd8, 0xff])) return '.jpg';
  if (buf.length > 12 && is([0x52, 0x49, 0x46, 0x46]) && is([0x57, 0x45, 0x42, 0x50], 8)) return '.webp';
  return null;
};
check('a PNG signature is recognised', sniff([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]) === '.png');
check('a JPEG signature is recognised', sniff([0xff, 0xd8, 0xff, 0xe0, 0, 0]) === '.jpg');
check('a WebP signature is recognised',
  sniff([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0]) === '.webp');
check('a RIFF that is NOT WebP is not mistaken for one — that would upload a .webp that is not one',
  sniff([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20, 0]) === null);
check('an unknown format falls through to conversion', sniff([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) === null);
check('a truncated file cannot be read past its end', sniff([0x89, 0x50]) === null);

// --- 10. THE ON-RAMP: Eddy actually uses the queue ---------------------------------------------------
// Owner, 2026-08-15: "generate is can click 100 and it send the 100". Until this, the 100-lane
// ceiling was real and unreachable — no page enqueued anything, so every render still held a
// browser socket and Chromium's six-per-host cap decided everything.
const eddy = read('client/src/pages/EddyGeneratePage.jsx');
const wsvc = read('server/services/wavespeedService.js');

check('Seedream 5 has a submit half now', wsvc.includes('async function submitSeedream5Edit('));
check('and the blocking call is built on it', wsvc.includes('const sub = await submitSeedream5Edit(imageInputs, prompt, opts);'));
check('it is exported for the queue', wsvc.includes('submitSeedream5Edit,'));
check('the reconciler can reach it', rec.includes('await wavespeed.submitSeedream5Edit('));

check('Eddy routes through the queue', eddy.includes("import { queuedSeedreamEdit } from '../lib/generationQueue';"));
// Three call sites: nano2, the Seedream fallback, and plain Seedream. Two are wrapped in
// withRateLimitRetry, so they read `() => runEdit(` rather than `await runEdit(`.
check('all three edit call sites go through one router', (eddy.match(/runEdit\(\{/g) || []).length === 3);
check('and none call the blocking route directly any more', !eddy.includes('seedreamApi.edit('));
check('nano2 and seedream5 are both routed', eddy.includes("const model = body.model === 'nano2' ? 'nano2' : 'seedream5';"));
check('tags travel with the job, so a recovered image stays attributable', eddy.includes('tags: body.tags,'));
check('the destination is read from a ref, not a stale closure', eddy.includes('destDb: genDestDbRef.current,'));

// The lane counts were tuned to the socket pool. They are real settings now.
const nano = Number((eddy.match(/const NANO2_PARALLEL_REQUESTS = (\d+);/) || [])[1]);
const seed = Number((eddy.match(/const PARALLEL_REQUESTS = (\d+);/) || [])[1]);
check(`nano2 lanes match the server ceiling (${nano})`, nano >= dflt);
check(`seedream lanes too (${seed})`, seed >= dflt);

// DOUBLE-FILE was the trap: the page files the result itself, so leaving the job unfiled would have
// the boot sweep file it a second time — one generation, two library rows.
const qlib = read('client/src/lib/generationQueue.js');
check('a delivered result claims its own job', qlib.includes('jobsApi.markFiled(jobId)'));
check('before returning, so the sweep can never double-file it',
  qlib.indexOf('jobsApi.markFiled(jobId)') < qlib.indexOf('images: job.images?.length'));
check('and a failed claim costs a duplicate, not a lost picture', qlib.includes('worst case: the sweep files a duplicate'));

// --- 11. AUDIT FINDINGS at 100 lanes -------------------------------------------------------------
// Both of these only appear once batches are large, and both cost money rather than merely looking
// wrong.

// FINDING 1: the client's own wait was shorter than a large queue takes to drain. 167 jobs against
// 100 lanes is two waves; a Nano Banana 2 render is ~3 minutes, so the tail lands around seven. Add
// one rate-limit backoff and the last tiles would have been marked FAILED while their pictures were
// still on the way -- and a failed-looking tile invites a regenerate, which is a second charge for
// an image already paid for.
const waitMs = Number((qlib.match(/WAIT_TIMEOUT_MS = (\d+) \* 60 \* 1000/) || [])[1]);
check(`the caller's wait covers a large batch (${waitMs} min)`, waitMs >= 45);
check('and the job is never abandoned when it does fire', qlib.includes('server keeps working'));

// FINDING 2: Stop ended the client loop but left everything already enqueued for the worker to
// submit. At a hundred lanes that is a lot of spending arriving after the button was pressed.
const jq = read('server/services/jobQueue.js');
check('there is a cancel for unsent work', jq.includes('function cancelQueued(userId)'));
check('it touches QUEUED only — never work already with the provider',
  jq.includes("WHERE user_id = ? AND status = ?") && jq.includes("STATUS.FAILED, 'Cancelled before it was sent — nothing was charged.'"));
check('the reason says plainly that nothing was charged', jq.includes('nothing was charged'));
check('it is exposed', routes.includes("router.post('/cancel-queued'"));
check('and Stop calls it', eddy.includes('jobsApi.cancelQueued()'));
check('Stop reports what it actually saved', eddy.includes('dropped, nothing charged for those'));

// The rule this shares with retry and the orphan sweep: never cancel or resend anything that
// reached the provider. Cancelling it locally does not un-bill it — it only loses the picture.
check('cancel refuses submitted work, matching retry and the orphan sweep',
  !/cancelQueued[\s\S]{0,400}STATUS\.SUBMITTED/.test(jq));

// --- 12. Photo Match SD on the queue, and the bug that came with it ---------------------------------
const pm = read('client/src/pages/PhotoMatchSeedreamPage.jsx');

// CHANGED 2026-08-16: waitForQueuedJob joined the import — the page can now rejoin work the
// server is still doing after a page change, instead of forgetting it.
check('Photo Match SD routes through the queue', pm.includes("import { queuedSeedreamEdit, waitForQueuedJob } from '../lib/generationQueue';"));
check('and no longer calls the blocking route', !pm.includes('seedreamApi.edit('));
// CHANGED 2026-08-16: a third engine. Photo Match NB2 is the same component with variant="nb2",
// running Nano Banana 2 through our bypass on Google's own API instead of WaveSpeed's resale of it.
check('all three engines are named', pm.includes("model: isNB2 ? 'nb2' : engine === 'nano2' ? 'nano2' : 'seedream5',"));
// Pinned `charName.trim()` — the page-wide shared character. Fixed 2026-08-16 to `jobWho`, the
// per-job name, so a multi-character batch tags each result with the character it actually is
// rather than whichever character happened to be first in the run.
check('tags travel, so a recovered match stays attributable', pm.includes("tags: jobWho ? ['eddy', jobWho] : ['eddy'],"));
check('the destination is read from a ref, not a stale closure', pm.includes('destDb: destDbRef.current,'));
const lanes = (pm.match(/LANES = \{ seedream: (\d+), nano2: (\d+) \}/) || []);
check(`its lanes match the server ceiling (${lanes[1]}/${lanes[2]})`, Number(lanes[1]) >= 300 && Number(lanes[2]) >= 300);

// THE BUG THIS INTRODUCED, caught before shipping. Three render sites branched on `job.result`
// being truthy and then read base64Data off it. Fine while every result arrived inline; broken the
// moment one came back through the queue — the object is there, base64Data is not, and the tile
// renders `data:undefined;base64,undefined`. A broken image for a picture that generated perfectly.
check('there is one resolver for what to display', pm.includes('function resultSrc(j)'));
check('it prefers the server copy', pm.includes('const server = urlOfJob(j);'));
check('and falls back to bytes only when there is no server copy', pm.includes("return j.result?.base64Data ?"));
check('no render site builds a data URL from job.result any more', !/job\.result \? `data:/.test(pm));
check('all three sites use it', (pm.match(/resultSrc\(job\)/g) || []).length === 3);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
