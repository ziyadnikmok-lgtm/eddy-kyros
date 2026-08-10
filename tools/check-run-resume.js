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

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- one record per tab ---------------------------------------------------------------------
check('the key is derived from the mode', g.includes("const jobQueueKey = (mode) => `unfinished:${mode || 'eddy'}`;"));
check('nothing writes the bare shared key any more',
  !/jobQueueStore\.set\(JOB_QUEUE_KEY,/.test(g));
check('markJob is told which tab it is patching', g.includes('async function markJob(mode, jid, status)'));
check('clearJobQueue too', g.includes('async function clearJobQueue(mode)'));
check('every markJob call passes it', (g.match(/await markJob\(mode, jid,/g) || []).length === 3
  && !/await markJob\(jid,/.test(g));
check('every clearJobQueue call passes it', !/await clearJobQueue\(\)/.test(g));
check('the run writes to its own key', g.includes('await jobQueueStore.set(jobQueueKey(mode), {'));

// --- a pre-split record is recovered, not orphaned ----------------------------------------------
check('the old key is still read once', g.includes("const JOB_QUEUE_KEY_LEGACY = 'unfinished';"));
check('and only by the tab it belongs to', /legacy && \(legacy\.mode \|\| 'eddy'\) === mode/.test(g));
check('then migrated so it is not read twice', /await jobQueueStore\.set\(jobQueueKey\(mode\), legacy\);/.test(g));

// --- the resume gate ------------------------------------------------------------------------------
check('the gate asks whether image 1 is available, not whether a slot is filled',
  g.includes('const canResume = maxOutfit || pickedBasePhotos.length > 0 || !!baseImage;'));
check('and it is in the deps, or it reads a stale value',
  /\}, \[loading, baseImage, maxOutfit, pickedBasePhotos, mode, notify\]\);/.test(g));

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

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
