# Tuning the Pinterest feed to the pins you pick — design

**Goal:** Tick photos you like, press Refresh, and the feed becomes Pinterest's own "more like this"
for those photos — mixed evenly across all of them.

**Status:** shape approved in conversation, 2026-08-12.

---

## The finding that makes this possible

The repo has said since the tab was built that related-pins does not work:

```
BaseSearchResource      -> 200
RelatedModulesResource  -> 404
RelatedPinFeedResource  -> 404      <-- wrong
BoardFeedResource       -> 400
```

`RelatedPinFeedResource` **works**. It was called with `pin_id`; the parameter is `pin`. Measured
against the live endpoint on 2026-08-12, with a `/pin/<id>/` referer and the `www/pin/[id].js`
handler header:

| call | result |
|---|---|
| `{ pin: <id>, page_size: 25 }` | 200 — 24 pins |
| `{ pin: <id>, page_size: 50 }` | 200 — 50 pins, 1.5s |
| `{ pin: <id>, page_size: 100 }` | 200 — 100 pins, 1.9s |
| `{ pin_id: <id> }` | 404 — the original mistake |
| 3 seeds in parallel | **2.5s total → 148 pins → 142 unique → 140 above the 600px gate** |
| overlap between two seeds' sets | 1 of 48 |
| pagination | bookmark returned, same mechanism as search |

Two things follow. This is Pinterest's real algorithm rather than an approximation of it, and it is
**faster per pin than the text search** already in use (related: 100 pins in 1.9s; search: 91 in
2.7s, 241 in 6-8.5s).

The near-zero overlap between seeds is what makes mixing worth doing: four seeds genuinely widen the
feed instead of returning the same pins four times.

---

## 1 · Where the pins come from

New route: `POST /api/pinterest-feed/related`, body `{ pins: [id, ...], pageSize, bookmarks }`.

- One `RelatedPinFeedResource` call per seed, **in parallel**.
- Each result normalised through the existing `normalisePin`, so the client receives exactly the
  shape it already renders. No new pin shape enters the app.
- Returns per-seed arrays plus each seed's bookmark, so the client can interleave and page.
- A seed whose call fails is skipped and named in the response; the other seeds still return. One
  dead pin must not cost the whole Refresh.

**Interleaved round-robin**, not concatenated: seed 1's first pin, seed 2's first, seed 3's first,
then around again. Concatenating would put 100 pins from the first seed above everything else, and
the mix would only be visible after a lot of scrolling.

Then through the existing `imageKey` dedupe, so the same picture reached from two seeds appears
once.

**Seeds are capped at 8**, most recently ticked. Past that the mix stops meaning anything and it is
eight simultaneous requests at a service that can rate-limit us. When more are ticked the button
says which count is being used.

---

## 2 · What Refresh does

A sticky button, bottom right, present whenever at least one pin is ticked:
**`Refresh feed · 3 picks`**.

- **Replaces** the grid with the mix. Every tick stays.
- Nothing is lost when the old grid goes: the selection holds pin objects, not ids (fixed
  2026-08-11 — that was the bug where picks from an earlier search vanished on send).
- Above the grid: **`Tuned to 3 pins`** with their thumbnails, and **Clear tuning**, which returns
  to a plain search.
- The background top-up already built for search runs here too: after the first parallel round it
  keeps paging each seed's bookmark until ~240 tiles.
- **Load more** continues the tuned feed, not the old text query.
- Typing a new search **exits tuning** — that is the way out, alongside Clear tuning.

**Ticking now does two jobs**: queue for Photo Match, and tune the feed. A send empties the queue but
**keeps the pins as seeds** (owner's choice), so the feed holds its taste after a batch goes out.
The "Tuned to" row is what makes them visible once they are no longer ticked.

---

## 3 · Tiles that go grey while scrolling

Every pin arrives from Pinterest carrying its real width and height, and the grid currently throws
that away at render time. So:

- Each tile **reserves its exact aspect ratio** as a placeholder box.
- The `<img>` receives its `src` only when an IntersectionObserver reports the tile within roughly
  **1.5 screens** of the viewport.

Two effects: the browser is no longer holding three hundred live images, and a picture starts
loading a screenful before it is reached rather than as it arrives. No layout shift, because the box
was already the right size.

**Not full windowed virtualisation.** With known aspect ratios this gets nearly all of the benefit
for a fraction of the complexity, and it does not fight the hand-bucketed masonry columns — which
exist because CSS `column-count` re-balanced every tile on append and moved pins out from under the
cursor.

---

## Order

Related route → Refresh + interleave → tuned-feed paging → lazy tiles.

The first two are the feature; the third makes it behave like the search feed; the fourth is
independent and helps the plain search just as much.

---

## Testing

`tools/check-tuned-feed.js`, in the pattern of the other 30 suites — run the real functions, not
greps, wherever the claim is about behaviour.

- the interleave deals round-robin and stops cleanly when one seed runs out
- a seed that fails is skipped, and the others still land
- the same picture from two seeds appears once (`imageKey`, already proven)
- more than 8 ticked uses 8 and says so
- a send keeps the seeds and empties the queue
- a new search clears tuning
- the aspect-ratio placeholder matches the pin's real w/h, so nothing shifts
- a tile outside the margin has no `src`; a tile inside has one

Manual, because no test proves it: tick one pin, Refresh, and see whether the feed actually looks
like it. That is the whole feature and it is a judgement.

---

## Known limits, stated up front

**It is a scrape.** `RelatedPinFeedResource` can change or be gated without notice, exactly like the
search resource. It fails the same way — named on screen, never an empty grid — and the tab keeps
working as plain search if it goes.

**Related feeds are per pin, not per taste.** Pinterest is not learning an account-level profile for
us; each Refresh is computed fresh from the pins ticked at that moment. Untick a pin and its
influence is gone on the next Refresh. This is simpler than what Pinterest does for a logged-in
user, and it is also more predictable — the feed reflects exactly what is on screen as ticked.

**Eight seeds is a judgement, not a measurement.** Three in parallel took 2.5s; eight has not been
timed against the live endpoint and may be slower or may draw a rate limit. If it does, the cap
comes down and the reason gets recorded here.
