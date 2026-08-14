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
const markIdx = rec.indexOf('jobQueue.markSubmitted(job.id, taskId)');
check('the worker records the task id immediately after Muapi accepts', submitIdx > -1 && markIdx > submitIdx);
check('a send failure requeues only when nothing reached Muapi', rec.includes('jobQueue.requeueUnsent(job.id)'));
check('and is failed outright if it cannot be requeued', /if \(!back\) jobQueue\.markFailed\(/.test(rec));
check('orphans are swept BEFORE the first pass', rec.indexOf('resolveOrphans()') < rec.indexOf('runOnce().catch'));
check('submitted jobs are POLLED, never resubmitted',
  rec.includes('for (const job of jobQueue.listResumable())') && !/listResumable[\s\S]{0,400}submitSeedreamEdit/.test(rec));

// --- 3. done is never recorded without a picture ---------------------------------------------------------
check('no gallery id means FAILED, not done', rec.includes("jobQueue.markFailed(job.id, 'Saved image but the gallery returned no id')"));
check('an empty output means failed too', rec.includes("'Seedream reported success but returned no image'"));
check('markDone is only reached with an id', rec.indexOf('if (!galleryId)') < rec.indexOf('jobQueue.markDone(job.id, galleryId)'));

// --- 4. one reconcile per task ------------------------------------------------------------------------------
// The video side records what this costs when it is missing: two passes both see "not done", both
// download and both bill.
check('concurrent polls share one promise', rec.includes('const inFlight = new Map()'));
check('and the entry is always cleaned up', /\.finally\(\(\) => inFlight\.delete\(job\.task_id\)\)/.test(rec));
check('a stale task is eventually abandoned rather than polled forever', rec.includes('STALE_AFTER_MS'));
check('submits are throttled to one per tick — these are billed calls', rec.includes('SUBMITS_PER_TICK = 1'));
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

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
