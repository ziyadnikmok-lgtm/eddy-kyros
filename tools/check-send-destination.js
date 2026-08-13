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
check('only a picture that EXISTS on the server is offered — an unsaved one cannot be moved',
  pm.includes('doneJobs.filter((j) => urlOfJob(j))'));
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

// --- Photo Match now wears Eddy's shell (owner, 2026-08-13) --------------------------------------------
// "The one of Eddy is different to the one of Photo Match." It was: Eddy puts results in a
// right-hand column with its own toolbar and hides the shared feed; Photo Match had a card at the
// bottom of one scrolling document, with the feed taking the right third.
const app = fs.readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
check('the shared feed is hidden on Photo Match, as it is on Eddy', (() => {
  const i = app.indexOf('const FEED_HIDDEN_PAGES');
  const j = app.indexOf('])', i);
  return app.slice(i, j).includes("'photoMatchSeedream'");
})());
check('and the page scrolls its own columns, as Eddy does', (() => {
  const i = app.indexOf('const SELF_SCROLL_PAGES');
  const j = app.indexOf('])', i);
  return app.slice(i, j).includes("'photoMatchSeedream'");
})());
check('both reasons are recorded beside the entries',
  /Photo Match grew the same inline results column Eddy has/.test(app)
  && /Photo Match now uses Eddy's two-column shell/.test(app));

check('the page opens the same flex shell Eddy uses',
  pm.includes('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto animate-in lg:flex-row'));
check('the setup column scrolls on its own', pm.includes('lg:min-h-0 lg:overflow-y-auto lg:pr-2'));
check('so does the results column', pm.includes('min-w-0 flex-1 space-y-3 lg:min-h-0 lg:overflow-y-auto'));
check('the results column exists BEFORE the first run, with an empty state',
  pm.includes('No matches yet') && pm.includes('tick any of them to send to Library or Base Library'));

// --- the panel keeps its pictures (owner, 2026-08-13) ---------------------------------------------
// "Make it save the images there unless I delete — same stuff we built in Eddy." Eddy's results are
// a persistent working queue; Photo Match's lived in React state and were gone the moment you left
// the tab.
check('Photo Match has its own results store, like Eddy', pm.includes("createPageStore('photomatch-results-v1')"));
check('separate from the form store, so clearing one cannot clear the other',
  pm.includes("createPageStore('kyros-photo-match-seedream-state')"));
check('only light fields are persisted — never the base64', pm.includes('function liteJob(j)') && !pm.includes('base64Data: j'));
check('the picture is redrawn from the saved server copy', pm.includes('galleryApi.imageUrl(j.galleryId)'));
check('the source side of the slider is kept as a SMALL jpeg', pm.includes("c.toDataURL('image/jpeg', 0.7)"));
check('and that shrink cannot break a run if it fails', pm.includes('img.onerror = () => resolve(null);'));
check('the queue is restored on open', pm.includes("await resultsStore.get('queue', [])"));
check('and never written before the read comes back — the classic order bug',
  pm.includes('if (!jobsRestored) return;'));
check('a restored row with no picture is dropped, not shown as an empty tile',
  pm.includes('saved.filter((j) => urlOfJob(j))'));
check('a run in progress is not persisted — it belongs to a session that is over',
  pm.includes("jobs.filter((j) => j.status === 'done' && urlOfJob(j)).map(liteJob)"));
check('a restored tile with no source thumb shows the result alone, not a broken slider',
  pm.includes('(job.result ? job.thumb : job.thumbSmall) ? ('));
check('each tile can be removed — which is what "until I delete" means', pm.includes('Take this off the panel'));
check('and Remove is the panel exit, not a delete',
  pm.includes('the picture stays in the gallery and the library')
  && pm.includes("this is the queue's exit, not a"));

// --- replay: what survives a reload -------------------------------------------------------------------
const lite = (j) => ({ id: j.id, status: j.status, galleryId: j.galleryId || null, charName: j.charName || '', filedDb: j.filedDb || 'eddy-library', thumbSmall: j.thumbSmall || null });
const live = [
  { id: 'a', status: 'done', galleryId: 'g1', result: { base64Data: 'x'.repeat(5000) }, thumb: 'y'.repeat(9000), thumbSmall: 'small' },
  { id: 'b', status: 'running' },
  { id: 'c', status: 'done', galleryId: null, result: { base64Data: 'z' } },
];
const saved = live.filter((j) => j.status === 'done' && j.galleryId).map(lite);
check('only the finished, filed one is saved', saved.length === 1 && saved[0].id === 'a');
check('the heavy fields are gone', !('result' in saved[0]) && !('thumb' in saved[0]));
check('what is kept is tiny', JSON.stringify(saved[0]).length < 200);
check('and it still knows where it was filed', saved[0].filedDb === 'eddy-library');
check('a restored row can still be redrawn', !!saved[0].galleryId);

// --- the panel shows what was already made (owner, 2026-08-13) ------------------------------------
// "Show some image I already generated, with photo match, so I can select them too or delete."
// Every Photo Match result has been filed into a library since long before the panel existed, so
// the panel reads those back rather than starting empty and pretending the work never happened.
check('previous matches are read back out of BOTH libraries',
  pm.includes('libraryStore.listItems(), baseStore.listItems()'));
check('a Photo Match row is recognised by name OR prompt — early rows lacked the prefix',
  pm.includes("String(r.name || '').startsWith('photomatch-')") && pm.includes("String(r.prompt || '').startsWith('Photo Match')"));
check('newest first', pm.includes('(b2.r.createdAt || 0) - (a2.r.createdAt || 0)'));
check('and capped — this is a working panel, not an archive', pm.includes('.slice(0, 60)'));
check('the Library tab is named as the archive instead', /the Library tab is the archive/.test(pm));
check('a picture already on the panel is not added twice', pm.includes('const seen = new Set(prev.map((j) => urlOfJob(j)));'));
check('an unreadable collection means an emptier panel, not a broken page',
  /an unreadable collection just means an emptier panel/.test(pm));
check('the tile remembers which library row it came from', pm.includes('libRowId: r.id'));
check('and which collection', pm.includes('filedDb: db'));

// --- one answer to "what is this tile's picture" ------------------------------------------------------
check('there is a single helper', pm.includes('function urlOfJob(j)'));
check('it covers a tile from this run and one from a library',
  pm.includes('return j.url || (j.galleryId ? galleryApi.imageUrl(j.galleryId)'));
check('the selection uses it', pm.includes('doneJobs.filter((j) => urlOfJob(j))'));
check('the move uses it', pm.includes('const url = urlOfJob(job);'));
check('and so does what gets persisted', pm.includes("jobs.filter((j) => j.status === 'done' && urlOfJob(j))"));

// --- Remove and Delete are different things -----------------------------------------------------------
check('Delete exists and is separate from Remove', pm.includes('const deleteJobRow = useCallback('));
check('it is confirmed, because only one of the two is undoable',
  pm.includes('Delete this picture from ${label}? It stays in the gallery.'));
check('it removes the row from the collection the tile came from', pm.includes('await store.removeItem(rowId)'));
check('a tile from this run has its row found by url instead', pm.includes("(await store.listItems()).find((i) => i.url === url)?.id"));
check('the server copy is deliberately left alone', /The server copy is left alone/.test(pm));
check('and the tile says whose it is', pm.includes("{job.charName ? `${job.charName} · ` : ''}"));

// --- the two Photo Match tabs are told apart by name (owner, 2026-08-13) --------------------------
// Two tabs called "Photo Match" — one Seedream, one Gemini — cost real time twice in one night: a
// bug report and a fix landed on different pages.
check('the Seedream tab is Photo Match SD', app.includes("{ id: 'photoMatchSeedream', label: 'Photo Match SD' }"));
check('the Gemini one says which it is', app.includes("{ id: 'photoMatch', label: 'Photo Match (old · Gemini)' }"));
check('no two nav items share the label "Photo Match"', (() => {
  const labels = [...app.matchAll(/label: '([^']*Photo Match[^']*)'/g)].map((m) => m[1]);
  return labels.length === new Set(labels).size;
})());
check('the reason is recorded beside the rename', /cost real time twice on 2026-08-13/.test(app));
// The FOLDER pictures are filed into is deliberately unchanged: renaming it would split every
// existing Photo Match folder in two.
check('the filing folder name is untouched', pm.includes("ensureFolder(who || 'Photo Match')"));

// --- the two columns must be SIBLINGS, not nested (owner, 2026-08-13) -------------------------------
// The results column was opened inside the setup column, so every result rendered in the left
// 560px strip while the right two thirds of the window sat empty. Every brace was balanced and
// eslint was clean — balance cannot tell nesting apart, only DEPTH can. So this walks the tags.
(() => {
  const lines = pm.split(String.fromCharCode(10));
  const start = lines.findIndex((l, i) => l.trim() === 'return (' && i > 900);
  let depth = 0;
  const at = {};
  for (let n = start; n < lines.length; n += 1) {
    const marks = lines[n].match(/<div|<\/div>/g) || [];
    for (const m of marks) {
      depth += m === '</div>' ? -1 : 1;
      if (lines[n].includes('lg:flex-row')) at.root = depth;
      else if (lines[n].includes('lg:w-[560px]')) at.setup = depth;
      else if (lines[n].includes('min-w-0 flex-1 space-y-3')) at.results = depth;
    }
  }
  check('the shell root is the outermost element', at.root === 1);
  check('the setup column sits inside it', at.setup === 2);
  check('the RESULTS column is a sibling of the setup column, not a child', at.results === 2);
  check('and every tag closes', depth === 0);
})();

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
