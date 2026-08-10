# Pinterest tab — design

**Goal:** Browse real Pinterest results in a masonry grid inside Kyros, tick images, and send them
straight into Photo Match (or another Seedream tab) as source photos — without leaving the app.

**Status:** approved in conversation 2026-08-10. Owner asked to build everything and review after.

---

## What was verified before designing

Not assumed — run against the live endpoint from this machine:

| Endpoint | Result |
|---|---|
| `BaseSearchResource` (search pins) | **HTTP 200, 11 results, bookmark for paging** |
| `RelatedModulesResource` (related pins) | HTTP 404 |
| `RelatedPinFeedResource` (related pins) | HTTP 404 |
| `BoardFeedResource` (a board's pins) | HTTP 400 |

**No cookies, no login, no API key.** The owner asked whether their Pinterest cookies were needed:
they are not. Cookies would only reach *their own* private boards and personalised home feed;
public search does not need them.

Two consequences, and they are the reason the feature list below is shorter than the ten items
discussed:

- **"More like this" is not built.** Both related-pin resources 404. Guessing further resource
  names would produce a button that works today and dies silently later. A *"search this pin's
  description"* action is offered instead, which uses the endpoint that actually works.
- **Board browsing is not built.** `BoardFeedResource` 400s. The existing single-pin scraper in
  `server/routes/pinterest.js` still handles a pasted pin URL, and is untouched.

---

## Architecture

One new server route, one new page. Nothing existing changes.

```
Pinterest tab (client)                 server/routes/pinterestFeed.js
  ─ type a query          ──POST──►    /api/pinterest-feed/search
                                         └─► pinterest.com BaseSearchResource
  ─ masonry grid          ◄─────────    { pins: [...], bookmark }
  ─ scroll                ──POST──►    same route + bookmark  (next page)
  ─ tick N pins
  ─ [Send to ▾]           ──GET───►    /api/pinterest/proxy?url=…   (EXISTS already)
                          ──event──►   kyros:use-as-<tab>-source
```

**The proxy is the load-bearing piece and it already exists.** `i.pinimg.com` refuses requests
with a browser `Origin`, so the client can never fetch a pin directly; every image — thumbnail and
full-size — goes through `/api/pinterest/proxy`, which is already written, already used by the old
Pinterest page, and needs no change.

### Why a new route rather than extending `pinterest.js`

That file is 625 lines and does something different: it takes ONE pin URL and scrapes it through a
third-party downloader (klickpin) to get video variants. Search is a different upstream, a
different shape, and a different failure mode. Keeping them apart means a Pinterest markup change
breaks one and not the other.

---

## Components

### `server/routes/pinterestFeed.js` (new)

`POST /api/pinterest-feed/search` — `{ query, bookmark?, safe? }` → `{ pins, bookmark }`

- Calls `BaseSearchResource` with the `X-Pinterest-PWS-Handler` header (required; without it the
  endpoint 403s).
- Normalises each result to `{ id, thumb, orig, w, h, alt, domain }`. Pinterest's shape is deeply
  nested and varies by pin type; a normaliser at the boundary means the client never sees that.
- Drops results with no `images.orig` — video pins and ads, which cannot be used as a source.
- **429 is reported as 429**, not as an empty result. An empty grid reads as "no matches" and
  sends the user off to retype their query; a rate-limit needs a wait, and saying so is the
  difference between the two.
- 12s timeout. A hung upstream must not hold a Kyros request open.

### `client/src/pages/PinterestFeedPage.jsx` (new)

- **Masonry grid** via CSS columns — the real Pinterest layout, and it needs no JS measurement
  pass, so it cannot jank on a fast scroll.
- **Tick to select**, with a count and a Clear.
- **Send to ▾** — Photo Match, Scene Recreate, Pose Remix, Outfit Swap. All four listeners already
  exist and are already used by the Library, so this is the same handoff, not a new one.
- Registered in `VALID_PAGE_IDS` as `pinterestFeed`. The existing `pinterest` id is left alone.

---

## The four features that ship

Chosen because each one prevents a specific, observed cost. The other six from the conversation are
follow-ups; two are impossible on this data source and are named above.

**1. Dedupe against the Library.** Pinterest repeats the same image across boards relentlessly.
Each result's origin URL is checked against what has already been imported and shown dimmed with an
"in Library" tag. Without it the same photo is imported and paid for more than once.

**2. Minimum-resolution gate.** Pinterest serves 236px thumbnails beside 1200px originals. A 400px
source produces a soft result and nothing on screen explains why. Anything under 600px on its long
edge is hidden by default, with the real pixel size on every tile.

**3. Selection survives navigation.** Ticks persist to IndexedDB. Same lesson as the run-queue bug
fixed earlier today: leaving the tab must not silently discard work.

**4. Rate-limit backoff.** A 429 pauses paging and says so, with a countdown. Fast scrolling will
hit Pinterest's limit; an empty grid that looks like "no results" is the failure worth avoiding.

---

## Error handling

Every failure names itself. The rule throughout: an empty grid must never be the way the user
learns something broke.

| Failure | Behaviour |
|---|---|
| Upstream 429 | "Pinterest is rate-limiting — waiting Ns", paging pauses, countdown shown |
| Upstream 403 / shape change | "Pinterest changed its search response" — explicit, because this WILL happen eventually |
| Proxy fails on one image | That tile shows broken; the other selected pins still send |
| No results | "No pins for that search" — distinct from every error above |

---

## Testing

`tools/check-pinterest-feed.js`, following the pattern of the other 14 suites: execute the real
normaliser against captured Pinterest payloads rather than grepping the source.

- The normaliser drops a video pin (no `images.orig`) rather than emitting a broken tile
- A 236px thumbnail is filtered by the resolution gate; a 1200px original is not
- Dedupe matches on origin URL, and does NOT match a different pin that merely shares a filename
- 429 surfaces as a rate-limit, never as zero results
- The send handoff emits the event name each destination tab actually listens for

Manual, because no test can prove it: one real search, tick three, send to Photo Match, confirm
three sources land.

---

## Known limits, stated up front

**This is a scrape.** It works today. Pinterest can change or gate that endpoint without notice and
the tab would stop returning results. It is worth building — it is not worth depending on for
anything time-critical, and the error message says so plainly when it breaks.

**No board browsing and no related-pins.** Both endpoints were tested and both fail. Named here so
nobody re-derives it.
