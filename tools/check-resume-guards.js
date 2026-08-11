// A RESUMED run must actually generate, not fail on a guard meant for the Generate button.
//
// The resume worked and then every image failed: "Picking up where the last run stopped — 3 still
// to generate", followed by "Every generation failed" (owner, 2026-08-10, after leaving the page
// mid-run on Max Outfit).
//
// Two guards asked "is the single Main-photo slot filled?" — which is the wrong question on the
// tabs where image 1 rides on the combo:
//   Max Outfit  -> combo.baseId       (a finished Library picture)
//   ticked bases -> combo.basePhotoId (one of several Base Library photos)
//
// A LIVE run never hit either, because clicking Generate implies something was filled in. Only a
// resumed run dispatches combos straight into run(), which is exactly the path with no operator
// present to read the error.
const fs = require('fs');
const g = fs.readFileSync('D:/Kyros/app/client/src/pages/EddyGeneratePage.jsx', 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the per-combo guard --------------------------------------------------------------------
check('a combo carrying its own source satisfies the guard',
  g.includes('const hasOwnMain = !!(combo?.baseId || combo?.basePhotoId);'));
check('the guard uses it', g.includes('if (!isEdit && !hasOwnMain && !charPayload.length) throw'));
check('the bare form is gone', !/if \(!isEdit && !charPayload\.length\) throw/.test(g));

// --- run()'s gate -------------------------------------------------------------------------------
check('run() asks the same question the Generate button asks',
  g.includes('const batchHasOwnMain = batch.every((c) => c?.baseId || c?.basePhotoId);'));
check('and lets a self-sourcing batch through',
  g.includes('if (!maxOutfit && !baseImage && !pickedBasePhotos.length && !batchHasOwnMain) {'));
check('the stale single-slot gate is gone', !/if \(!baseImage\) \{ notify\('Add the main photo first'/.test(g));
check('EVERY combo must carry a source, not just the first — a mixed batch still blocks',
  /batch\.every\(/.test(g) && !/batch\.some\(\(c\) => c\?\.baseId/.test(g));

// --- replay: the three tabs, live and resumed ---------------------------------------------------
const runGate = (maxOutfit, baseImage, picked, batch) => {
  const own = batch.every((c) => c.baseId || c.basePhotoId);
  return !(!maxOutfit && !baseImage && !picked && !own);   // true = allowed to run
};
const comboGate = (isEdit, combo, charPayloadLen) =>
  !(!isEdit && !(combo.baseId || combo.basePhotoId) && !charPayloadLen);

const outfitBatch = [{ baseId: 'lib-1' }, { baseId: 'lib-2' }];
const tickedBatch = [{ basePhotoId: 'b-1' }, { basePhotoId: 'b-2' }];
const plainBatch = [{ outfitId: 'o1', poseId: 'p1' }];

check('RESUMED Max Outfit, nothing on the page -> runs', runGate(true, '', 0, outfitBatch) === true);
check('RESUMED multi-base Max Nano, nothing on the page -> runs', runGate(false, '', 0, tickedBatch) === true);
check('RESUMED plain Eddy with no photo loaded yet -> still blocked, correctly',
  runGate(false, '', 0, plainBatch) === false);
check('LIVE plain Eddy with a photo -> runs', runGate(false, 'data:...', 0, plainBatch) === true);

check('a Max Outfit combo passes the per-combo guard with an empty charPayload',
  comboGate(false, { baseId: 'lib-1' }, 0) === true);
check('a ticked combo does too', comboGate(false, { basePhotoId: 'b-1' }, 0) === true);
check('a plain combo with no payload is still refused — the real error is kept',
  comboGate(false, { outfitId: 'o1' }, 0) === false);
check('an edit is exempt, as before', comboGate(true, { outfitId: 'o1' }, 0) === true);

// --- the mixed case: one combo without a source must not let the batch through -------------------
check('a batch where only SOME combos self-source is blocked',
  runGate(false, '', 0, [{ baseId: 'lib-1' }, { outfitId: 'o1' }]) === false);

// --- the RETRY button must not be dead on the tabs with no Main-photo slot ------------------
// A failed Max Outfit batch listed its failures and offered a disabled button: the images were
// paid for, the combos were held, and there was no way to re-run them (owner, 2026-08-10).
check('the retry button is not gated on baseImage alone',
  !/<Btn className="flex-1 !py-1\.5 !text-xs" disabled=\{!baseImage\}/.test(g));
check('it accepts a batch whose combos carry their own sources',
  /!failedCombos\.every\(\(f\) => f\.combo\?\.baseId \|\| f\.combo\?\.basePhotoId\)/.test(g));
check('Max Outfit is allowed outright', /disabled=\{!maxOutfit && !baseImage/.test(g));

const retryDisabled = (maxOutfit, baseImage, picked, combos) =>
  !maxOutfit && !baseImage && !picked && !combos.every((c) => c.baseId || c.basePhotoId);
check('Max Outfit retry is enabled', retryDisabled(true, '', 0, [{ baseId: 'x' }]) === false);
check('a ticked Max Nano retry is enabled', retryDisabled(false, '', 0, [{ basePhotoId: 'b' }]) === false);
check('plain Eddy with nothing loaded is still disabled', retryDisabled(false, '', 0, [{ outfitId: 'o' }]) === true);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
