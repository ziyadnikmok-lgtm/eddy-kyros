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
const det = read('client/src/lib/detectFacePico.js');
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
check('the page detects once and reuses it', page.includes('const face = await findFace(dataUrl)')
  && page.includes('await blurFound(dataUrl, face)'));
check('and the back-view flag comes from that same result', page.includes('backView: !face.present'));
check('the page no longer calls the detector itself', !page.includes("from '../lib/detectFacePico'"));

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
