# Run Pipeline — character → image → video

**Status:** approved, not yet implemented
**Date:** 2026-07-20

## The problem

Making a batch of clips today means doing everything by hand, twice. Generate images in Eddy,
save the good ones, open a video page, upload each image, paste its prompt, set its duration,
press go, repeat. Twenty-five clips is an evening of clicking, and a bad face is only discovered
after paying for the video that contains it.

## What it does

Three stages, a gate before each spend.

| Stage | You do | It does |
|---|---|---|
| 1. Set up | character, outfits, poses, environment | shows the cross product and estimated cost |
| gate | approve the plan | |
| 2. Images | | generates one image per outfit × pose |
| gate | keep or regenerate each image | |
| 3. Videos | typed confirm | each approved image → its own clip |
| gate | review, re-run any failure alone | |

Motion comes from the pose: each pose carries the video prompt describing how that shot moves.
Chosen once, never per image.

## Decisions

Each of these was chosen deliberately; the reasoning matters more than the choice.

### A new Runs page, not an extension of Eddy Generate

A run is a saved object with a lifecycle, not page state. Eddy Generate stays as it is for
one-off work.

### The server owns and drives the run

The run lives server side and a worker loop drives it. Closing Kyros does not stop it — an
hour-long batch should not be hostage to a window staying open. The server already performs the
generation; the browser only orchestrates today, so this relocates a loop rather than inventing
one.

The alternative — server stores state, browser drives — is roughly a third of the work but only
preserves state, not progress. Rejected for that reason.

### One card holds image, pose prompt and video prompt

A Pose card gains a `videoPrompt` field. Each entry is then: the reference image, how she is
positioned, and how she moves. Change the image and both prompts stay attached.

Video Library becomes a filtered view of poses that have a video prompt, not a separate store.

### No migration of the existing 97 video prompts

Current state: 36 poses (32 with a usable description), 97 video prompts, **zero** overlapping
images. The two collections do not map onto each other, so merging them would be a guess.

The existing Video Library stays as a legacy collection. New work happens on Pose cards. This
ships the pipeline without a risky data migration, and a merge can happen later once the real
pairing rate is known.

*Blocked measurement:* the pairing rate could not be measured because `exportAll` was dropping
titles, so the exported video prompts had nothing to match on. That export bug is fixed
(commit `3df4eba2`); re-exporting makes the measurement possible.

### The job is the unit, not the stage

```
run
  id, name, createdAt
  status    setup → generating-images → awaiting-review
            → generating-videos → done | cancelled | failed
  recipe    characterId, poseIds[], outfitIds[], environmentId,
            instruction, nsfw, aspectRatio, resolution
  spend     imagesEstimated, imagesActual, videosEstimated, videosActual
  jobs[]

job
  id, outfitId, poseId
  image   status: pending | running | done | failed | regenerating
          galleryId, error, attempts
  review  verdict: undecided | approved | dropped
  video   status: pending | running | done | failed
          filename, error, attempts
```

One row travels all three stages. "What happened to outfit 3 × pose 5?" is answered by one
object. Three parallel lists correlated by index is how the Pose Remix blend bug happened — six
photos went out as one payload and came back as one image.

### The recipe stores IDs, not resolved content

Fixing a pose's video prompt improves every future run, and a run stays small because it embeds
no images.

Accepted consequence: deleting a pose mid-run fails its jobs with "pose was deleted" rather than
killing the run. Those clips are lost; the run is not.

## Interface

```
POST /api/runs                  create from a recipe
GET  /api/runs/:id              current state (polled by the page)
POST /api/runs/:id/start        begin stage 1
POST /api/runs/:id/review       { jobId, verdict } | { approveAll: true }
POST /api/runs/:id/regenerate   { jobId } — one image, costs one image
POST /api/runs/:id/animate      begin stage 3
POST /api/runs/:id/cancel       stop dispatching; in-flight jobs finish
```

Stored as JSON in the server data directory alongside `video-history.json`.

## Execution

The worker takes the next `pending` job for the run's current stage, marks it `running`, calls
the existing generate function, writes the result back, and repeats. **Every transition is
persisted immediately**, so a crash resumes from the file instead of losing the batch.

**Concurrency: 2.** Measured on this project: four parallel workers against Vertex finished 14
of 48 before quota exhaustion, while a single paced stream ran clean. Seedance may be more
forgiving; 2 is a safe start and a single constant to raise.

**Gates are status transitions, not UI state.** A run sits at `awaiting-review` until acted on,
so the gate survives a restart.

**Cancel stops dispatch but lets in-flight jobs finish.** Killing a request mid-flight bills for
an image never received.

## Failure handling

A failed job keeps its row, its error text and its attempt count; the loop continues. Twenty-five
jobs with three failures yields 22 clips and 3 explained rows — never a dead run.

| Failure | Response |
|---|---|
| Rate limit / quota | back off and retry, up to 5 attempts |
| Permanent (deleted pose, missing reference) | fail immediately, no retries |
| Anything else | 2 retries |

This mirrors `client/src/lib/queueEngine.js`, which already solved retry, rate-limit backoff and
give-up-after-N for Photo Match and Pose Remix.

## Money

Estimates shown before each spend; actuals accumulate as jobs complete.

Stage 3 requires a **typed confirmation** — "25 clips · $12.40 — type GO" — because it is the
expensive irreversible step. Stage 1 is an ordinary button: images are cheap and regenerable.

Two rules:

- **A cancelled run never resumes silently.** Restarting is a fresh confirmation. A run that
  quietly continued after a deliberate stop would spend money the user believed was stopped.
- **Regenerate is always exactly one image**, never a batch re-run. The button states its cost.

## Verification

There is no test framework in this project, so verification is manual and specific:

1. **End to end small:** 1 outfit × 1 pose through all three stages.
2. **Resume:** kill the server mid-stage; confirm the run resumes from its file with no
   duplicate generation.
3. **Failure isolation:** force one job to fail; confirm the run completes and that row explains
   itself.
4. **Cancel:** confirm dispatch stops, in-flight jobs finish, and restarting requires a fresh
   confirmation.
5. **Deleted dependency:** delete a pose mid-run; confirm its jobs fail with a clear reason and
   the rest complete.

## Out of scope

- Merging the 97 legacy video prompts into pose cards
- Editing a video prompt at the review gate (pose supplies it; edit the pose)
- Swapping an image from the gallery at the review gate (regenerate or drop only)
- Scheduling or unattended runs
