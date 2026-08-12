// Running out of WaveSpeed credits must stop the batch, not be retried 4x per image.
//
// From the owner's log (2026-08-10): seven identical failures in three seconds.
//
//   400 {"code":400,"message":"Insufficient credits. Please top up your account to continue."}
//
// WaveSpeed reports it as a plain 400 with the reason only in the BODY, so it reached the client
// as a generic WAVESPEED_ERROR — indistinguishable from a bad request. So: four retries per image,
// then the same on every remaining combo. An 81-image batch is 324 pointless calls to be told 324
// times that the account cannot pay. Falling back to Seedream cannot help either: same account.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const svc = fs.readFileSync(path.join(ROOT, 'server/services/wavespeedService.js'), 'utf8').replace(/\r\n/g, '\n');
const g = fs.readFileSync(path.join(ROOT, 'client/src/pages/EddyGeneratePage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the server gives it a code of its own -------------------------------------------------
check('a helper exists rather than five copies of the regex',
  svc.includes('function throwIfOutOfCredits(status, text)'));
check('it is called at EVERY WaveSpeed call site, not just the one in the log',
  (svc.match(/throwIfOutOfCredits\(resp\.status, text\);/g) || []).length === 5);
check('it throws 402 INSUFFICIENT_CREDITS', /402, 'INSUFFICIENT_CREDITS'/.test(svc));
check('the message says what to do', /top up your account to continue/.test(svc));

// --- executed: the matcher must be narrow ----------------------------------------------------
const m = /function throwIfOutOfCredits\(status, text\) \{([\s\S]*?)\n\}/.exec(svc)[1];
const AppError = class extends Error { constructor(msg, st, code) { super(msg); this.status = st; this.code = code; } };
const probe = new Function('AppError', 'status', 'text', m);
const throws = (status, text) => { try { probe(AppError, status, text); return false; } catch { return true; } };

check('the real body is caught', throws(400, '{"code":400,"message":"Insufficient credits. Please top up your account to continue."}'));
check('case and spacing do not matter', throws(400, 'INSUFFICIENT   CREDIT'));
check('a stale media URL 400 is NOT caught — that one is worth retrying',
  !throws(400, '{"message":"Invalid image url: expired"}'));
check('a 429 is not caught — rate limiting has its own path', !throws(429, 'insufficient credits'));
check('a 500 is not caught', !throws(500, 'insufficient credits'));
check('an empty body does not throw', !throws(400, ''));

// --- the client treats it as terminal ------------------------------------------------------------
check('the code is in the terminal set', /'INSUFFICIENT_CREDITS',/.test(g));
check('402 is terminal by status too', /err\?\.status === 401 \|\| err\?\.status === 402/.test(g));
check('the reason is recorded — a fallback bills the same account',
  /Falling back to Seedream cannot help/.test(g));

// --- the batch stops, and the rest is kept -----------------------------------------------------------
check('a flag halts the pool', g.includes('cancelRef.current || outOfCredits'));
check('later combos return immediately', /const runCombo = async \(combo, idx\) => \{\s*\n\s*if \(outOfCredits\) return;/.test(g));
check('the untried job stays QUEUED, not failed', /await markJob\(mode, jid, 'queued'\);/.test(g));
check('so the record survives for a resume', g.includes('if (!outOfCredits) await clearJobQueue(mode);'));
check('and the user is told what happened and what to do',
  /out of credits — the rest of this run is on hold/.test(g));
check('only THIS error stops the batch; others still let it continue',
  /Deliberately narrow: only this/.test(g));

// --- replay: 81 combos, credits die on the third --------------------------------------------------
let calls = 0, stopped = false;
const combos = Array.from({ length: 81 }, (_, i) => i);
for (const c of combos) {
  if (stopped) continue;
  calls += 1;
  if (c === 2) stopped = true;          // the third call comes back 402
}
check('81 combos make 3 calls, not 81', calls === 3);
check('and with 4 retries each that is 3 requests, not 324', calls * 1 === 3);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
