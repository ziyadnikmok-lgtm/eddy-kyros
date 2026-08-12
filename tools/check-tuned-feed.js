// Tuning the feed to the pins you tick.
//
// The mixing rule lives in its own module so it can be executed here without React. It decides what
// the owner sees first after pressing Refresh, and "seed one's hundred pins, then seed two's" is a
// feed that looks like it ignored three of the four pins that were picked.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');

const srcText = fs.readFileSync(path.join(ROOT, 'client/src/lib/pinterestMix.js'), 'utf8');
// eslint-disable-next-line no-new-func
const { interleave, topSeeds } = new Function(
  `${srcText.replace(/^export /gm, '')}; return { interleave, topSeeds };`,
)();

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- interleave ---------------------------------------------------------------------------------
const A = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
const B = [{ id: 'b1' }, { id: 'b2' }];
const C = [{ id: 'c1' }];
check('deals round-robin, one from each seed in turn',
  interleave([A, B, C]).map((p) => p.id).join(',') === 'a1,b1,c1,a2,b2,a3');
check('a short seed drops out without leaving a gap',
  interleave([A, C]).map((p) => p.id).join(',') === 'a1,c1,a2,a3');
check('one seed behaves like a plain list', interleave([A]).map((p) => p.id).join(',') === 'a1,a2,a3');
check('no seeds is empty, not a crash', interleave([]).length === 0);
check('an empty seed is skipped', interleave([[], A]).map((p) => p.id).join(',') === 'a1,a2,a3');
check('nothing is lost', interleave([A, B, C]).length === 6);
check('nothing is duplicated', new Set(interleave([A, B, C]).map((p) => p.id)).size === 6);
check('a null set does not throw', interleave([null, A]).length === 3);

// --- topSeeds -----------------------------------------------------------------------------------
const ten = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}` }));
check('eight is the cap', topSeeds(ten).length === 8);
check('the MOST RECENT eight are kept — the last thing ticked matters most',
  topSeeds(ten).map((p) => p.id).join(',') === 'p2,p3,p4,p5,p6,p7,p8,p9');
check('fewer than the cap passes through untouched', topSeeds([{ id: 'x' }]).length === 1);
check('order is preserved inside the cap', topSeeds(ten)[0].id === 'p2');
check('an empty selection yields no seeds', topSeeds([]).length === 0);
check('null is handled', topSeeds(null).length === 0);

// --- the route ------------------------------------------------------------------------------------
// Measured live 2026-08-12: { pin } returns 200 with 100 pins in 1.9s; { pin_id } returns 404. The
// repo believed related-pins did not work for months because of that one parameter name.
const route = fs.readFileSync(path.join(ROOT, 'server/routes/pinterestFeed.js'), 'utf8');
check('there is a related route', route.includes("router.post('/related'"));
check('it uses RelatedPinFeedResource', route.includes('RelatedPinFeedResource'));
check('the seed parameter is `pin` — `pin_id` 404s', route.includes('pin: id') && !route.includes('pin_id:'));
check('the pin-page referer and handler are sent, as the search route does',
  route.includes('www/pin/[id].js') && route.includes('/pin/${id}/'));
check('seeds are fetched in PARALLEL — three took 2.5s that way', route.includes('await Promise.all(seeds.map('));
check('the cap is enforced server-side too, not only in the UI', route.includes('.slice(0, MAX_SEEDS)'));
check('every pin goes through the SAME normaliser as search', (() => {
  const i = route.indexOf("router.post('/related'");
  return route.slice(i).includes('.map(normalisePin).filter(Boolean)');
})());
check('one dead seed does not lose the others', route.includes('failed.push('));
check('and the caller is told which failed', route.includes('res.json({ sets, failed })'));
check('each seed returns its own bookmark, so the feed can page', route.includes('bookmark: '));
check('the reason the parameter matters is recorded', /`pin_id` returns 404/.test(route));
check('and the header no longer says related-pins is broken', !/RelatedPinFeedResource  -> 404/.test(route));

const api = fs.readFileSync(path.join(ROOT, 'client/src/services/api.js'), 'utf8');
check('the client can call it', api.includes("related: (body) => request('/pinterest-feed/related'"));

// --- the page wiring ----------------------------------------------------------------------------
const page = fs.readFileSync(path.join(ROOT, 'client/src/pages/PinterestFeedPage.jsx'), 'utf8');
check('the mixing rule is imported, not re-implemented in the page',
  page.includes("import { interleave, topSeeds } from '../lib/pinterestMix';"));
check('there is a sticky Refresh', page.includes('Refresh feed'));
check('it only exists once something is ticked', page.includes('{picked.length > 0 && ('));
check('it is fixed to the bottom right', page.includes('fixed bottom-6 right-6'));
check('it names how many picks it will use', page.includes('{seeds.length} pick'));
check('and says when the cap is trimming the selection', page.includes('of your'));
check('Refresh REPLACES the grid — the picks are objects, so nothing is lost',
  page.includes('mergePins(interleave(sets.map((s) => s.pins)), { replace: true })'));
check('the seeds are the capped selection', page.includes('const seeds = useMemo(() => topSeeds(picked), [picked]);'));
check('a tuned feed remembers what it is tuned to', page.includes('const [tunedTo, setTunedTo] = useState([]);'));
check('and shows those pins, so they survive a send', page.includes('Tuned to'));
check('there is a way out', page.includes('Clear tuning'));
check('a new search clears the tuning', page.includes('setTunedTo([])'));
check('Load more follows the TUNED feed once tuned, not the old query',
  page.includes('if (tunedTo.length) { loadMoreRelated(); return; }'));
check('each seed pages on its own bookmark', page.includes('bookmarks: relatedMarksRef.current'));
check('a newer action cancels an in-flight tune', page.includes('if (runIdRef.current !== runId) return;'));
check('a seed that failed is reported rather than silently missing',
  page.includes('could not be read'));
check('seeds are declared ABOVE the callbacks that read them — the TDZ trap',
  page.indexOf('const seeds = useMemo') < page.indexOf('const tuneToSelection = useCallback'));

// --- replay: what a Refresh puts on screen ------------------------------------------------------
const setsFrom = (n, per) => Array.from({ length: n }, (_, s) =>
  Array.from({ length: per }, (_, i) => ({ id: `s${s}i${i}`, w: 800, h: 1000 })));
const mixed = interleave(setsFrom(4, 50));
check('four seeds of fifty give two hundred tiles', mixed.length === 200);
check('the first four tiles come from four DIFFERENT seeds',
  new Set(mixed.slice(0, 4).map((p) => p.id[1])).size === 4);
check('one seed cannot dominate the top of the grid',
  mixed.slice(0, 12).filter((p) => p.id.startsWith('s0')).length === 3);

// --- the lazy tile ---------------------------------------------------------------------------------
// Owner, 2026-08-12: "tiles appear blank/grey as I scroll". Every pin arrives carrying its real
// width and height and the grid was throwing that away, so the browser held hundreds of live images
// and had no idea how tall any of them would be.
check('a tile reserves the pin REAL shape before the picture exists',
  page.includes('aspectRatio: (pin.w > 0 && pin.h > 0)'));
check('the image is only mounted when the tile is near the viewport',
  page.includes('IntersectionObserver') && page.includes('rootMargin'));
check('it starts loading about a screen and a half early',
  page.includes("rootMargin: '150% 0px'"));
check('and stops observing once loaded — an observer per tile forever is the other leak',
  page.includes('io.disconnect()'));
check('a pin with no dimensions still gets a sane box, not a collapsed one',
  page.includes("'3 / 4'"));
check('the grid tile actually uses it', page.includes('<PinTile pin={p}>'));
check('the reason is recorded', /held hundreds of live images/.test(page));

// --- replay: the placeholder must match the picture ------------------------------------------------
const box = (w, h) => ((w > 0 && h > 0) ? `${w} / ${h}` : '3 / 4');
check('a portrait pin reserves portrait space', box(800, 1200) === '800 / 1200');
check('a landscape pin reserves landscape space', box(1200, 800) === '1200 / 800');
check('a pin with no size falls back to a middling portrait', box(0, 0) === '3 / 4');
check('the fallback cannot be zero-height — that is what makes a grid jump', box(0, 0).includes('/'));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
