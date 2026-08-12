// Every SELECTED pose and outfit says whether it is front, back or close-up.
//
// That label decides which outfit a pose is paired with, and it was invisible in the selection:
// you could read the sentence and still not know what the matcher thought it was. Ticking
// close-up outfits against front poses is how four wrong images got made (owner, 2026-08-10) —
// seeing both kinds side by side is what makes the mismatch obvious BEFORE spending.
//
// The chip has to be read the same way the RUN reads it, or it is decoration that can disagree
// with the outcome. That is the property this file guards.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const g = fs.readFileSync(path.join(ROOT, 'client/src/pages/EddyGeneratePage.jsx'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the chip is on both views ------------------------------------------------------------------
check('the row view computes a view', g.includes("const view = slot.key === 'pose'"));
check('the compact grid does too', (g.match(/const view = slot\.key === 'pose'/g) || []).length === 2);
check('rows render a worded chip', g.includes("{view === 'closeup' ? 'close-up' : view}"));
check('the grid renders a one-letter dot', g.includes("{view === 'closeup' ? 'C' : view === 'back' ? 'B' : 'F'}"));
check('the dot is explained on hover, since a letter alone is not obvious',
  /title=\{view \? `\$\{view === 'closeup' \? 'Close-up'/.test(g));

// --- READ THE SAME WAY THE RUN READS IT -- the whole point ------------------------------------------
check('a pose chip uses readPoseView, exactly like generateCombo',
  (g.match(/\? readPoseView\(it\?\.prompt\)/g) || []).length === 2);
check('an outfit chip uses outfitViewOf — label first, folder second',
  (g.match(/outfitViewOf\(it, slot\.folders\.find\(\(f\) => f\.id === it\?\.folderId\)\?\.name \|\| ''\)/g) || []).length === 2);
check('so an outfit labelled by hand shows its LABEL, not its folder',
  g.includes('function outfitViewOf(row, folderName)'));
check('base photos get no chip — their view comes from the Library row, not this list',
  /: null;/.test(g));

// --- colours must agree between the two views ---------------------------------------------------------
const tone = /const VIEW_TONE = \{([\s\S]*?)\};/.exec(g)[1];
const dot = /const DOT = \{([\s\S]*?)\};/.exec(g)[1];
check('front is sky in both', /front:.*sky/.test(tone) && /front:.*sky/.test(dot));
check('back is violet in both', /back:.*violet/.test(tone) && /back:.*violet/.test(dot));
check('close-up is rose in both', /closeup:.*rose/.test(tone) && /closeup:.*rose/.test(dot));
check('and they match the front/back/close-up chips above Generate',
  /\['front', 'Front', 'border-sky-500/.test(g) && /\['closeup', 'Close-up', 'border-rose-500/.test(g));

// --- replay: the chip must equal what the matcher will do -----------------------------------------------
const outfitView = new Function('folderName', /function outfitView\(folderName\) \{([\s\S]*?)\n\}/.exec(g)[1]);
const outfitViewOf = new Function('row', 'folderName', 'outfitView',
  /function outfitViewOf\(row, folderName\) \{([\s\S]*?)\n\}/.exec(g)[1]);

const shown = (row, folder) => outfitViewOf(row, folder, outfitView);
check('an outfit in a CloseUps folder reads close-up', shown({}, '7. CloseUps - Underboob') === 'closeup');
check('an outfit in a back folder reads back', shown({}, '1. Lingerie - back') === 'back');
check('an unfoldered outfit reads front — the default, now visible instead of assumed',
  shown({}, '') === 'front');
check('a hand-labelled outfit beats its folder', shown({ poseView: 'closeup' }, '1. Lingerie - front') === 'closeup');
check('clearing the label falls back to the folder', shown({ poseView: '' }, '1. Lingerie - back') === 'back');

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
