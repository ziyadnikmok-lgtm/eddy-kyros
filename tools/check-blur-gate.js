// Which loose face matches get blurred, and which get thrown away.
//
// TWO FAILURES, IN OPPOSITE DIRECTIONS, A DAY APART:
//
//   2026-08-16 — the aggressive pass (score threshold 15 instead of 50) reported a backside in a
//   bent-over pose. Padded 25% on every side, it smeared a third of the photograph.
//
//   2026-08-17 — the flat 40%-of-frame cap added to stop that then rejected an obvious, large,
//   front-facing selfie head, which came back unblurred saying "no face". A sharp rival face in the
//   source is the single most reliable way to lose the character, so that miss is expensive.
//
// SIZE ALONE CANNOT SEPARATE THEM: a close-up head and a hip blob are both large. POSITION can — a
// face in a photograph of a person is high in the frame, because that is where heads are. So the
// gate rejects on absurd size, or on large-AND-low, and nothing else.
//
// This replays the real constants from the source against the shapes that actually occur. It is
// arithmetic, so it needs no browser — which is the only reason this logic can be tested at all.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const src = read('client/src/lib/autoBlurFace.js');
const det = read('client/src/lib/detectFacePico.js');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const num = (name) => {
  const m = new RegExp(`const ${name} = ([0-9.]+);`).exec(src);
  return m ? Number(m[1]) : null;
};
const ABSURD = num('ABSURD_FRACTION');
const LOW_FRAC = num('LOW_MATCH_FRACTION');
const LOW_CENTRE = num('LOW_CENTRE');

check('the thresholds are declared', ABSURD !== null && LOW_FRAC !== null && LOW_CENTRE !== null);
// The flat cap is what broke a real detection; it must not come back.
check('the flat size cap is gone', !src.includes('MAX_LOOSE_FACE_FRACTION'));
check('the gate is a named rule, not inline in the blur path', src.includes('function looksLikeAFace(box)'));
check('a rejected match reports not-blurred rather than blurring the wrong region',
  src.includes("'loose match was not face-shaped or face-placed'"));
// A strict hit returns before the gate is ever consulted — it exists for the loose threshold only.
check('and the confident pass is never second-guessed',
  src.includes('if (strict) return { box: strict, confident: true, present: true };')
  && src.indexOf('looksLikeAFace(loose)') > src.indexOf('if (strict) return'));

/** The gate, rebuilt from the constants the file actually declares. */
const rejects = (b) => {
  const centreY = b.y + b.h / 2;
  return (b.w > ABSURD || b.h > ABSURD) || (b.h > LOW_FRAC && centreY > LOW_CENTRE);
};

// name, box (fractions of the frame), should it be rejected
const CASES = [
  // The 2026-08-17 miss. A selfie head is enormous in frame and still a face.
  ['a close-up selfie head', { x: 0.30, y: 0.10, w: 0.40, h: 0.38 }, false],
  ['a very tight face crop', { x: 0.20, y: 0.05, w: 0.55, h: 0.55 }, false],
  ['an ordinary portrait head', { x: 0.38, y: 0.12, w: 0.22, h: 0.20 }, false],
  ['a small face in a full-body shot', { x: 0.44, y: 0.08, w: 0.10, h: 0.09 }, false],
  // Low but SMALL — someone lying down. Position alone must not condemn it.
  ['a face low in frame, lying down', { x: 0.30, y: 0.55, w: 0.24, h: 0.22 }, false],
  // The 2026-08-16 false positive: large AND low.
  ['a backside in a bent-over pose', { x: 0.35, y: 0.55, w: 0.45, h: 0.40 }, true],
  ['a hip blob, low and wide', { x: 0.25, y: 0.62, w: 0.40, h: 0.34 }, true],
  ['an absurd whole-frame match', { x: 0.05, y: 0.05, w: 0.85, h: 0.85 }, true],
];
for (const [name, box, want] of CASES) {
  const got = rejects(box);
  check(`${want ? 'rejects' : 'blurs'} ${name}`, got === want);
}

// The two directions, stated as the invariants rather than as examples.
check('a big match HIGH in the frame is kept — that is where heads are',
  !rejects({ x: 0.25, y: 0.05, w: 0.5, h: 0.5 }));
check('the same size LOW in the frame is rejected — that is where hips are',
  rejects({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }));

// --- WHICH detection wins when a photo has more than one -------------------------------------------
//
// ⚠️ THE ONE THAT WAS ACTUALLY BLURRING HER CHEST (owner, 2026-08-17: "sometimes it blur random
// stuff not the face"). The winner was picked by SIZE alone — "biggest wins, the subject's face is
// the large one" — which holds right up until the biggest match is not a face.
//
// Measured over 60 real generated photos: 5 had more than one detection, and in every one of those
// the largest was not the best. The scores are nowhere near each other:
//
//     photo      biggest (what shipped)   best      what the big box actually was
//     037f685c   score   61, 206px        2025      bare chest
//     046f7a4c   score  224, 176px        1896      bikini chest
//     00561834   score  333, 149px        1287      torso in a dress
//     0102c6f9   score   60, 153px         854      chest and neck
//     02d6efb8   score  257,  73px         434      also her face, one pixel smaller
//
// Crops of all five were compared side by side before and after: every one moved from a chest to a
// face, and the box centre moved from 40-45% of frame height to 11-29% — where heads are.
//
// AND NOTE WHERE THIS SITS: it is the STRICT pass. Both other guards — the size/position gate and
// the 256px re-scan — only ever look at LOOSE matches, so neither could have caught it.
const CONFIDENT = Number(/const CONFIDENT_FRACTION = ([0-9.]+);/.exec(det)[1]);
check(`confidence is ranked before size (fraction ${CONFIDENT})`, CONFIDENT > 0 && CONFIDENT < 1);
check('the weak candidates are dropped first', det.includes('const confident = clustered.filter((d) => d[3] >= topScore * CONFIDENT_FRACTION);'));
check('and the biggest of what REMAINS is chosen — the original rule, on real faces only',
  det.includes('confident.sort((a, b) => b[2] - a[2]);') && det.includes('const [rowCentre, colCentre, size] = confident[0];'));
check('the naive size sort is gone', !det.includes('clustered.sort((a, b) => b[2] - a[2]);'));
check('and the measurement is recorded, not just the change', det.includes('bare chest') && det.includes('bikini chest'));
// The threshold has to separate the two groups the measurement found: false picks at 3-26% of the
// best score, and one harmless same-face disagreement at 59%.
check('the fraction rejects every measured false pick', [61 / 2025, 224 / 1896, 333 / 1287, 60 / 854].every((r) => r < CONFIDENT));
check('and keeps the one that was two boxes on the same face', 257 / 434 > CONFIDENT);

// --- both passes must scan the SAME way, differing only in evidence required --------------------
//
// The first pass stepped the window at 0.1 and scaled at 1.1 — a coarse sweep — and that, not the
// score threshold, is what made it miss faces. Measured by running this cascade outside the browser
// on the owner's own photos (2026-08-17):
//
//     photo   coarse+strict   fine+strict
//     SRC2    nothing         410.0   <- eight times the threshold, missed by the sweep alone
//     REF3    nothing         151.7
//     SRC1    nothing          54.7
//
// None of those are weak detections, and each one went to the model with an unblurred rival face.
check('the scan step is the same on both passes', /shiftfactor: 0.05,/.test(det) && !/shiftfactor: aggressive/.test(det));
check('the scale step too', /scalefactor: 1.05,/.test(det) && !/scalefactor: aggressive/.test(det));
check('and the smallest-face floor', det.includes('minsize: Math.round(Math.min(r.w, r.h) * 0.04)'));
check('the ONLY difference is the score threshold', det.includes('const minScore = aggressive ? 15.0 : 50.0;'));
check('and the measurement is recorded, not just the change', det.includes('coarse+strict'));

// --- one detection per photo, feeding both answers ------------------------------------------------
// Adding a source ran the detector three times — a loose back-view check, a strict blur pass and a
// loose one — each decoding and sweeping eight rotations before the thumbnail appeared. They could
// also disagree, since the back-view check was loose and ungated while the blur was strict.
const blurLib = read('client/src/lib/autoBlurFace.js');
const page = read('client/src/pages/PhotoMatchSeedreamPage.jsx');
check('there is one entry point that finds the face', blurLib.includes('export async function findFace(dataUrl)'));
check('strict first, loose only if that finds nothing', blurLib.indexOf('aggressive: false') < blurLib.indexOf('aggressive: true'));
check('a confident hit skips the gate entirely', blurLib.includes('if (strict) return { box: strict, confident: true, present: true };'));
// A rejected loose match still means a face is probably there — it just is not this box. So the
// shot is not a back view, even though nothing was blurred.
check('a gated-out match still counts as a face being present',
  blurLib.includes('present: true, rejected: true'));
// CHANGED 2026-08-17: the per-photo work moved onto a worker pool (~945ms of sweep each; 500 photos
// on the main thread is eight frozen minutes). The main-thread path below is now the FALLBACK for a
// photo no worker could take, and it still detects once and reuses the result.
check('the main-thread fallback detects once and reuses it', page.includes('const face = await findFace(incoming)')
  && page.includes('await blurFound(incoming, face)'));
check('and the back-view flag comes from that same result', page.includes('backView: !r.present'));
check('the page no longer calls the detector itself', !page.includes("from '../lib/detectFacePico'"));

// --- the worker must run the SAME detection, or the two paths disagree per photo ------------------
// A photo that lands on a worker and the same photo that falls back must get the same verdict, so
// the sweep is imported rather than copied. The gate constants ARE duplicated in the worker (they
// sit beside blurRegion's DOM canvas, which a worker cannot load) — hence these assertions.
const worker = read('client/src/lib/faceWorker.js');
check('the worker imports the sweep instead of copying it',
  worker.includes("from './detectFacePico'") && worker.includes('sweepPlane') && worker.includes('greyscalePlane'));
check('and the sweep is exported as DOM-free for exactly that reason',
  det.includes('export function sweepPlane(grey, w, h, aggressive = false)'));
for (const name of ['ABSURD_FRACTION', 'LOW_MATCH_FRACTION', 'LOW_CENTRE']) {
  const inWorker = new RegExp(`const ${name} = ([0-9.]+);`).exec(worker);
  check(`the worker's ${name} matches the page's`, inWorker && Number(inWorker[1]) === num(name));
}
check('the worker escalates strict-then-loose too',
  worker.indexOf('sweepPlane(grey, w, h, false)') < worker.indexOf('sweepPlane(grey, w, h, true)'));
check('it pads the box by the same amount', worker.includes('const grow = 0.25;'));
check('and blurs by destroying the pixels, not softening them', worker.includes('Math.round(w / 24)'));
check('a worker that cannot run means the main thread does it, never a skipped photo',
  page.includes('fallback: onMainThread'));

// --- dropping a photo must work anywhere on the page ------------------------------------------------
// Paste was bound to the window and drop only to the dashed box, which scrolls out of view as soon
// as the page has content — so pasting worked everywhere and dragging almost nowhere.
check('drop is handled at the window, like paste', page.includes("window.addEventListener('drop', onDrop)"));
// Without preventDefault on dragover the drop event never fires at all.
check('and dragover is prevented, or no drop event is delivered',
  page.includes("window.addEventListener('dragover', onDragOver)"));
check('a browser drag, which carries a URL and no file, says so instead of doing nothing',
  page.includes("getData('text/uri-list')"));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
