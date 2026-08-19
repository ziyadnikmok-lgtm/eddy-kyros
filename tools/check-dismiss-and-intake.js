// A dismissed failure must STAY dismissed, and one photo must not freeze the window.
//
// Owner, 2026-08-19: "everytime refresh i click clear but it disappear but when it refresh it come
// back", and "photo match sd i cant drag or paste image and it slow".
//
// Both were the same shape of bug: the visible action worked and the thing behind it did not.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const pm = read('client/src/pages/PhotoMatchSeedreamPage.jsx');
const api = read('client/src/services/api.js');
const route = read('server/routes/jobs.js');
const queue = read('server/services/jobQueue.js');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- why it came back ---------------------------------------------------------------------------
// The resume effect reads every failed row from the server on load. That is correct and stays —
// the tile has to be the thing that goes, at the source.
check('the resume still reads failed rows back', pm.includes('const failed = mineOnly(list.failed);'));
check('which is exactly why a dismiss has to delete the row',
  /the resume effect reads every failed row back/i.test(pm));

// --- one tile, one row ----------------------------------------------------------------------------
check('the per-tile dismiss deletes its server row', pm.includes('jobsApi.deleteFailed(job.jobId)'));
check('and only when the tile HAS a row — a local-only tile has no jobId', pm.includes('if (job?.jobId)'));
check('the tile goes even if the call fails', /the tile is gone either way/.test(pm));
check('the api exposes it', api.includes("deleteFailed: (id) => request(`/jobs/failed/${id}`, { method: 'DELETE' })"));
check('the route exists', route.includes("router.delete('/failed/:id'"));
// Express matches in order: '/:id' would swallow '/failed/:id' if it came first.
check('and is declared BEFORE the /:id route, or it would never be reached',
  route.indexOf("router.delete('/failed/:id'") < route.indexOf("router.get('/:id'"));
check('the reason that ordering matters is written down', /Express would match this path against/.test(route));

// --- what it is allowed to delete ------------------------------------------------------------------
check('one-row delete is FAILED-only and scoped to the owner',
  queue.includes("DELETE FROM generation_jobs WHERE id = ? AND user_id = ? AND status = ?")
  && queue.includes('.run(id, userId, STATUS.FAILED)'));
// Verified against a copy of the real database on 2026-08-19: a done row removes 0, a failed row
// removes 1, and the same id under another user removes 0.
check('a queued or running job cannot be cancelled by a dismiss button',
  // The comment wraps, so match across the newline rather than on one line.
  /A queued or running job is not something a dismiss[\s\S]{0,20}button should be able to cancel/.test(queue));

// --- the bulk one must not empty another page ------------------------------------------------------
// Measured when reported: 7 failed on photoMatchNB2 and 20 on eddy, one button deleting all 27.
check('deleteAllFailed takes a feature', queue.includes('function deleteAllFailed(userId, feature = null)'));
check('and filters on it when given one',
  queue.includes('DELETE FROM generation_jobs WHERE user_id = ? AND status = ? AND feature = ?'));
check('no feature still means the whole account, for any caller that means that',
  /Omitting the feature keeps the old behaviour/.test(queue));
check('the route passes the query through', route.includes("req.query.feature === 'string'"));
check('the api sends it', api.includes('deleteAllFailed: (feature) =>'));
check('and the page sends ITS feature', pm.includes('jobsApi.deleteAllFailed(FEATURE)'));

// --- the QUEUE BAR needs its own dismiss ---------------------------------------------------------
// Owner, 2026-08-19: "i click clear and still show". The per-tile x and the results panel both
// delete their rows — but the bar at the top of the page that reads "27 FAILED" only ever offered
// Retry. Nothing there could clear anything, so the count survived every refresh regardless.
const panel = read('client/src/components/GenerationQueuePanel.jsx');
check('the queue bar has a dismiss', panel.includes('const dismissAll = async () => {'));
check('and it calls the delete, not the retry', panel.includes('await jobsApi.deleteAllFailed();'));
check('the button is rendered beside Retry', panel.includes('`Dismiss ${counts.failed}`'));
// Account-wide here on purpose: this bar's counts are account-wide (27 = 7 Photo Match + 20 Eddy),
// so a feature-scoped dismiss would leave a number that does not match its own button.
check('account-wide, matching the count it sits next to',
  panel.includes('jobsApi.deleteAllFailed();') && !panel.includes('deleteAllFailed(FEATURE)'));
check('why it is account-wide is written down', /this bar's counts are account-wide/.test(panel));
check('it reports what it removed rather than assuming', panel.includes("`${n} failed job${n === 1 ? '' : 's'} dismissed`"));
check('and reloads so the count updates', panel.split('const dismissAll')[1].slice(0, 600).includes('await load();'));

// --- one photo goes to a worker --------------------------------------------------------------------
// ~945ms of cascade sweep per photo, benchmarked over 25 real photos. On the main thread that is a
// frozen window at exactly the moment you drop something in.
check('the single-photo exclusion is gone', !pm.includes('poolAvailable() && take.length > 1'));
check('and from the re-scan path too', !pm.includes('poolAvailable() && targets.length > 1'));
check('intake uses the pool whenever there is one', pm.includes('const useWorkers = poolAvailable();'));
check('both paths do', (pm.match(/const useWorkers = poolAvailable\(\);/g) || []).length === 2);
check('the pool is warmed on mount so the first paste does not pay startup',
  pm.includes('useEffect(() => { poolAvailable(); }, []);'));
check('the cost that made this matter is recorded', /945ms/.test(pm));
// runBatch has always handled a batch of one — the guard was excluding it for no reason.
const pool = read('client/src/lib/facePool.js');
check('runBatch has no minimum batch size', pool.includes('await Promise.all(dataUrls.map(async (url, i) => {')
  && !/dataUrls\.length < 2/.test(pool));
// The fallback must survive: no environment gets a silently unprocessed photo.
check('a photo the worker cannot take still goes to the main thread', pm.includes('fallback: onMainThread'));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
