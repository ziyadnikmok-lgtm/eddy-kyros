# Library provenance and the four things it unlocks — design

**Goal:** Stop paying twice for the same recipe, and let the app answer "what made this picture?"

**Status:** shape approved in conversation 2026-08-11. Spec awaiting review.

---

## The one structural change

Four of the five asks hang off a single gap: **a Library row does not know what made it.**

```
row today:  { name, prompt, videoPrompt, poseView, url, folderId, createdAt }
row after:  + { basePhotoId, poseId, outfitId, comboKey, charName }
```

Build that and the rest are small. Build the rest without it and each one invents its own half-answer.

### The trap that must not be missed

`_addItems` in `client/src/lib/eddyCollectionStore.js` has an **ALLOWLIST**. A field not named there is
dropped with no error and no warning. Every new field above has to be added to it. This has already
bitten once — `poseView` was nearly lost the same way, and the comment in that file says so.

`_updateItems` takes a `Map` of id → partial row and rewrites the index once, so backfilling existing
rows is one write rather than 627.

---

## A CORRECTION, found while writing this

I told the owner an identical prompt means an identical image. **That is wrong**, and the spec
would have been built on it.

`server/services/wavespeedService.js:224` sends `seed: options.seed ?? -1`, and Eddy never passes a
seed — it sends only `images, model, prompt, aspectRatio, resolution, tags`. So **-1 = random**, and
the same recipe run twice gives two different pictures.

So a "duplicate" here is **not** "you already have this exact image". It is:

> **you have already generated from this exact recipe**

That is still the thing worth stopping — the observed waste is re-ticking the same poses and outfits
across sessions, not wanting deliberate variations. But it changes the wording the user sees, and it
means the escape hatch matters:

- the skip message says **recipe**, never "identical image"
- **Regenerate on a tile always runs.** That is an explicit ask for another take, and must never be
  skipped as a duplicate.
- the toast names the saving and how to override, so a deliberate variation is one click away

---

## 1 · Provenance on the row

`generateCombo` already resolves everything needed; it currently throws it away at the Library write.

`comboKey` = a short stable hash of `basePhotoId | poseId | outfitId | engine | resolution`. Explicit
ids, not the prompt — exact, and immune to a prompt-wording change.

`charName` is already computed for folder filing; storing it makes "everything of Grace's" answerable
without walking folders.

---

## 2 · Duplicate guard

On Generate, each planned combo's `comboKey` is checked against the Library. Matches are dropped from
the batch before anything is sent.

```
6 already exist — generating 18. Saved $0.27.        [Make them anyway]
```

**The 627 existing images work from day one.** They have no ids, but they have prompts, and an
identical recipe produces an identical prompt string. So the guard keeps a second index of prompt
hashes for rows with no `comboKey`. Without this the feature does nothing until the Library turns
over, which is months.

Where it does NOT apply:
- Regenerate on a tile — an explicit request for another take
- a retry of a failed combo — that image does not exist yet
- Max Outfit's cross product when the owner has ticked "every combination", which is a deliberate ask

---

## 3 · Max Outfit: already-swapped

Source photos already used as a Max Outfit base are dimmed with a **done** tag, reading `basePhotoId`
from §1. Identical in behaviour and code shape to the "in Kyros" dimming already shipped on the
Pinterest tab — dimmed, not hidden, so it stays pickable.

---

## 4 · Spend total

Beside the per-run cost: **`today $4.12 · this run $1.08`**.

Summed from the Library's own rows by `createdAt` and the stored per-image price — no new ledger, and
it survives a reload because it is derived, not counted in memory. The owner hit the WaveSpeed credit
wall on 2026-08-10 with no warning they were close.

---

## 5 · Failed combos survive a reload

`failedCombos` is React state only. A reload loses both the Retry bar and any record of what did not
generate — the only way to notice is counting images. Persisted to the same page store the job queue
already uses, cleared when a retry succeeds.

---

## Order

Provenance → duplicate guard → already-swapped → spend → failed-combo persistence.

Each is independently shippable and independently testable after the first.

---

## Testing

`tools/check-provenance.js`, in the pattern of the other 20 suites — execute the real functions, not
greps, wherever a claim is about behaviour.

- `comboKey` is stable across calls and differs when any input differs
- a field added to the row survives `_addItems` (the allowlist trap, asserted directly)
- the guard drops an existing combo and keeps a new one
- **Regenerate is never skipped** — the money-losing false positive
- a row with no `comboKey` still dedupes by prompt hash
- prompt-hash matching does not collide on two genuinely different prompts
- spend sums only today's rows, and a row with no price does not poison the total
- failed combos round-trip through the store

Manual, because no test proves it: one run where the guard skips something, and one Regenerate that
correctly does not skip.

---

## Known limits, stated up front

**The seed is random.** Skipping a "duplicate" means declining a *different* picture from the same
recipe. That is the intended trade, and "Make them anyway" is always offered.

**Old rows do NOT dedupe at all — changed during implementation, 2026-08-11.**

The plan was to hash the prompt for the 627 rows that predate `comboKey`. Building it revealed why
that cannot work: `buildPrompt` puts no base photo in its text. Two DIFFERENT base photos with the
same pose and outfit produce the byte-identical prompt string, so a multi-base run — the normal way
this page is used — would have skipped every base after the first and looked like a broken
generate.

Skipping is only ever the right default when a skip means "you already have this". There, it would
have meant "you already have a different woman's photo in the same dress". Failing to make
something the owner asked for is worse than making a second copy, so the fallback was dropped:
`splitBySeen` still accepts `promptFor` for a caller that can key it safely, and Eddy does not pass
it. `tools/check-dup-guard.js` replays the false positive so the idea stays refused.

Cost of the change: the guard does nothing for images made before this shipped. Everything
generated from here on carries ids and dedupes exactly.
