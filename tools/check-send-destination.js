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

// --- Photo Match got its own results panel (owner, 2026-08-13) ----------------------------------------
// "There is nothing on the side — it shows only the Generation Feed." Right: Photo Match's results
// had no selection and no actions, so a finished picture could only be acted on by leaving for the
// Library tab. Eddy's panel has had tick-and-send for months; this is the same idea, same words.
check('a finished job remembers its gallery id', pm.includes('galleryId: first.galleryId || null'));
check('and which collection it was filed into', pm.includes('filedDb: destDb'));
check('there is a selection', pm.includes('const [pickedJobs, setPickedJobs] = useState(() => new Set());'));
check('with a select-all that flips to clear', pm.includes("pickedJobs.size === filedJobs.length ? 'Clear selection'"));
check('both destinations are one click', pm.includes("moveResultsTo('eddy-library')") && pm.includes("moveResultsTo('eddy-base')"));
check('with nothing ticked it acts on everything filed',
  pm.includes('(pickedJobs.size ? filedJobs.filter((j) => pickedJobs.has(j.id)) : filedJobs)'));
check('only a FILED picture is offered — an unsaved one cannot be moved',
  pm.includes('doneJobs.filter((j) => j.galleryId)'));
check('each tile says which library it is in right now', pm.includes("in {job.filedDb === 'eddy-base' ? 'Base Library' : 'Library'}"));

check('the move writes the destination BEFORE dropping the source', (() => {
  const add = pm.indexOf('const landed = await target.addItems([{');
  const rm = pm.indexOf('await sourceStore.removeItem(stale.id)', add);
  return add > -1 && rm > add;
})());
check('a picture already in the target is left alone, not duplicated',
  pm.includes('if (targetRows.has(url)) { already += 1; continue; }'));
check('nothing is removed when the source and target are the same collection',
  pm.includes('if (job.filedDb !== targetDb) {'));
check('the job record follows the move, so pressing the other button moves it back',
  pm.includes('ids.has(j.id) ? { ...j, filedDb: targetDb } : j'));
check('the count reported is what actually moved', pm.includes('if (moved && !failure) notify(`${moved} sent to ${targetLabel}'));

// --- replay: pressing Base twice must not duplicate --------------------------------------------------
const libRows = new Map([['g1', true]]);
const baseRows = new Map();
let job = { url: 'g1', filedDb: 'eddy-library' };
const sendTo = (target) => {
  const rows = target === 'eddy-base' ? baseRows : libRows;
  const from = job.filedDb === 'eddy-base' ? baseRows : libRows;
  if (rows.has(job.url)) return 'already';
  rows.set(job.url, true);
  if (job.filedDb !== target) from.delete(job.url);
  job = { ...job, filedDb: target };
  return 'moved';
};
check('first press moves it to Base', sendTo('eddy-base') === 'moved' && baseRows.has('g1') && !libRows.has('g1'));
check('second press is a no-op, not a duplicate', sendTo('eddy-base') === 'already' && baseRows.size === 1);
check('and it can be sent back', sendTo('eddy-library') === 'moved' && libRows.has('g1') && !baseRows.has('g1'));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
