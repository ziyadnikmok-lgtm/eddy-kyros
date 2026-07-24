'use strict';
/**
 * DORMANT — NOTHING CALLS THIS MODULE. Verify before relying on it:
 *   grep -rn "runVideo" server client/src
 * returns only this file and comments referring to it. The live Eddy video path is
 * client/src/pages/EddyGeneratePage.jsx -> POST /api/video/generate (server/routes/video.js),
 * and the model that is actually billed is the one the CLIENT posts, priced by
 * MUAPI_VIDEO_PRICES in server/config/muapiVideoModels.js. VIDEO_MODEL below drives nothing
 * today, so do NOT treat it as the client's counterpart — changing it changes no behaviour.
 * Kept deliberately for the future server-side caller described next.
 *
 * Turns one approved image + its pose's video prompt into a saved clip. The separate batch
 * "Runs" page and its supporting batch-pipeline services have been removed — the replacement
 * caller lives inside the Eddy Generate flow and ships in a later task. This module is kept
 * as-is for that: generateVideo(run, job) still expects a run-shaped object (run.recipe.poses
 * carries resolved pose text) and a job-shaped object (job.image.galleryId, job.poseId) — the
 * next task adapts what builds those inputs, not this.
 *
 * Deliberately thin: every piece of actual video generation (submit, poll, download, spend
 * tracking, history bookkeeping) is the same code the manual POST /generate + GET /:taskId/status
 * routes in server/routes/video.js already use and already trust. This module's only job is to
 * resolve a job into the inputs those functions need, then wait for the result instead of
 * returning a taskId for a browser tab to keep polling — a caller invokes this once and needs the
 * finished filename back.
 */
const fs = require('node:fs');
const galleryManager = require('./galleryManager');
const muapi = require('./muapiService');
const videoHistory = require('./videoHistoryStore');
const { reconcileMuapiEntry } = require('./videoReconciler');

// Muapi's Seedance 2 (image-to-video) path, not WaveSpeed/Kling or Gemini/Veo: it takes a base64
// image directly (no separate upload-to-a-URL round trip the WaveSpeed branch needs) and its
// completion + download + spend-tracking already live in videoReconciler.js, sharable as-is.
// Fast, not VIP: the user pays per clip and VIP costs 40% more per second ($0.21 vs $0.15) for a
// tier they never asked for. A batch of 20 six-second clips is $18 on VIP against $12.60 on Fast.
// Do not "upgrade" this without asking — it is a direct, silent price increase.
const VIDEO_MODEL = 'seedance-2-fast';

const DEFAULT_DURATION_SECONDS = 6;

// videoReconciler's own background timer already polls every 6s; matching that cadence here
// means our foreground wait and the background sweep settle on the same rhythm instead of two
// different intervals hammering Muapi out of sync.
const POLL_INTERVAL_MS = 6000;
// Generous ceiling for a single clip. Something has gone genuinely wrong past this, not just
// slow — surface it as a job failure (with a real error message) rather than hang the worker's
// batch loop, and rather than reuse videoReconciler's 2-HOUR abandonment window, which is sized
// for a passive background sweep, not a job someone is actively waiting on.
const MAX_WAIT_MS = 15 * 60 * 1000;

/**
 * The prompt template writes duration as an explicit line, e.g. "Duration: exactly 6 seconds",
 * separate from any "N seconds" phrasing inside the story beats themselves (a beat like "she
 * turns for 2 seconds" describes timing WITHIN the clip, not the clip's total length). Matching
 * only text that follows the literal "Duration:" label — and never crossing a newline while
 * looking for the number — is what keeps a beat's incidental "N seconds" from being picked up
 * instead of the real duration.
 */
function parseDurationSeconds(videoPrompt) {
  const m = String(videoPrompt || '').match(/Duration:\s*[^\n]*?(\d+)\s*seconds?/i);
  return m ? Number(m[1]) : DEFAULT_DURATION_SECONDS;
}

/**
 * Poll videoReconciler's own reconcile function to completion instead of re-implementing
 * status-check/download/spend-tracking here. Reusing it (rather than just waiting on the
 * background timer) also means this shares the SAME in-flight de-dupe map
 * (videoReconciler.js's `inFlight`) as that timer — if both land on the same task in the same
 * tick, they join one execution instead of downloading (and billing) twice.
 */
async function _waitForCompletion(entry) {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const result = await reconcileMuapiEntry(entry);
    if (result.status === 'completed' && result.localFilename) return result.localFilename;
    if (result.status === 'failed') throw new Error(result.error || 'Video generation failed');
    // status 'completed' with no localFilename yet means the render finished but the download
    // step hit an error THIS pass — reconcileMuapiEntry deliberately leaves localPath unset so
    // the next pass retries the download instead of losing the render. Loop again rather than
    // treating that as done or as failed.
    if (Date.now() > deadline) {
      throw new Error(`Video generation timed out after ${Math.round(MAX_WAIT_MS / 60000)} minutes (task ${entry.taskId}) — check the Video Gallery, it may still complete`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    // Re-fetch: reconcileMuapiEntry / the background timer may have updated this row (localPath,
    // spendTracked) between passes, and the next call should see that, not a stale snapshot.
    entry = videoHistory.findByTaskId(entry.taskId) || entry;
  }
}

/**
 * @param {object} run  the run this job belongs to (run.recipe.poses carries resolved pose text)
 * @param {object} job  one job; job.image.galleryId points at the approved, already-generated image
 * @returns {{filename: string}} the saved clip's filename, for the caller to record against the job
 */
async function generateVideo(run, job) {
  const pose = (run.recipe?.poses || []).find((p) => p.id === job.poseId);
  const videoPrompt = pose?.videoPrompt?.trim();
  // No retry can fix a pose that simply has no video prompt attached — but this module doesn't
  // own retry policy (that's the caller's job), so the message just has to be specific enough
  // that whoever reads it in the UI after any automatic retries knows exactly what to fix and
  // where.
  if (!videoPrompt) {
    throw new Error(`Pose "${job.poseId || 'none'}" has no video prompt set — add one on the Pose card, then re-animate this job.`);
  }

  const duration = parseDurationSeconds(videoPrompt);

  // Same source the manual /generate route reads from when given a galleryId (server/routes/
  // video.js): read the approved image's bytes straight off disk via galleryManager, base64 it
  // for Muapi. No re-encode — the stored file is sent exactly as saved.
  const { filePath, mimeType } = galleryManager.getFilePath(job.image.galleryId);
  const imageBase64 = fs.readFileSync(filePath).toString('base64');

  const { taskId, status } = await muapi.createVideoTask(VIDEO_MODEL, {
    imageBase64,
    imageMimeType: mimeType,
    prompt: videoPrompt.slice(0, 2500), // same cap POST /generate applies before sending to Muapi
    aspectRatio: run.recipe?.aspectRatio,
    duration,
  });

  // Same videoHistory.add shape the muapi branch of POST /generate writes — this is what makes
  // the clip show up in the Video Gallery like any other, not a run-pipeline-only side record.
  const entry = videoHistory.add({
    taskId,
    provider: 'muapi',
    model: VIDEO_MODEL,
    prompt: videoPrompt.slice(0, 2500),
    sourceImageId: job.image.galleryId,
    status: status || 'processing',
    duration,
  });

  const filename = await _waitForCompletion(entry);
  return { filename };
}

module.exports = { generateVideo, parseDurationSeconds };
