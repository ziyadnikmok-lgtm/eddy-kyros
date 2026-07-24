# Eddy Generate — two-column layout

Branch `feat/run-pipeline`. Files touched: `client/src/pages/EddyGeneratePage.jsx`,
`client/src/App.jsx`, plus the committed `client/dist` rebuild.

## What changed

### 1. Two columns

`App.jsx` grew a third page-layout gate, `SELF_SCROLL_PAGES` (`eddyGenerate`, `eddy` — the same
two ids `FEED_HIDDEN_PAGES` already carries, because both route to `EddyGeneratePage`).

For a page in that set `<main>` stops being the scroller: it becomes
`flex flex-1 flex-col overflow-hidden` and its inner wrapper `flex min-h-0 flex-1 flex-col
max-w-none`. That hands the page a real, bounded height. It has to — a column can only hang
`overflow-y-auto` off an ancestor with a definite height, and `<main>`'s own `overflow-y-auto`
would have given the page an unbounded one instead. The gate is ordered first in the ternary so
neither of the existing two shapes changes for any other page.

The page root was `mx-auto max-w-3xl space-y-4` — a 768px column centred in a wide window, which
is where the dead margin came from once the feed was hidden. It is now:

```
flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto animate-in lg:flex-row lg:gap-5 lg:overflow-hidden
```

- **Left** (`w-full shrink-0 lg:w-[27rem] xl:w-[30rem] lg:min-h-0 lg:overflow-y-auto`) — the setup
  form, unchanged in content and order: photos, outfit, pose, instruction, final prompt,
  aspect/resolution, mode toggle, Generate. Fixed width at `lg`+ because it is a form, and a form
  stretched across a 2560px monitor is harder to read, not easier.
- **Right** (`flex w-full min-w-0 flex-1 flex-col lg:min-h-0 lg:overflow-y-auto`) — the results,
  in the space the shared Generation Feed used to hold. It takes all remaining width, which is what
  reclaims the margin.

`min-h-0` on both columns is load-bearing: a flex item defaults to `min-height:auto` and refuses to
shrink below its content, so without it the columns grow and the row scrolls instead of the panes.

**Below `lg` (1024px)** the row collapses to `flex-col`, the per-column scrollers switch off (they
are all `lg:`-prefixed) and the page scrolls as one document again. Two independently scrolling
panes side by side on a narrow screen would leave each a few centimetres tall; stacking is the
honest answer at that width.

### 2. Existing actions — read, moved, not rewritten

The action bar moved into the right column with its logic untouched: click-to-select
(`toggleResult`, uid-keyed), the shared instruction input, the `INSTRUCTION_PRESETS` chips filtered
by `BAR_PRESET_GROUPS` and the page's own `nsfw` flag, **Regenerate** (`regenerateSelected`, summed
per result via `r.regenCost` so a mixed-resolution selection prices correctly) and **Generate
video** (`openVideoConfirm` → `VideoConfirmGate` → `confirmVideo`, each clip at its pose's
`videoPrompt` and `clipDurationFor` duration). The only deleted lines in the whole diff are layout
wrappers and one instructional paragraph superseded by the column header — verified by reading
every `-` line in the diff.

### 3. Delete — added, and deliberately non-destructive

`removeSelected` drops the selected results **from this column only**. The images stay in the
Library and in the main gallery.

**The choice, stated:** every image here is already generated, already billed and already saved
server-side. A Delete that also reached into the Library would let one misclick destroy paid work
with no way back — and the button sits beside Regenerate in a bar the user clicks repeatedly during
a fix-it loop, which is precisely where a misclick happens. Clearing the tray is cheap and
reversible; deleting the asset is neither. So it is a "clear it off my workspace" action.

Being non-destructive is only useful if the user can tell, so it is said three ways: the button
reads `Remove {n}` (not "Delete"), a permanent line under the bar reads *"Remove clears them from
this list only — the images stay in your Library and can be found there any time"*, and the tooltip
and success toast repeat it. There is no confirmation gate, because nothing is lost.

Implementation notes:
- Keyed by `uid` throughout, so no surviving result can be re-paired with a neighbour's pose or
  `videoPrompt` the way an index-based removal could.
- Busy tiles are **skipped**, not removed: a tile mid-regenerate or mid-animate has a request in
  flight that will call back into `setResults` for its uid, and pulling it out would strand that
  callback and leave the user paying for an image with nowhere to land.
- Cleans `selectedUids`, `tileErrors` and the `videoFeedMap` entries pointing at removed uids, so
  the feed→tile map does not grow for the life of the session re-scanning entries that can never
  resolve.

### 4. Empty and busy states

- **Empty** — a dashed panel filling the column: "Nothing generated yet", plus one line pointing at
  the form and naming the three things you can do to a result. It replaces a blank right half that
  simply read as broken.
- **Busy** — `PendingTile`, one dashed `aspect-square` box per dispatched-but-unlanded image
  (`pendingCount = max(0, queued - done)`). Quiet on purpose: a grid of spinners reads as an error
  state, and the honest signal is "a slot is reserved for a picture". One 2.4s pulse, no chrome,
  `motion-safe:` only.
- Placeholders **lead** the grid because results are prepended, so each landing image takes the slot
  a placeholder just vacated: the cell count is constant and nothing already on screen moves.
- They are `aria-hidden`; the count is announced once by an `sr-only` `role="status"` live region
  above the grid instead of N times by N identical boxes.

## Preserved — walked one by one

| Item | Status |
|---|---|
| `PreRunConfirmGate` / video gate: `createPortal(…, document.body)`, `z-[150]`, backdrop cancel, `useScrollLock` | Untouched. Both gates still portal at `z-[150]`, both call `useScrollLock()`, both carry `onClick={onCancel}` on the backdrop. |
| Cancel dispatches zero requests | `onCancel` is `setShowPreRunConfirm(false)` / `setVideoConfirm(null)` — pure setState. The file has exactly two dispatch sites (`seedreamApi.edit`, `videoApi.generate`); `run()` is called only from `onConfirm`, `confirmVideo` only from `onConfirm`. Structurally unreachable from cancel. |
| Regenerate capped at `PARALLEL_REQUESTS`, video at `VIDEO_PARALLEL_REQUESTS`, both via `runPool` | All four `runPool` call sites unchanged (2 in `run()`, 1 in `regenerateSelected`, 1 in `confirmVideo`). Demonstrated below. |
| Tweak-conflict handling (five preserve rules soften with an instruction) | `buildPrompt` not touched — the diff contains **zero** lines matching `tweak|buildPrompt|preserve`. Bulk regenerate is still N calls of the one `generateCombo`. |
| Failed item keeps its image, shows its own error, does not abort the rest | `regenerateSelected` / `confirmVideo` error paths unchanged; `runPool` still swallows per-item throws. Demonstrated below (20 items, 4 throwing, 20 completed). |
| Selection + typed instruction persist after an action | Neither `regenerateSelected` nor `confirmVideo` clears `selectedUids` or `barInstruction`; unchanged. `removeSelected` drops only the uids it removed, which no longer exist. |
| Already-animated badge + "billed again" line | `hasClip()`, the `● Video` / `◌ Video` badge and `VideoConfirmGate`'s `alreadyAnimated` paragraph all untouched. |
| `GenerationFeedVideoWatcher` outside the feed gate | Still a sibling of `{showGenerationFeed && <GenerationFeedPanel …>}`, not inside it (App.jsx:815 vs 818). Not moved. |
| Results must not reflow while work is in flight | Tiles keyed by `uid`; busy state paints over the existing image in place; placeholders lead the grid and keep the cell count constant. |
| Feed renders normally elsewhere | `SELF_SCROLL_PAGES` is 2 ids, both already feed-hidden. Feed still shown on 16 pages. |

## Constraints

- No pricing constant, model id, cost arithmetic, duration clamp or prompt text changed — the diff
  contains no `+`/`-` line matching `PRICE|MODEL_ID|DURATION_M|seedreamCost|clipDurationFor|parseDurationSeconds`.
- Amber (`GATE_MONEY`) still money-only. The Delete button carries no dollar figure (nothing is
  billed, nothing refunded) so it uses no `Money` and no amber; its muted red is hover/focus-only,
  because a permanently red control in a bar you use constantly reads as a warning always shouting.
- Every new control has `GATE_FOCUS`; nothing is hover-gated; results stay keyboard-selectable
  (`<button>` + `aria-pressed`).

## Verification

### Executed against real code

**1. Build passes.**

```
✓ built in 5.38s
dist/assets/EddyGeneratePage-BgwvZMdP.js   46.12 kB │ gzip: 14.56 kB
```

**5. Concurrency caps hold** — driven through the real `client/src/lib/runPool.js`, with the caps
parsed out of the page source rather than retyped:

```
caps read from page source: { PARALLEL_REQUESTS: 6, VIDEO_PARALLEL_REQUESTS: 2 }
regenerateSelected:        items=20 cap=6 peak_in_flight=6 completed=20 threw=0 -> CAP HELD
confirmVideo:              items=20 cap=2 peak_in_flight=2 completed=20 threw=0 -> CAP HELD
regenerate w/ 4 failures:  items=20 cap=6 peak_in_flight=6 completed=20 threw=4 -> CAP HELD
```

The third line is also the "a failed item does not abort the rest" check: 4 of 20 workers threw and
all 20 still completed.

**3. Delete behaves as described** — the actual `removeSelected` body was extracted from the source
file and executed against fixtures (28 lines of real source, not a reimplementation). Fixture: 4
results with distinct `videoPrompt`s, selection `{a,c,d}`, with `c` mid-regenerate.

```
remaining results:
  b  galleryId=g-b  videoPrompt="PROMPT-B zoom in"
  c  galleryId=g-c  videoPrompt="PROMPT-C tilt up"
selection now : [ 'c' ]
tileErrors now: { c: 'bang', b: 'keep-me' }
feedMap now   : [ [ 'feed2', 'b' ], [ 'feed3', 'c' ] ]
notified      : [ 'Removed 2 from results — still in your Library' ]

PASS  a and d removed (selected, not busy)
PASS  c KEPT (selected but mid-regenerate)
PASS  b KEPT and still paired to PROMPT-B
PASS  no surviving result inherited a neighbour
PASS  selection drained of removed uids
PASS  b's tile error untouched
PASS  removed uids' errors cleared
PASS  feedMap dropped a, kept b and c
PASS  says Library in the toast
```

**4. Cancelling dispatches zero requests** — by reachability over the real source. The file has
exactly two network dispatch sites:

```
1236:  data = await seedreamApi.edit({ … })
1369:  res  = await videoApi.generate({ … })
```

`run()` is called from exactly one place and `confirmVideo` from exactly one place, both `onConfirm`:

```
2134:  onConfirm={() => { setShowPreRunConfirm(false); run(); }}
2135:  onCancel={() => setShowPreRunConfirm(false)}
2148:  onConfirm={confirmVideo}
2149:  onCancel={() => setVideoConfirm(null)}
```

Both `onCancel` handlers are pure `setState`, and the gates' cancelling backdrops call the same
`onCancel`. No dispatch site is reachable from either.

**6. Feed still renders elsewhere** — `SELF_SCROLL_PAGES` is 2 ids, both already in
`FEED_HIDDEN_PAGES`, so no page changed feed visibility:

```
SELF_SCROLL_PAGES = [ 'eddyGenerate', 'eddy' ]
total nav pages: 32 | feed hidden on: 20 | feed SHOWN on: 16
feed still shown on: seedreamEdit, outfitSwapSeedream, photoMatchSeedream, poseRemixSeedream,
  seedanceVideo, seedanceOmni, pasteInbox, photoMatch, outfitSwap, scene, postClone, carousel,
  poseFix, nanoBypass, video, admin
any self-scroll page also feed-shown? []
```

Two named: **`seedanceVideo`** and **`scene`**.

**7. Amber only on money** — grep of the added lines in the diff for `amber|f0b429|GATE_MONEY`
returns two hits, both inside a comment explaining the rule:

```
+  nothing is refunded — so there is no Money component and, per the amber rule,
+  no amber. The muted red appears on hover/focus only: a permanently red control
```

No amber class was added. Delete carries no dollar figure, so it uses no `Money`.

**Hook / dependency sweep** — ESLint run against a `git worktree` of `HEAD` and against the working
tree, then the message lists diffed. Exactly one new message:

```
> no-unused-vars :: 'PendingTile' is defined but never used.
```

Baseline 50 problems (10 errors, 40 warnings) → now 51 (10 errors, 41 warnings). That rule already
fires at baseline on `Money`, `ResultTile`, `PreRunConfirmGate` and `VideoConfirmGate` — the repo's
ESLint config does not count JSX usage — so it is the same known false positive, not a real finding.
**Zero** new errors and **zero** new `react-hooks/exhaustive-deps` warnings, which is the mechanical
answer to both "hooks used but not imported" and "dependency arrays referencing later consts".

### Measured in a real browser

`npm start` could not be used: `better-sqlite3` is built for `NODE_MODULE_VERSION 143` and the
installed Node 24.15.0 wants 137, and `npm rebuild` fails `EPERM` because the running Kyros
Electron app holds the `.node` file. Rather than kill the app or force the rebuild, measurement went
through the already-running Electron app, which serves the production bundle on
`http://127.0.0.1:18421` already authenticated. The loaded bundle was confirmed to contain the
restructure before measuring.

**Environment note that changes every number: root font-size is 20px** (the in-app TEXT control), so
Tailwind rem spacing runs at 1.25x — `lg:p-6` measures 30px, not 24px.

**2a. Side by side at 1600x900, nothing clipped.**

| | x | y | width | height | right |
|---|---|---|---|---|---|
| left column | 411 | 151 | 600 | 728 | 1011 |
| right column | 1036 | 151 | 513 | 728 | 1549 |

Left's right edge 1011 ≤ right's x 1036 — side by side with a 25px gutter, same `y`, same height.
`body.scrollWidth` 1600 = `innerWidth` 1600 (no horizontal scroll); `documentElement.scrollHeight`
900 = `clientHeight` 900 (the page itself does not scroll — `<main>`'s scroller really is off).

**2b. Independent scrolling, confirmed both directions.**

```
before:              left.scrollTop=0    right.scrollTop=0
set left  = 400   →  left.scrollTop=400  right.scrollTop=0    window.scrollY=0
set left  = 300   →  left.scrollTop=300  right.scrollTop=0
set right = 600   →  left.scrollTop=300  right.scrollTop=600  window.scrollY=0
```

`window.scrollY` stays 0 throughout — neither column drags the page.

**2c. Dead margin gone.** Right column's right edge 1549 vs `innerWidth` 1600 = a 51px gap, which is
30px of `<main>` padding plus the app shell's symmetric 21px inset (the sidebar starts at x=21).
Every ancestor from the right column up to `<body>` reports `max-width: none` —
`513 → 1138 → 1138 → main 1198 → … → body 1600` — so the old `max-w-3xl` (768px) cap is gone.

**2d. Stacked at 1000x900**, below the `lg` breakpoint. Row `flex-direction: column`; left at
y=136 h=1867, right at y=2023 h=217, so right.y > left.y. Neither crushed: both at the full 928px
width, both `overflow-y: visible` with `scrollHeight == clientHeight` (1867/1867, 217/217) — full
natural height, nothing clipped. Scrolling correctly reverts to one document scroller (row
`overflow-y: auto`, `scrollHeight` 2103 vs `clientHeight` 748). No horizontal scroll.

**2e. Empty state** renders in the right column at `x=1036 y=189 w=513 h=691`, reading "Nothing
generated yet" plus the pointer to the form, under a `RESULTS · 0 results` header.

Screenshots: `scratchpad/eddy-1600x900.png`, `eddy-1000x900-top.png`, `eddy-1000x900-bottom.png`.

### A real bug the measurement caught

The 1600x900 numbers show the left column at **600px** and the right at **513px** — the form wider
than the results, on a page whose whole point is the results. Cause: the left column was sized
`lg:w-[27rem]`, and the app's user-facing TEXT size control moves the root font-size (20px here), so
a rem width rides that 1.25x multiplier. This is exactly the class of thing reading the code cannot
find.

Fixed by switching the left column to pixels — `lg:w-[430px] xl:w-[460px]`, the same steps App.jsx
already uses for the control column on feed-dominant pages, so the app's two fixed columns now
match.

**Re-measured after the fix, at 1600x900.** New bundle confirmed live first: served script moved
`index-DbQ3Qcrn.js` → `index-nNnMrneL.js`, and the shipped chunk greps `lg:w-[430px]`=1,
`xl:w-[460px]`=1, `lg:w-[27rem]`=**0**, `xl:w-[30rem]`=**0**.

| | x | y | width | height | right |
|---|---|---|---|---|---|
| left column | 411 | 151 | **460** | 728 | 871 |
| right column | 896 | 151 | **653** | 728 | 1549 |

Results column now wider than the form by 193px, where before the fix it was 513 vs 600 the wrong
way round. Left's right edge 871 ≤ right's x 896, 25px gutter, same y and height. Still no
horizontal page scroll (1600 = 1600), page still does not scroll (900 = 900), left still scrollable
(`scrollHeight` 1753 > `clientHeight` 728).

**Regression-tested against the bug class, not just the one number.** Root font-size driven through
16 / 20 / 28px and re-measured (then restored):

```
16px -> left 460, right 678
20px -> left 460, right 653
28px -> left 460, right 603
```

Left is pinned at 460 at every text size and all slack goes to the results column;
`body.scrollWidth` stayed 1600 throughout. The rem inflation is genuinely gone, not masked at one
setting.

Note for whoever reads this next: at ≥1280px the `xl` step (460px) is what applies; the 430px value
only covers 1280 > w ≥ 1024.

**The tradeoff this introduces**, stated because it is a real consequence and not a bug: with the
left column fixed, larger text now shrinks the *right* column (678 → 603 across that range). The
results grid is therefore the thing that narrows at large text. Its track minimum is
`minmax(160px,1fr)` — **px, so it does not itself inflate with the text control** — meaning the grid
degrades linearly (roughly 4 columns → 3 at 28px text) rather than compounding the way a rem
minimum would. That is acceptable; it is noted so it is not rediscovered as a surprise.

### Does the TEXT-size control bite anywhere else on this page?

Surveyed but **deliberately not changed** — recording it so it is not rediscovered.

The hazard is specifically a *fixed rem width defining a layout box*. After the fix that pattern
appears **nowhere else on this page**. What remains, and why each is fine:

- `min-w-[12rem]` (action bar instruction input) — the only other arbitrary rem length used for
  layout, and it is a soft *minimum* on a `flex-1` input, not a fixed width. At 20px root it becomes
  240px instead of 192px, so the bar wraps one control earlier. Cosmetic.
- `max-w-sm` ×2 — the two confirmation gate panels (24rem → 480px instead of 384px). They are
  centred fixed overlays with `p-6` breathing room, so a wider receipt at larger text is arguably
  correct rather than wrong.
- `w-12 h-12`, `w-5 h-5`, `w-6 h-6`, `w-16` — thumbnails, the NSFW toggle knob, chip label gutters.
  Scaling these with text is the point of a text-size control.
- 36 arbitrary `text-[N rem]` font sizes — these *should* track the control. Not a hazard; that is
  the feature working.
- The results grid track `minmax(160px,1fr)` and the picker grids (`minmax(56px,1fr)`,
  `minmax(112px,1fr)`, `h-[180px]`, `h-[460px]`) are already px and therefore immune.

### Known environment issues (pre-existing, unrelated)

- Console shows CSP blocks on the Google Fonts stylesheet (`style-src 'self' 'unsafe-inline'`), so
  Outfit / JetBrains Mono fall back in this build. Not caused by this change.
- To run `npm start` standalone you must close the Electron app, `npm rebuild better-sqlite3`, and
  then `npm run rebuild:electron` to swap the ABI back. The same failure is already in the older
  `kyros-server.out` log.

