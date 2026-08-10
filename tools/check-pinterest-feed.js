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
check('the send fetches originals through it too', /fetch\(pinterestFeed\.proxyUrl\(p\.orig\)/.test(page));
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
check('the pin cache is capped rather than growing forever', /store\.set\('pins', pins\.slice\(0, 200\)\)/.test(page));

// --- dedupe --------------------------------------------------------------------------------------------------
check('imported pins are remembered by origin URL', /setSeen\(\(cur\) => new Set\(\[\.\.\.cur, \.\.\.chosen\.map\(\(p\) => p\.orig\)\]\)\)/.test(page));
check('an already-imported pin is dimmed, not hidden — still pickable', /already && !on \? 'opacity-40' : ''/.test(page));
check('duplicate ids across pages are collapsed', /const byId = new Map\(next\.map\(\(p\) => \[p\.id, p\]\)\)/.test(page));

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
check('a page is 100, not 25', /const PAGE_SIZE = 100;/.test(page));
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

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
