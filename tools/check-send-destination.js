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

// --- moving a batch that already exists (owner, 2026-08-13) -------------------------------------------
// "In photo match there is no select so I can grab the last 30, or the last hour, and send to base."
// Photo Match's results panel has no selection at all, and its dropdown only decides where the NEXT
// run goes. The place that already has "Select all", "Last hour" and "Last 24h" is the Library
// itself — it just had nowhere to send to.
const col = fs.readFileSync(path.join(ROOT, 'client/src/components/EddyCollection.jsx'), 'utf8');
check('the selectors this needs already exist', col.includes('Last hour (') && col.includes('Last 24h ('));
check('Library and Base Library know about each other',
  col.includes("const COUNTERPART = { 'eddy-library': { db: 'eddy-base'") && col.includes("'eddy-base': { db: 'eddy-library'"));
check('and nothing else does — outfit, pose and character have nowhere to send',
  col.includes('const counterpart = COUNTERPART[dbName] || null;'));
check('the button only renders where there is a counterpart', col.includes('{counterpart && ('));
check('it names the destination and the count', col.includes('`Send ${selected.length} to ${counterpart.label}`'));
// The BUTTON, not the function that declares it — the definition sits far above the bulk bar.
check('it sits with the selection it acts on', (() => {
  const bar = col.indexOf('<span className="text-xs text-zinc-300">{selected.length} selected</span>');
  const btn = col.indexOf('onClick={sendSelectedToCounterpart}');
  return bar > -1 && btn > bar;
})());

check('the destination row is written BEFORE the source row is dropped', (() => {
  const add = col.indexOf('await otherStore.addItems([payload]');
  const rm = col.indexOf('await store.removeItem(id);', add);
  return add > -1 && rm > add;
})());
check('a full quota leaves the picture where it was rather than nowhere',
  col.includes("if (!Array.isArray(landed) || !landed.length) { failure = 'storage is full'; continue; }"));
check('a row with no server url carries its BYTES across',
  col.includes('payload.dataUrl = thumbsRef.current[id] || await store.getImage(id);'));
check('and a row whose image cannot be read is skipped, not indexed empty',
  col.includes("failure = 'a picture had no image behind it'; continue;"));
check('provenance travels with it', col.includes('...(it.comboKey ? { comboKey: it.comboKey } : {}),'));
check('the folder name is recreated in the destination', col.includes('await otherStore.ensureFolder(name)'));
check('one ensureFolder per name, not per picture', col.includes('!destFolders.has(name)'));
check('the count reported is what actually landed', col.includes('if (done === total) notify(`Sent ${done} to'));

// --- replay: a partial failure must not lose a picture --------------------------------------------------
const src = new Map([['a', { url: 'ua' }], ['b', { url: 'ub' }], ['c', { url: 'uc' }]]);
const dst = new Map();
const quotaFullFor = new Set(['b']);
let done = 0;
for (const id of ['a', 'b', 'c']) {
  const landed = !quotaFullFor.has(id);
  if (!landed) continue;              // destination write failed -> source untouched
  dst.set(id, src.get(id));
  src.delete(id);
  done += 1;
}
check('the two that landed are gone from the source', !src.has('a') && !src.has('c'));
check('the one that failed is STILL in the source', src.has('b'));
check('and is not in the destination either — no half-move', !dst.has('b'));
check('the reported count is 2, not 3', done === 2);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
