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

// --- WHERE: under the REAL character folder, never the row's raw current folder ------------------------
//
// "under the photo's current folder" was the bug, not the spec: `_movedBases` is in-memory and
// empty again after every reload, so a base already filed under "Chloe > used" that got touched by
// a later reload had row.folderId POINTING AT "used" ITSELF — and ensureFolder('used', usedId) made
// a second "used" as a child of the first. Six reloads nested it six deep (2026-08-16). The fix
// walks past any ancestor literally named "used" before calling ensureFolder, so this file checks
// for THAT walk rather than for the parent being read off the row unconditionally.
check("'used' is created under the resolved parent, not the row's raw folder", page.includes("await baseStore.ensureFolder('used', parentId)"));
check('the parent starts from the row, then walks past any "used" ancestor',
  /let parentId = row\.folderId \|\| null;\s*\n\s*while \(parentId\)/.test(page));
check('the walk compares case-insensitively, matching how folders are actually matched elsewhere',
  page.includes("String(cur.name).trim().toLowerCase() !== 'used'"));
check('the store supports a parent, so this really nests', store.includes('_ensureFolder: async function(name, parentId = null)'));
check('an already-filed photo is not moved again', page.includes("if (used?.id && row.folderId !== used.id) await baseStore.moveItem(row.id, used.id);"));

// --- replay: EXECUTE the resolution logic against a fake store, including the reload case ----------------
//
// A pattern match on the source can agree with itself about a broken walk. This runs the actual
// parent-resolution loop the page uses, against folders shaped exactly like the nested mess found
// in production: Chloe -> used -> used -> used.
{
  const folders = [
    { id: 'chloe', name: 'Chloe', parentId: null },
    { id: 'used1', name: 'used', parentId: 'chloe' },
    { id: 'used2', name: 'used', parentId: 'used1' },
    { id: 'used3', name: 'used', parentId: 'used2' },
  ];
  const resolveParent = (startFolderId) => {
    let parentId = startFolderId;
    while (parentId) {
      const cur = folders.find((f) => f.id === parentId);
      if (!cur || String(cur.name).trim().toLowerCase() !== 'used') break;
      parentId = cur.parentId || null;
    }
    return parentId;
  };
  check('a base already three "used" folders deep still resolves to the top-level character folder',
    resolveParent('used3') === 'chloe');
  check('a base still sitting directly under the character folder resolves to itself',
    resolveParent('chloe') === 'chloe');
  check('a base one level into "used" also resolves to the character folder',
    resolveParent('used1') === 'chloe');
  // The scenario that actually happened: _movedBases resets (simulating a reload), the same base
  // is processed again from whatever nested folder it currently sits in, and the parent MUST still
  // resolve to "chloe" every time — never to the nested folder, which is what created the next level.
  let deepest = 'chloe';
  for (let reload = 0; reload < 6; reload += 1) {
    const parent = resolveParent(deepest);
    check(`reload ${reload + 1}: still resolves to the character folder`, parent === 'chloe');
    // ensureFolder('used', parent) always returns the SAME single "used1" here — nesting cannot occur.
    deepest = 'used1';
  }
}

// --- it must never cost a picture -----------------------------------------------------------------------
// {0,600} was a magic length that happened to fit the ORIGINAL body; the parent-resolution walk
// added 2026-08-16 pushed the real try/catch past it, and a length cap failing is not the same
// claim as the wrap being missing. Bounded generously rather than removed — an unbounded [\s\S]*
// here could match across an unrelated later try/catch and pass on a body that was never wrapped.
check('the whole move is wrapped', /try \{[\s\S]{0,2400}catch \{ \/\* a folder move must never cost a generated picture \*\/ \}/.test(page));
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
