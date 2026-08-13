// Where a finished picture goes: Library, or Base Library.
//
// The results panel only ever offered "Send N to Library", and Photo Match only ever filed into
// eddy-library. But a finished picture is sometimes the next BASE photo, and which one it is cannot
// be known until it exists — so the choice has to be at filing time, not built into the page
// (owner, 2026-08-12/13).
//
// The two are separate IndexedDB collections behind the tabs of the same name:
//   Library      -> eddy-library
//   Base Library -> eddy-base
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const gen = fs.readFileSync(path.join(ROOT, 'client/src/pages/EddyGeneratePage.jsx'), 'utf8');
const pm = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8');
const tabs = fs.readFileSync(path.join(ROOT, 'client/src/pages/EddyTabs.jsx'), 'utf8');
const store = fs.readFileSync(path.join(ROOT, 'client/src/lib/eddyCollectionStore.js'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the two collections are what the tabs actually read ------------------------------------------
// If these ever diverge, "Send to Base" would file into a database no tab displays.
check('the Library tab reads eddy-library', tabs.includes('dbName="eddy-library"'));
check('the Base Library tab reads eddy-base', tabs.includes('dbName="eddy-base"'));

// --- the results panel offers both ------------------------------------------------------------------
check('Send to Library is still there', gen.includes('Send {selectedResults.length || results.length} to Library'));
check('and Send to Base sits beside it', gen.includes('Send {selectedResults.length || results.length} to Base'));
check('each opens the picker against its own collection',
  gen.includes("openFilePicker('eddy-library')") && gen.includes("openFilePicker('eddy-base')"));
check('the picker lists folders from the CHOSEN collection',
  gen.includes("const store = db === 'eddy-base' ? baseLibStore : libraryStore;"));
check('a new folder is created in that collection too, not always the Library',
  gen.includes('await filingStore.ensureFolder(name)'));
check('the picker says which one it is filing into', gen.includes('to {filingLabel}…'));

// --- moving to Base must not leave the picture in two tabs --------------------------------------------
check('the Library row is dropped when a picture becomes a base photo',
  gen.includes('if (stale) await libraryStore.removeItem(stale.id);'));
check('and only when Base was chosen', gen.includes("const toBase = filingDb === 'eddy-base';"));
check('the add happens BEFORE the removal, so a failure loses nothing',
  gen.indexOf('await filingStore.addItems(') < gen.indexOf('await libraryStore.removeItem(stale.id)'));
check('the user is told this, rather than discovering it', gen.includes('Their Library entry is removed'));
check('the reason is recorded', /sometimes the next base photo/.test(gen));

// --- the API it calls has to exist --------------------------------------------------------------------
// removeItems (plural) was written first and does not exist; the store exposes removeItem.
check('removeItem is a real method on the collection', store.includes('removeItem: (...a) => serialize('));
check('and nothing calls the plural form that does not exist', !gen.includes('removeItems('));

// --- Photo Match chooses before the run ------------------------------------------------------------------
// Different shape on purpose: there the destination is known before generating, and a batch of
// thirty landing in the wrong tab is thirty drags.
check('Photo Match offers both destinations', pm.includes("{ value: 'eddy-library', label: 'Library' }")
  && pm.includes("{ value: 'eddy-base', label: 'Base Library' }"));
check('as a Settings dropdown, set before Generate', pm.includes('label="Send results to"'));
check('and it files into whichever was chosen', pm.includes('await destStore.addItems(['));

// --- replay: the move, as the code performs it ------------------------------------------------------------
const library = new Map([['u1', { id: 'L1', url: 'u1' }], ['u2', { id: 'L2', url: 'u2' }]]);
const base = new Map();
const sendToBase = (url) => {
  base.set(url, { id: `B${base.size + 1}`, url });      // add first
  const stale = library.get(url);
  if (stale) library.delete(url);                        // then drop the old row
};
sendToBase('u1');
check('the picture is in Base afterwards', base.has('u1'));
check('and no longer in the Library — one picture, one place', !library.has('u1'));
check('the other Library rows are untouched', library.has('u2') && library.size === 1);
sendToBase('u3');
check('a picture with no Library row still files into Base', base.has('u3'));
check('and that case removes nothing', library.size === 1);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
