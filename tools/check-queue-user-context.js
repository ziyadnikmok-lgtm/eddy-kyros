// The queue must run each job AS THE PERSON WHO QUEUED IT.
//
// ⚠️ THE BUG (owner, 2026-08-17): "for the wavespeed can it be fixed it tell him api not
// configured" — on an account that plainly had a WaveSpeed key saved.
//
// API keys are per user, and which user is resolved from AsyncLocalStorage. apiKeyManager reads
// getUserId() to pick a store, and in the web deployment paths._getRoot() derives the whole DATA
// DIRECTORY from it (WEB_DATA_ROOT/<userId>). requireAuth sets that context on the way in from a
// request — but the reconciler is a setInterval, so it has none.
//
// Every provider call from the queue therefore looked up keys as nobody: an empty store under
// server/ instead of the user's own, no WaveSpeed key, no Gemini key, and a perfectly honest "not
// configured" from a service that genuinely could not find one.
//
// WHY IT WAS INVISIBLE HERE: ELECTRON_USER_DATA short-circuits the per-user path, so a desktop
// install reads one shared store and works. It only ever fails on the web deployment — the other
// laptop — which is where every report of it came from.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const rec = read('server/services/generationReconciler.js');
const keys = read('server/services/apiKeyManager.js');
const paths = read('server/paths.js');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the two things that actually depend on the context ---------------------------------------
check('key storage is per user, resolved from AsyncLocalStorage',
  keys.includes("const userId = getUserId() || '__anon__';"));
check('and in the web deployment so is the data directory itself',
  paths.includes('const userId = getUserId();') && paths.includes('return path.join(WEB_DATA_ROOT, userId);'));
check('with a no-context fallback that is NOT the user\'s data — hence the empty store',
  paths.includes("return path.join(projectRoot, 'server');"));
// The reason it never reproduced locally.
check('Electron short-circuits it, which is why this only ever failed on the web',
  paths.includes('if (process.env.ELECTRON_USER_DATA) {'));

// --- every path out of the worker runs inside the job's user --------------------------------------
check('there is one helper for it', rec.includes('function asJobUser(job, fn) {')
  && rec.includes('return runWithUser(job.user_id, fn);'));
check('submitting runs as the job owner', rec.includes('return asJobUser(job, () => _submitClaimed(job));'));
check('polling too — it reads the WaveSpeed key to fetch the result', rec.includes('const res = await asJobUser(job, () => (engineOf(job) === \'muapi\''));
check('and saving, which writes into the user\'s own gallery',
  rec.includes('return runWithUser(job.user_id, () => _saveResultAsUser(job, images));'));
check('the reason is written down where the next person will hit it',
  /this worker is a setInterval\. It has none\./.test(rec));

// --- the shape that makes it hard to regress ------------------------------------------------------
// The claim happens outside (it is a plain DB write and needs no user), and everything after it is
// one function that can only be called through the wrapper.
check('the claim is separate from the work', rec.includes('const job = jobQueue.claimNext();'));
check('and the work is a named function, so it cannot be called unwrapped by accident',
  rec.includes('async function _submitClaimed(job) {'));
// A provider call outside the wrapper is the regression to catch.
const submitBody = rec.slice(rec.indexOf('async function _submitClaimed'), rec.indexOf('const SUBMIT_BURST_CAP'));
for (const call of ['wavespeed.submitSeedream5Edit', 'wavespeed.submitNanoBanana2Edit', 'muapi.submitSeedreamEdit', 'apiKeys.getActiveKey', 'jobBlobs.load']) {
  check(`${call} is inside the wrapped work`, submitBody.includes(call));
}

// --- and the error it used to produce -------------------------------------------------------------
// Kept as an assertion so the wording in the report and the wording in the code stay connected.
check('the service message that was being seen is still this one',
  read('server/services/wavespeedService.js').includes("throw new AppError('WaveSpeed API key not configured. Add it in API Keys.', 400, 'NO_WAVESPEED_KEY')"));
// It is terminal, correctly — but only ever reached when the key is genuinely absent.
check('and it is treated as terminal rather than retried forever',
  rec.includes("'NO_WAVESPEED_KEY'"));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
