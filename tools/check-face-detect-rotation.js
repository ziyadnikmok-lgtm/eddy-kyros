// Finding a face that is not sitting upright and looking at the lens.
//
// WHY (owner, 2026-08-15: "the auto face blur need more work he dont auto face detect face"):
// pico's cascade is trained on UPRIGHT, FRONTAL faces and has no rotation search of its own. Run
// once on the original it finds a straight-to-camera portrait and misses nearly everything else —
// which, in a real library, is most of it. Mirror selfies tilt the head, lying-on-a-bed shots are
// effectively sideways, over-the-shoulder poses lean, and an upside-down shot is 180 degrees off.
// Every one of those returned "no face found" on an image that obviously contains a face.
//
// The geometry is the part worth testing, and it is testable without a browser: a hit found in a
// rotated plane must map back to the RIGHT place in the original, or the blur lands on a shoulder
// while the face stays visible — which is worse than not blurring at all, because it looks handled.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const src = read('client/src/lib/detectFacePico.js');
const blur = read('client/src/lib/autoBlurFace.js');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// Lift the two pure geometry helpers — no canvas, no cascade, no DOM.
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  const j = src.indexOf('\n}\n', i) + 3;
  return src.slice(i, j);
};
// eslint-disable-next-line no-new-func
const geo = new Function(`${grab('rotatePlane')}${grab('unrotatePoint')}; return { rotatePlane, unrotatePoint };`)();
const { rotatePlane, unrotatePoint } = geo;

// --- 1. the angles that are tried ------------------------------------------------------------------
const angles = JSON.parse((src.match(/const ANGLES = (\[[^\]]*\]);/) || [])[1] || '[]');
check(`several angles are tried (${angles.length})`, angles.length >= 5);
check('upright is FIRST, so the common case still exits on pass one', angles[0] === 0);
check('both tilt directions are covered', angles.some((a) => a > 0 && a < 90) && angles.some((a) => a < 0 && a > -90));
check('a sideways photo is covered — lying on a bed is 90 degrees', angles.includes(90) || angles.includes(-90));
check('and upside down', angles.includes(180));
check('it stops at the first hit rather than scanning all of them', src.includes('if (!clustered.length) continue;'));

// --- 2. THE GEOMETRY: a hit maps back to the right place --------------------------------------------
// This is the assertion that matters. Get it wrong and the blur lands somewhere else on the photo
// while the face stays visible — worse than no blur, because it looks handled.
const W = 200, H = 300;
for (const deg of angles) {
  const r = rotatePlane(new Uint8Array(W * H), W, H, deg);
  // Take a known point in the ORIGINAL, carry it into the rotated frame the same way rotatePlane
  // does, then bring it home and check it survived the round trip.
  for (const [ox, oy] of [[100, 150], [40, 60], [160, 240], [10, 290]]) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // Forward: original -> rotated (the inverse of the inverse map rotatePlane uses).
    const dx = ox - W / 2;
    const dy = oy - H / 2;
    const rx = r.w / 2 + dx * cos - dy * sin;
    const ry = r.h / 2 + dx * sin + dy * cos;
    const back = unrotatePoint(rx, ry, deg, W, H, r.w, r.h);
    const off = Math.hypot(back.col - ox, back.row - oy);
    check(`${String(deg).padStart(4)}deg: (${ox},${oy}) round-trips within a pixel (off by ${off.toFixed(3)})`, off < 1);
  }
}

// --- 3. the rotated canvas is big enough --------------------------------------------------------------
// Rotating inside the original bounds crops the corners, and a face in a corner is exactly the one
// being hunted.
for (const deg of [20, -40, 90, 180]) {
  const r = rotatePlane(new Uint8Array(W * H), W, H, deg);
  const rad = Math.abs((deg * Math.PI) / 180);
  const need = {
    w: Math.abs(W * Math.cos(rad)) + Math.abs(H * Math.sin(rad)),
    h: Math.abs(W * Math.sin(rad)) + Math.abs(H * Math.cos(rad)),
  };
  check(`${deg}deg: the canvas grows to fit the corners (${r.w}x${r.h})`,
    r.w >= Math.round(need.w) - 1 && r.h >= Math.round(need.h) - 1);
}
const same = rotatePlane(new Uint8Array(W * H), W, H, 0);
check('0 degrees returns the plane untouched — no copy, no cost', same.w === W && same.h === H);

// --- 4. pixels actually move -----------------------------------------------------------------------------
// A rotate that quietly returned the input would pass every geometry test above and find nothing new.
const plane = new Uint8Array(W * H);
plane[10 * W + 10] = 255;                       // one bright pixel near the top-left
const rot180 = rotatePlane(plane, W, H, 180);
const brightAt = rot180.grey.findIndex((v) => v === 255);
check('a 180 rotation moves the pixel', brightAt !== 10 * W + 10 && brightAt !== -1);
check('and puts it in the opposite corner',
  Math.abs((brightAt % rot180.w) - (W - 1 - 10)) <= 1 && Math.abs(Math.floor(brightAt / rot180.w) - (H - 1 - 10)) <= 1);
check('nothing is lost off the edge at 90 degrees',
  rotatePlane(plane, W, H, 90).grey.some((v) => v === 255));

// --- 5. the caller still behaves -------------------------------------------------------------------------
check('the found angle is reported, so a caller can widen the box if it wants', src.includes('angle: deg,'));
check('a miss is still a plain null', src.includes('return null;'));
// CHANGED 2026-08-17: this moved into blurFound, which turns one shared detection into a picture,
// so adding a source no longer runs the detector three separate times.
check('no face found is not an error — the photo is passed through unblurred',
  blur.includes("reason: face?.rejected ? 'loose match was not face-shaped or face-placed' : 'no face found',"));
check('the box is still padded, which covers the extra spread of a tilted face',
  blur.includes('const grow = 0.25;'));
check('a thrown detector never costs the image', blur.includes("reason: err?.message || 'blur failed'"));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
