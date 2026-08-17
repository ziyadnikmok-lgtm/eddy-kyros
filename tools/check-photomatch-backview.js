// A source photo shot from BEHIND must not come back with her turned around.
//
// THE BUG THIS CLOSES: every other line of the Photo Match prompt demands a face — "match exactly:
// face, head shape, jaw", "render her face sharply", "faces, hair, skin and whole body". Handed a
// back-facing photo, that is an order to produce something the photo does not contain, and an edit
// model resolves it the only way it can: it rotates her toward the camera. The pose the photo was
// chosen for is gone, and the result looks like the page simply ignored the source.
//
// Owner, 2026-08-16: "sometimes face won't appear in the source image and we want that, or model
// face don't appear too." No face in, no face out.
//
// Runs the REAL builder, lifted out of the page — no React, no bundler.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const src = read('client/src/pages/PhotoMatchSeedreamPage.jsx');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// All three module constants are lifted with the function, so this exercises the REAL text.
const nudeLine = /const NUDE_LINE = (`[\s\S]*?`|'[^']*');/.exec(src);
const lightingLine = /const LIGHTING_LINE = ('[^']*');/.exec(src);
const backLine = /const BACK_VIEW_LINE = ([\s\S]*?);\n/.exec(src);
const fnStart = src.indexOf('export function buildMatchInstruction');
const fnEnd = src.indexOf('\n}\n', fnStart) + 3;
// eslint-disable-next-line no-new-func
const build = new Function(
  `const NUDE_LINE = ${nudeLine ? nudeLine[1] : "''"};
   const LIGHTING_LINE = ${lightingLine ? lightingLine[1] : "''"};
   const BACK_VIEW_LINE = ${backLine[1]};
   ${src.slice(fnStart, fnEnd).replace('export function', 'function')}; return buildMatchInstruction;`,
)();

const BASE = {
  characterName: 'Grace', refCount: 4, masterPrompt: '', exactRecreate: false, varyBackground: false,
  allowExpressionChange: false, allowHairChange: false, allowBodyChange: false, allowLightingChange: false,
  faceless: false, wantsNude: false, addGenericNudeLine: false, sourceFaceBlurred: false,
};

// --- off by default, and off means nothing changed ------------------------------------------------
const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures-photomatch-prompt.json'), 'utf8'));
const front = build({ ...BASE, exactRecreate: true });
check('a front photo still gets the face rules', /match exactly: face, head shape, jaw/.test(front));
check('and no back-view line', !/BACK VIEW/.test(front));
// Against the hashes taken before backView existed. Chloe, not Grace: the fixture was generated
// with that name and the name is IN the prompt, so comparing with any other one always differs.
check('backView defaults off — the prompt is unchanged',
  crypto.createHash('sha256').update(build({ ...BASE, characterName: 'Chloe', exactRecreate: true })).digest('hex').slice(0, 16) === pinned.exact);

// --- on: the face rules come OUT, and the direction is pinned ---------------------------------------
const back = build({ ...BASE, exactRecreate: true, faceless: true, backView: true });
check('the shot is declared as taken from behind', /BACK VIEW — HER FACING DIRECTION IS FIXED: image 5 is shot from BEHIND/.test(back));
// The single load-bearing sentence. Without it the model rotates her to satisfy the face rules.
check('she must not be rotated toward the camera',
  /Do NOT turn, twist, rotate or re-angle her toward the camera/.test(back));
check('and her face must not be brought into frame', /do NOT bring her face or chest into frame/.test(back));
check('the pose may not change to make a face visible', /do NOT change the pose to make either visible/.test(back));

check('the identity list no longer demands a face', !/match exactly: face, head shape, jaw/.test(back));
check('but skin, hair and body still come from her references', /match exactly: skin tone, hair, neck, shoulders/.test(back));
check('no face is invented', /Do NOT invent or show a face/.test(back));
// "cropped above the shoulders" is a different composition — it would re-frame a shot we are
// otherwise telling it to reproduce exactly.
check('the final lock says she is facing away, not that she may be cropped',
  back.includes('she is facing away and stays that way') && !back.includes('cropped above the shoulders'));

// Eddy solved this first; both prompts open with the same marker so they read as one rule.
const eddy = fs.readFileSync(path.join(ROOT, 'client/src/pages/EddyGeneratePage.jsx'), 'utf8').replace(/\r\n/g, '\n');
check("Eddy's back-view rule still exists to match", eddy.includes('BACK VIEW — HER FACING DIRECTION IS FIXED'));
check('and Photo Match opens with the same marker', back.includes('BACK VIEW — HER FACING DIRECTION IS FIXED'));
// Deliberately NOT the same string: Eddy's is ~700 chars of bust/outfit scoping that does not exist
// on this page, and importing it would push the identity lock past ByteDance's cap.
check('but Photo Match keeps its own shorter version', backLine[1].length < 400);

// --- it has to FIT, in every combination -------------------------------------------------------------
// Over the cap ByteDance 422s and the batch dies; the caller's backstop slices the tail, which is
// the identity lock.
const CAST = [{ name: 'Arya', from: 1, to: 4 }, { name: 'Rosary', from: 5, to: 8 }];
const COMBOS = {
  'single back': { faceless: true, backView: true, exactRecreate: true },
  'single back nude': { faceless: true, backView: true, wantsNude: true, addGenericNudeLine: true },
  'single back, everything': { faceless: true, backView: true, exactRecreate: true, outfitFromChar: true, sourceFaceBlurred: true, masterPrompt: 'x'.repeat(200) },
  'pair back': { refCount: 8, cast: CAST, faceless: true, backView: true, exactRecreate: true },
  'pair back, everything': { refCount: 8, cast: CAST, faceless: true, backView: true, exactRecreate: true, outfitFromChar: true, lookAtCamera: true, sourceFaceBlurred: true, masterPrompt: 'x'.repeat(200) },
};
for (const [name, opts] of Object.entries(COMBOS)) {
  const out = build({ ...BASE, budget: 3000, ...opts });
  check(`fits the 3000 cap: ${name} (${out.length})`, out.length <= 3000);
  check(`keeps the back-view lock: ${name}`, /BACK VIEW — HER FACING/.test(out));
  check(`keeps the identity lock: ${name}`, out.includes('FINAL — HIGHEST PRIORITY'));
}

// --- the page wiring ------------------------------------------------------------------------------
// THE ORDERING TRAP, and the reason this assertion exists: auto-blur paints over the face and
// reassigns dataUrl. Detect after that and a blurred face reads as NO face, so every face-blurred
// front photo silently becomes a back view — stripping the face rules from the photos that need
// them most. Blur is ON by default, so this would have hit almost every source.
const addBlock = src.slice(src.indexOf('const addSources = useCallback'), src.indexOf('setSources((prev) => [...prev, ...added]);'));
// CHANGED 2026-08-17: one detection now feeds both the blur and the back-view flag, so the order
// is findFace-then-blurFound rather than two independent detector calls. Same invariant: the face is
// found on the ORIGINAL, before any blur, or a blurred-out face reads as no face.
check('the face is detected BEFORE anything is blurred',
  addBlock.indexOf('await findFace(dataUrl)') < addBlock.indexOf('await blurFound(dataUrl, face)'));
check('and the reason is written down', /Detecting after would read a blurred-out face as no/.test(src));

// Aggressive detection, because the two mistakes are not equally expensive: a false "face found"
// means today's behaviour; a false "no face" strips the face rules off a front photo.
// The escalation moved into findFace: strict first, loose only if that finds nothing. The page no
// longer chooses a mode at all, which is why the two answers can never disagree again.
check('detection escalates strict-then-loose inside findFace',
  read('client/src/lib/autoBlurFace.js').includes('const loose = await detectFacePico(dataUrl, { aggressive: true });'));
check('and a detector failure does not take the paste down', addBlock.includes('.catch(() => ({ box: null, present: false }))'));
check('each source carries its own verdict', addBlock.includes('backView: !face.present'));

// Per photo, not per run — the global Faceless switch was all-or-nothing across a mixed batch.
check('the prompt is built per source photo', src.includes('const promptFor = (who, refCount, source) => {'));
check('and the run passes the source in', src.includes('promptFor(item.who, item.who.refs.length, item.src)'));
check('a back shot is treated as faceless', src.includes('faceless: faceless || backView,'));
check('the global Faceless switch still forces it on for everything', src.includes('faceless: faceless || backView,'));

// Never silent: detection is right most of the time, not always.
check('the verdict is shown on the thumbnail', src.includes("{s.backView ? 'Back view' : 'Front'}"));
check('and one click flips it', src.includes('{ ...x, backView: !x.backView }'));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
