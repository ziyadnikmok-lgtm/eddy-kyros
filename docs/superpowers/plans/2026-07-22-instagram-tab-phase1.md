# Instagram Tab — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Instagram tab's recreation core — drop/URL a reel, auto-detect its shots, analyze each with Gemini, recreate every shot as an image of the user's Character, and write a viral post caption. (Slideshow assembly is Phase 2.)

**Architecture:** A new page (`InstagramReelPage.jsx`) drives a new route group (`server/routes/instagramReel.js`) that orchestrates existing services: the `instagramFrames` yt-dlp/Apify downloader for URL ingest, ffmpeg (via `server/utils/ffmpeg`) for scene-cut detection + keyframe/audio extraction, `geminiVertexService` for per-keyframe analysis and the caption, and `POST /api/seedream/edit` for per-shot recreation with the user's `characterId`. UI reuses Eddy's `PreRunConfirmGate` cost gate and results-grid patterns.

**Tech Stack:** React/Vite (client), Node/Express (server), ffmpeg (ffmpeg-static path), Vertex Gemini, Seedream (WaveSpeed/Muapi).

## Global Constraints

- **No test framework exists.** Verification is `cd client && npm run build` for the client, `node --input-type=module -e "…"` / `node -e "…"` extract-and-run for pure server functions, and reading the code. Do NOT invent pytest/jest. Every "test" step below uses one of these.
- `client/dist` IS committed — rebuild and commit it whenever client source changes.
- Windows only; no bash in shipped scripts. ffmpeg/yt-dlp spawned via `execFile` with no shell.
- Gemini key: `apiKeyManager.getActiveKeyOrNull()`; call `geminiService.analyzeImageWithPrompt(apiKey, imageBase64, mimeType, prompt)` (returns text) and `geminiService.generateText(apiKey, prompt, options)` (returns text). `geminiService = require('../services/geminiVertexService')` (a singleton instance).
- Seedream recreation: `POST /api/seedream/edit` body `{ images: [dataUrl…], prompt, aspectRatio, resolution }` → `{ images: [{ galleryId, imageId, mimeType }] }`. Character reference images come from `charApi`/`referenceManager` exactly as `SceneRecreateSeedreamPage.jsx` builds them.
- **Identity is the user's Character only.** No code path may render the source person. The recreate call always includes `characterId` reference images; the source keyframe is used ONLY as the scene blueprint, never as an identity/face reference.
- Money: the recreate stage (only paid stage) MUST show a full `PreRunConfirmGate` bill (N images × price) before any generation. Cancel dispatches zero requests.
- Temp files live under the run's own dir (`getTempDir()/instagram-reel/<runId>/`); never touch the user's content folders.

---

### Task 1: Page scaffold + nav registration

**Files:**
- Create: `client/src/pages/InstagramReelPage.jsx`
- Modify: `client/src/context/AppContext.jsx` (add `'instagramReel'` to `VALID_PAGE_IDS`)
- Modify: `client/src/App.jsx` (lazy import + render case + sidebar entry under a fitting section)

**Interfaces:**
- Produces: a routable page id `'instagramReel'` rendering `<InstagramReelPage/>`.

- [ ] **Step 1: Placeholder page.** Create `InstagramReelPage.jsx` exporting a default component that renders a header "Instagram" + subtitle "Recreate a reel with your model" and an empty two-column shell (left = setup, right = shots), mirroring `EddyGeneratePage.jsx`'s layout wrappers (fixed ~460px left column, right column `flex-1`, both `overflow-y-auto`).
- [ ] **Step 2: Register the id.** In `AppContext.jsx`, add `'instagramReel'` to the `VALID_PAGE_IDS` Set (an id missing from it silently falls back to another page — this is a known trap).
- [ ] **Step 3: Wire App.jsx.** Add `const InstagramReelPage = lazy(() => import('./pages/InstagramReelPage'));`, a render branch for `activePage === 'instagramReel'`, and a sidebar entry `{ id: 'instagramReel', label: 'Instagram' }` in a sensible section (near `instagramFrames`/Media Grab).
- [ ] **Step 4: Verify.** `cd client && npm run build` → `✓ built`. Grep the built bundle name to confirm the chunk emitted. Load path: navigating to the tab shows the shell (verify by reading the render branch, since there's no runtime test harness).
- [ ] **Step 5: Commit.** `git add client/src/pages/InstagramReelPage.jsx client/src/context/AppContext.jsx client/src/App.jsx client/dist && git commit -m "feat(instagram-tab): scaffold page + nav registration"`

---

### Task 2: Ingest — file upload or URL download

**Files:**
- Create: `server/routes/instagramReel.js`
- Modify: `server/index.js` or the route-mount file (mount `instagramReel` router at `/api/instagram-reel`)
- Reference: `server/routes/instagramFrames.js` (`resolveYtDlp()`, `detectPlatform()`, `tryApifyImageFallback()`, session-dir pattern) — reuse its download helpers rather than reimplement.

**Interfaces:**
- Produces: `POST /api/instagram-reel/ingest` — accepts either a multipart video file OR JSON `{ url }`. Returns `{ runId, videoPath, source: 'upload'|'url' }`. On URL failure returns HTTP 422 `{ error: "Couldn't download from that link — download the reel and drop the file instead." }` (no silent empty run).

- [ ] **Step 1: Run dir + upload path.** In the new router, on ingest create `runId` (`crypto.randomUUID()`), a run dir under `getTempDir()/instagram-reel/<runId>/`, and if a file is uploaded save it to `<runDir>/source.mp4`. Return `{ runId, videoPath, source: 'upload' }`.
- [ ] **Step 2: URL branch.** If body has `{ url }` and no file: reuse `instagramFrames.js`'s yt-dlp resolution + `execFile(ytDlp, ['-o', `${runDir}/source.%(ext)s`, '--no-playlist', url])`. On non-zero exit or missing output, respond 422 with the exact fallback message above. (Apify fallback is optional and image-only; for Phase 1, on video-download failure just return the 422 — do not silently produce images.)
- [ ] **Step 3: Guard.** Reject if neither file nor url present (400 `{ error: 'Provide a video file or a URL' }`). Cap upload size using the existing multipart limits.
- [ ] **Step 4: Verify.** Extract the URL-fail path and run it with a bogus url via `node -e` against the shipped handler logic (stub `execFile` to exit non-zero) → expect the 422 message. Also `node -e "require('./server/routes/instagramReel.js')"` loads without throwing.
- [ ] **Step 5: Commit.** `git add server/routes/instagramReel.js server/index.js && git commit -m "feat(instagram-tab): reel ingest (file + best-effort URL)"`

---

### Task 3: Scene detection + keyframe/audio extraction

**Files:**
- Create: `server/services/reelRecreate/detectShots.js`
- Test (extract-run): the pure parser `parseShowinfo(stderr, totalDuration)`.

**Interfaces:**
- Consumes: `videoPath`, `runDir`.
- Produces: `async detectShots(videoPath, runDir) → { shots: [{ index, startSec, durationSec, keyframePath }], audioPath }`. `parseShowinfo(stderr, totalDuration) → number[]` (ordered cut timestamps, first is always 0).

- [ ] **Step 1: Failing extract-run for the parser.** Write `parseShowinfo` that reads ffmpeg `showinfo` stderr lines (`pts_time:<n>`) emitted by `select='gt(scene,0.3)'`, returns `[0, ...cutTimes]`, merges any two cuts closer than `MIN_SHOT_SEC = 0.8` (keep the earlier), and appends `totalDuration` as the final boundary so the last shot's duration is computable. Extract it and run:
  ```
  node --input-type=module -e "import('./server/services/reelRecreate/detectShots.js').then(m=>{const c=m.parseShowinfo('pts_time:1.2\\npts_time:1.3\\npts_time:4.0',6.0);console.log(JSON.stringify(c))})"
  ```
  Expected `[0,1.2,4,6]` (1.3 merged into 1.2 by MIN_SHOT_SEC; 6 appended as end).
- [ ] **Step 2: Implement the parser** to make that output true.
- [ ] **Step 3: Wire ffmpeg.** `detectShots` runs, via `execFile(require('../../utils/ffmpeg'), […])`: (a) `ffprobe`-style duration read (or `ffmpeg -i` stderr parse) for `totalDuration`; (b) the scene-detect pass with `-vf "select='gt(scene,0.3)',showinfo" -f null -` capturing stderr → `parseShowinfo`; (c) for each boundary pair, extract one keyframe at the shot's start `+0.1s` to `<runDir>/shot_<i>.jpg` via `-ss <t> -frames:v 1`; (d) extract audio once to `<runDir>/audio.m4a` via `-vn -c:a copy` (fallback `-c:a aac` if copy fails). Build the `shots` array with `startSec`, `durationSec = next - start`, `keyframePath`.
- [ ] **Step 4: Verify end-to-end on a fixture.** Use any short local mp4 copied into the scratchpad (never a user content folder). Run `detectShots` and print the shot count + that each `keyframePath` exists and `audioPath` exists. Confirm shots are ordered and durations are positive.
- [ ] **Step 5: Commit.** `git add server/services/reelRecreate/detectShots.js && git commit -m "feat(instagram-tab): ffmpeg scene detection + keyframe/audio extraction"`

---

### Task 4: Gemini analysis + recreate-prompt builder

**Files:**
- Create: `server/services/reelRecreate/analyzeShots.js`
- Modify: `server/routes/instagramReel.js` (add `POST /api/instagram-reel/analyze`)
- Test (extract-run): `buildRecreatePrompt(analysis)`.

**Interfaces:**
- Consumes: `shots` (from Task 3), `apiKeyManager.getActiveKeyOrNull()`, `geminiService.analyzeImageWithPrompt`.
- Produces: `async analyzeShots(shots, apiKey) → shots[]` each gaining `analysis: { sceneDescription, pose, outfit, onScreenText }` and `recreatePrompt: string`. `buildRecreatePrompt(analysis) → string`.

- [ ] **Step 1: Analysis prompt constant.** One instruction telling Gemini to return STRICT JSON `{ "sceneDescription", "pose", "outfit", "onScreenText" }` for the attached frame — describing the single main person's pose, her outfit, the background/framing/camera angle, and any on-screen caption/emoji text verbatim (`onScreenText: ""` if none). Read each `keyframePath`, base64 it, call `geminiService.analyzeImageWithPrompt(apiKey, b64, 'image/jpeg', PROMPT)`, `JSON.parse` with a regex fallback (the existing pose-JSON pattern) so a malformed reply still yields fields rather than throwing.
- [ ] **Step 2: Failing extract-run for `buildRecreatePrompt`.** It composes the Scene-Recreate prompt: the scene/pose/outfit from `analysis`, explicitly stating the person is the user's Character (identity from the reference images, NOT the frame), and that the frame is a scene blueprint only. Assert the output contains the sceneDescription, the pose, and the phrase `scene blueprint` and does NOT instruct copying the frame's face. Run via `node --input-type=module`.
- [ ] **Step 3: Implement `buildRecreatePrompt`** to satisfy the assertion. Reuse the wording contract from `SceneRecreateSeedreamPage.jsx`'s prompt (identity from refs, scene from source, "recreate her pose exactly", never take the face from the source).
- [ ] **Step 4: Route.** `POST /api/instagram-reel/analyze` body `{ runId }` → loads that run's shots (from Task 3, run detection here if not cached), calls `analyzeShots`, returns `{ shots }` (each with `analysis` + `recreatePrompt`, and a base64 or served URL for its keyframe so the UI can show it). A frame whose analysis fails is returned with `analysis: null` and a flag, not dropped.
- [ ] **Step 5: Verify.** Extract-run `buildRecreatePrompt` passes; `node -e "require('./server/services/reelRecreate/analyzeShots.js')"` loads. (The live Gemini call is exercised in-app, not billed here.)
- [ ] **Step 6: Commit.** `git add server/services/reelRecreate/analyzeShots.js server/routes/instagramReel.js && git commit -m "feat(instagram-tab): per-shot Gemini analysis + recreate-prompt builder"`

---

### Task 5: Analysis UI — ingest form + shot list + drop

**Files:**
- Modify: `client/src/pages/InstagramReelPage.jsx`
- Reference: `EddyGeneratePage.jsx` (two-column layout, Character picker, `Money` component), `client/src/services/api.js` (add `instagramReel` client methods).

**Interfaces:**
- Consumes: `POST /api/instagram-reel/ingest`, `POST /api/instagram-reel/analyze`.
- Produces: page state `shots` (with per-shot `keep` flag defaulting true) and a selected `characterId`.

- [ ] **Step 1: Left column.** A drop zone / file input for the video, a URL text field + "Fetch" button (calls ingest; on 422 shows the fallback message inline), and a Character picker reused from the Seedream pages (sets `characterId`). An "Analyze reel" button (disabled until a video is ingested) calls analyze and populates `shots`.
- [ ] **Step 2: Right column shot list.** Render each shot as a card: its keyframe thumbnail, the `sceneDescription`, `pose`, `outfit`, the detected `onScreenText` (or "no on-screen text"), and a Keep/Drop toggle (default Keep). A header shows "N shots · M kept". This is the free checkpoint — no spend yet.
- [ ] **Step 3: api.js methods.** Add `instagramReel.ingestFile(file)`, `.ingestUrl(url)`, `.analyze(runId)` mirroring existing service method style.
- [ ] **Step 4: Verify.** `cd client && npm run build` passes; read the component to confirm dropped shots (`keep=false`) are excluded from the kept count and later from the recreate payload. No hooks used-but-unimported; no dep-array-forward-ref.
- [ ] **Step 5: Commit.** `git add client/src/pages/InstagramReelPage.jsx client/src/services/api.js client/dist && git commit -m "feat(instagram-tab): ingest form + shot analysis review UI"`

---

### Task 6: Recreate kept shots (cost-gated) + review grid

**Files:**
- Modify: `client/src/pages/InstagramReelPage.jsx`
- Reference: `EddyGeneratePage.jsx` `PreRunConfirmGate`, the results-grid + per-tile Regenerate/Remove, `seedreamCost` from `client/src/config/photoModes.js`, `seedream.edit` from `client/src/services/api.js`.

**Interfaces:**
- Consumes: `seedream.edit`, `charApi` reference-image URLs, `seedreamCost(resolution, imageCount)`.
- Produces: per-shot `result: { galleryId, imageId, status }`; a `results` grid.

- [ ] **Step 1: Cost gate.** A "Recreate N shots" button (N = kept shots) opens `PreRunConfirmGate` showing `N images × seedreamCost = total` (amber via `Money`). Cancel dispatches nothing. Reuse the Eddy gate verbatim — do not invent a second style.
- [ ] **Step 2: Dispatch.** On confirm, for each kept shot call `seedream.edit({ images: [...characterRefDataUrls, keyframeDataUrl], prompt: shot.recreatePrompt, aspectRatio, resolution })`, capped at the Eddy image concurrency (`PARALLEL_REQUESTS`). The character reference images go FIRST (identity), the keyframe LAST (scene blueprint) — matching Photo Match/Scene Recreate ordering so Seedream keeps the Character's face. Store `{ galleryId, imageId, status }` on the shot.
- [ ] **Step 2b: Guard.** A shot with no `characterId` selected must fail loudly before spending ("Pick your character first"), not fall back to the source face.
- [ ] **Step 3: Review grid.** Show each recreated image beside its shot. Per tile: Regenerate (re-runs that shot's `seedream.edit`, replacing in place; a failure keeps the original and surfaces the error) and Remove (drops it from the reel set). Reuse Eddy's tile behaviour and the failure contract (failed item keeps prior state, does not abort the batch).
- [ ] **Step 4: Verify.** `cd client && npm run build` passes. Read the dispatch path to confirm: Cancel → zero `seedream.edit` calls; character refs precede the keyframe in `images`; no `characterId` → no dispatch. Grep the diff so amber is only on money.
- [ ] **Step 5: Commit.** `git add client/src/pages/InstagramReelPage.jsx client/dist && git commit -m "feat(instagram-tab): cost-gated per-shot recreation + review grid"`

---

### Task 7: Viral caption

**Files:**
- Modify: `server/routes/instagramReel.js` (`POST /api/instagram-reel/caption`), `client/src/pages/InstagramReelPage.jsx`, `client/src/services/api.js`.

**Interfaces:**
- Consumes: the run's `shots[].analysis` (esp. `onScreenText`), `geminiService.generateText`.
- Produces: `POST /api/instagram-reel/caption` body `{ runId }` → `{ caption }`.

- [ ] **Step 1: Route.** Concatenate the shots' `sceneDescription` + `onScreenText` into one context string; call `geminiService.generateText(apiKey, PROMPT)` where PROMPT asks for a short viral-style Instagram caption with fitting hashtags and emojis, matching the reel's vibe. Return `{ caption }`.
- [ ] **Step 2: UI.** A "Write caption" button under the grid → shows the caption in a read-only box with a Copy button.
- [ ] **Step 3: api.js.** Add `instagramReel.caption(runId)`.
- [ ] **Step 4: Verify.** `cd client && npm run build`; `node -e "require('./server/routes/instagram-reel.js')"`-style load check for the route file; read the route to confirm it uses the run's real analysis, not a hardcoded string.
- [ ] **Step 5: Commit.** `git add server/routes/instagramReel.js client/src/pages/InstagramReelPage.jsx client/src/services/api.js client/dist && git commit -m "feat(instagram-tab): viral caption from shot analysis"`

---

## Phase 1 Done = the tab can: ingest a reel, show its N shots with on-screen text, let the user drop shots, recreate the kept ones as their Character behind a cost gate with a review grid, and produce a caption. **Phase 2** (separate plan) adds the ffmpeg slideshow assembly: kept images on the original audio with re-rendered caption/emoji overlays → the finished downloadable reel.

## Self-Review notes
- Spec coverage: ingest ✓(T2), detect ✓(T3), analyze+onScreenText ✓(T4), page+nav ✓(T1), review/drop ✓(T5), gated recreate+grid ✓(T6), caption ✓(T7). Slideshow assembly deliberately deferred to Phase 2 per spec phasing.
- Identity line enforced in T4 (prompt) + T6 (refs-first ordering, characterId-required guard).
- No-test-framework reality honored: every verify step is build / extract-run / code-read, never pytest.
