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
const src = fs.readFileSync(path.join(ROOT, 'client/src/lib/autoBlurFace.js'), 'utf8').replace(/\r\n/g, '\n');

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
check('the gate only applies to the LOOSE pass', src.includes('if (aggressive) {'));
check('a rejected match reports not-blurred rather than blurring the wrong region',
  src.includes("blurred: false, reason: 'loose match was not face-shaped or face-placed'"));
check('and the confident pass is never second-guessed',
  src.indexOf('if (aggressive) {') > src.indexOf('const found = await detectFacePico'));

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

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
