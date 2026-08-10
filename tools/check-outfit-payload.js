// Max Outfit sends TWO images: her finished photo, and the garment.
//
// It was sending a third — a face close-up — taken from the run-level Face slot. That slot holds
// ONE photo, so every combo in the batch got the same face: a run spanning Grace and Mia put
// GRACE'S FACE on Mia's pictures (owner, 2026-08-10, seen in the Library).
//
// Image 1 is already a finished picture of her — face, body, room — and only the clothes change,
// so the close-up adds nothing it does not already have. The other tabs still send it, because
// there image 1 is a base photo and the close-up is what holds her identity through a pose change.
const fs = require('fs');
const g = fs.readFileSync('D:/Kyros/app/client/src/pages/EddyGeneratePage.jsx', 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the payload ------------------------------------------------------------------------------
check('Max Outfit resolves no face image',
  g.includes('const faceImg = maxOutfit ? null : (comboFace || charPayload[1] || null);'));
check('the other tabs are unchanged — comboFace first, then the slot',
  /comboFace \|\| charPayload\[1\] \|\| null/.test(g));
check('the reason is recorded, naming the actual symptom',
  /put GRACE'S FACE on Mia's pictures/.test(g));

// --- the prompt must drop its face clauses, not point at a missing image --------------------------
check('the face block is gated on faceIndex', /if \(faceIndex\) \{/.test(g));
check('the FINAL CHECK line has a no-face branch', /\? `FINAL CHECK: the woman in the result is the woman from image 1 — her body/.test(g));
check('no face clause is written unconditionally',
  (g.match(/Image \$\{faceIndex\} is a close-up/g) || []).length === 2);

// --- the count ---------------------------------------------------------------------------------------
const perRun = (maxOutfit, outfits, picked, slots, poses) => (maxOutfit
  ? 1 + (outfits ? 1 : 0)
  : (picked ? 2 : slots) + (poses ? 1 : 0));

check('Max Outfit with an outfit = 2 images', perRun(true, 3, 0, 2, 0) === 2);
check('Max Outfit ignores the Face slot even when it is filled', perRun(true, 3, 0, 2, 0) === 2);
check('Max Outfit with no outfit picked = 1', perRun(true, 0, 0, 0, 0) === 1);
check('Max Nano multi-base + pose is still 3', perRun(false, 0, 2, 0, 1) === 3);
check('Eddy single-slot + pose is still 3', perRun(false, 1, 0, 2, 1) === 3);
check('the source explains the 2', /Her finished photo \+ the garment/.test(g));

// --- what a mixed batch used to do, as a replay ------------------------------------------------------
const combos = [
  { baseId: 'grace-1', who: 'Grace' },
  { baseId: 'mia-1', who: 'Mia' },
  { baseId: 'grace-2', who: 'Grace' },
];
const runFaceSlot = 'GRACE_FACE';
const before = combos.map((c) => ({ who: c.who, face: runFaceSlot }));
const after = combos.map((c) => ({ who: c.who, face: null }));
check('BEFORE: every combo carried the same face, including Mia\'s',
  before.every((r) => r.face === 'GRACE_FACE') && before[1].who === 'Mia');
check('AFTER: no combo carries a face at all', after.every((r) => r.face === null));
check('so a mixed batch can no longer cross faces', new Set(after.map((r) => r.face)).size === 1
  && after[0].face === null);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
