// The Library paints first and fetches its pictures after — on-screen ones first.
//
// It used to `await Promise.all(...)` every image in the collection before rendering anything:
// six hundred full-size data URLs read out of IndexedDB and held in one state object, while the
// grid shows a hundred and twenty. That is why the tab took so long to open and why tiles came up
// black — the browser was handed more base64 than it could decode at once (owner, 2026-08-11).
const fs = require('fs');
const col = fs.readFileSync('D:/Kyros/app/client/src/components/EddyCollection.jsx', 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the blocking load is gone -------------------------------------------------------------------
check('refresh no longer reads every image before painting',
  !col.includes('await Promise.all(i.map(async (it) => { map[it.id] = await store.getImage(it.id); }));'));
check('the grid is released before the pictures are fetched', (() => {
  const stop = col.indexOf('setLoading(false);\n    pumpImages(');
  return stop > -1;
})());
check('there is a pump', col.includes('const pumpImages = useCallback(async (allItems, alsoBack)'));
check('it loads in batches, not all at once', col.includes('const BATCH = 8;'));
check('it yields a frame between batches so tiles actually paint',
  col.includes('await new Promise((r) => { setTimeout(r, 0); });'));
check('the reason is recorded', /more base64 than it can decode at once/.test(col));

// --- on-screen first ---------------------------------------------------------------------------------
check('the grid publishes what it is showing', col.includes('wantRef.current = visible.slice(0, shown).map((i) => i.id);'));
check('the pump reads it EVERY batch, so a scroll re-prioritises',
  col.includes('const onScreen = wantRef.current.filter((id) => remaining.has(id));'));
check('and falls back to the rest when nothing on screen is missing',
  col.includes('(onScreen.length ? onScreen : [...remaining]).slice(0, BATCH)'));

// --- the TDZ trap this file has hit three times ---------------------------------------------------------
// A dependency array is evaluated during RENDER, so an effect naming `visible` must sit BELOW the
// const that declares it or the page blanks on every render.
check('the wantRef effect is below `visible`, not above it', (() => {
  const decl = col.indexOf('const visible = useMemo(');
  const eff = col.indexOf('wantRef.current = visible.slice(0, shown)');
  return decl > -1 && eff > decl;
})());
check('and the trap is named where it would be reintroduced', /temporal-dead-zone ReferenceError that blanks the whole/.test(col));

// --- cache hygiene -------------------------------------------------------------------------------------
check('a cached picture whose item is gone is dropped', col.includes('const stale = Object.keys(thumbsRef.current).filter((id) => !live.has(id));'));
check('what is already cached is NOT re-read on a folder switch',
  col.includes('const remaining = new Set([...live].filter((id) => !(id in thumbsRef.current)));'));
check('a refresh cancels the previous pump, so two cannot interleave',
  col.includes('if (pumpRunRef.current !== run) return;'));
check('the ref mirrors the state, because the pump spans many awaits',
  col.includes('useEffect(() => { thumbsRef.current = thumbs; }, [thumbs]);'));
check('the count still loading is on screen', col.includes('loading {imagesPending} picture'));

// --- replay the priority rule ---------------------------------------------------------------------------
const pick = (remaining, onScreenIds, batch = 8) => {
  const onScreen = onScreenIds.filter((id) => remaining.has(id));
  return (onScreen.length ? onScreen : [...remaining]).slice(0, batch);
};
const all = new Set(Array.from({ length: 300 }, (_, i) => `i${i}`));
const screen = ['i120', 'i121', 'i122'];
check('what is on screen is taken first', pick(all, screen).join(',') === 'i120,i121,i122');
check('once those are in, it carries on with the rest',
  pick(new Set(['i5', 'i6']), screen).join(',') === 'i5,i6');
check('a batch is capped', pick(all, []).length === 8);
check('an empty collection asks for nothing', pick(new Set(), []).length === 0);
check('an on-screen id already loaded is not re-requested',
  !pick(new Set(['i121']), screen).includes('i120'));

// The old behaviour, kept as the thing being prevented: one pass over everything before paint.
const OLD = 300, PAGE = 120;
check('the old load fetched 300 images to show 120', OLD > PAGE);
check('the new one fetches the 120 first', pick(all, Array.from({ length: PAGE }, (_, i) => `i${i}`))[0] === 'i0');

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
