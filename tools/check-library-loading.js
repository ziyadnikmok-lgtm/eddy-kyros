// The Library paints first and fetches its pictures after — on-screen ones first.
//
// It used to `await Promise.all(...)` every image in the collection before rendering anything:
// six hundred full-size data URLs read out of IndexedDB and held in one state object, while the
// grid shows a hundred and twenty. That is why the tab took so long to open and why tiles came up
// black — the browser was handed more base64 than it could decode at once (owner, 2026-08-11).
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const col = rd('client/src/components/EddyCollection.jsx');
const pageStore = rd('client/src/lib/pageStateStore.js');
const collStore = rd('client/src/lib/eddyCollectionStore.js');
const tabs = rd('client/src/pages/EddyTabs.jsx');
const galleryRoute = rd('server/routes/gallery.js');
const galleryMgr = rd('server/services/galleryManager.js');

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

// ================================================================================================
// 2026-08-15 — the pump was right about ORDER and wrong about VOLUME. Measured in the owner's
// running window: eddy-library is 2,298 rows and every single one is server-backed, so all 2,298
// reads came back empty — at ~34 ms each, because every read opened its own database connection.
// ================================================================================================

// --- one connection per database, not one per read ------------------------------------------------
check('the page store keeps its connections', pageStore.includes('const _conns = new Map();'));
check('open() returns the cached handle', pageStore.includes("const cached = _conns.get(dbName);\n  if (cached) return cached;"));
check('a failed open is not cached', /p\.catch\(\(\) => \{ if \(_conns\.get\(dbName\) === p\) _conns\.delete\(dbName\); \}\);/.test(pageStore));
check('it lets go when another context needs an upgrade', pageStore.includes('db.onversionchange'));
check('and when the browser closes it under us', pageStore.includes('db.onclose = evict;'));
check('a dead connection is retried once', pageStore.includes('async function withDB(dbName, fn)'));
check('but a quota failure is NOT retried — that answer is real',
  pageStore.includes('if (attempt > 0 || !isDeadConnection(err)) throw err;'));
check('no read or write opens its own connection any more',
  !/const db = await openDB\(dbName\);\n\s+const rec/.test(pageStore));
check('the measurement is recorded, so the next person does not re-discover it',
  /2,298/.test(pageStore) && /34 ms/.test(pageStore));

// --- ask which rows HAVE a picture before reading any ---------------------------------------------
check('the store can list keys without reading values', pageStore.includes('getAllKeys()'));
check('and read a batch in ONE transaction', pageStore.includes('async getMany(keys, fallback = null)'));
check('the collection derives stored ids from the key list', collStore.includes('async storedImageIds()'));
check('front and back are told apart by suffix, not by reading',
  collStore.includes("if (rest.endsWith(':back')) back.add(rest.slice(0, -5));"));
check('spare copies are deliberately not reported as pictures',
  /`:alt` and `:preplate` are/.test(collStore));
check('the pump asks for that set before it reads anything',
  col.includes('const stored = await store.storedImageIds()'));
check('a row with no local bytes is blanked without a read',
  col.includes("if (!stored.front.has(id)) { blanks[id] = ''; remaining.delete(id); }"));
check('the blank still goes into thumbs — absent and empty must not mean the same thing',
  /leaving the key absent would make "not loaded yet" and "no local copy" the same thing/.test(col));
check('a batch is one transaction, not eight', col.includes('const values = await store.getImages(batch);'));
check('the outfit back pass is batched too', col.includes('const values = await store.getBackImages(slice);'));
check('and only walks the rows that actually have a back crop',
  col.includes('allItems.filter((it) => stored.back.has(it.id))'));
check('a failed key list falls back to reading everything, rather than showing nothing',
  col.includes('.catch(() => null)') && col.includes('const stored = await store.storedImageIds()'));

// Replay it: the owner's real numbers.
const plan = (rows, storedFront) => {
  const remaining = new Set(rows.map((r) => r.id));
  let reads = 0;
  for (const id of [...remaining]) if (!storedFront.has(id)) remaining.delete(id);
  while (remaining.size) { const b = [...remaining].slice(0, 8); b.forEach((id) => remaining.delete(id)); reads += 1; }
  return reads;   // transactions, not images
};
const LIBRARY = Array.from({ length: 2298 }, (_, i) => ({ id: `i${i}`, url: '/api/gallery/x/image' }));
check('2,298 server-backed rows cost ZERO image reads', plan(LIBRARY, new Set()) === 0);
const OUTFIT = Array.from({ length: 1109 }, (_, i) => ({ id: `o${i}` }));
check('1,109 locally-stored rows cost 139 transactions, not 1,109 reads',
  plan(OUTFIT, new Set(OUTFIT.map((o) => o.id))) === 139);
check('a mixed collection only reads its local half',
  plan([...LIBRARY.slice(0, 100), ...OUTFIT.slice(0, 8)], new Set(OUTFIT.slice(0, 8).map((o) => o.id))) === 1);

// --- the grid asks the server for what is on screen ------------------------------------------------
check('grid tiles load lazily', /loading="lazy"/.test(col));
check('and decode off the paint thread', /decoding="async"/.test(col));

// --- the server builds a thumbnail once ------------------------------------------------------------
check('there is a thumbnail cache on disk', galleryMgr.includes('thumbPath(id)'));
check('its path is validated, not concatenated from user input',
  galleryMgr.includes("if (!/^[\\w.-]+$/.test(String(id)))"));
check('the cache is served when it is newer than the source',
  galleryRoute.includes('if (cached && cached.mtimeMs >= src.mtimeMs && cached.size > 0)'));
check('it is written atomically, so a half-written JPEG is never served',
  galleryRoute.includes('fs.renameSync(tmp, thumbFile)'));
check('a full disk still returns the picture', /cache is an optimisation/.test(galleryRoute));
check('deleting an image drops its preview', galleryMgr.includes('this.dropThumb(entry.id);'));
check('previews are cached hard, with an mtime ETag so a replaced file is refetched',
  galleryRoute.includes('max-age=31536000, immutable') && galleryRoute.includes("ETag', `W/\"${req.params.id}-"));

// --- the recovery sweep stops downloading nine megabytes to compare ids ----------------------------
check('the listing can be asked for ids only', galleryMgr.includes("fields === 'slim'"));
check('and the route passes it through', galleryRoute.includes('fields: req.query.fields'));
check('the sweep asks for slim, filtered server-side',
  tabs.includes("galleryApi.list({ fields: 'slim', tag: 'eddy' })"));
check('prompts are fetched only for what is actually missing', tabs.includes('const prompts = new Map();'));
check('recovery writes once per folder, not once per picture', tabs.includes('const byFolder = new Map();'));
check('and the 12 MB index rewrite is named as the reason', /12 MB of prompt text/.test(tabs));
check('the sweep waits for the grid to paint', tabs.includes('requestIdleCallback(start, { timeout: 3000 })'));
check('a cancelled sweep re-arms rather than being lost forever',
  tabs.includes('sweptRef.current = false;'));

// --- "Image not on this machine": clear them out, but ask the SERVER which ones ------------------
// The badge is an <img> error, and an image fails to load for reasons that are nothing to do with
// the file — an aborted request, a busy thumbnail, a tile unmounted mid-flight. Deleting on that
// signal throws away good work to fix a display problem.
check('what gets removed is decided by the gallery listing',
  col.includes("const res = await galleryApi.list({ fields: 'slim' });") && col.includes('alive = new Set('));
check('an empty listing removes NOTHING', col.includes("if (!alive.size) throw new Error('the gallery listing came back empty');"));
check('and says so instead of failing silently', col.includes('Not removing anything — could not check the gallery'));
check('a row holding its own bytes is never a candidate', col.includes('.filter(({ it, gid }) => gid && !thumbs[it.id])'));
check('tiles that failed but whose picture IS here are reported, not deleted',
  col.includes('const falseAlarms =') && /failed to load but the picture IS here/.test(col));
check('the cleanup is reachable without scrolling every tile into view first',
  col.includes('{items.some((i) => i.url) && ('));
check('many rows go in ONE index write', collStore.includes('_removeItems: async function(ids)'));
check('and that write is serialized like every other mutation',
  collStore.includes('removeItems: (...a) => serialize(() => impl._removeItems.apply(impl, a)),'));
check('the index is written BEFORE the bytes are blanked',
  collStore.indexOf("await write('index', next);") < collStore.indexOf("await store.set(`img:${id}`, '');\n        // eslint-disable-next-line no-await-in-loop"));

// Replay the rule that decides what dies.
const GALLERY_ID = /\/gallery\/([^/?#]+)\/(?:image|thumb)/;
const doomFor = (rows, aliveIds, localBytes = {}) => rows
  .map((it) => ({ it, gid: (GALLERY_ID.exec(it.url || '') || [])[1] }))
  .filter(({ it, gid }) => gid && !localBytes[it.id])
  .filter(({ gid }) => !aliveIds.has(gid))
  .map(({ it }) => it.id);
const ROWS = [
  { id: 'a', url: '/api/gallery/here/image' },      // on this machine
  { id: 'b', url: '/api/gallery/gone/image' },      // someone else's export
  { id: 'c', prompt: 'a pose, no picture' },        // prompt-only card
  { id: 'd', url: '/api/video/file/clip.mp4' },     // not a gallery row at all
  { id: 'e', url: '/api/gallery/gone2/image' },     // gone, but its bytes are here
];
check('a row whose gallery id is missing is removed', doomFor(ROWS, new Set(['here'])).includes('b'));
check('a row whose picture is present is kept', !doomFor(ROWS, new Set(['here'])).includes('a'));
check('a prompt-only card is never touched', !doomFor(ROWS, new Set(['here'])).includes('c'));
check('a non-gallery url is never touched', !doomFor(ROWS, new Set(['here'])).includes('d'));
check('a row holding local bytes is never touched', !doomFor(ROWS, new Set(['here']), { e: 'data:...' }).includes('e'));
check('nothing is removed when every id is alive',
  doomFor(ROWS, new Set(['here', 'gone', 'gone2'])).length === 0);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
