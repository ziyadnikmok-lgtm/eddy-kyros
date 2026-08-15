# Pose tags + pose randomiser — implementation brief

**The ask (owner, 2026-08-14):**
> "First I need the poses to have one extra label. The label of Mirror selfie so that all poses with
> mirror selfie have that label. Then feature where it randomise poses selection, i write a number of
> how many poses i want, and choose the labels of poses i want and click randomise and it will pick
> the same amount of poses i write down but randomly."

Two features in the Eddy tab: a new pose label, and a randomiser that draws N poses from the labels
you choose.

---

## Ground truth — how pose labels work today

Read this before writing anything. The label system is not what it looks like from the UI.

| Thing | Where | Note |
|---|---|---|
| Pose card storage | `eddy-pose` collection, `createEddyCollection` | The card's `prompt` field holds a **JSON block**, not prose |
| The only label today | `pose_action.view` ∈ `front` \| `back` \| `closeup` | Lives **inside** that JSON — not a row field |
| Read it | `readPoseView(text)` — [poseText.js:101](../../../client/src/lib/poseText.js#L101) | Defaults to `'front'` for anything unparseable |
| Is it explicitly set? | `hasPoseView(text)` — [poseText.js:152](../../../client/src/lib/poseText.js#L152) | Distinct from the `'front'` default |
| Write it without touching anything else | `mergePoseView(oldText, view)` — [poseText.js:173](../../../client/src/lib/poseText.js#L173) | Surgical: parses, sets one key, re-stringifies |
| Per-card label chips | [EddyCollection.jsx:3028-3057](../../../client/src/components/EddyCollection.jsx#L3028) | front / back / close-up + "Ask AI" |
| Bulk AI labeller | `labelViews` / `labelOneView` — [EddyCollection.jsx:732](../../../client/src/components/EddyCollection.jsx#L732) | Only targets cards where `!hasPoseView` |
| The paid call | `POST /api/eddy/classify-pose-view` — [eddyVision.js:284](../../../server/routes/eddyVision.js#L284) | Returns **one word**. `{ view }` |
| Pose selection state | `pickedPoses` / `setPickedPoses` — [EddyGeneratePage.jsx:3438](../../../client/src/pages/EddyGeneratePage.jsx#L3438) | Array of pose ids |
| The picker + Select all | [EddyGeneratePage.jsx:6690-6740](../../../client/src/pages/EddyGeneratePage.jsx#L6690) | `visible` = the pool the grid is showing |

---

## Decision 1 — "Mirror selfie" is a TAG, not a fourth view. This one is load-bearing.

The obvious implementation is to add `'mirror'` to `POSE_VIEWS`. **Do not do that.** It would silently
break outfit matching:

- `pose_action.view` decides **which side of the garment gets described** — `VIEW_RULE`
  ([eddyVision.js:73](../../../server/routes/eddyVision.js#L73)) classifies by which side of the
  *outfit* the camera sees, and a back-facing body wearing a front-described garment is the exact
  mismatch the field exists to prevent.
- Max Outfit reads `poseView` off the Library row to match a back shot to a back outfit
  ([poseViewBackfill.js:4](../../../client/src/lib/poseViewBackfill.js#L4)).
- `smartMatch` pairs close-up poses with close-up outfits
  ([EddyGeneratePage.jsx:4752](../../../client/src/pages/EddyGeneratePage.jsx#L4752)).

A mirror selfie is **orthogonal** to all of that — it can be front-facing (phone at chest, facing the
mirror) or back-facing (turned away, back in the reflection). Making it a fourth `view` value forces
every mirror pose to give up its front/back answer, and those poses start getting the wrong side of
the garment described.

**So: `view` stays exactly as it is. Tags are a new, independent field.**

## Decision 2 — a tag ARRAY, not a `mirrorSelfie` boolean

The ask says "one extra label", but the randomiser in the same breath says "choose the **labels** of
poses i want" — plural, and generic. A hardcoded boolean means the second label (bed, car, gym,
outdoor, POV, lying down) rebuilds the whole feature.

```jsonc
"pose_action": {
  "description": "…",
  "view": "front",           // unchanged, still exactly one of front|back|closeup
  "tags": ["mirror selfie"]  // NEW — free-form, lowercase, deduped, order-insensitive
}
```

Ship with `mirror selfie` as the only tag in the vocabulary. Adding the next one is then a one-line
change to a constant, and the randomiser picks it up with no work at all.

## Decision 3 — label the existing ~60 poses for free before paying for any of them

`planPoseViewBackfill` already established the pattern in this repo: **don't run a vision pass for
something the saved text already says.** Every pose card stores the description it was generated
from, and a mirror selfie's description almost always contains the word.

Do it in two passes, in this order:

1. **Free text pass** — scan `readPoseDescription(card.prompt)` for `/\bmirror\b/i`. Tag every hit.
   Costs nothing, runs offline, and will catch most of the library.
2. **AI pass, remainder only** — for cards with no `tags` key yet, fold the question into the call
   that is *already being made* (see Task 3). One call, one price, two answers.

Never re-ask about a card that already has a `tags` array — same rule `hasPoseView` enforces for
views. A card tagged `[]` means "asked, and it is not a mirror selfie", which is a real answer and
must not be re-scanned.

## Decision 4 — the randomiser's unstated rules

The one-liner leaves these open. Decide them this way:

| Question | Answer | Why |
|---|---|---|
| Draw from what pool? | `visible` — the exact array the grid is showing | Select all is already scoped this way, for the stated reason that a button selecting off-screen items "would silently add poses from a folder you filtered out" |
| Multiple tags selected? | **OR / union** — a pose matching any selected tag is eligible | "choose the labels of poses i want" reads as *any of these* |
| No tags selected? | Draw from all visible poses, tagged or not | The plain "give me 12 random poses" case |
| N larger than the pool? | Take the whole pool and **say so** on screen | Silently returning 4 when 30 was typed is the failure mode |
| Replace or add to the current pick? | **Replace**, and show the new count | That is what "randomise" means; adding makes repeat clicks unbounded |
| Repeat clicks | Must give a different draw each time | No seed reuse. Fisher–Yates over a copy |
| Unlabelled poses when a tag IS selected | Excluded | They are not the thing that was asked for |

## Decision 5 — show the cost before they click Generate

Not asked for, but this is where the money is and it costs one line. Eddy is a **cross product**:
outfits × poses. Randomising 30 poses against 10 outfits is 300 images. The page already computes
`combos` and `perImagePrice`. Put the resulting image count beside the Randomise button so a draw of
30 shows its consequence immediately rather than at the confirm dialog.

---

## Tasks

Each ends in a testable deliverable and one commit. Repo has no test framework — write a standalone
`tools/check-*.js` per the existing 33, run with `node`.

### Task 1 — the tag primitives (pure functions, no UI)

**File:** `client/src/lib/poseText.js`

Add three exports beside the existing view helpers, following `readPoseView` / `hasPoseView` /
`mergePoseView` line for line — including their tolerance for the CSV-double-quoted import shape
that `tryParsePoseJson` repairs.

```js
export const POSE_TAGS = ['mirror selfie'];        // the whole vocabulary, one place

export function readPoseTags(text)                 // -> string[]; [] when absent/unparseable
export function hasPoseTags(text)                  // -> bool; true only when a tags ARRAY exists,
                                                   //    including an empty one (= asked, answered no)
export function mergePoseTags(oldText, tags)       // -> new JSON text; touches ONLY pose_action.tags
```

Rules `mergePoseTags` must hold to, all of which `mergePoseView` already models:
- returns `raw` unchanged when the text is not a recoverable pose JSON block
- returns `raw` unchanged when `pose_action` is missing or not an object
- never touches `description`, `view`, or anything else in the block
- normalises: lowercase, trimmed, deduped, drops anything not in `POSE_TAGS`
- accepts `[]` and writes it (that is the "not a mirror selfie" answer)

**Check:** `tools/check-pose-tags.js` — round-trip through both storage shapes (clean JSON and the
CSV-escaped one), the empty-array case, a card with no `pose_action`, a plain-prose card, and an
assertion that `readPoseView` returns the SAME answer before and after a tag merge. Read the source
with `.replace(/\r\n/g, '\n')` — every suite in this repo does, or it fails on a CRLF checkout.

### Task 2 — the free text pass

**File:** `client/src/lib/poseTagBackfill.js` (new), modelled on `poseViewBackfill.js`

```js
export function planPoseTagBackfill(poseCards, { readPoseDescription, hasPoseTags })
// -> { patches: Map<id, {prompt}>, stats: { total, already, matched, untouched } }
```

Pure — returns patches, writes nothing, the caller decides. A card is a hit when its description
matches `/\bmirror\b/i`. Cards that already have a tags array are skipped (`stats.already`). Cards
with no match are **left alone**, not stamped `[]` — the AI pass in Task 3 still needs to see them.

Wire it to a button in the Pose tab toolbar beside the existing "Label poses":
**"Tag mirror selfies · free"**. Report the real numbers: `"Tagged 34 · 26 need the AI pass"`.

**Check:** `tools/check-pose-tag-backfill.js` — feed it fixture cards covering: description says
mirror, description says "mirrored" (should NOT match — `\b` word boundary), already tagged, empty
prompt, unparseable prompt.

### Task 3 — one call, two answers

**Files:** `server/routes/eddyVision.js`, `client/src/services/api.js`, `client/src/components/EddyCollection.jsx`

The route returns a bare word today and the client strips every non-letter from it
([eddyVision.js:307](../../../server/routes/eddyVision.js#L307)). Widen it to answer both questions
in the one paid call:

- Add a `MIRROR_RULE` constant beside `VIEW_RULE`, written to the same standard — say what counts
  (a phone visibly held up, a mirror frame or edge in shot, a reflection being photographed) and
  what does not (any other phone-in-hand shot, a reflective surface that is not being used as a
  mirror). State the tie-break explicitly, as `VIEW_RULE` does: **when torn, answer no.**
- Ask for `<view> <yes|no>` — two tokens, one line — and parse defensively: split on whitespace,
  first token validated against the existing three, second against yes/no. **If the second token is
  missing or unrecognised, fall back to `view` alone and no tag** — an older model reply, or a
  hosted-model change, must degrade to today's behaviour rather than mis-tagging the library.
- Response becomes `{ view, mirror: boolean }`. `view` keeps its exact current meaning and default.
- `labelOneView` writes both: `mergePoseView` then `mergePoseTags` — two surgical merges, not one
  rewrite.
- `labelViews`' target filter widens from `!hasPoseView(i.prompt)` to
  `!hasPoseView(i.prompt) || !hasPoseTags(i.prompt)`, so poses labelled before tags existed get
  picked up without re-asking about the ones that don't need it.

**Check:** `tools/check-pose-vision-reply.js` — parse fixtures for `"front yes"`, `"back no"`,
`"closeup"` (one token → view only, no tag), `"CLOSEUP  YES"` (case + whitespace),
`"I think it is front"` (junk → must not silently become a tag), `""`.

### Task 4 — per-card tag chip

**File:** `client/src/components/EddyCollection.jsx`, in the pose label row at
[line 3028](../../../client/src/components/EddyCollection.jsx#L3028)

Add a `MIRROR SELFIE` toggle chip after the three view buttons, in the same row and the same visual
language. Clicking toggles it via `mergePoseTags`. Same reason the view buttons exist and are stated
in the comment there: *the automatic answer is a guess you cannot see*, and three buttons cost
nothing and are certain. Use a different accent from the blue view chips so the two label families
never read as one set of four.

Show `unlabeled` for tags the way the view row does, only when `!hasPoseTags`.

### Task 5 — the randomiser

**File:** `client/src/pages/EddyGeneratePage.jsx`, in the pose picker slot at
[line 6690](../../../client/src/pages/EddyGeneratePage.jsx#L6690)

A row **under** the picker header, rendered only when `slot.key === 'pose'` and
`openPickers.pose` — the header is already full and this must not push Select all off-screen.

```
Randomise:  [ 12 ]  [ mirror selfie ]  ( Randomise )    → 12 of 34 · 12 × 3 outfits = 36 images
```

- number input, min 1, defaults to 12, persisted in the page cache snapshot alongside `pickedPoses`
  ([line 4155](../../../client/src/pages/EddyGeneratePage.jsx#L4155))
- one toggle chip per entry in `POSE_TAGS`, multi-select, union semantics
- the button calls `setPickedPoses(draw)` where `draw` is a Fisher–Yates shuffle of the eligible
  pool sliced to N
- the live line to its right states the truth every time: how many it will take against how many are
  eligible, and the resulting image count from the existing cross-product arithmetic. When N exceeds
  the pool, it must read `12 of 4 — taking all 4`.

**TDZ warning, this file specifically:** the eligible-pool memo and the draw callback must be
declared **after** every `const` they name in their dependency arrays. A `useCallback` whose deps
array names a `const` declared later in the component blanks the entire page at render — it has
happened four times in this repo. `node tools/check-tdz-deps.js` must be green before the commit.

**Check:** `tools/check-pose-randomiser.js` — pure-function assertions on the draw:
returns exactly N when the pool is larger; returns the whole pool when N exceeds it; every id in the
draw came from the eligible pool; a tag filter excludes untagged poses; no tag filter includes them;
two consecutive draws over a pool of 40 taking 10 are not identical; N of 0 or negative returns `[]`
rather than throwing.

---

## Constraints (all tasks)

1. **`pose_action.view` behaviour must not change.** Every existing check stays green — the pose
   suites, `check-provenance.js`, and `check-tdz-deps.js` in particular.
2. **Tags live in the prompt JSON, never as a row field.** `_addItems` in `eddyCollectionStore.js`
   has an **allowlist**, and a field that is not named there is dropped with no error — that is how
   `poseView` was nearly lost. Storing inside the JSON sidesteps it completely. (Note the existing
   asymmetry: *outfits* keep `poseView` as a row field, poses keep it in the JSON. Do not widen that
   split — poses stay in the JSON.)
3. **One change per commit**, message says what and why.
4. **Every new check reads source with `.replace(/\r\n/g, '\n')`.**
5. Run the full suite before pushing: every `tools/check-*.js` green, and `cd client && npx eslint
   src` at **0 errors** (113 pre-existing warnings are the baseline, don't chase them).
6. The root `npm run lint` is broken — there is no `eslint.config.js` at the repo root. The real
   config is `client/eslint.config.js`. Lint from `client/`.

## Done means

- A pose can be `front` **and** `mirror selfie` at once, and Max Outfit still hands it a front garment.
- The free pass tags most of the existing library at zero cost; the AI pass finishes the rest inside
  the call it was already making.
- Typing `12`, picking `mirror selfie`, clicking Randomise selects 12 random mirror-selfie poses from
  the folder currently on screen — and the row says what it did.
