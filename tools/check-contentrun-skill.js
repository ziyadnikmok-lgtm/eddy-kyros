// The contentrun skill must not tell anyone something the code does not do.
//
// A skill is documentation that gets FOLLOWED rather than read, so a stale line in it is worse than
// a stale comment: someone acts on it. This pins the claims that would waste a batch if they drifted
// — the lane ceiling, which pages are on the queue, which way the randomiser chips run, and that
// every command it hands out exists.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const skill = read('.claude/skills/contentrun/SKILL.md');
const rec = read('server/services/generationReconciler.js');
const eddy = read('client/src/pages/EddyGeneratePage.jsx');
const pm = read('client/src/pages/PhotoMatchSeedreamPage.jsx');

// --- it is a valid skill --------------------------------------------------------------------------
check('has frontmatter', /^---\n[\s\S]*?\n---/.test(skill));
check('is named contentrun', /^name: contentrun$/m.test(skill));
// The description is the only thing that decides whether the skill gets invoked, so it has to carry
// the words someone would actually say.
const desc = (skill.match(/^description: "(.+)"$/m) || [])[1] || '';
check('has a description', desc.length > 40);
for (const phrase of ['content run', 'mass generation', 'outfit folder', 'pose tag']) {
  check(`the description carries "${phrase}", so it triggers on real wording`, desc.toLowerCase().includes(phrase));
}

// --- every command it hands out exists ----------------------------------------------------------------
for (const tool of ['tools/preflight.js', 'tools/export-to-folders.js']) {
  check(`${tool} exists`, fs.existsSync(path.join(ROOT, tool)));
  check(`the skill names ${path.basename(tool)}`, skill.includes(path.basename(tool)));
}

// --- claims that would waste a batch if they went stale -------------------------------------------------
const lanes = Number((rec.match(/KYROS_MAX_INFLIGHT\) \|\| (\d+)/) || [])[1]);
check(`the skill quotes the real lane ceiling (${lanes})`, skill.includes(String(lanes)));
check('and names the env var that changes it', skill.includes('KYROS_MAX_INFLIGHT'));

// The single most damaging thing it could get wrong: the chips EXCLUDE. Telling someone to tick
// "front" to get front poses does the exact opposite of what they wanted, for a whole batch.
check('it says the randomiser chips EXCLUDE', /chips EXCLUDE/i.test(skill));
check('and the code agrees — ticking a chip removes those poses',
  read('client/src/lib/poseRandomiser.js').includes('THE CHIPS ARE EXCLUSIONS'));

// Cross product. 20 poses x 5 outfits is 100 images, and people read it as 20.
check('it warns that Eddy is a cross product', /cross product/i.test(skill));
check('and the page really does multiply them', eddy.includes('outfits x poses') || eddy.includes('outfits × poses') || eddy.includes('cross product'));

// Which pages are on the queue — if this drifts, the skill promises throughput a page cannot deliver.
check('it claims Eddy is on the queue', /Eddy.*on the queue/i.test(skill));
check('and Eddy actually is', eddy.includes('queuedSeedreamEdit') && !eddy.includes('seedreamApi.edit('));
check('it claims Photo Match SD is too', /Photo Match SD/i.test(skill));
check('and it actually is', pm.includes('queuedSeedreamEdit') && !pm.includes('seedreamApi.edit('));

// Behaviour it promises about closing the app and Stop.
check('it says closing the app is safe', /Closing the app is safe/i.test(skill));
check('and the queue really resumes on boot', rec.includes('startGenerationReconciler'));
check('it says Stop cancels only unsent work', /Stop.*cancels only what has not been sent/is.test(skill));
check('and cancel really is queued-only', read('server/services/jobQueue.js').includes('function cancelQueued(userId)'));
check('it says images land as each one finishes', /as each one finishes/i.test(skill));

// --- preflight really checks what the skill says it does ------------------------------------------------
const pre = read('tools/preflight.js');
check('preflight compares build age to source', pre.includes('the build is OLDER than the source'));
check('preflight detects a page still on the blocking route', pre.includes('still calls the blocking route'));
check('preflight runs the check suites', pre.includes('check suites'));
check('preflight exits non-zero on a FIX, so it can gate a run', pre.includes('process.exit(bad ? 1 : 0)'));
check('and FIX vs NOTE is the documented gate', /`FIX` lines block the run/.test(skill));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
