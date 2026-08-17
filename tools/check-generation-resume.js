// Resuming a Seedream render across an app restart — the worker, the routes and the client half.
//
// The bug being closed: a render was awaited inside one HTTP request, and the Muapi request_id
// lived only in that stack frame. Close the app mid-render and the picture was gone — except it
// was not, because Muapi had already made it and already billed for it. videoReconciler solved
// exactly this for video and says so in its own header ("generation must not depend on a browser
// tab staying mounted"); this is the image half, deliberately built to the same shape.
//
// The assertions that matter are about MONEY, not plumbing:
//   * a job that reached Muapi is polled, never resent
//   * the task id is written down BEFORE the render is waited on
//   * a job is never marked done without a gallery id — done-with-no-id is a picture nobody can
//     reach, and the client files by that id
//   * the client marks a job filed only AFTER the library write succeeds
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const muapi = read('server/services/muapiService.js');
const rec = read('server/services/generationReconciler.js');
const routes = read('server/routes/jobs.js');
const index = read('server/index.js');
const qlib = read('client/src/lib/generationQueue.js');
const app = read('client/src/App.jsx');

// --- 1. submit and poll are separable ------------------------------------------------------------
// While they were one function, there was no way to record the id before the wait — which is the
// entire reason a closed app lost the picture.
check('submitSeedreamEdit exists on its own', muapi.includes('async function submitSeedreamEdit('));
check('and returns the task id', /return \{ taskId \};/.test(muapi));
check('pollSeedreamEdit checks once without waiting', muapi.includes('async function pollSeedreamEdit(taskId)'));
check('a failed task is an ANSWER, not a throw — the queue records it',
  /return \{ status: 'failed', error: res\.error \|\| 'unknown error' \};/.test(muapi));
check('processing is reported plainly', muapi.includes("return { status: 'processing' };"));
check('both are exported', muapi.includes('submitSeedreamEdit,') && muapi.includes('pollSeedreamEdit,'));

// The blocking call must still behave exactly as before — every existing page depends on it.
check('generateSeedreamEdit still exists and still awaits a result', muapi.includes('async function generateSeedreamEdit('));
check('it is now built on the two halves', /const \{ taskId \} = await submitSeedreamEdit\(/.test(muapi));
check('it still throws on failure, as its callers expect', /throw new AppError\(`Seedream edit failed: \$\{res\.error\}`/.test(muapi));
check('it still times out rather than hanging', muapi.includes("'Seedream edit timed out after 3 minutes'"));
check('onTaskId lets a caller record the id before the wait', muapi.includes("if (typeof opts.onTaskId === 'function')"));
check('and a throw in that callback cannot sink a live render',
  /try \{ opts\.onTaskId\(taskId\); \} catch \{[^}]*\}/.test(muapi));

// --- 2. THE MONEY RULE: recorded before waited on -----------------------------------------------------
const submitIdx = rec.indexOf('await muapi.submitSeedreamEdit(');
const markIdx = rec.indexOf('jobQueue.markSubmitted(job.id, sub.taskId)');
check('the worker records the task id immediately after the provider accepts', submitIdx > -1 && markIdx > submitIdx);
check('a send failure requeues only when nothing reached Muapi', rec.includes('jobQueue.requeueUnsent(job.id)'));
check('and is failed outright if it cannot be requeued', /if \(!back\) jobQueue\.markFailed\(/.test(rec));
check('orphans are swept BEFORE the first pass', rec.indexOf('resolveOrphans()') < rec.indexOf('runOnce().catch'));
// The invariant, asserted at its source rather than by text proximity: the ONLY way submitOne
// gets a job is claimNext, and claimNext only ever returns a row whose status is queued. So a
// submitted job cannot reach a submit call however runOnce is later restructured.
check('the only job a submit can reach comes from claimNext',
  /async function submitOne\(\) \{[\s\S]{0,200}const job = jobQueue\.claimNext\(\);/.test(rec));
check('and claimNext only ever claims a QUEUED row',
  read('server/services/jobQueue.js').includes("WHERE status = ? ORDER BY created_at LIMIT 1")
  && read('server/services/jobQueue.js').includes('WHERE id = ? AND status = ?'));
check('resumable jobs go to the poller', /running\.map\(async \(job\)[\s\S]{0,200}await pollJob\(job\)/.test(rec));

// --- 3. done is never recorded without a picture ---------------------------------------------------------
check('no gallery id means FAILED, not done', rec.includes("jobQueue.markFailed(job.id, 'Saved image but the gallery returned no id')"));
check('an empty output means failed too', rec.includes("'The provider reported success but returned no image'"));
// Reworded 2026-08-15 when the save path started keeping EVERY image: the guard is now on the
// collected list, but the rule is unchanged — nothing is marked done without at least one id.
const guardIdx = rec.indexOf('if (!ids.length) {');
const doneIdx = rec.indexOf('jobQueue.markDone(job.id, rows)');
check('markDone is only reached with at least one id', guardIdx > -1 && doneIdx > guardIdx);

// --- 4. one reconcile per task ------------------------------------------------------------------------------
// The video side records what this costs when it is missing: two passes both see "not done", both
// download and both bill.
check('concurrent polls share one promise', rec.includes('const inFlight = new Map()'));
check('and the entry is always cleaned up', /\.finally\(\(\) => inFlight\.delete\(job\.task_id\)\)/.test(rec));
check('a stale task is eventually abandoned rather than polled forever', rec.includes('STALE_AFTER_MS'));
// Replaced by a real ceiling on 2026-08-15: a per-tick budget either crawls or overshoots
// depending on render time, whereas "keep N in flight" limits the thing that actually costs money.
check('submits are bounded by an in-flight ceiling — these are billed calls',
  rec.includes('const MAX_INFLIGHT =') && rec.includes('MAX_INFLIGHT - running.length'));
check('the timer is unref\'d so it cannot hold the process open', rec.includes('if (timer.unref) timer.unref()'));

// --- 5. the routes are scoped to their owner ----------------------------------------------------------------
// A job carries a paid-for picture. Leaking one across accounts leaks the work and lets someone
// else mark it filed, which hides it from whoever paid.
check('an unauthenticated caller is refused', routes.includes("throw new AppError('Not signed in', 401, 'UNAUTHENTICATED')"));
check('reading a job checks ownership', routes.includes('if (!job || job.user_id !== userId)'));
check('and reports the same 404 either way, so ids cannot be probed',
  /user_id !== userId\) throw new AppError\('No such job', 404/.test(routes));
check('marking filed is scoped by user in the query itself', read('server/services/jobQueue.js').includes('WHERE id = ? AND user_id = ?'));
check('the payload is never returned — it holds the source images', !routes.includes('payload: job.payload'));
check('enqueue validates it has something to render', routes.includes('"payload.images" must hold at least one source image'));

// --- 6. it is actually wired in --------------------------------------------------------------------------------
check('the routes are mounted', index.includes("app.use('/api/jobs', jobsRouter)"));
check('the reconciler starts at boot', index.includes("require('./services/generationReconciler').startGenerationReconciler()"));
check('it starts alongside the video one, not instead of it', index.includes('startVideoReconciler()'));
check('the queue is NOT behind the generate rate limiter',
  !/app\.use\('\/api\/jobs', generateLimiter/.test(index));

// --- 7. the client half ----------------------------------------------------------------------------------------
check('queuedSeedreamEdit awaits a finished result, like the call it replaces', qlib.includes('export async function queuedSeedreamEdit('));
check('a timeout is reported as still-running, not as a failure', qlib.includes('class QueuedJobStillRunning'));
check('a blip in the status check does not fail the render', /catch \{\s*continue;/.test(qlib));
check('a failed job throws with its reason', qlib.includes("if (job.status === 'failed') throw new Error(job.error"));

check('the boot pass files what finished while away', qlib.includes('export async function reconcileUnfiled('));
check('each job goes to the destination it was STARTED with', qlib.includes("createEddyCollection(job.destDb || 'eddy-library')"));
// The order here is the whole correctness argument: filed-but-not-written is invisible forever,
// unwritten-and-unfiled is simply retried.
const writeIdx = qlib.indexOf('await fileIntoLibrary(');
const filedIdx = qlib.indexOf('await jobsApi.markFiled(job.id)');
check('it marks filed only AFTER the library write succeeds', writeIdx > -1 && filedIdx > writeIdx);
check('a failed write leaves the job unfiled for the next load', /catch \{[\s\S]{0,120}failed \+= 1;/.test(qlib));
check('being signed out or offline is silent, not an error', qlib.includes('return { filed: 0, failed: 0 };'));

check('the app runs the boot pass', app.includes('reconcileUnfiled()'));
check('only once signed in', /if \(!currentUser\) return undefined;/.test(app));
check('and says nothing when there was nothing to collect', app.includes('if (cancelled || (!filed && !failed)) return;'));
check('bookkeeping can never block the app', /\.catch\(\(\) => \{ \/\* never block the app on bookkeeping \*\/ \}\)/.test(app));

// --- 7. a queued result is saved AS THE JOB'S OWNER ------------------------------------------------
//
// getUserId() is AsyncLocalStorage, set by requireAuth on the way in from a request. The reconciler
// is a setInterval tick, so there is no request and the store is empty — every service that scopes
// by user saw '__anon__'.
//
// What that looked like on 2026-08-16: galleryManager keeps its entries in a PER-USER in-memory
// store, so a queued render wrote its file correctly, appended its entry to the ANONYMOUS store and
// persisted it, while the browser — authenticated as the real user — looked the id up in its own
// store, missed, and answered 404. The picture sat on disk at full size the whole time and the
// Library showed 'Image not on this machine'. It also risked the reverse: the user's state writing
// its own snapshot back over gallery.json and dropping the worker's entries entirely.
check('a queued result is saved as the job owner, not as nobody',
  rec.includes('return runWithUser(job.user_id, () => _saveResultAsUser(job, images));'));
check('using the helper the codebase already has for acting as a user',
  rec.includes("const { runWithUser } = require('../userContext');"));
// Wrapped at the definition, so neither the poller nor the submit path can forget it.
// CHANGED 2026-08-17: there are now TWO wrappers, and that is the fix rather than a regression —
// saving was wrapped, submitting and polling were not, so the worker looked up API keys as nobody
// and reported "WaveSpeed API key not configured" on an account that had one. Both go through a
// named helper; check-queue-user-context.js is the suite that holds that shape.
check('wrapped at the definition, never ad hoc at a call site',
  rec.includes('function asJobUser(job, fn) {')
  && rec.split('runWithUser(job.user_id').length - 1 === 2);
check('and the failure it fixes is recorded', /Image not on this machine/.test(rec));

// --- 8. the page can REJOIN work it walked away from ------------------------------------------------
//
// Leaving Photo Match unmounts the component and every promise awaiting a render goes with it. The
// work does not stop — it is on the durable queue, the server finishes it and bills it — but the
// panel forgot it existed, so coming back showed an empty page while paid pictures completed
// invisibly (owner, 2026-08-16: 'when leave page it stop showing the generated').
const pmPage = read('client/src/pages/PhotoMatchSeedreamPage.jsx');
check('the waiting loop can be reached by job id', qlib.includes('export async function waitForQueuedJob(jobId'));
// One loop, not two: enqueue-and-wait and rejoin-by-id must not drift apart.
check('and enqueue uses that same loop', qlib.includes('return waitForQueuedJob(jobId, { signal });'));
check('the page asks the server what is still running', pmPage.includes('await jobsApi.list()'));
check('and rejoins each one', pmPage.includes('waitForQueuedJob(j.id)'));
// Per tab, or the two tabs adopt each other's work. The model cannot tell them apart: an NB2 job
// that falls back runs on seedream5 and would then look like an SD job.
check('scoped to THIS tab, by feature', pmPage.includes("const FEATURE = variant === 'nb2' ? 'photoMatchNB2' : 'photoMatchSeedream';"));
check('and the enqueue uses it', pmPage.includes('feature: FEATURE,'));
check('resume runs only after the saved panel is restored, so it cannot race it',
  pmPage.includes('if (!jobsRestored) return;'));

// One filing path for the live run, the resume and the retry — a recovered picture must land in the
// same collection, folder and shape as one watched all the way through.
check('filing is one shared function', pmPage.includes('const filePicture = useCallback(async (first, who, usedPrompt)'));
// CHANGED 2026-08-16: the PROMPT travels with the picture now. The library row carried only the
// label 'Photo Match - <her>', so the instruction that actually made the image — every chip, every
// lock, the identity rules — was gone once the run ended and Copy had nothing to copy.
// CHANGED 2026-08-16: filed under WHOSE picture it is, not the head of the ticked list — runOne
// runs once per source x character and was reading the page-level charName for all of them.
check('the live run uses it, and passes the prompt it sent', pmPage.includes('await filePicture(first, whoName, prompt);'));
check('the resume uses it', pmPage.includes("await filePicture(first, j.destFolder || '', j.cardPrompt || '');"));
check('and no inline copy was left behind', !pmPage.includes("ensureFolder(who || 'Photo Match')"));

// The retry endpoint has existed since the queue was built; the page just never offered it, so
// recovering one failed picture meant re-running the whole batch.
check('failed jobs can be run again from the panel', pmPage.includes('await jobsApi.retry(t.jobId);'));
check('and the button only appears when there is something to retry',
  pmPage.includes('{failedJobs.length > 0 && ('));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
