# Library Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Library row remember what made it, then use that to stop paying twice for the same recipe, mark already-swapped sources, show a running spend, and keep failed combos across a reload.

**Architecture:** One new pure module (`client/src/lib/provenance.js`) holds the key-building and matching logic so it can be unit-tested without React or IndexedDB. Everything else is small edits at named lines in two existing files. Tasks 2–5 each depend only on Task 1.

**Tech Stack:** React 18, Vite, IndexedDB via `createEddyCollection`, plain-Node check files under `tools/` (no test framework in this repo).

## Global Constraints

- **No test framework exists.** Tests are standalone Node scripts under `tools/check-*.js`, run with `node tools/check-NAME.js`, printing `OK`/`FAIL` lines and exiting non-zero on failure. Follow the existing 20 files exactly.
- **Run EVERY `tools/check-*.js` before any commit**, not just the new one. A hard-coded count in an assertion is forbidden — assert membership and shape (`>= 3`, "none of the old form"), never an exact total.
- **Never write a regex through a bash heredoc.** `\n` becomes a literal newline and breaks the file. Use the Write tool, or `String.raw`, or prefer `String.includes()` over a regex.
- **This repo is CRLF.** A pattern containing a literal `\n` fails on correct code — use `\s+`.
- **`_addItems` has an ALLOWLIST** at `client/src/lib/eddyCollectionStore.js:237`. A field not named there is dropped silently. Every new row field MUST be added to it.
- Build with `cd client && npx vite build` and confirm `✓ built` before committing.
- Lint with `cd client && npx eslint src` — zero errors required.
- Comments explain WHY, not what. Match the density and voice of the surrounding code.

---

### Task 1: `provenance.js` — the key, the matcher, the spend sum

**Files:**
- Create: `client/src/lib/provenance.js`
- Modify: `client/src/lib/eddyCollectionStore.js:237` (the allowlist)
- Test: `tools/check-provenance.js`

**Interfaces:**
- Produces:
  - `comboKey({ basePhotoId, baseId, poseId, outfitId, engine, resolution }) -> string`
  - `promptKey(prompt: string) -> string`
  - `buildSeenKeys(rows: Array<Row>) -> { combos: Set<string>, prompts: Set<string> }`
  - `splitBySeen(combos: Array<Combo>, seen, { engine, resolution, promptFor }) -> { fresh: Array<Combo>, skipped: Array<Combo> }`
  - `spendToday(rows: Array<Row>, now: number) -> number`
  - Row gains: `basePhotoId`, `poseId`, `outfitId`, `comboKey`, `charName`, `price`

- [x] **Step 1: Write the failing test**

Create `tools/check-provenance.js`:

```js
// The key that decides whether an image already exists, and the spend sum.
//
// Kept pure and in its own module so it can be executed here without React or IndexedDB. The
// duplicate guard spends the owner's money when it is wrong in one direction and wastes it when
// wrong in the other, so every branch is exercised against real shapes.
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/Kyros/app';

// The module is ESM; read and eval the pure functions rather than importing.
const srcText = fs.readFileSync(path.join(ROOT, 'client/src/lib/provenance.js'), 'utf8');
const body = srcText.replace(/^export /gm, '');
// eslint-disable-next-line no-new-func
const mod = new Function(`${body}; return { comboKey, promptKey, buildSeenKeys, splitBySeen, spendToday };`)();
const { comboKey, promptKey, buildSeenKeys, splitBySeen, spendToday } = mod;

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- comboKey ---------------------------------------------------------------------------------
const base = { basePhotoId: 'b1', poseId: 'p1', outfitId: 'o1', engine: 'seedream', resolution: '2K' };
check('a key is stable across calls', comboKey(base) === comboKey({ ...base }));
check('a different pose is a different key', comboKey(base) !== comboKey({ ...base, poseId: 'p2' }));
check('a different outfit is a different key', comboKey(base) !== comboKey({ ...base, outfitId: 'o2' }));
check('a different base photo is a different key', comboKey(base) !== comboKey({ ...base, basePhotoId: 'b2' }));
check('a different engine is a different key', comboKey(base) !== comboKey({ ...base, engine: 'nano2' }));
check('a different resolution is a different key', comboKey(base) !== comboKey({ ...base, resolution: '1K' }));
check('baseId and basePhotoId do not collide',
  comboKey({ baseId: 'x' }) !== comboKey({ basePhotoId: 'x' }));
check('a missing field is stable, not undefined-in-a-string',
  typeof comboKey({}) === 'string' && comboKey({}) === comboKey({}));

// --- promptKey ---------------------------------------------------------------------------------
check('the same prompt gives the same key', promptKey('a woman by a pool') === promptKey('a woman by a pool'));
check('whitespace and case do not change it', promptKey(' A Woman  by a Pool ') === promptKey('a woman by a pool'));
check('a different prompt gives a different key', promptKey('a') !== promptKey('b'));
check('an empty prompt yields empty, so it can be ignored rather than matching everything',
  promptKey('') === '' && promptKey('   ') === '');

// --- buildSeenKeys ------------------------------------------------------------------------------
const rows = [
  { comboKey: 'K1', prompt: 'red dress by the pool' },
  { prompt: 'blue dress in a car' },          // old row, no comboKey
  { comboKey: 'K2' },                          // no prompt
  { },                                         // neither
];
const seen = buildSeenKeys(rows);
check('combo keys are collected', seen.combos.has('K1') && seen.combos.has('K2'));
check('prompts are collected for rows with no combo key', seen.prompts.has(promptKey('blue dress in a car')));
check('an empty row adds nothing', !seen.combos.has('') && !seen.prompts.has(''));

// --- splitBySeen: the money decision --------------------------------------------------------------
const promptFor = (c) => (c.poseId === 'p9' ? 'blue dress in a car' : `prompt-${c.poseId}`);
const planned = [
  { basePhotoId: 'b1', poseId: 'p1', outfitId: 'o1' },   // K1 by key -> skip
  { basePhotoId: 'b1', poseId: 'p2', outfitId: 'o1' },   // new -> keep
  { basePhotoId: 'b1', poseId: 'p9', outfitId: 'o1' },   // old row by PROMPT -> skip
];
const seen2 = buildSeenKeys([
  { comboKey: comboKey({ ...planned[0], engine: 'seedream', resolution: '2K' }) },
  { prompt: 'blue dress in a car' },
]);
const out = splitBySeen(planned, seen2, { engine: 'seedream', resolution: '2K', promptFor });
check('a combo already generated by KEY is skipped', out.skipped.some((c) => c.poseId === 'p1'));
check('a combo already generated by PROMPT is skipped — old rows work from day one',
  out.skipped.some((c) => c.poseId === 'p9'));
check('a genuinely new combo is kept', out.fresh.some((c) => c.poseId === 'p2'));
check('nothing is both kept and skipped', out.fresh.length + out.skipped.length === planned.length);
check('an empty seen set keeps everything',
  splitBySeen(planned, buildSeenKeys([]), { engine: 'seedream', resolution: '2K', promptFor }).fresh.length === 3);
check('a promptFor that throws does not lose the combo — it is kept, never silently dropped',
  splitBySeen(planned, seen2, { engine: 'x', resolution: 'y', promptFor: () => { throw new Error('boom'); } }).fresh.length === 3);

// --- spendToday --------------------------------------------------------------------------------
const DAY = 86400000;
const now = Date.UTC(2026, 7, 11, 18, 0, 0);
const priced = [
  { createdAt: now - 3600000, price: 0.045 },
  { createdAt: now - 7200000, price: 0.045 },
  { createdAt: now - 2 * DAY, price: 0.045 },  // older than today
  { createdAt: now - 100, price: undefined },  // unpriced
  { price: 0.045 },                            // no timestamp
];
check('today sums only today', Math.abs(spendToday(priced, now) - 0.09) < 1e-9);
check('a row with no price does not poison the total', Number.isFinite(spendToday(priced, now)));
check('an empty library is zero, not NaN', spendToday([], now) === 0);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
```

- [x] **Step 2: Run it to confirm it fails**

Run: `node tools/check-provenance.js`
Expected: FAIL — `ENOENT ... provenance.js`

- [x] **Step 3: Create the module**

Create `client/src/lib/provenance.js`:

```js
/**
 * What made a picture, and whether we have already made it.
 *
 * Kept pure and separate from the page so it can be executed in a check file without React or
 * IndexedDB. The duplicate guard decides whether money is spent, so it has to be testable on its
 * own rather than only through a running app.
 *
 * IMPORTANT: the seed is RANDOM. server/services/wavespeedService.js sends `seed: -1` because Eddy
 * never passes one, so the same recipe run twice produces two DIFFERENT pictures. A "duplicate"
 * here therefore means "already generated from this recipe", never "you already have this image".
 * Every message shown to the user must say recipe, and skipping must always be overridable.
 */

/** Join with a separator that cannot appear in an id, so two fields cannot blur into one. */
const SEP = '\u0001';

/**
 * The identity of a generation request: same key, same recipe.
 *
 * Built from explicit ids rather than the prompt text, so rewording a prompt template does not
 * orphan every existing key. Fields are always written in the same order and missing ones become
 * '', which keeps the key stable rather than embedding the string "undefined".
 */
export function comboKey({ basePhotoId, baseId, poseId, outfitId, engine, resolution } = {}) {
  // basePhotoId and baseId are tagged, not merged: they come from different collections and the
  // same id string could legitimately appear in both.
  return [
    `bp:${basePhotoId || ''}`,
    `bi:${baseId || ''}`,
    `po:${poseId || ''}`,
    `ou:${outfitId || ''}`,
    `en:${engine || ''}`,
    `re:${resolution || ''}`,
  ].join(SEP);
}

/**
 * A key for a row that predates comboKey.
 *
 * The 627 existing images have no ids but they do have prompts, and an identical recipe produces
 * an identical prompt string. Without this the guard does nothing until the Library turns over.
 *
 * Empty in, empty out -- an empty prompt must not become a key that matches every other empty one.
 */
export function promptKey(prompt) {
  const t = String(prompt || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return t;
}

/** Both indexes in one pass over the Library. */
export function buildSeenKeys(rows) {
  const combos = new Set();
  const prompts = new Set();
  for (const r of rows || []) {
    if (r?.comboKey) combos.add(r.comboKey);
    // Only for rows with no key: a keyed row is already covered, and adding its prompt as well
    // would make an edited prompt look like a second recipe.
    else if (r?.prompt) {
      const k = promptKey(r.prompt);
      if (k) prompts.add(k);
    }
  }
  return { combos, prompts };
}

/**
 * Split a planned batch into what is new and what already exists.
 *
 * A combo whose prompt cannot be built is KEPT, never skipped: failing to generate something the
 * owner asked for is worse than generating a second copy, and a thrown promptFor is a bug in the
 * caller rather than evidence the image exists.
 */
export function splitBySeen(combos, seen, { engine, resolution, promptFor } = {}) {
  const fresh = [];
  const skipped = [];
  for (const c of combos || []) {
    const key = comboKey({ ...c, engine, resolution });
    if (seen?.combos?.has(key)) { skipped.push(c); continue; }
    let pk = '';
    try { pk = promptKey(promptFor ? promptFor(c) : ''); } catch { pk = ''; }
    if (pk && seen?.prompts?.has(pk)) { skipped.push(c); continue; }
    fresh.push(c);
  }
  return { fresh, skipped };
}

/**
 * What today's images cost, summed from the Library itself.
 *
 * Derived rather than counted in a running total, so it survives a reload and cannot drift. A row
 * with no price contributes nothing instead of NaN-ing the whole sum.
 */
export function spendToday(rows, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  let total = 0;
  for (const r of rows || []) {
    const at = Number(r?.createdAt);
    const price = Number(r?.price);
    if (Number.isFinite(at) && at >= from && Number.isFinite(price)) total += price;
  }
  return total;
}
```

- [x] **Step 4: Add the new fields to the allowlist**

In `client/src/lib/eddyCollectionStore.js`, replace line 237's `added.push({...})` opening so the new fields survive. The existing line is:

```js
          added.push({ id, srcIndex: idx, name: it.name || 'image', prompt: it.prompt || '', videoPrompt: it.videoPrompt || '', poseView: it.poseView || '', url: it.url || '',
```

Replace with:

```js
          // PROVENANCE: what made this picture. Absent from this allowlist means silently dropped,
          // which is how poseView was nearly lost -- see the note above. comboKey is what the
          // duplicate guard matches on; price is what the spend total sums.
          added.push({ id, srcIndex: idx, name: it.name || 'image', prompt: it.prompt || '', videoPrompt: it.videoPrompt || '', poseView: it.poseView || '', url: it.url || '',
          ...(it.basePhotoId ? { basePhotoId: it.basePhotoId } : {}),
          ...(it.poseId ? { poseId: it.poseId } : {}),
          ...(it.outfitId ? { outfitId: it.outfitId } : {}),
          ...(it.comboKey ? { comboKey: it.comboKey } : {}),
          ...(it.charName ? { charName: it.charName } : {}),
          ...(Number.isFinite(it.price) ? { price: it.price } : {}),
```

- [x] **Step 5: Run the test to confirm it passes**

Run: `node tools/check-provenance.js`
Expected: `PASS — 27/27`

- [x] **Step 6: Add an allowlist assertion to the test**

Append before the final `console.log` in `tools/check-provenance.js`:

```js
// --- the allowlist trap ---------------------------------------------------------------------
// A field missing here is dropped with no error. This is the one assertion that catches it.
const store = fs.readFileSync(path.join(ROOT, 'client/src/lib/eddyCollectionStore.js'), 'utf8');
for (const f of ['basePhotoId', 'poseId', 'outfitId', 'comboKey', 'charName', 'price']) {
  check(`the allowlist keeps ${f}`, store.includes(`it.${f}`));
}
```

- [x] **Step 7: Run every check file, then build**

Run: `for f in tools/check-*.js; do node "$f" | tail -1; done`
Expected: every line `PASS`

Run: `cd client && npx eslint src && npx vite build`
Expected: zero errors, `✓ built`

- [x] **Step 8: Commit**

```bash
git add client/src/lib/provenance.js client/src/lib/eddyCollectionStore.js tools/check-provenance.js
git commit -m "feat(library): a row can record what made it

comboKey identifies a generation request by explicit ids rather than
prompt text, so rewording a template does not orphan every key. promptKey
covers the 627 rows that predate it -- without that the guard does
nothing until the Library turns over.

The new fields are added to the _addItems allowlist, which drops unknown
fields silently. That is how poseView was nearly lost."
```

---

### Task 2: Write provenance when generating

**Files:**
- Modify: `client/src/pages/EddyGeneratePage.jsx:5413` (the Library write in `generateCombo`)
- Test: `tools/check-provenance.js` (extend)

**Interfaces:**
- Consumes: `comboKey` from Task 1
- Produces: Library rows carrying `basePhotoId`, `poseId`, `outfitId`, `comboKey`, `charName`, `price`

- [x] **Step 1: Write the failing test**

Append to `tools/check-provenance.js` before the final `console.log`:

```js
// --- the write actually carries provenance --------------------------------------------------
const gen = fs.readFileSync(path.join(ROOT, 'client/src/pages/EddyGeneratePage.jsx'), 'utf8');
check('the Library write records the combo key', gen.includes('comboKey: rowComboKey'));
check('and the ids behind it', gen.includes('basePhotoId: combo?.basePhotoId || null')
  && gen.includes('poseId: combo?.poseId || null')
  && gen.includes('outfitId: combo?.outfitId || null'));
check('and who it was filed under', gen.includes('charName: filedUnder || \'\''));
check('and what it cost, for the spend total', gen.includes('price: perImageCost'));
check('provenance is imported, not re-implemented inline',
  gen.includes("from '../lib/provenance'"));
```

- [x] **Step 2: Run it to confirm it fails**

Run: `node tools/check-provenance.js`
Expected: FAIL on `the Library write records the combo key`

- [x] **Step 3: Import the module**

In `client/src/pages/EddyGeneratePage.jsx`, find the existing import of `../lib/poseText` (or any `../lib/` import near the top) and add below it:

```js
import { comboKey } from '../lib/provenance';
```

- [x] **Step 4: Write the fields at the Library write**

At `client/src/pages/EddyGeneratePage.jsx:5413`, the current call is:

```js
        const filed = await libraryStore.addItems(
          [{ url: galleryApi.imageUrl(first.galleryId), prompt, poseView, name: `eddy-${Date.now()}` }],
          libFolderId,
        );
```

Replace with:

```js
        /**
         * PROVENANCE, written at the only moment everything is known.
         *
         * The result object is transient and the folder name is lossy -- "Grace 3" does not say
         * which pose or outfit made the picture. Recording it here is what lets the duplicate
         * guard skip a recipe already generated, and Max Outfit mark a source as already swapped.
         */
        const rowComboKey = comboKey({
          basePhotoId: combo?.basePhotoId,
          baseId: combo?.baseId,
          poseId: combo?.poseId,
          outfitId: combo?.outfitId,
          engine,
          resolution,
        });
        const filed = await libraryStore.addItems(
          [{
            url: galleryApi.imageUrl(first.galleryId),
            prompt,
            poseView,
            name: `eddy-${Date.now()}`,
            basePhotoId: combo?.basePhotoId || null,
            poseId: combo?.poseId || null,
            outfitId: combo?.outfitId || null,
            comboKey: rowComboKey,
            charName: filedUnder || '',
            price: perImageCost,
          }],
          libFolderId,
        );
```

- [x] **Step 5: Run the test to confirm it passes**

Run: `node tools/check-provenance.js`
Expected: PASS

- [x] **Step 6: Verify `perImageCost` and `filedUnder` are in scope**

Run: `grep -n "const perImageCost\|let filedUnder" client/src/pages/EddyGeneratePage.jsx`
Expected: both appear ABOVE line 5413 inside `generateCombo`. If either does not, the plan is wrong — stop and report rather than inventing a value.

- [x] **Step 7: Run every check file, then build**

Run: `for f in tools/check-*.js; do node "$f" | tail -1; done`
Run: `cd client && npx eslint src && npx vite build`

- [x] **Step 8: Commit**

```bash
git add client/src/pages/EddyGeneratePage.jsx tools/check-provenance.js
git commit -m "feat(library): record what made each picture

Written at the Library write, the only moment base, pose, outfit, engine,
resolution, character and price are all known. The result object is
transient and a folder name is lossy -- 'Grace 3' does not say which pose
made the shot."
```

---

### Task 3: The duplicate guard

**Files:**
- Modify: `client/src/pages/EddyGeneratePage.jsx:5454` (inside `run()`)
- Test: `tools/check-dup-guard.js`

**Interfaces:**
- Consumes: `buildSeenKeys`, `splitBySeen` from Task 1
- Produces: nothing further

- [x] **Step 1: Write the failing test**

Create `tools/check-dup-guard.js`:

```js
// Skipping a recipe already generated -- and never skipping one the owner explicitly asked for.
//
// The seed is RANDOM, so a "duplicate" is a second picture from the same recipe, not the same
// picture. Skipping is therefore a judgement call, and the two cases that must never be skipped
// are a Regenerate and a retry: both are explicit asks for an image that does not exist yet.
const fs = require('fs');
const gen = fs.readFileSync('D:/Kyros/app/client/src/pages/EddyGeneratePage.jsx', 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

check('the guard runs inside run(), before anything is dispatched', (() => {
  const i = gen.indexOf('const { fresh, skipped } = splitBySeen(');
  const j = gen.indexOf('await runPool(');
  return i > -1 && j > i;
})());
check('it reads the Library to build the seen set', gen.includes('buildSeenKeys(await libraryStore.listItems())'));
check('a retry is never deduped — those images do not exist yet',
  gen.includes('const isRetry = Array.isArray(only) && only.length > 0;'));
check('and the reason is written down', /Regenerate and a retry are explicit asks/.test(gen));
check('the message says RECIPE, not "identical image"', gen.includes('already generated from this recipe'));
check('the saving is named', gen.includes('Saved $'));
check('an override is always offered', gen.includes('Make them anyway'));
check('skipping everything is reported rather than looking like a no-op',
  gen.includes('Every one of those recipes has been generated already'));

// --- replay the decision -----------------------------------------------------------------------
const decide = (isRetry, planned, seenKeys) => {
  if (isRetry) return { fresh: planned, skipped: [] };
  const fresh = planned.filter((c) => !seenKeys.has(c.key));
  return { fresh, skipped: planned.filter((c) => seenKeys.has(c.key)) };
};
const seen = new Set(['K1', 'K3']);
const planned = [{ key: 'K1' }, { key: 'K2' }, { key: 'K3' }, { key: 'K4' }];
check('two of four are skipped', decide(false, planned, seen).skipped.length === 2);
check('the other two run', decide(false, planned, seen).fresh.length === 2);
check('a RETRY runs everything, including keys already seen', decide(true, planned, seen).fresh.length === 4);
check('an empty seen set runs everything', decide(false, planned, new Set()).fresh.length === 4);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
```

- [x] **Step 2: Run it to confirm it fails**

Run: `node tools/check-dup-guard.js`
Expected: FAIL on the first check

- [x] **Step 3: Extend the import**

Change the Task 2 import line in `client/src/pages/EddyGeneratePage.jsx` to:

```js
import { comboKey, buildSeenKeys, splitBySeen } from '../lib/provenance';
```

- [x] **Step 4: Add the guard in `run()`**

At `client/src/pages/EddyGeneratePage.jsx:5454` the current line is:

```js
    const batch = Array.isArray(only) && only.length ? only : combos;
```

Replace with:

```js
    /**
     * SKIP RECIPES ALREADY GENERATED.
     *
     * The seed is random (wavespeedService sends -1), so this declines a DIFFERENT picture from a
     * recipe already used -- not a byte-identical one. That is the intended trade: the observed
     * waste is re-ticking the same poses and outfits across sessions, and "Make them anyway" is
     * always one click away.
     *
     * Regenerate and a retry are explicit asks for an image that does not exist yet, so neither is
     * ever deduped. A retry arrives as `only`, which is exactly how they are told apart.
     */
    const isRetry = Array.isArray(only) && only.length > 0;
    let batch = isRetry ? only : combos;
    let skippedCount = 0;
    if (!isRetry && batch.length) {
      try {
        const seen = buildSeenKeys(await libraryStore.listItems());
        const { fresh, skipped } = splitBySeen(batch, seen, {
          engine,
          resolution,
          // The prompt only matters for rows that predate comboKey; building it per combo here
          // would duplicate generateCombo's assembly, so the cheap identifying part is used.
          promptFor: (c) => {
            const po = poses.find((x) => x.id === c.poseId);
            return po ? poseSentence(po.prompt) : '';
          },
        });
        skippedCount = skipped.length;
        if (skippedCount && !fresh.length) {
          notify('Every one of those recipes has been generated already — nothing new to make.', 'info');
          return;
        }
        if (skippedCount) batch = fresh;
      } catch {
        // A guard that cannot read the Library must not block a run the owner asked for.
        skippedCount = 0;
      }
    }
```

- [x] **Step 5: Report the skip after the confirm gate**

Find the line in `run()` that reads `setRunning(true);` (search: `grep -n "setInFlight((n) => n + 1)" client/src/pages/EddyGeneratePage.jsx`) and insert immediately BEFORE it:

```js
    if (skippedCount) {
      const saved = (skippedCount * perImagePrice).toFixed(2);
      notify(`${skippedCount} already generated from this recipe — skipped. Saved $${saved}. Use Regenerate on a tile to make another anyway, or tick "Make them anyway".`, 'info');
    }
```

- [x] **Step 6: Add the "Make them anyway" escape**

Immediately above the Generate button (search: `grep -n "Generate {combos.length}" client/src/pages/EddyGeneratePage.jsx`), add:

```jsx
        {/* The override. Skipping is right by default, but the seed is random -- another take on a
            recipe you already used is a legitimate thing to want. */}
        {skipDupes === false && (
          <p className="text-center text-[0.625rem] text-amber-300/80">
            Duplicate skipping is off — every ticked combination will generate.
          </p>
        )}
        <label className="flex cursor-pointer items-center justify-center gap-1.5 text-[0.625rem] text-zinc-500">
          <input type="checkbox" checked={!skipDupes} onChange={(e) => setSkipDupes(!e.target.checked)}
            className="cursor-pointer accent-rose-500" />
          Make them anyway (do not skip recipes already generated)
        </label>
```

And add the state beside the other `useState` calls near `const [instruction, setInstruction]`:

```js
  // Remembered: whoever wants variations wants them repeatedly.
  const [skipDupes, setSkipDupes] = useState(() => {
    try { return localStorage.getItem('kyros.skipDupes') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('kyros.skipDupes', skipDupes ? '1' : '0'); } catch { /* private mode */ }
  }, [skipDupes]);
```

Then change the guard condition in Step 4 from `if (!isRetry && batch.length)` to `if (skipDupes && !isRetry && batch.length)`.

- [x] **Step 7: Run both tests, all check files, then build**

Run: `node tools/check-dup-guard.js`
Expected: PASS

Run: `for f in tools/check-*.js; do node "$f" | tail -1; done`
Run: `cd client && npx eslint src && npx vite build`

- [x] **Step 8: Commit**

```bash
git add client/src/pages/EddyGeneratePage.jsx tools/check-dup-guard.js
git commit -m "feat(eddy): skip recipes already generated

Nothing stopped re-ticking the same base, pose and outfit across
sessions and paying again. The guard drops them before dispatch and says
what it saved.

The seed is random, so this declines a DIFFERENT picture from a recipe
already used, not a byte-identical one -- the message says recipe, and
'Make them anyway' is always offered. A Regenerate or a retry is an
explicit ask for an image that does not exist yet and is never skipped."
```

---

### Task 4: Max Outfit marks already-swapped sources

**Files:**
- Modify: `client/src/pages/EddyGeneratePage.jsx` (the picker slot list and its tile render)
- Test: `tools/check-already-swapped.js`

**Interfaces:**
- Consumes: `basePhotoId` on Library rows from Task 2

- [x] **Step 1: Write the failing test**

Create `tools/check-already-swapped.js`:

```js
// Max Outfit dims a source it has already swapped.
//
// The owner points it at a Library folder, swaps forty, comes back later and has to re-pick by
// memory. Identical in shape to the "in Kyros" dimming already shipped on the Pinterest tab:
// dimmed, never hidden, so it stays pickable when a second take is wanted.
const fs = require('fs');
const gen = fs.readFileSync('D:/Kyros/app/client/src/pages/EddyGeneratePage.jsx', 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

check('a set of already-swapped source ids is built', gen.includes('const swappedSourceIds = useMemo('));
check('it reads basePhotoId off Library rows', gen.includes('if (r.basePhotoId) out.add(r.basePhotoId)'));
check('it also reads baseId, which is what Max Outfit sets', gen.includes('if (r.baseId) out.add(r.baseId)'));
check('the tile is dimmed, not hidden — a second take stays possible',
  gen.includes("swappedSourceIds.has(id) && !on ? 'opacity-40' : ''"));
check('and carries a label saying why', gen.includes('done'));
check('the reason is recorded', /re-pick by memory/.test(gen));

const swapped = new Set(['s1', 's3']);
const dim = (id, picked) => (swapped.has(id) && !picked ? 'dim' : 'normal');
check('an already-swapped source is dimmed', dim('s1', false) === 'dim');
check('unless it is currently picked', dim('s1', true) === 'normal');
check('an unswapped source is normal', dim('s2', false) === 'normal');

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
```

- [x] **Step 2: Run it to confirm it fails**

Run: `node tools/check-already-swapped.js`
Expected: FAIL on the first check

- [x] **Step 3: Build the set**

In `client/src/pages/EddyGeneratePage.jsx`, immediately after the `basePhotoPairs` memo (search: `grep -n "const basePhotoPairs = useMemo" client/src/pages/EddyGeneratePage.jsx`), add:

```js
  /**
   * Sources Max Outfit has already dressed.
   *
   * Pointing it at a folder, swapping forty and coming back later meant re-pick by memory --
   * nothing marked what was done. Read from the Library's own provenance, so it is accurate
   * without a second ledger to keep in step.
   */
  const swappedSourceIds = useMemo(() => {
    const out = new Set();
    for (const r of libItems) {
      if (r.basePhotoId) out.add(r.basePhotoId);
      if (r.baseId) out.add(r.baseId);
    }
    return out;
  }, [libItems]);
```

- [x] **Step 4: Dim the tile**

Find the picker tile render (search: `grep -n "onClick={() => toggle(setPicked)(id)}" client/src/pages/EddyGeneratePage.jsx` — the compact grid added earlier). In the `className` of that button, add `swappedSourceIds.has(id) && !on ? 'opacity-40' : ''` to the `cn(...)` call, and inside the button add:

```jsx
                        {swappedSourceIds.has(id) && (
                          <span className="absolute bottom-0.5 left-0.5 rounded bg-black/80 px-1 text-[0.5rem] font-semibold uppercase text-zinc-300">
                            done
                          </span>
                        )}
```

- [x] **Step 5: Run the test, all check files, then build**

Run: `node tools/check-already-swapped.js`
Run: `for f in tools/check-*.js; do node "$f" | tail -1; done`
Run: `cd client && npx eslint src && npx vite build`

- [x] **Step 6: Commit**

```bash
git add client/src/pages/EddyGeneratePage.jsx tools/check-already-swapped.js
git commit -m "feat(max-outfit): mark sources already swapped

Point it at a folder, swap forty, come back later and nothing said which
were done -- you re-picked by memory. Read from the Library's own
provenance rather than a second ledger. Dimmed, not hidden: a second take
stays one click away."
```

---

### Task 5: Spend total, and failed combos that survive a reload

**Files:**
- Modify: `client/src/pages/EddyGeneratePage.jsx:6907` (the cost line) and the `failedCombos` state
- Test: `tools/check-spend-and-retry.js`

**Interfaces:**
- Consumes: `spendToday` from Task 1, `price` on rows from Task 2

- [x] **Step 1: Write the failing test**

Create `tools/check-spend-and-retry.js`:

```js
// Two small things that both cost the owner information they needed.
//
// The credits wall was hit on 2026-08-10 with no warning it was close -- cost was shown per run
// and never cumulatively. And failedCombos lived in React state alone, so a reload lost both the
// Retry bar and any record of what had not generated; the only way to notice was counting images.
const fs = require('fs');
const gen = fs.readFileSync('D:/Kyros/app/client/src/pages/EddyGeneratePage.jsx', 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- spend -------------------------------------------------------------------------------------
check('today is summed from the Library, not counted in memory', gen.includes('spendToday(libItems'));
check('it is shown beside the run cost', gen.includes('today $'));
check('it is derived, so it survives a reload', /derived, not counted/.test(gen));

// --- failed combos ----------------------------------------------------------------------------
check('failed combos are persisted', gen.includes("store.set('failedCombos'"));
check('and restored', gen.includes("store.get('failedCombos', [])"));
check('a successful retry clears its entry', gen.includes('prev.filter((f) => f.combo !== combo)'));
check('the reason is recorded', /the only way to notice was counting images/.test(gen));

// --- replay ---------------------------------------------------------------------------------------
const DAY = 86400000;
const now = Date.UTC(2026, 7, 11, 18, 0, 0);
const sum = (rows) => {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return rows.reduce((t, r) => {
    const at = Number(r.createdAt); const p = Number(r.price);
    return (Number.isFinite(at) && at >= start.getTime() && Number.isFinite(p)) ? t + p : t;
  }, 0);
};
check('two images today at 0.045 sum to 0.09',
  Math.abs(sum([{ createdAt: now - 1000, price: 0.045 }, { createdAt: now - 2000, price: 0.045 }]) - 0.09) < 1e-9);
check('yesterday is excluded', sum([{ createdAt: now - 2 * DAY, price: 0.045 }]) === 0);
check('an unpriced row contributes nothing rather than NaN',
  sum([{ createdAt: now - 1000 }]) === 0);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
```

- [x] **Step 2: Run it to confirm it fails**

Run: `node tools/check-spend-and-retry.js`
Expected: FAIL on the first check

- [x] **Step 3: Extend the import**

```js
import { comboKey, buildSeenKeys, splitBySeen, spendToday } from '../lib/provenance';
```

- [x] **Step 4: Add the spend line**

At `client/src/pages/EddyGeneratePage.jsx:6907` the cost paragraph ends with `</p>`. Immediately after that closing `</p>`, add:

```jsx
        {/* WHAT TODAY HAS COST. Per-run cost was the only number shown, so the credits wall
            arrived with no warning it was close. Derived, not counted -- summed from the Library's
            own rows, so it survives a reload and cannot drift out of step. */}
        {spendToday(libItems) > 0 && (
          <p className="text-center text-[0.625rem] text-zinc-600">
            today <span className="font-mono text-zinc-400">${spendToday(libItems).toFixed(2)}</span>
            {' · '}this run <span className="font-mono text-zinc-400">${totalCost.toFixed(2)}</span>
          </p>
        )}
```

- [x] **Step 5: Persist failed combos**

Find `const [failedCombos, setFailedCombos] = useState([]);` and replace with:

```js
  /**
   * Kept across a reload.
   *
   * This was React state alone, so reloading lost both the Retry bar and any record of what had
   * not generated -- the only way to notice was counting images. Stored in the same page store the
   * rest of this page uses.
   */
  const [failedCombos, setFailedCombos] = useState([]);
  useEffect(() => {
    (async () => {
      const saved = await stateStore.get('failedCombos', []);
      if (Array.isArray(saved) && saved.length) setFailedCombos(saved);
    })();
  }, []);
  useEffect(() => {
    stateStore.set('failedCombos', failedCombos);
  }, [failedCombos]);
```

Verify `stateStore` is the correct store name first:
Run: `grep -n "const stateStore = createPageStore" client/src/pages/EddyGeneratePage.jsx`
If the name differs, use the actual one — do not create a second store.

- [x] **Step 6: Run the test, all check files, then build**

Run: `node tools/check-spend-and-retry.js`
Run: `for f in tools/check-*.js; do node "$f" | tail -1; done`
Run: `cd client && npx eslint src && npx vite build`

- [x] **Step 7: Commit**

```bash
git add client/src/pages/EddyGeneratePage.jsx tools/check-spend-and-retry.js
git commit -m "feat(eddy): show today's spend; keep failed combos across a reload

Cost was shown per run only, so the credits wall arrived with no warning
it was close. Today's total is summed from the Library's own rows --
derived rather than counted, so it survives a reload and cannot drift.

failedCombos was React state alone: a reload lost the Retry bar and any
record of what had not generated, and the only way to notice was counting
images."
```

---

## What actually shipped (2026-08-11)

All five tasks, commits `2ff3a17d` (Tasks 1-2, committed together — a field nothing writes is
useless), `58843d12`, `bcd5d5d7`, `db00371b`.

Three deviations from the plan text, each for a reason found while building:

1. **No prompt-hash fallback in the guard** (Task 3). The plan hashed the pose sentence, which
   could never equal a stored full prompt; hashing the FULL prompt would have skipped every base
   after the first in a multi-base run, because buildPrompt carries no base photo. Dropped. See the
   spec's "Known limits" and `tools/check-dup-guard.js`.
2. **The already-swapped dimming is a PickerGrid prop** (Task 4), not an inline expression — the
   tiles are a shared component, and the pose and outfit pickers must not be marked.
3. **`priceOne()` added** (Task 5). The price stamped on each row came from `seedreamCost()` on
   every engine including nano2, the default, so the new spend total would have summed a wrong
   number. Both confirm dialogs quoted the same wrong rate.

---

## Self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 Provenance on the row | Task 1 (fields + allowlist), Task 2 (write) |
| §2 Duplicate guard, incl. prompt fallback for old rows | Task 1 (`splitBySeen`), Task 3 |
| §3 Max Outfit already-swapped | Task 4 |
| §4 Spend total | Task 1 (`spendToday`), Task 5 |
| §5 Failed combos persist | Task 5 |
| Seed-is-random correction | Task 1 module header, Task 3 comment + user-facing wording |
| Allowlist trap | Task 1 Step 4 + Step 6 assertion |

No gaps.

**Placeholder scan:** no TBD/TODO; every code step carries real code; no "similar to Task N".

**Type consistency:** `comboKey`, `promptKey`, `buildSeenKeys`, `splitBySeen`, `spendToday` are named identically in the module, the tests and every call site. Row fields `basePhotoId`, `poseId`, `outfitId`, `comboKey`, `charName`, `price` match between the allowlist, the write and the readers.

**Two verification steps are deliberate** (Task 2 Step 6, Task 5 Step 5): they check that `perImageCost`, `filedUnder` and `stateStore` really exist under those names before use, and instruct the implementer to stop rather than invent. Those are the assumptions most likely to be wrong.
