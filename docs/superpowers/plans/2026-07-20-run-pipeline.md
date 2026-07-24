# Run Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a three-stage pipeline — character/outfit/pose/environment → images → review → videos — driven by a server-side worker so closing the app does not stop a run.

**Architecture:** A run is one JSON file in the server data directory holding a recipe and a flat list of jobs. **The recipe carries resolved prompt text, not ids** — poses and outfits live in the browser's IndexedDB, which the server cannot read, so the browser looks them up when creating the run and sends the text with it. A consequence worth knowing: editing a pose later does not change a run already created, which also makes a run reproducible. A worker loop picks the next pending job for the run's current stage, calls the existing generation service, and persists the result immediately. The browser is a viewer: it polls run state and posts decisions. Gates are status values on the run, not UI state, so they survive a restart.

**Tech Stack:** Node/Express (server), React 18 (client), existing `wavespeedService` for generation, `atomicWriteJSON` for persistence.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-20-run-pipeline-design.md`
- **No test framework exists in this project.** Verification is by extracting a function and running it with `node --input-type=module`, plus `npm run build` in `client/`. Never write a `pytest`/`jest` command — there is no runner.
- Client changes require `cd client && npm run build`. The app serves from `client/dist`, which **is** committed.
- Server changes require a full app restart (`Launch Kyros Studio.vbs`), not Ctrl+R — Node caches modules at startup.
- Concurrency for generation is **2**. Measured: 4 parallel Vertex workers finished 14 of 48 before quota exhaustion.
- Retry policy: rate-limit/quota → back off, up to 5 attempts. Permanent failure → 0 retries. Other → 2 retries.
- Never re-encode images when saving; never claim a file is cleaned when it is not.
- Sweep for hooks used but not imported, and for temporal-dead-zone references in dependency arrays, before every commit. Both have caused runtime crashes in this codebase.

---

### Task 1: Pose cards carry a video prompt

**Files:**
- Modify: `client/src/components/EddyCollection.jsx`
- Modify: `client/src/pages/EddyTabs.jsx`

**Interfaces:**
- Consumes: nothing
- Produces: pose items gain a `videoPrompt` string field, persisted by the existing `store.updateItem(id, patch)`. Task 4 and Task 6 read `item.videoPrompt`.

- [ ] **Step 1: Add the prop and the field**

In `EddyCollection.jsx`, add to the destructured props:

```jsx
  // A second prompt on the card. Pose uses it for the motion that goes with the shot, so one
  // card holds the image, how she is positioned, and how she moves.
  withVideoPrompt = false,
```

- [ ] **Step 2: Render the field under the existing prompt**

Find the `<Textarea>` that edits `it.prompt` and add immediately after its closing tag:

```jsx
              {withVideoPrompt && (
                <Textarea
                  defaultValue={it.videoPrompt || ''}
                  rows={2}
                  placeholder="Video prompt — how this shot moves"
                  onBlur={(e) => store.updateItem(it.id, { videoPrompt: e.target.value }).then(refresh)}
                  className="!text-[0.6875rem]"
                />
              )}
```

- [ ] **Step 3: Turn it on for the Pose tab**

In `EddyTabs.jsx`, inside `EddyPosePage`'s `<EddyCollection>`, add:

```jsx
        withVideoPrompt
```

- [ ] **Step 4: Verify it persists**

Run: `cd client && npm run build`
Expected: `✓ built in Ns`, no errors.

Then in the app: Pose tab → type into a video prompt → switch folders → switch back. The text is still there.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/EddyCollection.jsx client/src/pages/EddyTabs.jsx client/dist
git commit -m "feat(pose): cards carry a video prompt alongside the pose prompt"
```

---

### Task 2: The run store

**Files:**
- Create: `server/services/runStore.js`

**Interfaces:**
- Consumes: `getDataDir` from `server/paths.js`, `atomicWriteJSON` from `server/utils/helpers.js`
- Produces:
  - `create({ name, recipe, jobs }) -> run`
  - `get(id) -> run | null`
  - `list() -> run[]` (newest first, jobs omitted)
  - `update(id, patch) -> run`
  - `updateJob(id, jobId, patch) -> run`
  - `remove(id) -> boolean`

- [ ] **Step 1: Write the store**

Create `server/services/runStore.js`:

```js
'use strict';
/**
 * Runs are persisted as ONE json file, not one file per run.
 *
 * A run stores prompt TEXT plus a small environment image, never generated images, so the whole
 * set fits comfortably in memory,
 * and a single file makes an atomic write cover the entire state. Per-run files would leave a
 * half-updated set behind if the process died between two writes.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJSON } = require('../utils/helpers');
const { getDataDir } = require('../paths');

const MAX_RUNS = 50;

function _file() { return path.join(getDataDir(), 'runs.json'); }

function _load() {
  try {
    const raw = fs.readFileSync(_file(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Missing or corrupt file means no runs yet. Throwing here would make the whole page fail
    // on first use, which reads as broken rather than empty.
    return [];
  }
}

function _save(runs) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  atomicWriteJSON(_file(), runs.slice(0, MAX_RUNS));
}

function create({ name, recipe, jobs }) {
  const runs = _load();
  const run = {
    id: crypto.randomUUID(),
    name: name || `Run ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    createdAt: new Date().toISOString(),
    status: 'setup',
    recipe,
    spend: { imagesEstimated: 0, imagesActual: 0, videosEstimated: 0, videosActual: 0 },
    jobs,
  };
  runs.unshift(run);
  _save(runs);
  return run;
}

function get(id) {
  return _load().find((r) => r.id === id) || null;
}

/** Summaries only — the jobs array is the bulk of a run and a list view never needs it. */
function list() {
  return _load().map(({ jobs, ...rest }) => ({
    ...rest,
    jobCount: jobs.length,
    imagesDone: jobs.filter((j) => j.image.status === 'done').length,
    videosDone: jobs.filter((j) => j.video.status === 'done').length,
  }));
}

function update(id, patch) {
  const runs = _load();
  const i = runs.findIndex((r) => r.id === id);
  if (i < 0) return null;
  runs[i] = { ...runs[i], ...patch };
  _save(runs);
  return runs[i];
}

function updateJob(id, jobId, patch) {
  const runs = _load();
  const i = runs.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const j = runs[i].jobs.findIndex((x) => x.id === jobId);
  if (j < 0) return null;
  // Merged per sub-object so a patch of { image: {...} } does not wipe review or video.
  const job = runs[i].jobs[j];
  runs[i].jobs[j] = {
    ...job,
    ...patch,
    image: { ...job.image, ...(patch.image || {}) },
    review: { ...job.review, ...(patch.review || {}) },
    video: { ...job.video, ...(patch.video || {}) },
  };
  _save(runs);
  return runs[i];
}

function remove(id) {
  const runs = _load();
  const next = runs.filter((r) => r.id !== id);
  if (next.length === runs.length) return false;
  _save(next);
  return true;
}

module.exports = { create, get, list, update, updateJob, remove };
```

- [ ] **Step 2: Verify it round-trips and that a partial patch does not clobber siblings**

Run:

```bash
cd "C:/Users/asusg/Desktop/ai-content-studio-saas"
node -e "
const s = require('./server/services/runStore');
const run = s.create({ name: 'test', recipe: { characterId: 'c1' }, jobs: [
  { id: 'j1', outfitId: 'o1', poseId: 'p1',
    image: { status: 'pending', attempts: 0 },
    review: { verdict: 'undecided' },
    video: { status: 'pending', attempts: 0 } }
]});
s.updateJob(run.id, 'j1', { image: { status: 'done', galleryId: 'g1' } });
s.updateJob(run.id, 'j1', { review: { verdict: 'approved' } });
const after = s.get(run.id).jobs[0];
console.log('image kept  :', after.image.status === 'done' && after.image.galleryId === 'g1');
console.log('review set  :', after.review.verdict === 'approved');
console.log('video intact:', after.video.status === 'pending');
console.log('list omits jobs:', s.list().find(r => r.id === run.id).jobs === undefined);
s.remove(run.id);
console.log('removed     :', s.get(run.id) === null);
"
```

Expected: all five lines print `true`.

- [ ] **Step 3: Commit**

```bash
git add server/services/runStore.js
git commit -m "feat(runs): json-backed run store with per-job patching"
```

---

### Task 3: Run routes

**Files:**
- Create: `server/routes/runs.js`
- Modify: `server/index.js`

**Interfaces:**
- Consumes: `runStore` from Task 2
- Produces: `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/review`, `POST /api/runs/:id/cancel`. Task 4 adds `/start`, Task 5 adds `/animate` and `/regenerate`.

- [ ] **Step 1: Write the routes**

Create `server/routes/runs.js`:

```js
'use strict';
const express = require('express');
const runStore = require('../services/runStore');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

/** Build one job per outfit x pose. An empty outfit list still yields one job per pose. */
function buildJobs(recipe) {
  const outfits = recipe.outfitIds?.length ? recipe.outfitIds : [null];
  const poses = recipe.poseIds?.length ? recipe.poseIds : [null];
  const jobs = [];
  for (const outfitId of outfits) {
    for (const poseId of poses) {
      jobs.push({
        id: `${outfitId || 'none'}__${poseId || 'none'}`,
        outfitId,
        poseId,
        image: { status: 'pending', galleryId: '', error: '', attempts: 0 },
        review: { verdict: 'undecided' },
        video: { status: 'pending', filename: '', error: '', attempts: 0 },
      });
    }
  }
  return jobs;
}

router.post('/', (req, res, next) => {
  try {
    const { name, recipe } = req.body || {};
    if (!recipe?.characterId) throw new AppError('recipe.characterId is required', 400, 'VALIDATION_ERROR');
    const jobs = buildJobs(recipe);
    if (!jobs.length) throw new AppError('Nothing to generate', 400, 'VALIDATION_ERROR');
    res.json({ success: true, data: runStore.create({ name, recipe, jobs }) });
  } catch (err) { next(err); }
});

router.get('/', (_req, res, next) => {
  try { res.json({ success: true, data: runStore.list() }); } catch (err) { next(err); }
});

router.get('/:id', (req, res, next) => {
  try {
    const run = runStore.get(req.params.id);
    if (!run) throw new AppError('Run not found', 404, 'NOT_FOUND');
    res.json({ success: true, data: run });
  } catch (err) { next(err); }
});

router.post('/:id/review', (req, res, next) => {
  try {
    const run = runStore.get(req.params.id);
    if (!run) throw new AppError('Run not found', 404, 'NOT_FOUND');
    const { jobId, verdict, approveAll } = req.body || {};

    if (approveAll) {
      // Only images that actually exist can be approved; a failed one has nothing to animate.
      for (const j of run.jobs) {
        if (j.image.status === 'done') runStore.updateJob(run.id, j.id, { review: { verdict: 'approved' } });
      }
      return res.json({ success: true, data: runStore.get(run.id) });
    }

    if (!jobId || !['approved', 'dropped', 'undecided'].includes(verdict)) {
      throw new AppError('jobId and a valid verdict are required', 400, 'VALIDATION_ERROR');
    }
    const updated = runStore.updateJob(run.id, jobId, { review: { verdict } });
    if (!updated) throw new AppError('Job not found', 404, 'NOT_FOUND');
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

router.post('/:id/cancel', (req, res, next) => {
  try {
    const run = runStore.get(req.params.id);
    if (!run) throw new AppError('Run not found', 404, 'NOT_FOUND');
    // Only dispatch stops. Jobs already running finish — killing a request mid-flight bills for
    // an image that never arrives.
    res.json({ success: true, data: runStore.update(run.id, { status: 'cancelled' }) });
  } catch (err) { next(err); }
});

module.exports = router;
```

- [ ] **Step 2: Mount it**

In `server/index.js`, beside the other feature routers (near `app.use('/api/characters', ...)`):

```js
app.use('/api/runs', require('./routes/runs'));
```

- [ ] **Step 3: Verify the cross product and the review rules**

Run:

```bash
cd "C:/Users/asusg/Desktop/ai-content-studio-saas"
node -e "
const src = require('fs').readFileSync('server/routes/runs.js','utf8');
const fn = src.slice(src.indexOf('function buildJobs'), src.indexOf('router.post'));
const buildJobs = new Function(fn + '; return buildJobs;')();
console.log('3 outfits x 2 poses =', buildJobs({ outfitIds:['a','b','c'], poseIds:['p','q'] }).length, '(want 6)');
console.log('no outfits, 2 poses =', buildJobs({ poseIds:['p','q'] }).length, '(want 2)');
const ids = buildJobs({ outfitIds:['a','b'], poseIds:['p','q'] }).map(j=>j.id);
console.log('ids unique          :', new Set(ids).size === ids.length);
"
```

Expected: `6`, `2`, `true`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/runs.js server/index.js
git commit -m "feat(runs): create, read, review and cancel endpoints"
```

---

### Task 4: Worker — stage 1, images

**Files:**
- Create: `server/services/runWorker.js`
- Modify: `server/routes/runs.js`

**Interfaces:**
- Consumes: `runStore` (Task 2), `generateSeedream5Edit(imageInputs, prompt, opts)` from `server/services/wavespeedService.js`
- Produces: `startImages(runId)`, `classifyError(message) -> 'rate-limit' | 'permanent' | 'transient'`, `maxAttemptsFor(kind) -> number`. Task 5 reuses both classifiers.

- [ ] **Step 1: Write the worker**

Create `server/services/runWorker.js`:

```js
'use strict';
/**
 * Drives a run's jobs server side, so closing the app does not stop an hour-long batch.
 *
 * Every state change is written before the next job starts. A crash therefore resumes from the
 * file rather than losing the batch — the cost is one small write per transition, which is
 * nothing next to a generation call.
 */
const runStore = require('./runStore');
const log = require('../utils/logger');

const CONCURRENCY = 2;   // measured: 4 parallel workers finished 14 of 48 before quota death

/** Which retry budget applies. Reusing the wording already proven in queueEngine.js. */
function classifyError(message) {
  const m = String(message || '');
  if (/rate limit|quota|resource[_ ]exhausted|\b429\b/i.test(m)) return 'rate-limit';
  if (/was deleted|no character identity|not found|add it again/i.test(m)) return 'permanent';
  return 'transient';
}

function maxAttemptsFor(kind) {
  if (kind === 'rate-limit') return 5;
  if (kind === 'permanent') return 0;
  return 2;
}

const active = new Set();   // run ids currently being driven, so a double start is a no-op

async function _runStage(runId, stageKey, doJob) {
  if (active.has(runId)) return;
  active.add(runId);
  try {
    for (;;) {
      const run = runStore.get(runId);
      if (!run || run.status === 'cancelled') break;

      const pending = run.jobs.filter((j) => j[stageKey].status === 'pending');
      if (!pending.length) break;

      const batch = pending.slice(0, CONCURRENCY);
      await Promise.all(batch.map(async (job) => {
        runStore.updateJob(runId, job.id, { [stageKey]: { status: 'running' } });
        try {
          const result = await doJob(run, job);
          runStore.updateJob(runId, job.id, { [stageKey]: { status: 'done', ...result } });
        } catch (err) {
          const kind = classifyError(err.message);
          const attempts = (job[stageKey].attempts || 0) + 1;
          const retry = attempts <= maxAttemptsFor(kind);
          runStore.updateJob(runId, job.id, {
            [stageKey]: {
              status: retry ? 'pending' : 'failed',
              attempts,
              error: err.message?.slice(0, 300) || 'unknown error',
            },
          });
          if (kind === 'rate-limit') await new Promise((r) => setTimeout(r, Math.min(15000 * attempts, 60000)));
          log.error('run_job_failed', { runId, jobId: job.id, stage: stageKey, kind, attempts });
        }
      }));
    }
  } finally {
    active.delete(runId);
  }
}

module.exports = { classifyError, maxAttemptsFor, _runStage, CONCURRENCY };
```

- [ ] **Step 2: Verify the classifier and retry budgets**

Run:

```bash
cd "C:/Users/asusg/Desktop/ai-content-studio-saas"
node -e "
const w = require('./server/services/runWorker');
const cases = [
  ['Quota exceeded for aiplatform', 'rate-limit', 5],
  ['HTTP 429 rate limited', 'rate-limit', 5],
  ['pose was deleted', 'permanent', 0],
  ['no character identity images', 'permanent', 0],
  ['socket hang up', 'transient', 2],
];
let ok = 0;
for (const [msg, kind, max] of cases) {
  const k = w.classifyError(msg), m = w.maxAttemptsFor(k);
  const pass = k === kind && m === max;
  if (pass) ok++;
  console.log((pass?'ok   ':'FAIL ') + msg.slice(0,32).padEnd(34) + '-> ' + k + ' / ' + m);
}
console.log(ok + '/' + cases.length);
"
```

Expected: `5/5`.

- [ ] **Step 3: Add the image stage and the /start route**

Append to `server/services/runWorker.js`, before `module.exports`:

```js
const { generateSeedream5Edit } = require('./wavespeedService');
const galleryManager = require('./galleryManager');

/**
 * Stage 1. Resolves the pose and outfit by id at call time, so a run stores ids only and an
 * edited pose improves every future run.
 */
async function startImages(runId, deps) {
  runStore.update(runId, { status: 'generating-images' });
  await _runStage(runId, 'image', async (run, job) => {
    const { buildPrompt, loadImages } = deps;
    const { prompt, images } = await buildPrompt(run, job);
    if (!images.length) throw new Error('no character identity images — add one to this character');
    const out = await generateSeedream5Edit(images, prompt, {
      aspectRatio: run.recipe.aspectRatio,
      resolution: run.recipe.resolution,
    });
    const first = (out.images || [])[0];
    if (!first) throw new Error('generation returned no image');
    const saved = await galleryManager.save({
      base64Data: first.base64Data ?? first.base64,
      mimeType: first.mimeType || 'image/png',
      prompt,
      source: 'run',
      tags: ['run', run.id],
    });
    return { galleryId: saved.id, error: '' };
  });
  const after = runStore.get(runId);
  if (after && after.status !== 'cancelled') runStore.update(runId, { status: 'awaiting-review' });
}
```

Update the exports line to:

```js
module.exports = { classifyError, maxAttemptsFor, _runStage, startImages, CONCURRENCY };
```

- [ ] **Step 4: Wire /start**

In `server/routes/runs.js`, add before `module.exports`:

```js
const runWorker = require('../services/runWorker');
const runPrompt = require('../services/runPrompt');
const runVideoDeps = require('../services/runVideo');

router.post('/:id/start', (req, res, next) => {
  try {
    const run = runStore.get(req.params.id);
    if (!run) throw new AppError('Run not found', 404, 'NOT_FOUND');
    if (run.status !== 'setup') throw new AppError(`Run is already ${run.status}`, 409, 'CONFLICT');
    // Fire and forget: the worker persists as it goes, and the page polls for state.
    runWorker.startImages(run.id, runPrompt).catch(() => { /* per-job errors are already stored */ });
    res.json({ success: true, data: runStore.update(run.id, { status: 'generating-images' }) });
  } catch (err) { next(err); }
});
```

- [ ] **Step 5: Commit**

```bash
git add server/services/runWorker.js server/routes/runs.js
git commit -m "feat(runs): server-side worker for the image stage"
```

---

### Task 5: Prompt assembly + the video stage

**Files:**
- Create: `server/services/runPrompt.js`
- Modify: `server/services/runWorker.js`
- Modify: `server/routes/runs.js`

**Interfaces:**
- Consumes: `runStore`, `classifyError`/`_runStage` from Task 4
- Produces: `runPrompt.buildPrompt(run, job) -> { prompt, images }`, `runWorker.startVideos(runId)`, `runWorker.regenerateOne(runId, jobId, deps)`

- [ ] **Step 1: Write prompt assembly**

Create `server/services/runPrompt.js`:

```js
'use strict';
/**
 * Turns a run's ids into the prompt and image list for one job.
 *
 * Kept out of the worker because it is the only part that needs to know how a prompt is shaped,
 * and it is the part most likely to be tuned. The worker only cares that it gets a prompt and
 * some images.
 */
const referenceManager = require('./referenceManager');

/** A pose is stored as a JSON block; only pose_action.description belongs in a generation. */
function poseSentence(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('{')) return raw;
  try {
    const d = JSON.parse(raw)?.pose_action?.description;
    if (typeof d === 'string' && d.trim()) return d.trim();
  } catch {
    const m = raw.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
  }
  return raw;
}

async function buildPrompt(run, job) {
  const { recipe } = run;
  const character = referenceManager.getCharacterSafe(recipe.characterId);
  if (!character) throw new Error('character was deleted');

  // EVERY primary image, not just the first. One identity image against a pose photo is close
  // to a coin flip — that was the Photo Match identity bug.
  const images = referenceManager.getPrimaryImages(recipe.characterId).map((img) => ({
    base64: img.buffer.toString('base64'),
    mimeType: img.mimeType,
  }));

  const lines = [];
  lines.push('The woman in image 1 is the subject. Her identity, body and skin come from image 1.');
  const pose = (recipe.poses || []).find((p) => p.id === job.poseId);
  const outfit = (recipe.outfits || []).find((o) => o.id === job.outfitId);
  if (pose) lines.push(`POSE: ${poseSentence(pose.posePrompt)}`);
  if (outfit?.prompt) lines.push(`OUTFIT: ${outfit.prompt}`);
  if (recipe.instruction?.trim()) lines.push(recipe.instruction.trim());
  lines.push('Keep the ENTIRE background sharp and in focus — no bokeh, no depth-of-field blur.');
  lines.push('Photorealistic: real skin texture with pores, natural hair, slight asymmetry.');

  return { prompt: lines.filter(Boolean).join(' '), images };
}

module.exports = { buildPrompt, poseSentence };
```

- [ ] **Step 2: Verify pose extraction, including the malformed case**

Run:

```bash
cd "C:/Users/asusg/Desktop/ai-content-studio-saas"
node -e "
const { poseSentence } = require('./server/services/runPrompt');
const valid = JSON.stringify({ pose_action: { description: 'Reclining with legs raised.' } });
const broken = '{ \"pose_action\": { \"description\": \"Kneeling, back arched.\" }, \"camera\": { \"a\": \"1\" \"b\": \"2\", } }';
console.log('valid  :', poseSentence(valid) === 'Reclining with legs raised.');
console.log('broken :', poseSentence(broken) === 'Kneeling, back arched.');
console.log('plain  :', poseSentence('On all fours.') === 'On all fours.');
console.log('empty  :', poseSentence('') === '');
"
```

Expected: four `true`. The broken case matters — the source template has a missing comma, so `JSON.parse` fails on real data.

- [ ] **Step 3: Add the video stage**

Append to `server/services/runWorker.js` before `module.exports`:

```js
/**
 * Stage 3. Only approved jobs with a finished image are animated; everything else is skipped so
 * a dropped or failed image can never cost a video.
 */
async function startVideos(runId, deps) {
  const run = runStore.get(runId);
  if (!run) return;
  for (const j of run.jobs) {
    const eligible = j.review.verdict === 'approved' && j.image.status === 'done';
    if (!eligible && j.video.status === 'pending') {
      runStore.updateJob(runId, j.id, { video: { status: 'skipped' } });
    }
  }
  runStore.update(runId, { status: 'generating-videos' });
  await _runStage(runId, 'video', async (r, job) => {
    const { generateVideo } = deps;
    const out = await generateVideo(r, job);
    return { filename: out.filename, error: '' };
  });
  const after = runStore.get(runId);
  if (after && after.status !== 'cancelled') runStore.update(runId, { status: 'done' });
}

/** Exactly one image. Never a batch re-run — the button says what it costs. */
async function regenerateOne(runId, jobId, deps) {
  runStore.updateJob(runId, jobId, { image: { status: 'pending', attempts: 0, error: '' }, review: { verdict: 'undecided' } });
  await startImages(runId, deps);
}
```

Update exports:

```js
module.exports = { classifyError, maxAttemptsFor, _runStage, startImages, startVideos, regenerateOne, CONCURRENCY };
```

- [ ] **Step 4: Verify skip logic before spending anything**

Run:

```bash
cd "C:/Users/asusg/Desktop/ai-content-studio-saas"
node -e "
const s = require('./server/services/runStore');
const mk = (id, verdict, imgStatus) => ({ id, outfitId:'o', poseId:'p',
  image:{status:imgStatus,attempts:0,galleryId:'',error:''},
  review:{verdict}, video:{status:'pending',attempts:0,filename:'',error:''} });
const run = s.create({ name:'skip', recipe:{characterId:'c'}, jobs:[
  mk('a','approved','done'), mk('b','dropped','done'), mk('c','undecided','done'), mk('d','approved','failed')
]});
// mirror of the eligibility rule in startVideos
for (const j of s.get(run.id).jobs) {
  const eligible = j.review.verdict === 'approved' && j.image.status === 'done';
  if (!eligible) s.updateJob(run.id, j.id, { video: { status: 'skipped' } });
}
const st = Object.fromEntries(s.get(run.id).jobs.map(j => [j.id, j.video.status]));
console.log('approved+done animates :', st.a === 'pending');
console.log('dropped skipped        :', st.b === 'skipped');
console.log('undecided skipped      :', st.c === 'skipped');
console.log('failed image skipped   :', st.d === 'skipped');
s.remove(run.id);
"
```

Expected: four `true`.

- [ ] **Step 5: Wire /animate and /regenerate**

In `server/routes/runs.js`, before `module.exports`:

```js
router.post('/:id/animate', (req, res, next) => {
  try {
    const run = runStore.get(req.params.id);
    if (!run) throw new AppError('Run not found', 404, 'NOT_FOUND');
    if (run.status === 'cancelled') throw new AppError('Cancelled runs need a fresh start', 409, 'CONFLICT');
    if (!run.jobs.some((j) => j.review.verdict === 'approved' && j.image.status === 'done')) {
      throw new AppError('Nothing approved to animate', 400, 'VALIDATION_ERROR');
    }
    runWorker.startVideos(run.id, runVideoDeps).catch(() => { /* per-job errors are stored */ });
    res.json({ success: true, data: runStore.update(run.id, { status: 'generating-videos' }) });
  } catch (err) { next(err); }
});

router.post('/:id/regenerate', (req, res, next) => {
  try {
    const run = runStore.get(req.params.id);
    if (!run) throw new AppError('Run not found', 404, 'NOT_FOUND');
    const { jobId } = req.body || {};
    if (!run.jobs.some((j) => j.id === jobId)) throw new AppError('Job not found', 404, 'NOT_FOUND');
    runWorker.regenerateOne(run.id, jobId, runPrompt).catch(() => {});
    res.json({ success: true, data: runStore.get(run.id) });
  } catch (err) { next(err); }
});
```

- [ ] **Step 6: Commit**

```bash
git add server/services/runPrompt.js server/services/runWorker.js server/routes/runs.js
git commit -m "feat(runs): prompt assembly, video stage and single-image regenerate"
```

---

### Task 6: Runs page — setup and list

**Files:**
- Create: `client/src/pages/RunsPage.jsx`
- Modify: `client/src/services/api.js`
- Modify: `client/src/App.jsx`
- Modify: `client/src/context/AppContext.jsx`

**Interfaces:**
- Consumes: the endpoints from Tasks 3–5
- Produces: `runs` API object; route id `runs`

- [ ] **Step 1: Add the API client**

In `client/src/services/api.js`, beside the other exports:

```js
export const runs = {
  list: () => request('/runs'),
  get: (id) => request(`/runs/${id}`),
  create: (body) => request('/runs', { method: 'POST', body }),
  start: (id) => request(`/runs/${id}/start`, { method: 'POST' }),
  review: (id, body) => request(`/runs/${id}/review`, { method: 'POST', body }),
  regenerate: (id, jobId) => request(`/runs/${id}/regenerate`, { method: 'POST', body: { jobId } }),
  animate: (id) => request(`/runs/${id}/animate`, { method: 'POST' }),
  cancel: (id) => request(`/runs/${id}/cancel`, { method: 'POST' }),
};
```

- [ ] **Step 2: Register the route**

In `client/src/context/AppContext.jsx`, add `'runs'` to `VALID_PAGE_IDS`.

> An id missing from that set is silently rewritten to `generate`, which reads as a broken page. This exact omission cost an hour on Video Library.

In `client/src/App.jsx`:

```js
const RunsPage = lazy(() => import('./pages/RunsPage'));
```

Add to `PAGES`: `runs: RunsPage,`
Add to the Eddy nav section: `{ id: 'runs', label: 'Runs' },`
Add to `FEED_HIDDEN_PAGES`: `'runs',`

- [ ] **Step 3: Verify every nav row still routes**

Run:

```bash
cd "C:/Users/asusg/Desktop/ai-content-studio-saas"
node --input-type=module -e "
import fs from 'fs';
const ctx = fs.readFileSync('client/src/context/AppContext.jsx','utf8');
const ids = [...ctx.split('\n').find(l=>l.includes('VALID_PAGE_IDS')).matchAll(/'([^']+)'/g)].map(m=>m[1]);
const nav = fs.readFileSync('client/src/App.jsx','utf8');
const navIds = [...nav.matchAll(/\{ id: '([^']+)', label:/g)].map(m=>m[1]);
const missing = navIds.filter(id => !ids.includes(id));
console.log('nav ids not routable:', missing.length ? missing.join(', ') : 'none');
"
```

Expected: `none`.

- [ ] **Step 4: Build the setup view**

Create `client/src/pages/RunsPage.jsx` with a component that: lists runs from `runs.list()`; offers a character picker, pose and outfit multi-select fed by `createEddyCollection('eddy-pose')` and `('eddy-outfit')`, an environment picker from `('eddy-environment')`, an instruction box; shows `poses.length * outfits.length` as the image count with an estimated cost; and calls `runs.create` then `runs.start`.

Poll with `useEffect` on a 3s interval while `status` is `generating-images` or `generating-videos`, and stop polling otherwise.

- [ ] **Step 5: Verify the build and sweep**

Run: `cd client && npm run build`
Expected: `✓ built in Ns`.

Then sweep for the two crash patterns:

```bash
cd "C:/Users/asusg/Desktop/ai-content-studio-saas"
python -X utf8 -c "
import pathlib, re
s = pathlib.Path('client/src/pages/RunsPage.jsx').read_text(encoding='utf-8')
imported=set()
for m in re.finditer(r\"import\s+(?:\w+,\s*)?\{([^}]*)\}\s*from\s*'react'\", s):
    imported |= {x.strip() for x in m.group(1).split(',')}
used=set(re.findall(r'\buse(?:State|Effect|Memo|Ref|Callback)\b', s))
print('hooks missing:', sorted(used-imported) or 'none')
"
```

Expected: `none`.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/RunsPage.jsx client/src/services/api.js client/src/App.jsx client/src/context/AppContext.jsx client/dist
git commit -m "feat(runs): Runs page with setup, cost estimate and run list"
```

---

### Task 7: Review gate

**Files:**
- Modify: `client/src/pages/RunsPage.jsx`

**Interfaces:**
- Consumes: `runs.review`, `runs.regenerate`
- Produces: nothing downstream

- [ ] **Step 1: Build the review grid**

When `run.status === 'awaiting-review'`, render every job as a card: the generated image (via `galleryApi.imageUrl(job.image.galleryId)`), its outfit and pose names, and three actions — **Keep**, **Drop**, **Regenerate**. A failed image shows its `error` text and offers only Regenerate.

Add an **Approve all** button calling `runs.review(id, { approveAll: true })`.

Show a running count: "18 kept · 4 dropped · 3 undecided".

- [ ] **Step 2: Verify the gate blocks on undecided**

The Animate button must be disabled while any job is `undecided`, with the reason shown. Verify by loading a run with mixed verdicts and confirming the button is disabled and labelled.

- [ ] **Step 3: Build the app and sweep**

Run: `cd client && npm run build`
Expected: `✓ built in Ns`. Re-run the hooks sweep from Task 6 Step 5.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/RunsPage.jsx client/dist
git commit -m "feat(runs): image review gate with keep, drop and regenerate"
```

---

### Task 8: Video stage with typed confirmation

**Files:**
- Modify: `client/src/pages/RunsPage.jsx`

**Interfaces:**
- Consumes: `runs.animate`, `runs.cancel`

- [ ] **Step 1: Build the confirmation**

Before calling `runs.animate`, show a modal (through `createPortal` to `document.body` — a plain fixed overlay is trapped by this app's backdrop-filtered cards) stating: `N clips · $X.XX` and requiring the word `GO` typed into an input before the confirm button enables.

- [ ] **Step 2: Build the video progress view**

While `generating-videos`, show each approved job with its video status. A finished clip links to `videoApi.cleanFileUrl(filename)` so the download is stripped. A failed one shows its error and a re-run button for that job alone.

- [ ] **Step 3: Verify the cancel rule**

Cancel a run mid-stage, then confirm the Animate button requires the typed confirmation again rather than resuming silently.

- [ ] **Step 4: Build and sweep**

Run: `cd client && npm run build`
Expected: `✓ built in Ns`. Re-run the hooks sweep.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/RunsPage.jsx client/dist
git commit -m "feat(runs): video stage with typed confirmation and per-job retry"
```

---

### Task 9: End-to-end verification

**Files:** none — this task runs the app.

- [ ] **Step 1: Restart on the new server code**

```bash
cd "C:/Users/asusg/Desktop/ai-content-studio-saas"
cmd //c start "" wscript.exe "C:\Users\asusg\Desktop\ai-content-studio-saas\Launch Kyros Studio.vbs"
```

A restart is required: Node caches modules at startup, so Ctrl+R will not pick up any of Tasks 2–5.

- [ ] **Step 2: Smallest possible run**

1 outfit × 1 pose. Confirm: one image generates, the review gate appears, Keep enables Animate, the typed confirm is required, one clip is produced.

- [ ] **Step 3: Resume after a kill**

Start a 4-job run. While images are generating, kill the app. Restart it and open the run.

Expected: state matches what was persisted; remaining jobs continue; no job generates twice.

- [ ] **Step 4: Failure isolation**

Delete a pose that a queued run references. Expected: that job fails with a message naming the pose, the other jobs finish, and the run reaches `awaiting-review` rather than dying.

- [ ] **Step 5: Cancel**

Cancel mid-stage. Expected: dispatch stops, in-flight jobs still finish, and restarting requires a fresh typed confirmation.

- [ ] **Step 6: Commit the verification notes**

```bash
git add docs/superpowers/plans/2026-07-20-run-pipeline.md
git commit -m "docs: record run pipeline end-to-end verification results"
```
