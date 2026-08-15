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
check(`its default is above the old browser-bound 6 (${dflt})`, dflt > 6);
check('but NOT the provider maximum of 300 — that is $21-31 fired in one click', dflt < 300);
check('and it is overridable for a deliberate run', rec.includes('process.env.KYROS_MAX_INFLIGHT'));
check('it can never be zero, which would stall the queue silently', rec.includes('Math.max(1, Number(process.env.KYROS_MAX_INFLIGHT)'));

// It counts what is IN FLIGHT, not submissions per tick. A per-tick budget either crawls or
// overshoots depending on render time; "keep N running" is the thing actually being limited.
check('the ceiling counts jobs in flight, not submits per tick',
  rec.includes('const room = Math.max(0, MAX_INFLIGHT - running.length);'));
check('the old per-tick budget is gone', !rec.includes('SUBMITS_PER_TICK'));
check('lanes are filled in parallel — sequential submits would spend the tick uploading',
  /await Promise\.all\(Array\.from\(\{ length: room \}/.test(rec));
check('polling is parallel too — one slow status check must not hold up 23 others',
  /await Promise\.all\(running\.map\(async \(job\)/.test(rec));
check('a throwing submit cannot take the whole tick down', /submitOne\(\)\.catch\(/.test(rec));

// --- 3. THE MONEY RULE still holds at 24 lanes ---------------------------------------------------------
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
check('but is capped, so it cannot back off for an hour', /BACKOFF_MAX_MS = 120_000/.test(rec));
check('a success clears the penalty', (rec.match(/backoffMs = BACKOFF_START_MS;/g) || []).length >= 2);

// --- 5. both providers, one queue -------------------------------------------------------------------------
check('a job knows which provider owns it', rec.includes('function providerOf(job)'));
check('it defaults to the original provider, so old rows keep working',
  rec.includes("return job.payload?.provider === 'wavespeed' ? 'wavespeed' : 'muapi';"));
check('polling branches on it', /providerOf\(job\) === 'wavespeed'\s*\n\s*\? await wavespeed\.pollNanoBanana2/.test(rec));
check('submitting branches on it', /provider === 'wavespeed'\s*\n\s*\? await wavespeed\.submitNanoBanana2Edit/.test(rec));
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

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
