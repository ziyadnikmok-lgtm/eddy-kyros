// "Send results to Library / Base Library" — the shared control, and the filing behind it.
//
// Four tabs that make pictures filed NOWHERE: Seedream 5 Pro, Scene Recreate, Pose Remix and
// Outfit Swap generated, the picture landed in the gallery and on the feed, and that was it. Two
// other tabs each grew their own copy of the destination dropdown. Six hand-rolled copies would
// drift, and the way they drift is silent — a different default, or one of them forgetting that
// addItems signals storage-full by returning an empty array rather than throwing.
//
// So the two assertions that matter most here are: the default is never Base (it is the SOURCE set
// Max Outfit dresses, and polluting it corrupts the input for every later run), and a full-storage
// miss is never reported as a success.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const srcText = read('client/src/lib/libraryDestination.js');
// eslint-disable-next-line no-new-func
const mod = new Function(`${srcText.replace(/^export /gm, '')}; return { LIBRARY_DESTS, normaliseDest, destLabel, fileIntoLibrary, cardName };`)();
const { LIBRARY_DESTS, normaliseDest, destLabel, fileIntoLibrary, cardName } = mod;

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };
const results = [];
const done = () => Promise.all(results);

// --- 1. the vocabulary ---------------------------------------------------------------------------
check('two destinations', LIBRARY_DESTS.length === 2);
check('the normal Library', LIBRARY_DESTS[0].db === 'eddy-library' && LIBRARY_DESTS[0].label === 'Library');
check('and Base Library', LIBRARY_DESTS[1].db === 'eddy-base' && LIBRARY_DESTS[1].label === 'Base Library');

// --- 2. THE DEFAULT IS NEVER BASE ------------------------------------------------------------------
// Base Library is the source set Max Outfit dresses. A stored value that has gone stale, a typo, a
// null from private-mode localStorage — none of them may resolve to Base.
for (const bad of [null, undefined, '', 'eddy-Base', 'EDDY-BASE', 'base', 'library', 'eddy-outfit', 0, false, {}, []]) {
  check(`${JSON.stringify(bad)} falls back to the normal Library`, normaliseDest(bad) === 'eddy-library');
}
check('a real value survives', normaliseDest('eddy-base') === 'eddy-base');
check('and so does the other one', normaliseDest('eddy-library') === 'eddy-library');

check('labels match the nav wording', destLabel('eddy-base') === 'Base Library' && destLabel('eddy-library') === 'Library');
check('an unknown db still labels safely', destLabel('nonsense') === 'Library');

// --- 3. filing ---------------------------------------------------------------------------------------
const fakeStore = (opts = {}) => {
  const calls = { ensureFolder: [], addItems: [] };
  return {
    calls,
    ensureFolder: async (n) => { calls.ensureFolder.push(n); if (opts.folderThrows) throw new Error('folder boom'); return opts.noFolder ? null : { id: `f-${n}` }; },
    addItems: async (items, folderId) => { calls.addItems.push({ items, folderId }); return opts.full ? [] : items.map((it, i) => ({ ...it, id: `i${i}` })); },
  };
};
const ITEM = { url: '/api/gallery/abc/image', prompt: 'Scene Recreate', name: 'scene-1' };

results.push((async () => {
  const s = fakeStore();
  const filed = await fileIntoLibrary(s, ITEM, { folder: 'Grace', label: 'Base Library' });
  check('it files and returns the stored rows', filed.length === 1 && filed[0].id === 'i0');
  check('the folder is created by name', s.calls.ensureFolder[0] === 'Grace');
  check('and the item lands in it', s.calls.addItems[0].folderId === 'f-Grace');
  check('the item is passed through untouched', s.calls.addItems[0].items[0].url === ITEM.url);
})());

results.push((async () => {
  const s = fakeStore();
  await fileIntoLibrary(s, ITEM, { label: 'Library' });
  check('no folder name means the collection root, not a folder called ""', s.calls.addItems[0].folderId === null);
  check('and ensureFolder is not called at all', s.calls.ensureFolder.length === 0);
})());

results.push((async () => {
  const s = fakeStore();
  await fileIntoLibrary(s, ITEM, { folder: '   ', label: 'Library' });
  check('a whitespace folder name is treated as none', s.calls.ensureFolder.length === 0);
})());

// A folder failure must not cost the picture — the root is findable, a lost image is not.
results.push((async () => {
  const s = fakeStore({ folderThrows: true });
  const filed = await fileIntoLibrary(s, ITEM, { folder: 'Grace', label: 'Library' });
  check('a folder failure still files the picture, at the root', filed.length === 1 && s.calls.addItems[0].folderId === null);
})());
results.push((async () => {
  const s = fakeStore({ noFolder: true });
  const filed = await fileIntoLibrary(s, ITEM, { folder: 'Grace', label: 'Library' });
  check('a folder that resolves to nothing does the same', filed.length === 1 && s.calls.addItems[0].folderId === null);
})());

// --- 4. STORAGE FULL IS NOT A SUCCESS ------------------------------------------------------------------
// addItems returns [] rather than throwing. Nothing about that reads as an error at the call site,
// which is exactly how a caller ends up reporting "done" while dropping every picture.
results.push((async () => {
  let msg = '';
  try { await fileIntoLibrary(fakeStore({ full: true }), ITEM, { folder: 'Grace', label: 'Base Library' }); } catch (e) { msg = e.message; }
  check('a full store throws rather than returning empty', msg !== '');
  check('the message names the library that missed out', msg.includes('Base Library'));
  check('and says the picture still exists in the gallery', msg.includes('in the gallery'));
})());

results.push((async () => {
  let msg = '';
  try { await fileIntoLibrary(null, ITEM, {}); } catch (e) { msg = e.message; }
  check('no store is refused', msg === 'No library selected');
  msg = '';
  try { await fileIntoLibrary(fakeStore(), { prompt: 'x' }, {}); } catch (e) { msg = e.message; }
  check('an item with no url is refused', msg.includes('no image URL'));
})());

// --- 5. names do not collide -------------------------------------------------------------------------
// `${prefix}-${Date.now()}` collides whenever two results land in the same millisecond, which the
// concurrency-2 queues in these tabs do routinely.
const names = Array.from({ length: 50 }, (_, i) => cardName('scene', i));
check('50 names in the same tick are all distinct', new Set(names).size === 50);
check('the prefix is kept', names[0].startsWith('scene-'));
check('a bare call still works', cardName('scene').startsWith('scene-'));

// --- 6. the component uses the shared logic rather than its own ----------------------------------------
const picker = read('client/src/components/LibraryDestinationPicker.jsx');
check('the picker renders from LIBRARY_DESTS, not a hardcoded pair', picker.includes('LIBRARY_DESTS.map'));
check('the hook normalises what it reads from storage', picker.includes('normaliseDest(localStorage.getItem(storageKey))'));
check('and normalises what the user picks', picker.includes('onChange(normaliseDest(e.target.value))'));
check('a private-mode read cannot leave it undefined', /catch \{ return 'eddy-library'; \}/.test(picker));
check('each tab gets its own storage key', picker.includes('useLibraryDestination(storageKey)'));
check('the store is memoised per destination', picker.includes('useMemo(() => createEddyCollection(destDb), [destDb])'));
check('the Base-only warning exists', picker.includes('This run files into Base Library'));
check('and shows for Base only', /normaliseDest\(value\) !== 'eddy-base'\) return null/.test(picker));

// --- 7. every tab that generates actually files ---------------------------------------------------------
// The four that filed nowhere. If one of these goes red, that tab has silently gone back to
// generating pictures that land in no library at all.
for (const page of ['SeedreamEditPage', 'SceneRecreateSeedreamPage', 'PoseRemixSeedreamPage', 'OutfitSwapSeedreamPage']) {
  const p = read(`client/src/pages/${page}.jsx`);
  check(`${page}: has the destination picker`, p.includes('LibraryDestinationPicker'));
  check(`${page}: files results into it`, p.includes('fileIntoLibrary'));
  check(`${page}: uses its own storage key`, /useLibraryDestination\('kyros\.[a-zA-Z]+\.genDest'\)/.test(p));
}
// Distinct keys, or one tab silently redirects another.
const keys = ['SeedreamEditPage', 'SceneRecreateSeedreamPage', 'PoseRemixSeedreamPage', 'OutfitSwapSeedreamPage']
  .map((p) => (read(`client/src/pages/${p}.jsx`).match(/useLibraryDestination\('([^']+)'\)/) || [])[1]);
check(`all four storage keys are distinct (${keys.filter(Boolean).length} found)`, new Set(keys.filter(Boolean)).size === 4);

done().then(() => {
  console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
  process.exit(fail ? 1 : 0);
});
