# Instagram Tab — Reel Recreation, Design Spec

**Date:** 2026-07-22
**Status:** Draft for review
**Branch:** `feat/run-pipeline`

## Goal

A new **Instagram** tab in Kyros. The user drops a viral reel (video file, or best-effort
URL download). The tab detects the reel's shots, analyzes the single main character in each,
and recreates each shot as an **image of the user's own Character**. It then assembles those
images into a **slideshow reel** — each image held for its shot's duration, synced to the
**original audio**, with recreated **caption/emoji text overlays** — and writes a viral-style
**post caption**. Output is a finished reel plus its caption, using the user's AI model only.

## Non-Goals (YAGNI — explicitly out)

- **No AI video generation.** The reel is an image slideshow, not Seedance clips. Zero
  per-clip video cost. (Dropped from an earlier draft.)
- **No "Edge"/intensity dial.** Recreation is faithful to the source. The provocativeness comes
  from which reel the user feeds in, not from the tool amplifying it.
- **No deepfake of the real creator.** The tool analyzes the reel's *structure* (shots, poses,
  pacing, on-screen text) and puts the **user's Character** in it. It never reproduces the real
  person's face or likeness. This is the load-bearing safety line, enforced by only ever
  rendering identity from the user's selected Character.
- **No pixel-perfect cloning** of the source's on-screen text fonts or exotic transitions. Text
  is *recreated* as our own overlays (matching content/vibe); cuts are hard cuts on the detected
  timing.

## Architecture — orchestrator over existing services

The tab is mostly an **orchestration layer**. Reused pieces:

| Concern | Existing code reused |
|---|---|
| Reel download from URL + ffmpeg | `server/routes/instagramFrames.js` (cookie/proxy scraper, `utils/ffmpeg`) |
| Scene/keyframe extraction | ffmpeg via the frames route pattern |
| Vision + text (Gemini) | `server/services/geminiVertexService.js` |
| Per-shot recreation with Character | Scene Recreate (Seedream): `seedreamApi.edit` + `characterId`, as in `SceneRecreateSeedreamPage.jsx` |
| Slideshow assembly (ffmpeg) | `server/routes/videoCompose.js` (concat/filter_complex patterns) |
| Cost confirmation gate, review grid | The Eddy `PreRunConfirmGate` / results-grid patterns |
| Page nav registration | `VALID_PAGE_IDS` in `AppContext.jsx`; sidebar in `App.jsx` |

New code: one page (`InstagramReelPage.jsx`), one orchestration route
(`server/routes/instagramReel.js`), and one analysis+assembly service
(`server/services/reelRecreate/`).

## Data model — the Shot

Analysis produces an ordered list of shots. Each shot:

```
{
  index:        0-based order
  startSec:     start time in the source
  durationSec:  how long this shot is held (drives the slideshow timing)
  keyframePath: extracted representative frame (server temp)
  analysis: {
    sceneDescription:  what the shot shows (background, framing, camera angle)
    pose:              the main character's pose/action
    outfit:            described outfit
    onScreenText:      any caption/emoji text burned into the shot ('' if none)
  },
  recreatePrompt:  the Scene-Recreate prompt built from analysis (Character swapped in)
  result: {                         // filled by the recreate stage
    galleryId, imageId, status: 'pending'|'done'|'failed', error?
  }
}
```

The source audio track is extracted once (`audio.m4a` in the run's temp dir) and reused
verbatim in assembly.

## Data flow (pipeline)

1. **Ingest.** User drops a video file → uploaded to a run temp dir. Or pastes a URL → the
   `instagramFrames` scraper attempts download; on any failure it returns a clear "couldn't
   fetch — download it and drop the file" message (no silent failure). No ToS-violating retries.
2. **Detect shots.** ffmpeg scene-cut (`select='gt(scene,THRESH)'` + `showinfo`, plus a minimum
   shot length so micro-cuts don't explode the count) → ordered shots with `startSec` /
   `durationSec` and one extracted keyframe each. Extract the audio track once.
3. **Analyze.** For each keyframe, one Gemini vision call → `sceneDescription`, `pose`, `outfit`,
   `onScreenText`. The tab shows **"N shots"** with each description and the detected on-screen
   text. **Cost-free checkpoint** — the user can drop shots before spending.
4. **Recreate (paid).** A cost gate shows **N images × price = total** before anything runs.
   On confirm, each shot's `recreatePrompt` runs through Scene Recreate (Seedream) with the
   user's `characterId`, capped at a small concurrency (reuse Eddy's pool). Results land in a
   **review grid**: keep / drop / regenerate per shot (drop excludes it from the reel).
5. **Assemble (free).** ffmpeg builds the slideshow: each kept image shown for its
   `durationSec`, concatenated in `index` order, muxed with the extracted **original audio**
   (trimmed/padded to the images' total length), with **drawtext overlays** re-rendering each
   shot's `onScreenText` (+emoji) where the original had text. Output MP4 → saved to the Video
   Library and downloadable (through the metadata stripper, like every other download).
6. **Caption.** One Gemini text call reads the analysis + on-screen text → a viral-style post
   caption with hashtags/emojis, shown for copy.

## Cost

Only step 4 spends: **N images** at the Seedream per-image price, shown as a full bill before
generation, reusing the existing `PreRunConfirmGate`. Steps 2, 3, 5 are local ffmpeg/analysis;
step 6 is a single cheap Gemini text call. No video-generation cost anywhere.

## Error handling

- URL download failure → explicit "drop the file instead" message; never a silent empty run.
- A shot whose keyframe won't analyze → shown as "analysis failed, describe/skip", not dropped
  silently.
- A failed recreate → keeps the shot in the grid with its error (retryable), does not abort the
  batch (same contract as Eddy's pool).
- Assembly with a missing image → that shot is skipped from the edit with a visible note, rather
  than producing a broken MP4.
- Original audio shorter/longer than the images' total → padded with silence / trimmed, never a
  desync crash.

## Phasing

- **Phase 1:** ingest (file + URL) → detect shots → analyze → recreate images (Scene Recreate,
  review grid, cost gate) → post caption. Delivers "your model, every shot, + caption."
- **Phase 2:** the slideshow assembly — images on the original audio with the caption/emoji
  overlays → the finished downloadable reel.

Each phase is independently testable and useful. Phase 1 ships the expensive/valuable core;
Phase 2 is local ffmpeg assembly with no new spend.

## Identity & safety (restated, non-negotiable)

Every rendered person is the user's selected **Character**. The source reel's real creator is
never reproduced. The tab reads structure and text, not identity. This is enforced by the
recreate stage requiring a `characterId` and rendering only from the Character's reference
images — there is no code path that renders the source person's face.
