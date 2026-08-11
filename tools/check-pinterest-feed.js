// The Pinterest browse tab: search, normalise, dedupe, send.
//
// The normaliser runs against a REAL captured Pinterest payload (tools/fixtures-pinterest.json,
// 6 live pins), not a hand-written fake. A fixture I invented would agree with whatever I assumed
// the shape was, which is the assumption most worth testing — Pinterest's payload is deeply nested
// and varies by pin type.
//
// THIS IS A SCRAPE and it can stop working. What these tests protect is the behaviour WHEN it
// breaks: every failure must name itself rather than collapsing to an empty grid, because an empty
// grid reads as "no matches" and sends the user off to retype a query that was never the problem.
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/Kyros/app';
const route = require(path.join(ROOT, 'server/routes/pinterestFeed.js'));
const page = fs.readFileSync(path.join(ROOT, 'client/src/pages/PinterestFeedPage.jsx'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'server/routes/pinterestFeed.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
const ctx = fs.readFileSync(path.join(ROOT, 'client/src/context/AppContext.jsx'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures-pinterest.json'), 'utf8'));

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const { normalisePin } = route;

// --- the normaliser, on real data --------------------------------------------------------------
const pins = fixture.results.map(normalisePin).filter(Boolean);
check('every real pin normalises', pins.length === fixture.results.length);
check('each has an original URL', pins.every((p) => /^https?:\/\//.test(p.orig)));
check('each has a thumbnail', pins.every((p) => /^https?:\/\//.test(p.thumb)));
check('each carries real dimensions', pins.every((p) => p.w > 0 && p.h > 0));
check('the thumbnail is NOT the original — a grid of 1200px files janks the scroll',
  pins.some((p) => p.thumb !== p.orig));

// --- the shapes that must be dropped rather than rendered ------------------------------------------
check('a video pin (no orig) is dropped, not turned into a broken tile',
  normalisePin({ id: 'v1', images: {} }) === null);
check('null is dropped', normalisePin(null) === null);
check('a non-object is dropped', normalisePin('nope') === null);
check('an orig with no url is dropped', normalisePin({ id: 'x', images: { orig: { width: 900 } } }) === null);
check('alt text is capped, so one pathological description cannot bloat the response',
  normalisePin({ id: 'a', images: { orig: { url: 'http://x/a.jpg', width: 900, height: 900 } }, description: 'z'.repeat(500) }).alt.length === 200);

// --- the resolution gate ------------------------------------------------------------------------------
const MIN = Number(/const MIN_LONG_EDGE = (\d+);/.exec(page)[1]);
const passes = (w, h) => Math.max(w, h) >= MIN;
check('the floor is 600px', MIN === 600);
check('a 236px thumbnail is filtered out', !passes(236, 236));
check('a 1200px original is kept', passes(1200, 800));
check('portrait counts its LONG edge, so a 600x900 shot is kept', passes(600, 900));
check('the gate is on the long edge, not the area', passes(4000, 100));
check('real fixture pins mostly survive the gate',
  pins.filter((p) => passes(p.w, p.h)).length >= Math.floor(pins.length / 2));

// --- every failure names itself -------------------------------------------------------------------------
check('a rate limit is its own code, never zero results', /PINTEREST_RATE_LIMITED/.test(src));
check('and it reads retry-after rather than guessing', /Number\(resp\.headers\?\.\['retry-after'\]\) \|\| 30/.test(src));
check('unreachable is distinct from blocked',
  /PINTEREST_UNREACHABLE/.test(src) && /PINTEREST_BLOCKED/.test(src));
check('a CHANGED SHAPE is distinct from no results — the two need different reactions',
  /PINTEREST_SHAPE/.test(src) && /Pinterest changed its search response/.test(src));
check('an empty array really is no matches, and passes through',
  /if \(!Array\.isArray\(results\)\)/.test(src));
check('a non-200 never silently returns pins', /validateStatus: \(\) => true/.test(src));
check('the request cannot hang a Kyros worker', /timeout: TIMEOUT_MS/.test(src));

// --- the header Pinterest requires ---------------------------------------------------------------------
check('the PWS handler header is sent — without it the endpoint 403s',
  /'X-Pinterest-PWS-Handler': PWS_HANDLER/.test(src));
check('and the reason is recorded', /403s the resource endpoint without this header/.test(src));

// --- paging ------------------------------------------------------------------------------------------------
check('the fixture proves paging is real', typeof fixture.bookmark === 'string' && fixture.bookmark.length > 0);
check('the bookmark is sent back in an ARRAY, which is what Pinterest expects',
  /bookmarks: bookmark \? \[bookmark\] : \[\]/.test(src));
check('null bookmark, not empty string, so the client can test it plainly',
  /bookmark: body\?\.resource_response\?\.bookmark \|\| null/.test(src));

// --- images must go through the proxy ----------------------------------------------------------------------
check('the grid loads thumbs through the proxy', /src=\{pinterestFeed\.proxyUrl\(p\.thumb\)\}/.test(page));
check('the send fetches originals through it too', page.includes('fetchPinWithRetry(pinterestFeed.proxyUrl(p.orig))'));
check('the reason is written down — i.pinimg refuses a browser Origin',
  /refuses a request carrying a browser Origin/.test(page));

// --- the handoff ---------------------------------------------------------------------------------------------
const dests = /const DESTINATIONS = \[([\s\S]*?)\];/.exec(page)[1];
for (const [label, ev] of [
  ['Photo Match', 'kyros:use-as-photo-match-seedream-source'],
  ['Scene Recreate', 'kyros:use-as-scene-recreate-seedream-source'],
  ['Pose Remix', 'kyros:use-as-pose-remix-seedream-source'],
  ['Outfit Swap', 'kyros:use-as-outfit-swap-seedream-source'],
]) {
  check(`${label} uses the event that tab actually listens for`, dests.includes(ev));
}
check('one dead pin does not abandon the whole selection', /failed\.push\(p\.id\)/.test(page));
check('and the skip is reported rather than silent', /could not be downloaded/.test(page));
check('downloads are sequential — twenty parallel fetches is what earns a rate limit',
  /sequential on purpose: twenty parallel/.test(page));

// --- selection survives navigation -------------------------------------------------------------------------
check('the selection persists', /store\.set\('picked', picked\)/.test(page));
check('and is restored', /store\.get\('picked', \[\]\)/.test(page));
check('the pin cache is capped rather than growing forever — at more than one page (was 200)', /store\.set\('pins', pins\.slice\(0, 1000\)\)/.test(page));

// --- dedupe --------------------------------------------------------------------------------------------------
check('imported pins are remembered by origin URL — and only the ones that ARRIVED',
  page.includes('setSeen((cur) => new Set([...cur, ...chosen.filter((p) => sentIds.has(p.id)).map((p) => p.orig)]));'));
check('an already-imported pin is dimmed, not hidden — still pickable', /already && !on \? 'opacity-40' : ''/.test(page));
check('duplicate ids across pages are collapsed — and a repeat never MOVES the tile it repeats',
  page.includes('const have = new Set(base.map((p) => p.id));')
  && page.includes('const incoming = r.pins.filter((p) => !have.has(p.id));'));

// --- registration: the step that silently breaks a new page ---------------------------------------------------
check('the id is in VALID_PAGE_IDS, or the tab falls back to eddy', /'pinterestFeed'/.test(ctx));
check('the page is imported', /PinterestFeedPage = lazy/.test(app));
check('the component is mapped', /pinterestFeed: PinterestFeedPage,/.test(app));
check('it has a sidebar entry', /\{ id: 'pinterestFeed', label: 'Pinterest' \}/.test(app));
check('it has an icon and a colour', /pinterestFeed: IconCrosshairs/.test(app) && /pinterestFeed: \['#fca5a5'/.test(app));
check('the route is mounted', /app\.use\('\/api\/pinterest-feed', pinterestFeedRoute\)/.test(index));
check('browsing does NOT eat the paid-generation rate budget',
  /\/\/ NOT behind generateLimiter/.test(index));

// --- honesty about what does not work ---------------------------------------------------------------------------
check('the 404/400 endpoints are recorded so nobody re-derives them',
  /RelatedModulesResource  -> 404/.test(src) && /BoardFeedResource       -> 400/.test(src));
check('the scrape risk is stated in the source, not just in a chat message',
  /THIS IS A SCRAPE/.test(src) && /THIS IS A SCRAPE/.test(page));

// --- THE HANDOFF ACTUALLY ARRIVES (owner, 2026-08-10: "i click send it didnt send") ------------
// A CustomEvent alone dropped everything: the destination is lazy-loaded, so the event fired into
// the void before its chunk had mounted. lib/sourceHandoff exists for exactly this and is consumed
// ON MOUNT. Frame Grabber has always done it in this order; the Pinterest tab did not.
check('the payload is stashed before navigating', (() => {
  const i = page.indexOf('stashSourceHandoff(target.id, itemsPayload)');
  const j = page.indexOf('navigateTo(target.id)');
  return i > -1 && j > i;
})());
check('the event fires AFTER the navigate, for a page already open', (() => {
  const j = page.indexOf('navigateTo(target.id)');
  const k = page.indexOf('new CustomEvent(target.event');
  return k > j;
})());
check('the payload key is `items`, matching every other sender and every listener',
  /detail: \{ items: itemsPayload \}/.test(page));
check('and the old `images` key is gone', !/detail: \{ images \}/.test(page));
check('the reason is recorded', /fired into the void before its chunk had mounted/.test(page));

// --- 100 a page ---------------------------------------------------------------------------------
check('a page is 250 — what Pinterest actually serves', /const PAGE_SIZE = 250;/.test(page));
check('the search sends it', /pageSize: PAGE_SIZE/.test(page));
check('Load more still pages by bookmark', /search\(query, true\)/.test(page));

// --- replace or add -------------------------------------------------------------------------------
check('the toggle exists and is remembered', /localStorage\.getItem\('kyros\.pinterest\.replaceTarget'\)/.test(page));
check('the intent travels with the stash', /kyros\.pendingSourceMode\.\$\{target\.id\}/.test(page));
const pm = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8');
check('Photo Match reads that intent', /kyros\.pendingSourceMode\.photoMatchSeedream/.test(pm));
check('and clears it, so it cannot leak into the next handoff', /removeItem\('kyros\.pendingSourceMode\.photoMatchSeedream'\)/.test(pm));
check('ABSENT means ADD -- losing work is the worse mistake', /let mode = 'add';/.test(pm));
check('adding dedups on the image itself', /const have = new Set\(prev\.map\(\(x\) => x\.dataUrl\)\)/.test(pm));
check('replacing into an EMPTY list is the same as adding', /if \(mode === 'replace' \|\| !prev\.length\) return incoming;/.test(pm));

// --- no generation feed on a page that generates nothing ---------------------------------------------
const appSrc = fs.readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
check('Pinterest is in FEED_HIDDEN_PAGES', /const FEED_HIDDEN_PAGES = new Set\(\[[\s\S]{0,400}'pinterestFeed',/.test(appSrc));

// replay the replace/add rule
const merge = (prev, incoming, mode) => {
  if (mode === 'replace' || !prev.length) return incoming;
  const have = new Set(prev.map((x) => x.dataUrl));
  return [...prev, ...incoming.filter((x) => !have.has(x.dataUrl))];
};
const A = [{ dataUrl: 'a' }, { dataUrl: 'b' }];
const B = [{ dataUrl: 'b' }, { dataUrl: 'c' }];
check('replace discards what was there', merge(A, B, 'replace').length === 2);
check('add keeps both and dedups the overlap', merge(A, B, 'add').map((x) => x.dataUrl).join() === 'a,b,c');
check('add into an empty list just loads', merge([], B, 'add').length === 2);

// --- paging: one click, a lot more content (owner, 2026-08-11) ------------------------------------
// Measured live that day, same query, one request each: page_size 25 -> 20 pins, 50 -> 45,
// 100 -> 92, 250 -> 237. The server was clamping to 50, so "Load more" added a handful.
check('the server lets a page be big', src.includes('const MAX_PAGE_SIZE = 250;'));
check('and the measurement that justifies it is written down', /page_size=250 -> 237 pins/.test(src));
check('the client asks for a full page', page.includes('const PAGE_SIZE = 250;'));
check('Load more keeps paging until it has added a lot', page.includes('const MORE_TARGET = 120;'));
check('but cannot spin forever on a query with nothing left', page.includes('const MORE_MAX_PAGES = 4;'));
check('it counts tiles that will be SEEN, not raw results',
  page.includes('fresh = incoming.filter((p) => Math.max(p.w, p.h) >= MIN_LONG_EDGE).length;'));
check('it stops when the bookmark runs out', page.includes('if (!mark || lastEmpty || added >= MORE_TARGET) break;'));
check('a first search is still ONE page, not four', page.includes('page < (more ? MORE_MAX_PAGES : 1)'));
check('and it says how many arrived, so an empty page is not silence', page.includes("Pinterest is repeating itself"));
check('the session cap is bigger than one page', page.includes("store.set('pins', pins.slice(0, 1000))"));

// --- the grid must not move under the cursor -------------------------------------------------------
// The prose explaining the bug is allowed to name it; what must be gone is the CLASS.
check('the CSS column-count class is GONE — it re-balanced every tile on append',
  !page.includes('[column-count:'));
check('pins are bucketed into columns by hand', page.includes('const columns = useMemo(('));
check('shortest column wins, measured by aspect ratio',
  page.includes('heights[k] += (p.w > 0 && p.h > 0) ? p.h / p.w : 1.25;'));
check('the column count follows the window', page.includes('function colsForWidth(w)'));
check('and is recomputed on resize', page.includes("window.addEventListener('resize', onResize)"));
check('the reason is recorded', /appending can never move one that is already placed/.test(page));

// --- replay: appending must not move anything ---------------------------------------------------------
const bucket = (items, cols) => {
  const out = Array.from({ length: cols }, () => []);
  const h = new Array(cols).fill(0);
  for (const p of items) {
    let k = 0;
    for (let i = 1; i < cols; i += 1) if (h[i] < h[k]) k = i;
    out[k].push(p);
    h[k] += (p.w > 0 && p.h > 0) ? p.h / p.w : 1.25;
  }
  return out;
};
const where = (buckets, id) => {
  for (let c = 0; c < buckets.length; c += 1) {
    const i = buckets[c].findIndex((p) => p.id === id);
    if (i > -1) return `${c}:${i}`;
  }
  return null;
};
const mk = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `p${from + i}`, w: 800, h: 900 + ((i * 137) % 700) }));
const first = mk(40);
const before = bucket(first, 4);
const after = bucket([...first, ...mk(60, 40)], 4);
check('every pin from the first page is in the SAME place after loading more',
  first.every((p) => where(before, p.id) === where(after, p.id)));
check('and the new ones really did arrive',
  after.flat().length === 100 && before.flat().length === 40);
check('a pin with no dimensions cannot collapse a column',
  bucket([{ id: 'x', w: 0, h: 0 }], 2).flat().length === 1);
check('one column still works', bucket(mk(5), 1)[0].length === 5);

// --- 20 ticked, 11 arrived (owner, 2026-08-11) ------------------------------------------------------
// Cause: the browse grid renders one PROXIED thumbnail per tile, and the whole /api/pinterest
// router sat behind the 60/min GENERATION limiter. Measured in app.log: one minute served 71 x 200
// then 114 x 429. The send's own downloads then hit the exhausted bucket, came back 429, and were
// counted as "could not be downloaded" and dropped. Three layers, all asserted here.
const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
const pin = fs.readFileSync(path.join(ROOT, 'server/routes/pinterest.js'), 'utf8');

check('the proxy no longer sits behind the generation limiter',
  !idx.includes("app.use('/api/pinterest', generateLimiter, pinterestRoute);"));
check('a GET of the proxy takes the READ budget',
  idx.includes("req.method === 'GET' && req.path === '/proxy'") && idx.includes('readLimiter(req, res, next)'));
check('while the POST scrape endpoints keep the generation limiter',
  idx.includes('generateLimiter(req, res, next)'));
check('the measurement is recorded at the mount', idx.includes('71 x 200') && idx.includes('114 x 429'));
check('proxied images are cacheable, so a re-render is not a re-fetch',
  pin.includes("res.setHeader('Cache-Control', 'private, max-age=86400, immutable');"));

check('a 429 on a download is retried, not counted as a dead pin',
  page.includes('async function fetchPinWithRetry(url, tries = 3)'));
check('it honours Retry-After when the server sends one', page.includes("resp.headers.get('retry-after')"));
check('and only retries 429 — a 404 will still be a 404 in four seconds',
  page.includes('if (resp.status !== 429) return resp;'));
check('the send uses it', page.includes('await fetchPinWithRetry(pinterestFeed.proxyUrl(p.orig))'));
check('a pin that failed STAYS TICKED so Send retries exactly those',
  page.includes('setPicked((cur) => cur.filter((id) => !sentIds.has(id)));'));
check('only what actually arrived is marked as imported', page.includes('const sentIds = new Set('));
check('and a partial send is an ERROR, not a cheerful info toast',
  page.includes('press Send again to retry') && page.includes("failed.length ? 'error' : 'success'"));

// --- replay: a partial send must not lose the selection ------------------------------------------------
const ticked = ['a', 'b', 'c', 'd', 'e'];
const failedIds = ['c', 'e'];
const sent = new Set(ticked.filter((id) => !failedIds.includes(id)));
const stillTicked = ticked.filter((id) => !sent.has(id));
check('the three that went are unticked', sent.size === 3);
check('the two that failed are still selected', stillTicked.join(',') === 'c,e');
check('nothing is both sent and still selected', stillTicked.every((id) => !sent.has(id)));

// backoff: 1s, 2s, 4s, and a Retry-After wins but is capped
const waitFor = (i, retryAfter) => (Number.isFinite(retryAfter) && retryAfter > 0
  ? Math.min(retryAfter * 1000, 10_000) : 1000 * (2 ** i));
check('the first wait is a second', waitFor(0, NaN) === 1000);
check('it doubles', waitFor(1, NaN) === 2000 && waitFor(2, NaN) === 4000);
check("Retry-After wins when it is given", waitFor(0, 3) === 3000);
check('but cannot park the app for a minute', waitFor(0, 120) === 10_000);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
