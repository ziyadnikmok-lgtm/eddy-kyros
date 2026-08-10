// An unfinished run must survive leaving the page — on every tab, not just Eddy.
//
// Two bugs this locks down, both of which lose a paid run silently:
//
//   1. ONE SHARED KEY. The record lived at 'unfinished' with the mode stored inside it, and a read
//      whose mode did not match returned null. So a Max Outfit run overwrote an unfinished Max
//      Nano one, and each tab then read the other's record and discarded it.
//
//   2. THE RESUME GATE READ `baseImage`. That is the single Main-photo slot. Max Outfit never
//      fills it (its sources ride on each combo) and a multi-base run does not either — so those
//      tabs returned on the first line of the effect and never resumed at all.
const fs = require('fs');
const g = fs.readFileSync('D:/Kyros/app/client/src/pages/EddyGeneratePage.jsx', 'utf8');

// The resume effect's dependency array, isolated so the check below reads THAT list and not
// some other hook's.
const s_deps = (/runRef\.current\?\.\(queued\);[\s\S]{0,400}?\n  \}, \[[^\]]*\]\);/.exec(g) || [''])[0];

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- one record per tab ---------------------------------------------------------------------
check('the key is derived from the mode', g.includes("const jobQueueKey = (mode) => `unfinished:${mode || 'eddy'}`;"));
check('nothing writes the bare shared key any more',
  !/jobQueueStore\.set\(JOB_QUEUE_KEY,/.test(g));
check('markJob is told which tab it is patching', g.includes('async function markJob(mode, jid, status)'));
check('clearJobQueue too', g.includes('async function clearJobQueue(mode)'));
// Counted as 'none of the old shape', not 'exactly N of the new one'. A hard-coded 3 went red
// the moment a fourth status was added (queued, for an out-of-credits hold) -- which is a
// correct change failing a test that was measuring the wrong thing.
check('every markJob call passes the mode',
  (g.match(/await markJob\(mode, jid,/g) || []).length >= 3 && !/await markJob\(jid,/.test(g));
check('every clearJobQueue call passes it', !/await clearJobQueue\(\)/.test(g));
check('the run writes to its own key', g.includes('await jobQueueStore.set(jobQueueKey(mode), {'));

// --- a pre-split record is recovered, not orphaned ----------------------------------------------
check('the old key is still read once', g.includes("const JOB_QUEUE_KEY_LEGACY = 'unfinished';"));
check('and only by the tab it belongs to', /legacy && \(legacy\.mode \|\| 'eddy'\) === mode/.test(g));
check('then migrated so it is not read twice', /await jobQueueStore\.set\(jobQueueKey\(mode\), legacy\);/.test(g));

// --- the resume gate ------------------------------------------------------------------------------
check('the gate asks whether image 1 is available, not whether a slot is filled',
  g.includes('const canResume = maxOutfit || pickedBasePhotos.length > 0 || !!baseImage;'));
check('and the deps it reads are all listed',
  ['loading', 'baseImage', 'maxOutfit', 'pickedBasePhotos', 'mode', 'resolution', 'perRunImages']
    .every((d) => new RegExp('\\}, \\[[^\\]]*\\b' + d + '\\b[^\\]]*\\]\\);').test(s_deps)));

// --- replay: which tabs can resume ------------------------------------------------------------------
const canResume = (maxOutfit, picked, baseImage) => maxOutfit || picked > 0 || !!baseImage;
check('Max Outfit resumes with no slot filled', canResume(true, 0, '') === true);
check('a multi-base Max Nano run resumes with no slot filled', canResume(false, 4, '') === true);
check('plain Eddy still waits for its photo to load', canResume(false, 0, '') === false);
check('...and resumes once it has', canResume(false, 0, 'data:image/png;base64,x') === true);

// --- replay: two tabs keep two records -----------------------------------------------------------
const store = new Map();
const key = (mode) => `unfinished:${mode || 'eddy'}`;
store.set(key('maxNano'), { mode: 'maxNano', jobs: [{ jid: 'a', status: 'queued' }] });
store.set(key('maxOutfit'), { mode: 'maxOutfit', jobs: [{ jid: 'b', status: 'queued' }] });
check('starting a Max Outfit run does not erase the Max Nano one',
  store.get(key('maxNano')).jobs[0].jid === 'a');
check('each tab reads its own', store.get(key('maxOutfit')).jobs[0].jid === 'b');
store.set(key('maxNano'), null);
check('clearing one leaves the other', store.get(key('maxOutfit')) !== null);

// --- RESUMING MUST NEVER SPEND MONEY ON ITS OWN (owner, 2026-08-10) ---------------------------
// It fired automatically, so leaving the page and coming back started a paid run with no click --
// the owner watched images regenerate on a tab switch. An unfinished queue is a reasonable thing
// to OFFER; it is not a reasonable thing to charge for unprompted.
check('the resume asks before spending', /const ok = window\.confirm\(/.test(g));
check('the prompt states the cost', /About \$\$\{\(queued\.length \* each\)\.toFixed\(2\)\}/.test(g));
check('and how many are left', /A run was interrupted with \$\{queued\.length\} image/.test(g));
check('declining CLEARS the queue rather than asking again every visit',
  /if \(!ok\) \{ await clearJobQueue\(mode\); return; \}/.test(g));
check('the cancel wording says what cancel does', /Cancel discards the rest of that run/.test(g));
check('nothing dispatches before the confirm', (() => {
  const i = g.indexOf('const ok = window.confirm(');
  const j = g.indexOf('runRef.current?.(queued)');
  return i > -1 && j > i;
})());
check('the reason is recorded', /Never spend money because a tab was re-opened/.test(g));

// a completed run must leave nothing to resume
check('a finished job is marked done', /await markJob\(mode, jid, 'done'\)/.test(g));
check('and the queue clears at the end of a run', /if \(!outOfCredits\) await clearJobQueue\(mode\);/.test(g));

// --- CHANGING A PHOTO MID-RUN MUST NOT DUPLICATE IT (owner, 2026-08-10) -----------------------
// Two faults together duplicated a paid run: pickedBasePhotos is in the resume effect's deps, so
// picking a different base photo re-fired it; and resumedRef was set only AFTER the early return,
// so a first pass that found no record never armed the guard. Mid-run there IS a record -- the run
// writes its queue up front -- so the effect offered to "resume" jobs that were already in flight.
// \s+ rather than a literal newline: this file is CRLF on disk, so matching "\n" alone fails on
// correct code — a test measuring the checkout's line endings instead of the behaviour.
check('the once-per-mount flag is armed BEFORE the first await',
  /resumedRef\.current = true;\s+let alive = true;/.test(g));
check('and no longer sits after the record check',
  !/if \(!alive \|\| !rec\) return;\s+resumedRef\.current = true;/.test(g));
check('a live run is never treated as something to recover',
  g.includes('|| inFlight > 0) return undefined;'));
check('inFlight is in the deps, so the guard sees the truth',
  g.includes('pickedBasePhotos, inFlight, mode'));
check('the symptom is recorded', g.includes('accepting ran them twice'));

// replay: the exact sequence that duplicated
{
  let resumed = false, prompts = 0;
  const effect = (inFlight, hasRecord) => {
    if (resumed || inFlight > 0) return;
    resumed = true;
    if (hasRecord) prompts += 1;
  };
  effect(0, false);          // mount, nothing outstanding
  effect(12, true);          // a run starts and writes its queue; user picks a new base photo
  effect(12, true);          // ...and another
  check('picking new photos mid-run prompts ZERO times', prompts === 0);
  check('and the flag stayed armed from the first pass', resumed === true);
}
{
  let resumed = false, prompts = 0;
  const effect = (inFlight, hasRecord) => {
    if (resumed || inFlight > 0) return;
    resumed = true;
    if (hasRecord) prompts += 1;
  };
  effect(0, true);           // a genuine interrupted run, nothing in flight
  check('a real interrupted run still offers to resume, exactly once', prompts === 1);
}

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
