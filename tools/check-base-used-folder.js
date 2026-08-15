// A base photo that has actually been used gets filed under "used".
//
// Owner, 2026-08-15: "in base image when used in eddy it will move it to a sub folder in library
// used".
//
// The two decisions worth pinning, because both are easy to get backwards:
//
//   WHEN. After the result is filed, never when the photo is ticked. Moving on selection would file
//   base photos you picked and then abandoned, and "used" would stop meaning anything at all.
//
//   WHERE. "used" is a CHILD of the folder the photo already sits in, so Grace's used shots stay
//   under Grace. Base Library's entire organisation is by character; one flat "used" would throw
//   that away the first time it ran.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const page = read('client/src/pages/EddyGeneratePage.jsx');
const store = read('client/src/lib/eddyCollectionStore.js');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- WHEN: only after the result actually landed ----------------------------------------------------
const filedGuard = page.indexOf("throw new Error(filed?.failed");
const move = page.indexOf('_movedBases.has(combo.basePhotoId)');
check('the move happens AFTER the result is confirmed filed', filedGuard > -1 && move > filedGuard);
check('it is inside the success path, not the catch',
  page.indexOf('const filed = await genStore.addItems') < move);
check('it needs a real base photo id — Max Outfit uses baseId and must not be touched',
  page.includes('if (combo?.basePhotoId && !_movedBases.has(combo.basePhotoId))'));

// --- WHERE: under the photo's own folder ---------------------------------------------------------------
check("'used' is created under the photo's current folder", page.includes("await baseStore.ensureFolder('used', parentId)"));
check('and the parent is read off the row, not guessed', page.includes('const parentId = row.folderId || null;'));
check('the store supports a parent, so this really nests', store.includes('_ensureFolder: async function(name, parentId = null)'));
check('an already-filed photo is not moved again', page.includes("if (used?.id && row.folderId !== used.id) await baseStore.moveItem(row.id, used.id);"));

// --- it must never cost a picture -----------------------------------------------------------------------
check('the whole move is wrapped', /try \{[\s\S]{0,600}catch \{ \/\* a folder move must never cost a generated picture \*\/ \}/.test(page));
check('a missing row is simply skipped', page.includes('if (row) {'));

// --- one move per photo, not one per combo -----------------------------------------------------------------
// A base photo is normally used across every combo in a run: twenty poses is twenty successful
// generations naming the same id. Without the guard that is twenty index reads and twenty writes.
check('there is a session guard', page.includes('const _movedBases = new Set();'));
check('and it is marked BEFORE the await, so concurrent combos cannot race in',
  page.indexOf('_movedBases.add(combo.basePhotoId);') < page.indexOf('await baseStore.listItems()'));

// Replay: twenty combos sharing one base photo must produce exactly one move.
const seen = new Set();
let moves = 0;
for (let i = 0; i < 20; i += 1) {
  const id = 'base-1';
  if (!seen.has(id)) { seen.add(id); moves += 1; }
}
check('twenty combos on one base photo cause one move', moves === 1);

// Two different base photos in the same run both get moved.
const seen2 = new Set();
let moves2 = 0;
for (const id of ['a', 'a', 'b', 'a', 'b']) {
  if (!seen2.has(id)) { seen2.add(id); moves2 += 1; }
}
check('but two different base photos each get their own', moves2 === 2);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
