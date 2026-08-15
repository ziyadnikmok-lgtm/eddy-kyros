---
name: contentrun
description: "Set up and start a big Kyros generation run without the headache. Use when the user says content run, generate a batch, mass generation, run the outfits, make N per model, or names an outfit folder / pose tag / base to use. Runs preflight first, then turns 'bikini folder, front poses, 20 per model' into the exact clicks. Also converts Kyros exports into folders of images."
---

# contentrun — say what you want, get the run

The point of this skill: the user should say *"bikini subfolder, front and back
poses, 20 per model"* and get a working run. Not a tour of the app.

Two things it does, in this order, always:

1. **Preflight** — catch the things that waste a batch, before spending anything.
2. **Translate** — turn what they said into the exact selections in Kyros.

---

## Step 1 — preflight, every time

```
node tools/preflight.js
```

Run it before ANY run, even if they ran one an hour ago. It takes seconds and
covers the failures this project has actually had:

| It checks | Because |
|---|---|
| build newer than source | The most common "my fix did nothing" — Kyros serves `client/dist`, so unbuilt source is old code still running |
| Eddy + Photo Match on the queue | If a page still calls the blocking route it is capped at **6** by the browser, whatever the lane count says |
| server lane ceiling | The real limiter, `KYROS_MAX_INFLIGHT` (300) |
| client lanes ≥ server | Otherwise the browser is the narrower of the two |
| WaveSpeed key | Both engines need it. "Present but unreadable here" is normal and fine — it is encrypted per install and Kyros itself reads it |
| all 44 check suites | A red suite before a paid run is worth ten seconds |

**`FIX` lines block the run. `NOTE` lines do not.** Do the fix it names — it
prints the command — then re-run preflight. Do not start a batch with a `FIX`
outstanding; every one of them means the run behaves differently than it looks.

If Kyros is running when a rebuild happens, it must be **restarted** — a running
app holds the old bundle.

---

## Step 2 — translate what they said

They will say something like:

> "bikini folder, front and back poses, 20 per model, Grace and Kaily"

That maps onto Kyros like this. Confirm the numbers back before they click.

**Eddy / Max Nano — Generate tab**

| They said | Where it goes |
|---|---|
| a character | **Character** picker — one run per character, or pick the base photos of each |
| "the base" / a base photo | **Main photo** slot, sourced from **Base Library** |
| an outfit folder or subfolder | **Outfit** picker → open it → click the folder chip → **Select all N** |
| "front poses" / "back" / "close-up" | **Pose** picker → **Randomise** row → the `front` / `back` / `close-up` chips |
| a pose tag like *mirror selfie* | same row — the tag chips sit left of the view chips |
| "20 per model" | the **number** in the Randomise row, then **Randomise** |
| where results go | **Send results to** — Library or Base Library, chosen *before* Generate |

Two things worth saying out loud when confirming:

- **The randomiser chips EXCLUDE.** Ticking `close-up` leaves close-ups OUT. If
  they want only front poses, tick `back` and `close-up` — or use folder chips.
  Each chip shows what it costs; nothing ticked = the whole grid.
- **Eddy is a cross product.** Outfits × poses. 20 poses and 5 outfits is **100
  images**, not 20. The Randomise row states the image count next to it — read
  that number back to them before they press Generate.

**Photo Match SD** — same shape: source photos, character, then Send results to.

---

## Step 3 — watching it

Once Generate is pressed:

- The **queue strip** at the top of every page shows *waiting / rendering / to
  file / failed*, with **Retry N failed** and a per-job retry.
- Images land in the character's folder **as each one finishes**, not at the end.
- Closing the app is safe. Queued work is sent on the next boot; work already
  rendering is collected and filed. `Stop` cancels only what has not been sent —
  anything already with WaveSpeed is billed either way, so it is kept.
- A failure shows its reason on the strip. `Retry N failed` re-sends them.

---

## Also: exports → folders

When they want the pictures as files (to sort, to hand over, to use elsewhere):

```
node tools/export-to-folders.js <export.json> <output-folder> [--flat] [--dry]
```

Export from the collection's own **Export all** button, then:

```
node tools/export-to-folders.js D:\Downloads\eddy-outfit.json D:\Content\outfits
  -> D:\Content\outfits\bikini\black-lace-set.jpg
     D:\Content\outfits\dresses\red-slip.jpg
     D:\Content\outfits\_unfiled\...
```

**Subfolders survive** — the folder each card was filed under becomes a real
folder. Cards with no folder go to `_unfiled` rather than the root, so what still
needs sorting stays separate from what is sorted. `--dry` shows what it would do
and writes nothing. Run `--dry` first on an export they care about.

---

## Rules

- **Never start a run with a `FIX` outstanding.** Fix, re-run preflight, then go.
- **Read the image count back** before they press Generate. Outfits × poses
  surprises people, and it is their money.
- **Never guess a folder or tag name.** Ask, or have them read the chips off the
  picker. A run against the wrong folder is a whole batch wasted.
- **`--dry` first** on any export conversion pointed at a folder that already has
  files in it.
- If a run misbehaves, get the **queue strip numbers** first — waiting /
  rendering / failed and the reason on a failed one. That answers most of it
  before touching code.
