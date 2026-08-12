// Max Outfit dims a source it has already swapped.
//
// The owner points it at a Library folder, swaps forty, comes back later and has to re-pick by
// memory. Identical in shape to the "in Kyros" dimming already shipped on the Pinterest tab:
// dimmed, never hidden, so it stays pickable when a second take is wanted.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const gen = fs.readFileSync(path.join(ROOT, 'client/src/pages/EddyGeneratePage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the set ---------------------------------------------------------------------------------------
check('a set of already-swapped source ids is built', gen.includes('const swappedSourceIds = useMemo('));
check('it reads basePhotoId off Library rows', gen.includes('if (r.basePhotoId) out.add(r.basePhotoId)'));
check('it also reads baseId, which is what Max Outfit sets', gen.includes('if (r.baseId) out.add(r.baseId)'));
check('it is derived from the Library, not a second ledger to keep in step',
  /const swappedSourceIds = useMemo\(\(\) => \{[\s\S]{0,400}?\}, \[libItems\]\);/.test(gen));
check('the reason is recorded', /re-pick by memory/.test(gen));

// --- the tile ---------------------------------------------------------------------------------------
// The tiles are PickerGrid's, shared by the pose and outfit slots too, so this arrives as a prop
// rather than reaching for page state the component cannot see.
check('PickerGrid takes the set as a prop', gen.includes('function PickerGrid({ items, thumbs, selected, favIds, onToggle, onToggleFavorite, empty, doneIds })'));
check('the tile is dimmed, not hidden — a second take stays possible',
  gen.includes("doneIds?.has(it.id) && !on ? 'opacity-40 hover:opacity-100' : ''"));
check('and carries a label saying why', gen.includes('>done<'));
check('the pose and outfit pickers are left alone — only Max Outfit sources are marked',
  (gen.match(/doneIds=\{/g) || []).length === 1);
check('and it is the base slot that gets it', /doneIds=\{slot\.key === 'base' \? swappedSourceIds : null\}/.test(gen));
check('a picker with no set passed cannot crash on it', gen.includes('doneIds?.has('));

// --- replay the decision ---------------------------------------------------------------------------
const swapped = new Set(['s1', 's3']);
const dim = (id, picked) => (swapped.has(id) && !picked ? 'dim' : 'normal');
check('an already-swapped source is dimmed', dim('s1', false) === 'dim');
check('unless it is currently picked', dim('s1', true) === 'normal');
check('an unswapped source is normal', dim('s2', false) === 'normal');

// The set builder itself, run against rows in the shape Task 2 writes.
const build = (rows) => {
  const out = new Set();
  for (const r of rows) {
    if (r.basePhotoId) out.add(r.basePhotoId);
    if (r.baseId) out.add(r.baseId);
  }
  return out;
};
const built = build([
  { baseId: 'lib-7' },                       // a Max Outfit result
  { basePhotoId: 'photo-2' },                // an Eddy multi-base result
  { baseId: 'lib-7', basePhotoId: null },    // the same source, swapped twice
  { prompt: 'an old row with neither' },
]);
check('a Max Outfit source is marked from its result row', built.has('lib-7'));
check('an Eddy base photo is marked too', built.has('photo-2'));
check('swapping the same source twice is still one entry', built.size === 2);
check('a row carrying neither adds nothing', !built.has(undefined) && !built.has(null));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
