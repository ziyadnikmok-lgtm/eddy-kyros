// Hook dependency arrays that MUST list what they read.
//
// 2026-08-19: three separate "the toggle does nothing" reports, one root cause. A useCallback that
// reads state absent from its dep array keeps a FROZEN copy. It corrects itself only when some
// unrelated listed dep happens to change — which is why all three read as intermittent rather than
// broken, and why none could be reproduced on demand.
//
// eslint's react-hooks/exhaustive-deps is now on as a WARN (see client/eslint.config.js for why not
// error). This file is the hard gate for the specific ones that cost money or block a workflow.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// Pull the dep array that closes a given callback, by name of its opening line.
const depsAfter = (src, opener) => {
  const i = src.indexOf(opener);
  if (i < 0) return null;
  const j = src.indexOf('\n  }, [', i);
  if (j < 0) return null;
  return src.slice(j, src.indexOf(');', j));
};

// --- 1. Photo Match: the one that billed for wrong pictures ---------------------------------------
// lookAtCamera gates the EYES TO CAMERA paragraph and drops 'expression' from the scene list;
// outfitFromChar decides whose clothes she wears. Frozen, Generate paid for the previous setting
// while the toggle sat visibly on.
const pm = read('client/src/pages/PhotoMatchSeedreamPage.jsx');
const pmDeps = depsAfter(pm, 'const buildPromptFactory = useCallback(');
check('the prompt factory has a dep array', !!pmDeps);
check('it lists lookAtCamera', /\blookAtCamera\b/.test(pmDeps || ''));
check('and outfitFromChar', /\boutfitFromChar\b/.test(pmDeps || ''));
// Both are genuinely read in the body — if either stops being read, drop it from here too.
check('both are actually read by the factory',
  pm.includes('outfitFromChar,') && pm.includes('lookAtCamera,'));

// --- 2. Eddy: a save that refused over photos that were visibly ticked ----------------------------
const eddy = read('client/src/pages/EddyGeneratePage.jsx');
const saveDeps = depsAfter(eddy, 'const saveAsModel = useCallback(') || depsAfter(eddy, 'saveAsModel = useCallback(');
check('the save-as-model callback is found', !!saveDeps || eddy.includes('pickedBases, pickedBasePhotos]'));
check('its deps include the picked photos it guards on',
  eddy.includes('notify, pickedBases, pickedBasePhotos]'));

// --- 3. Library: "Create a folder first" after creating one ---------------------------------------
const lib = read('client/src/pages/LibraryPage.jsx');
check('the context-menu callback lists folders',
  lib.includes('[contextMenu, handleImageDownload, navigateTo, notify, openImage, folders]'));
check('and it really does read folders.length', lib.includes('if (folders.length === 0)'));

// --- the rule that catches the NEXT one -----------------------------------------------------------
const cfg = read('client/eslint.config.js');
check('exhaustive-deps is enabled', cfg.includes("'react-hooks/exhaustive-deps': 'warn'"));
check('the plugin is actually registered, or the rule is inert',
  cfg.includes("import reactHooks from 'eslint-plugin-react-hooks';") && cfg.includes("plugins: { 'react-hooks': reactHooks }"));
check('and why it is warn rather than error is written down',
  /a rule that fails the build on day one gets deleted/.test(cfg));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
