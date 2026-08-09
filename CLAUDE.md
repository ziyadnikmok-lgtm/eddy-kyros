# CLAUDE.md — Kyros Studio

Rules for anyone (human or AI) changing this repo. Every one of them exists because the thing it
describes actually broke, on the date given. They are not style preferences.

## The shape of this app

Electron + React client (`client/`), Express server (`server/`). One codebase, three **workspaces**
(Eddy / Ziyad / Max) that differ ONLY in which nav sections they show — `client/src/lib/workspace.js`.
A change lands in all three at once; there is no per-workspace build.

The owner uses **Eddy** and **Photo Match**. Everything else is secondary.

---

## 1. A new page must be registered in FOUR places, or it silently does nothing

Adding a page to the sidebar is not enough. `AppContext.pageFromPathname` falls back to `'eddy'` for
any id it does not recognise, so an unregistered page **renders a different page with no error**.

Shipped broken this way: **Max Outfit, 2026-08-09** — in the sidebar, in the page map, invisible.

| where | what |
|---|---|
| `client/src/App.jsx` | the lazy import + the `PAGES` map entry |
| `client/src/App.jsx` | the sidebar `{ id, label }`, plus its icon and colour |
| `client/src/context/AppContext.jsx` | **`VALID_PAGE_IDS`** — the one that is always forgotten |
| `client/src/App.jsx` | the hidden-feed lists, if the page has its own results column |

`check_maxoutfit.js` walks every sidebar id and fails if any is missing from `VALID_PAGE_IDS`. Keep
that check alive.

## 2. Lint runs. Do not ship past it

`client/eslint.config.js` — `npm run lint`. Deliberately narrow: **`no-undef` is an error**,
hygiene rules only warn (102 pre-existing warnings; a config that fails on day one gets deleted).

There was no lint config until 2026-08-09, and Vite does not care about an undefined identifier — it
only transpiles. Two live bugs were sitting in the tree because of it:

- **`poseView`** used ~300 lines outside the block that declared it. Every generation threw
  ReferenceError at the Library write, was caught, and surfaced as a toast nobody read. The image
  rendered and never reached the Library. **This was the "it doesn't send to Library" bug.**
- **`load()`** called where the function is `refresh()` — the star sweep threw at the end and the
  grid never re-read.

It caught a third within the hour: a cleanup that deleted `eddyTags` along with its neighbour.

## 3. Never swallow a failure that decides where a paid image goes

The Library write sat inside its own `catch {}` with the note *"the picture is safe in the main
gallery either way"*. True, and exactly why it was wrong: the swallow meant the outer handler's
`"Saved to the gallery but not to Eddy"` toast — written for that failure — **could never fire**.

Related, and worse: **`addItems` does not throw on a storage failure.** It skips the row and returns
normally, with the count on `added.failed`. A skipped row is indistinguishable from a success unless
the caller checks the returned array. Check it.

## 4. `folderId: null` is not "unsorted", it is INVISIBLE

The Library lists items by folder. A row with no folder appears under "All" and in **no folder at
all**. 89 pictures reached that state on 2026-08-09 and read as never having arrived — they were
safe the whole time, just unreachable.

`resolveLibraryFolder` ends every branch in a `generic()` floor for this reason. Worst case must be
"in the wrong folder" (recoverable by dragging), never "nowhere".

## 5. The folder rule: ONE FOLDER PER CHARACTER

`Grace`. Nothing above it, nothing below it, on **every** tab — Eddy, Max Nano, Max Outfit,
Photo Match. Settled 2026-08-09 after two failed attempts:

- `Grace Seedream` / `Grace Nano` as flat siblings — sorted away from her own folder, so opening
  Grace showed none of it.
- `Grace > Seedream` and `Max Nano > Grace` as subfolders — splits her work by a distinction that
  matters only while comparing engines, and gets in the way every other day.

Tab folders (`Max Nano`, `Eddy`, `Eddy NSFW`) survive for runs with **no character picked** only.

**Changing this scheme strands every image already filed.** If it changes again, say so out loud and
do not bulk-move the owner's existing images silently.

## 6. `_addItems` has an ALLOWLIST. A new field is dropped without a word

`client/src/lib/eddyCollectionStore.js` — any field not named there vanishes. `videoPrompt` was lost
this way once, `poseView` nearly was. Add the field to the allowlist in the same commit that starts
sending it.

## 7. Persisted state: a field in the snapshot must be in the effect's deps

`EddyGeneratePage`'s snapshot effect is the **only** thing that writes it. A field in `snap` but not
in the deps array never gets saved — the effect does not re-run, and the value is gone next launch.
`pickedBases` / `outfitRotation` / `smartMatch` all shipped this way.

`check_charfolder.js` parses both as lists and fails on any mismatch.

## 8. Filing happens in the BROWSER. The server bills either way

A generation is saved and charged whether or not the tab survives. Reload, crash or close mid-batch
and the picture is safe on disk and missing from the Library. `RecoverFromGallery` now sweeps
automatically on every Library open — quiet when there is nothing to do, deduped on gallery id so it
can never double-file.

Recovery must file **exactly the way a live run files**, or it just moves the problem. It also reads
the character back off the generation's tags, which is why `eddyTags()` sends her name.

## 9. Do NOT delete the gallery

Measured 2026-08-09: **9.6 GB, 4,002 files**. A Library row stores a **URL into the gallery, not
bytes** — deliberately, so a 25-image batch does not pour tens of megabytes into IndexedDB.

Delete `/api/gallery` and every Library row goes black. Holding bytes instead is ~1.7 GB on day one
and ~1.6 GB per 500-image batch, in a store whose quota failure *silently skips rows*.

The browsing **pages** were the problem and both are gone (`GalleryPage` deleted; the `library` row
off the sidebar). `LibraryPage` stays reachable by URL — it is still the only surface listing Batch
and Carousel output.

## 10. Concurrency is bounded by the server's rate limiter, not by taste

`generateLimiter`: **60 requests / 60 s** on `/api/seedream`, shared by every page. A lane issues one
request and waits out the whole generation, so the rate is `lanes / duration`, not `lanes`.

Current: Eddy 12 (Seedream) / 6 (nano2), Photo Match 4 → about 21 of 60 when both run. The friend's
pipeline reports 429s at 30 concurrent workers. Raising these means redoing that arithmetic, and
anything raised needs a 429 retry on that path first — Photo Match had none when it went to 4.

---

## Working with Eddy (the collaborator)

Remote `friend` → `share-clean`. **`git fetch friend share-clean` before every push.** Pushes here
are whole-file copies, so a stale copy silently reverts his commits — this destroyed one of his
`eddy.css` rules on 2026-08-09 and it was only noticed because the owner asked.

When his change and a requested change conflict, **merge, do not pick a side**, and say which parts
came from where.

## Verification

`npm run lint` and a clean `vite build` are the floor, not the ceiling.

The checks live in the session scratchpad (43 suites). The ones that matter **execute** code rather
than pattern-matching it — pattern checks passed while three real bugs shipped today:

- `check_filing_e2e.js` — loads the **real** `eddyCollectionStore` on a fake IndexedDB and files
  images the way `generateCombo` does. Catches folder-scheme regressions and concurrent-batch races.
- `check_charfolder.js` — drives `resolveLibraryFolder` against a recording fake store.
- `check_smart.js`, `check_maxoutfit.js` — replay the combo builders.

**Nothing here has been verified by generating a real image.** Every claim in this file is about code
behaviour. The app is Electron + browser IndexedDB; a generation triggered outside it does not touch
the Library. On-screen verification is the owner's, and it has caught what the checks did not.
