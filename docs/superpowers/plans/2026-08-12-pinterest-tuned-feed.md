# Tuned Pinterest Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tick pins you like, press Refresh, and the feed becomes Pinterest's own related-pins for
those pins — mixed evenly across all of them.

**Architecture:** A new server route calls `RelatedPinFeedResource` once per ticked pin in parallel
and normalises each result through the existing `normalisePin`. The client interleaves the sets
round-robin, deduplicates with the existing `imageKey`, and renders them through the grid that
already exists. Separately, tiles reserve their real aspect ratio and only load their image when
near the viewport.

**Tech Stack:** Express + axios (server), React 18 (client), plain Node check files under `tools/`
(no test framework in this repo).

## Global Constraints

- **The parameter is `pin`, never `pin_id`.** `{ pin_id }` returns 404. This is the mistake that made
  the repo believe related-pins did not work.
- Related calls need `Referer: https://www.pinterest.com/pin/<id>/` and
  `X-Pinterest-PWS-Handler: www/pin/[id].js`, mirroring what the search route already sends.
- **Seed cap: 8**, most recently ticked.
- **`MORE_TARGET`/backfill target stays 240** — the same ceiling the search feed uses.
- Every pin reaching the client goes through `normalisePin` — no second pin shape enters the app.
- Every failure names itself on screen. An empty grid must never be the way a failure is reported.
- Check files live in `tools/check-*.js`, derive `ROOT` from `__dirname`, and are run with
  `node tools/check-<name>.js`. No test framework, no test runner.
- Run **every** `tools/check-*.js`, `npx eslint src` and `npx vite build` before any commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/routes/pinterestFeed.js` (modify) | Add `POST /related`: fan out one `RelatedPinFeedResource` call per seed, normalise, return per-seed results. The existing `/search` handler and `normalisePin` are untouched. |
| `client/src/services/api.js` (modify, line 452-458) | Add `related: (body) => request('/pinterest-feed/related', ...)` beside `search`. |
| `client/src/lib/pinterestMix.js` (create) | `interleave(sets)` and `topSeeds(picked, max)` — pure, no React, so the mixing rule is testable on its own. |
| `client/src/pages/PinterestFeedPage.jsx` (modify) | Sticky Refresh, the "Tuned to" row, tuned-feed paging, and the lazy tile. |
| `tools/check-tuned-feed.js` (create) | The whole feature: the route's shape, the mix, the UI wiring, the lazy tile. |

---

### Task 1: The mixing rule, on its own

**Files:**
- Create: `client/src/lib/pinterestMix.js`
- Test: `tools/check-tuned-feed.js` (created here, extended by later tasks)

**Interfaces:**
- Produces: `interleave(sets: Array<Array<pin>>): Array<pin>`, `topSeeds(picked: Array<pin>, max=8): Array<pin>`

- [ ] **Step 1: Write the failing test**

Create `tools/check-tuned-feed.js`:

```js
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

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node tools/check-tuned-feed.js`
Expected: throws — `client/src/lib/pinterestMix.js` does not exist yet.

- [ ] **Step 3: Write the module**

Create `client/src/lib/pinterestMix.js`:

```js
/**
 * How several picked pins become one feed.
 *
 * Kept out of the page so the rule that decides what the owner sees first can be executed in a
 * check file without React. Both functions are pure.
 */

/**
 * Deal the sets out like cards: seed 1's first pin, seed 2's first, seed 3's first, then round
 * again.
 *
 * Concatenating instead would put one seed's hundred pins above everything else, and a mix of four
 * picks would only become visible after a lot of scrolling — which reads as "it ignored three of
 * the four I chose". A seed that runs out simply stops being dealt to.
 */
export function interleave(sets) {
  const lists = (sets || []).filter((s) => Array.isArray(s) && s.length);
  const out = [];
  const longest = lists.reduce((m, s) => Math.max(m, s.length), 0);
  for (let i = 0; i < longest; i += 1) {
    for (const list of lists) {
      if (i < list.length) out.push(list[i]);
    }
  }
  return out;
}

/**
 * The pins a Refresh actually uses.
 *
 * Capped at eight: past that the mix stops meaning anything and it is eight simultaneous requests
 * at a service that can rate-limit us. The MOST RECENT are kept, because the last thing ticked is
 * the clearest statement of what is wanted now.
 */
export function topSeeds(picked, max = 8) {
  const all = Array.isArray(picked) ? picked : [];
  return all.slice(Math.max(0, all.length - max));
}
```

- [ ] **Step 4: Run the test**

Run: `node tools/check-tuned-feed.js`
Expected: PASS — 14/14

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/pinterestMix.js tools/check-tuned-feed.js
git commit -m "feat(pinterest): the rule that mixes several picked pins into one feed"
```

---

### Task 2: The related-pins route

**Files:**
- Modify: `server/routes/pinterestFeed.js` (add a `POST /related` handler above `function safeJson`)
- Modify: `client/src/services/api.js:452-458`
- Test: `tools/check-tuned-feed.js` (extend)

**Interfaces:**
- Consumes: `normalisePin` (already exported from `server/routes/pinterestFeed.js`)
- Produces: `POST /api/pinterest-feed/related` with body `{ pins: string[], pageSize?: number, bookmarks?: Record<string,string> }`, returning `{ sets: [{ pin, pins, bookmark }], failed: string[] }`; and `pinterestFeed.related(body)` on the client.

- [ ] **Step 1: Write the failing test**

Append to `tools/check-tuned-feed.js`, immediately before the final `console.log`:

```js
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
check('and the caller is told which failed', route.includes('failed,'));
check('each seed returns its own bookmark, so the feed can page', route.includes('bookmark: '));
check('the reason the parameter matters is recorded', /`pin_id` returns 404/.test(route));

const api = fs.readFileSync(path.join(ROOT, 'client/src/services/api.js'), 'utf8');
check('the client can call it', api.includes("related: (body) => request('/pinterest-feed/related'"));
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node tools/check-tuned-feed.js`
Expected: FAIL — "there is a related route" and the rest of the new block.

- [ ] **Step 3: Add the route**

In `server/routes/pinterestFeed.js`, immediately above `function safeJson(text) {`, add:

```js
/**
 * How many pins one Refresh may be tuned to.
 *
 * Capped here as well as in the UI: the UI cap is a courtesy, this one is the guarantee. Eight
 * simultaneous requests is already a burst at a service that rate-limits.
 */
const MAX_SEEDS = 8;

/**
 * POST /api/pinterest-feed/related
 * body: { pins: [id, ...], pageSize?, bookmarks?: { [id]: bookmark } }
 *  -> { sets: [{ pin, pins: [...], bookmark }], failed: [id, ...] }
 *
 * Pinterest's own "more like this", one call per seed, in parallel.
 *
 * THE PARAMETER IS `pin`. `pin_id` returns 404, and that single mistake is why this repo recorded
 * RelatedPinFeedResource as broken when the tab was built. Measured live 2026-08-12: page_size 100
 * returns 100 pins in 1.9s, and three seeds in parallel took 2.5s for 140 usable tiles.
 *
 * A seed that fails is reported by id and skipped; the others still return. Losing a whole Refresh
 * because one pin went private is the failure worth avoiding.
 */
router.post('/related', async (req, res, next) => {
  const seeds = (Array.isArray(req.body?.pins) ? req.body.pins : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .slice(0, MAX_SEEDS);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.body?.pageSize) || 100));
  const bookmarks = req.body?.bookmarks && typeof req.body.bookmarks === 'object' ? req.body.bookmarks : {};

  if (!seeds.length) throw new AppError('At least one pin is required', 400, 'VALIDATION_ERROR');

  const failed = [];
  const sets = await Promise.all(seeds.map(async (id) => {
    const sourceUrl = `/pin/${id}/`;
    const options = {
      pin: id,
      page_size: pageSize,
      bookmarks: bookmarks[id] ? [bookmarks[id]] : [],
    };
    const url = `${PIN_BASE}/resource/RelatedPinFeedResource/get/`
      + `?source_url=${encodeURIComponent(sourceUrl)}`
      + `&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}`;
    try {
      const r = await axios.get(url, {
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/javascript, */*, q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Pinterest-PWS-Handler': 'www/pin/[id].js',
          Referer: `${PIN_BASE}${sourceUrl}`,
        },
      });
      if (r.status !== 200) {
        log.error('pinterest_related_status', { status: r.status, pin: id });
        failed.push(id);
        return { pin: id, pins: [], bookmark: null };
      }
      const body = typeof r.data === 'string' ? safeJson(r.data) : r.data;
      const data = body?.resource_response?.data;
      const results = Array.isArray(data) ? data : (data?.results || []);
      if (!Array.isArray(results)) {
        log.error('pinterest_related_shape', { pin: id });
        failed.push(id);
        return { pin: id, pins: [], bookmark: null };
      }
      return {
        pin: id,
        pins: results.map(normalisePin).filter(Boolean),
        bookmark: body?.resource_response?.bookmark || null,
      };
    } catch (err) {
      log.error('pinterest_related_unreachable', { pin: id, message: String(err?.message || '').slice(0, 200) });
      failed.push(id);
      return { pin: id, pins: [], bookmark: null };
    }
  }));

  // Every seed failing is a real failure, not an empty feed — say so with a code the client can read.
  if (failed.length === seeds.length) {
    throw new AppError('Pinterest returned nothing related to those pins', 502, 'PINTEREST_RELATED_FAILED');
  }
  res.json({ sets, failed });
});
```

- [ ] **Step 4: Add the client call**

In `client/src/services/api.js`, inside the `pinterestFeed` object (line 452-458), after the
`search` line:

```js
  // Pinterest's own "more like this", one call per ticked pin. See routes/pinterestFeed.js — the
  // seed parameter is `pin`, not `pin_id`.
  related: (body) => request('/pinterest-feed/related', { method: 'POST', body }),
```

- [ ] **Step 5: Verify the route parses and the checks pass**

Run: `node --check server/routes/pinterestFeed.js`
Expected: no output.

Run: `node tools/check-tuned-feed.js`
Expected: PASS — 26/26

- [ ] **Step 6: Prove it against the live endpoint, once**

This is a scrape; a green grep proves the code says the right words, not that Pinterest answers.
Run this throwaway (it needs no app running):

```bash
node -e "
const axios=require('./node_modules/axios');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const B='https://www.pinterest.com';
(async()=>{
  const id='26529085301010581';
  const su='/pin/'+id+'/';
  const o={pin:id,page_size:100,bookmarks:[]};
  const u=B+'/resource/RelatedPinFeedResource/get/?source_url='+encodeURIComponent(su)+'&data='+encodeURIComponent(JSON.stringify({options:o,context:{}}));
  const r=await axios.get(u,{headers:{'User-Agent':UA,'X-Requested-With':'XMLHttpRequest','X-Pinterest-PWS-Handler':'www/pin/[id].js',Referer:B+su},validateStatus:()=>true});
  const d=r.data&&r.data.resource_response&&r.data.resource_response.data;
  console.log('status',r.status,'pins',(Array.isArray(d)?d:(d&&d.results)||[]).length);
})();
"
```

Expected: `status 200 pins 100` (a different pin id is fine; any 200 with pins proves the shape).
If it returns 404, the parameter name is wrong — check it says `pin:` and not `pin_id:`.

- [ ] **Step 7: Commit**

```bash
git add server/routes/pinterestFeed.js client/src/services/api.js tools/check-tuned-feed.js
git commit -m "feat(pinterest): a related-pins route — Pinterest's own more-like-this

The repo recorded RelatedPinFeedResource as a 404 when this tab was
built. It works; it was called with pin_id and the parameter is pin.
Measured live: 100 related pins in 1.9s, three seeds in parallel in 2.5s.

One call per seed, in parallel, each normalised through the same
normalisePin the search uses. A seed that fails is named and skipped so
one private pin cannot cost the whole Refresh."
```

---

### Task 3: Refresh, the tuned row, and paging the tuned feed

**Files:**
- Modify: `client/src/pages/PinterestFeedPage.jsx`
- Test: `tools/check-tuned-feed.js` (extend)

**Interfaces:**
- Consumes: `interleave`, `topSeeds` (Task 1); `pinterestFeed.related` (Task 2); the page's existing
  `mergePins(incoming, { replace })`, `picked` (array of pin objects), `toggle(pin)`, `visible`,
  `backfilling`, `runIdRef`.
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

Append to `tools/check-tuned-feed.js`, immediately before the final `console.log`:

```js
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

// --- replay: what a Refresh puts on screen ------------------------------------------------------
const setsFrom = (n, per) => Array.from({ length: n }, (_, s) =>
  Array.from({ length: per }, (_, i) => ({ id: `s${s}i${i}`, orig: `https://i.pinimg.com/originals/aa/bb/cc/${s}${String(i).padStart(31, '0')}.jpg`, w: 800, h: 1000 })));
const mixed = interleave(setsFrom(4, 50));
check('four seeds of fifty give two hundred tiles', mixed.length === 200);
check('the first four tiles come from four DIFFERENT seeds',
  new Set(mixed.slice(0, 4).map((p) => p.id[1])).size === 4);
check('one seed cannot dominate the top of the grid',
  mixed.slice(0, 12).filter((p) => p.id.startsWith('s0')).length === 3);
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node tools/check-tuned-feed.js`
Expected: FAIL on "the mixing rule is imported..." and the rest of the page block.

- [ ] **Step 3: Import the rule and add the state**

In `client/src/pages/PinterestFeedPage.jsx`, after the `stashSourceHandoff` import, add:

```js
import { interleave, topSeeds } from '../lib/pinterestMix';
```

Immediately after the line `const runIdRef = useRef(0);`, add:

```js
  /**
   * WHAT THE FEED IS TUNED TO.
   *
   * `seeds` is what a Refresh would use right now — the ticked pins, capped. `tunedTo` is what the
   * feed on screen was actually built from, which is NOT the same list: a send unticks what it
   * sent, and the owner asked that the feed keep its taste afterwards. `tunedTo` is what the
   * "Tuned to" row shows, and what tells Load more to page the related feeds instead of the query.
   */
  const [tunedTo, setTunedTo] = useState([]);
  const [tuning, setTuning] = useState(false);
  // Each seed pages on its own bookmark, so they are kept per pin id rather than as one cursor.
  const relatedMarksRef = useRef({});
```

And immediately after the `pickedIds` memo, add:

```js
  const seeds = useMemo(() => topSeeds(picked), [picked]);
```

- [ ] **Step 4: Add the tune action**

In the same file, immediately BELOW the `search` useCallback (after its closing
`}, [bookmark, safe, notify, mergePins]);`), add:

```js
  /**
   * REFRESH — rebuild the feed from the pins that are ticked.
   *
   * One call, which fans out to one Pinterest request per seed in parallel; measured at 2.5s for
   * three seeds and ~140 usable tiles. The grid is REPLACED rather than appended to: the point is
   * "show me this instead", and nothing is lost because the selection holds pin objects.
   *
   * Shares runIdRef with search(), so a Refresh and a search can never both be writing into the
   * grid — whichever started last owns it.
   */
  const tuneToSelection = useCallback(async () => {
    if (!seeds.length) return;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setTuning(true);
    setError('');
    try {
      const r = await pinterestFeed.related({ pins: seeds.map((p) => p.id), pageSize: 100 });
      if (runIdRef.current !== runId) return;
      const sets = Array.isArray(r.sets) ? r.sets : [];
      const added = mergePins(interleave(sets.map((s) => s.pins)), { replace: true });
      relatedMarksRef.current = Object.fromEntries(sets.filter((s) => s.bookmark).map((s) => [s.pin, s.bookmark]));
      setTunedTo(seeds);
      setBookmark(null);          // the text query's cursor no longer applies
      const failed = Array.isArray(r.failed) ? r.failed.length : 0;
      notify(failed
        ? `${added} tiles from ${seeds.length - failed} of ${seeds.length} picks — ${failed} could not be read`
        : `${added} tiles from ${seeds.length} pick${seeds.length === 1 ? '' : 's'}`,
      failed ? 'info' : 'success');
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setError(err?.message || 'Could not tune the feed');
    } finally {
      if (runIdRef.current === runId) setTuning(false);
    }
  }, [seeds, mergePins, notify]);

  /**
   * Load more, for a tuned feed: page every seed once and interleave again, so the feed keeps its
   * balance as it grows rather than drifting toward whichever seed has the deepest tail.
   */
  const loadMoreRelated = useCallback(async () => {
    const ids = tunedTo.map((p) => p.id).filter((id) => relatedMarksRef.current[id]);
    if (!ids.length) { notify('No more from those pins', 'info'); return; }
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setTuning(true);
    try {
      const r = await pinterestFeed.related({ pins: ids, pageSize: 100, bookmarks: relatedMarksRef.current });
      if (runIdRef.current !== runId) return;
      const sets = Array.isArray(r.sets) ? r.sets : [];
      const added = mergePins(interleave(sets.map((s) => s.pins)));
      for (const s of sets) relatedMarksRef.current[s.pin] = s.bookmark || null;
      notify(added ? `${added} more` : 'Nothing new from those pins', added ? 'success' : 'info');
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setError(err?.message || 'Could not load more');
    } finally {
      if (runIdRef.current === runId) setTuning(false);
    }
  }, [tunedTo, mergePins, notify]);
```

- [ ] **Step 5: Clear the tuning when a new search runs**

In the same file, inside the `search` useCallback, immediately after the line
`setError('');` near the top of the function body, add:

```js
      // A typed search is the way out of a tuned feed — it replaces the grid, so the tuning it was
      // built from no longer describes what is on screen.
      if (!more) { setTunedTo([]); relatedMarksRef.current = {}; }
```

- [ ] **Step 6: Route Load more to whichever feed is showing**

Find the Load more button (search: `{bookmark && visible.length > 0 && (`) and replace its
`onClick={() => search(query, true)}` with:

```jsx
          onClick={() => { if (tunedTo.length) { loadMoreRelated(); return; } search(query, true); }}
```

And change its render condition from `{bookmark && visible.length > 0 && (` to:

```jsx
      {(bookmark || tunedTo.length > 0) && visible.length > 0 && (
```

- [ ] **Step 7: Add the "Tuned to" row**

Immediately ABOVE the masonry block (search for the comment
`{/* One flex column per bucket.`), add:

```jsx
      {/* WHAT THE FEED IS BUILT FROM. Shown separately from the selection because a send unticks
          what it sent while the tuning survives — without this row those pins would be invisible
          and the feed would look like it had drifted on its own. */}
      {tunedTo.length > 0 && (
        <Card className="flex flex-wrap items-center gap-2 p-3">
          <Badge color="green">Tuned to {tunedTo.length} pin{tunedTo.length === 1 ? '' : 's'}</Badge>
          <div className="flex flex-wrap gap-1.5">
            {tunedTo.map((p) => (
              <img key={p.id} src={p.thumb} alt="" loading="lazy" referrerPolicy="no-referrer"
                className="h-10 w-8 rounded border border-white/[0.08] object-cover bg-zinc-900" />
            ))}
          </div>
          <button
            onClick={() => { setTunedTo([]); relatedMarksRef.current = {}; }}
            className="text-xs text-zinc-500 underline hover:text-zinc-300 cursor-pointer"
          >
            Clear tuning
          </button>
        </Card>
      )}
```

- [ ] **Step 8: Add the sticky Refresh button**

At the very end of the component's returned JSX, immediately before the final `</div>`, add:

```jsx
      {/* STICKY, bottom right: the feed is scrolled while picking, and a button at the top of the
          page would be off screen exactly when it is wanted. */}
      {picked.length > 0 && (
        <div className="fixed bottom-6 right-6 z-30">
          <Btn onClick={tuneToSelection} disabled={tuning} className="shadow-xl">
            {tuning ? <Spinner size={14} /> : null}
            Refresh feed · {seeds.length} pick{seeds.length === 1 ? '' : 's'}
            {picked.length > seeds.length && (
              <span className="ml-1 text-[0.625rem] opacity-75">of your {picked.length}</span>
            )}
          </Btn>
        </div>
      )}
```

- [ ] **Step 9: Run the checks, lint and build**

Run: `node tools/check-tuned-feed.js`
Expected: PASS — 45/45

Run: `for f in tools/check-*.js; do node "$f" | tail -1; done`
Expected: every line reads PASS.

Run: `cd client && npx eslint src && npx vite build`
Expected: 0 errors, build succeeds.

- [ ] **Step 10: Commit**

```bash
git add client/src/pages/PinterestFeedPage.jsx tools/check-tuned-feed.js client/dist
git commit -m "feat(pinterest): Refresh the feed from the pins you ticked

A sticky Refresh appears the moment a pin is ticked. It asks Pinterest
what is related to each ticked pin, in parallel, and deals the answers
round-robin so all of them shape the feed evenly rather than the first
one filling the screen.

The grid is replaced and the ticks stay. A send unticks what it sent but
the feed keeps its taste — the pins it was built from are shown in a
Tuned to row, with Clear tuning as the way out. Load more pages every
seed and interleaves again; a typed search leaves the tuned feed."
```

---

### Task 4: Tiles that do not go grey while scrolling

**Files:**
- Modify: `client/src/pages/PinterestFeedPage.jsx` (the tile `<img>`, currently at ~line 589)
- Test: `tools/check-tuned-feed.js` (extend)

**Interfaces:**
- Consumes: `p.w`, `p.h` from `normalisePin` (already present on every pin).
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

Append to `tools/check-tuned-feed.js`, immediately before the final `console.log`:

```js
// --- the lazy tile ---------------------------------------------------------------------------------
// Owner, 2026-08-12: "tiles appear blank/grey as I scroll". Every pin arrives carrying its real
// width and height and the grid was throwing that away, so the browser held hundreds of live images
// and had no idea how tall any of them would be.
check('a tile reserves the pin\'s REAL shape before the picture exists',
  page.includes('aspectRatio: `${p.w} / ${p.h}`'));
check('the image is only mounted when the tile is near the viewport',
  page.includes('IntersectionObserver') && page.includes('rootMargin'));
check('it starts loading about a screen and a half early',
  page.includes("rootMargin: '150% 0px'"));
check('and stops observing once loaded — an observer per tile forever is the other leak',
  page.includes('io.disconnect()'));
check('a pin with no dimensions still gets a sane box, not a collapsed one',
  page.includes('p.w > 0 && p.h > 0'));
check('the reason is recorded', /held hundreds of live images/.test(page));

// --- replay: the placeholder must match the picture ------------------------------------------------
const box = (w, h) => ((w > 0 && h > 0) ? `${w} / ${h}` : '3 / 4');
check('a portrait pin reserves portrait space', box(800, 1200) === '800 / 1200');
check('a landscape pin reserves landscape space', box(1200, 800) === '1200 / 800');
check('a pin with no size falls back to a middling portrait', box(0, 0) === '3 / 4');
check('the fallback cannot be zero-height — that is what makes a grid jump', box(0, 0).includes('/'));
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node tools/check-tuned-feed.js`
Expected: FAIL on the lazy-tile block.

- [ ] **Step 3: Add the lazy tile component**

In `client/src/pages/PinterestFeedPage.jsx`, immediately above
`export default function PinterestFeedPage() {`, add:

```jsx
/**
 * One tile's picture, loaded only when it is nearly on screen.
 *
 * The grid rendered every image at once, so the browser held hundreds of live images and the
 * pictures could not keep up with a scroll — grey boxes that filled in a moment later (owner,
 * 2026-08-12). Native loading="lazy" was already on and did not fix it: it defers the FETCH but
 * still creates every element, and its margin is the browser's choice, not ours.
 *
 * Two things make this work. Pinterest sends each pin's real width and height, so the tile can
 * reserve exactly the right box before the picture exists — nothing shifts when it lands. And a
 * 150% rootMargin starts the load a screen and a half early, so it is ready by the time it is
 * reached rather than starting when it arrives.
 */
function PinTile({ pin, children }) {
  const ref = useRef(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();          // one shot: a picture already loaded never needs watching again
      }
    }, { rootMargin: '150% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  return (
    <div
      ref={ref}
      // The pin's own proportions, so the column has its final height before the picture arrives.
      style={{ aspectRatio: (pin.w > 0 && pin.h > 0) ? `${pin.w} / ${pin.h}` : '3 / 4' }}
      className="w-full bg-zinc-900"
    >
      {near ? children : null}
    </div>
  );
}
```

- [ ] **Step 4: Wrap the tile image**

Find the grid tile `<img>` (search: `src={p.thumb}` — the one with the `onError` proxy fallback)
and wrap it in the new component. The `<img>` element itself is unchanged except that it fills
the reserved box:

```jsx
                <PinTile pin={p}>
                  <img
                    src={p.thumb}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      const el = e.currentTarget;
                      if (el.dataset.viaProxy) return;
                      el.dataset.viaProxy = '1';
                      el.src = pinterestFeed.proxyUrl(p.thumb);
                    }}
                    className="h-full w-full object-cover bg-zinc-900"
                  />
                </PinTile>
```

- [ ] **Step 5: Run the checks, lint and build**

Run: `node tools/check-tuned-feed.js`
Expected: PASS — 55/55

Run: `for f in tools/check-*.js; do node "$f" | tail -1; done`
Expected: every line reads PASS.

Run: `cd client && npx eslint src && npx vite build`
Expected: 0 errors, build succeeds.

- [ ] **Step 6: Manual check, because no test proves it**

Rebuild, reopen Kyros, search something broad, and scroll fast. Expected: no layout jumping (every
box is its final size immediately), and pictures already present as you arrive rather than filling
in behind you.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/PinterestFeedPage.jsx tools/check-tuned-feed.js client/dist
git commit -m "perf(pinterest): tiles reserve their real shape and load a screen early

Grey tiles while scrolling: the grid rendered every image at once, so the
browser held hundreds of live images, and native loading=lazy did not
help — it defers the fetch but still creates every element, with a margin
the browser chooses.

Each pin arrives with its real width and height, which the grid was
throwing away. A tile now reserves exactly that box before the picture
exists — so nothing shifts when it lands — and an IntersectionObserver
mounts the image at 150% of the viewport, a screen and a half early."
```

---

## Self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 related route, parallel, `pin` not `pin_id`, normalisePin, per-seed bookmarks, failed seeds | Task 2 |
| §1 round-robin interleave, dedupe, 8-seed cap | Task 1 (rule) + Task 2 (server cap) + Task 3 (wiring) |
| §2 sticky Refresh, replaces grid, ticks stay | Task 3 |
| §2 "Tuned to" row, Clear tuning, seeds survive a send | Task 3 |
| §2 Load more follows the tuned feed; a new search exits tuning | Task 3 |
| §3 aspect-ratio placeholder + IntersectionObserver at ~1.5 screens | Task 4 |
| Testing section | `tools/check-tuned-feed.js`, extended by every task |

No gaps.

**Placeholder scan:** none — every step carries the code to paste, exact anchors to search for, and
the command to run with its expected output.

**Type consistency:** `interleave(sets)` and `topSeeds(picked, max)` are named identically in the
module, the checks and the page. The route returns `{ sets: [{ pin, pins, bookmark }], failed }` and
Task 3 reads exactly those names. `mergePins(incoming, { replace })` matches the existing signature
in the page. `tunedTo`, `seeds`, `relatedMarksRef` and `tuning` are introduced in Task 3 Step 3 and
used only afterwards.

**One deliberate ordering note:** Task 3 Step 3 places `const seeds = ...` after the `pickedIds`
memo, and `tunedTo` after `runIdRef`. Both sit ABOVE the callbacks that read them. A dependency
array is evaluated during render, so a `useCallback` naming a const declared further down is a
temporal-dead-zone error that blanks the page — it has happened four times in this repo, and
`tools/check-tdz-deps.js` is the net.
