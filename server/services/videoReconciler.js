const path = require('node:path');
const wavespeed = require('./wavespeedService');
const muapi = require('./muapiService');
const videoHistory = require('./videoHistoryStore');
const apiKeyManager = require('./apiKeyManager');
const { UPLOADS_DIR } = require('../paths');
const { logUsageEvent, finishGenerationRun } = require('./eventLogger');
const { MUAPI_PRICE_PER_SECOND } = require('../config/muapiVideoModels');
const log = require('../utils/logger');

const VIDEO_DIR = path.join(UPLOADS_DIR, 'videos');

const POLL_INTERVAL_MS = 6000;
// Muapi renders in minutes. Past this a task is not coming back, and we stop asking rather
// than hammer their API forever on every app start.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// Why this file exists: the download used to happen ONLY inside GET /:taskId/status, and the
// only caller was a setInterval living inside a page component. Navigating away cleared the
// interval, so nobody ever asked Muapi again — the render finished, the file was never
// downloaded, and the history entry sat at 'processing' forever while Muapi reported
// 'completed'. Generation must not depend on a browser tab staying mounted.

// One reconcile per task at a time. Both the poller and a live page can call this for the same
// task, and the guards below ('!entry.localPath', '!entry.spendTracked') are read-modify-write
// against a JSON file — two concurrent passes would both see 'not yet done' and download twice
// AND bill the user twice. Sharing the promise means one execution and both callers get the
// result.
const inFlight = new Map();

function reconcileMuapiEntry(entry, opts = {}) {
  const existing = inFlight.get(entry.taskId);
  if (existing) return existing;
  const p = _reconcileMuapi(entry, opts).finally(() => inFlight.delete(entry.taskId));
  inFlight.set(entry.taskId, p);
  return p;
}

async function _reconcileMuapi(entry, { userId = null } = {}) {
  const { taskId } = entry;
  const result = await muapi.getTaskStatus(taskId);

  if (result.status === 'completed' && result.outputs?.length > 0) {
    // Re-read: this entry may have been captured before an earlier pass completed it.
    const fresh = videoHistory.findByTaskId(taskId) || entry;
    if (!fresh.localPath) {
      try {
        const { filename, filePath } = await wavespeed.downloadVideo(result.outputs[0], VIDEO_DIR);
        videoHistory.update(fresh.id, { status: 'completed', videoUrl: result.outputs[0], localPath: filePath, filename });
        finishGenerationRun(taskId, { status: 'succeeded', outputCount: 1, provider: 'muapi', model: fresh.model });
        logUsageEvent({
          userId,
          eventType: 'generation.succeeded',
          entityType: 'generation_run',
          entityId: taskId,
          source: 'video',
          payload: { feature: 'video', provider: 'muapi', localFilename: filename },
        });
        result.localFilename = filename;
      } catch (dlErr) {
        // The render succeeded and we hold the URL — record that much so it isn't lost, and
        // leave localPath unset so a later pass retries the download.
        log.warn('muapi_video_auto_download_failed', { taskId, error: dlErr.message });
        videoHistory.update(fresh.id, { status: 'completed', videoUrl: result.outputs[0] });
        finishGenerationRun(taskId, { status: 'succeeded', outputCount: 1, provider: 'muapi', model: fresh.model });
      }
      if (!fresh.spendTracked) {
        const perSecond = MUAPI_PRICE_PER_SECOND[fresh.model] || 0;
        const cost = perSecond * (fresh.duration || 5);
        if (cost > 0) {
          apiKeyManager.addExternalSpend(cost, 'video');
          videoHistory.update(fresh.id, { spendTracked: true });
        }
      }
    } else if (fresh.filename) {
      result.localFilename = fresh.filename;
    }
  }

  if (result.status === 'failed') {
    videoHistory.update(entry.id, { status: 'failed', error: result.error || 'Generation failed' });
    finishGenerationRun(taskId, {
      status: 'failed',
      outputCount: 0,
      provider: 'muapi',
      model: entry.model,
      errorCode: 'TASK_FAILED',
      errorMessage: result.error || 'Generation failed',
    });
    logUsageEvent({
      userId,
      eventType: 'generation.failed',
      entityType: 'generation_run',
      entityId: taskId,
      source: 'video',
      payload: { feature: 'video', provider: 'muapi', errorCode: 'TASK_FAILED', message: result.error || 'Generation failed' },
    });
  }

  return result;
}

function pendingMuapiEntries() {
  return videoHistory.list().filter((e) => e.provider === 'muapi' && e.status === 'processing' && e.taskId);
}

async function runOnce() {
  const pending = pendingMuapiEntries();
  if (!pending.length) return;

  for (const entry of pending) {
    const age = Date.now() - new Date(entry.createdAt).getTime();
    try {
      await reconcileMuapiEntry(entry);
    } catch (err) {
      // A blip shouldn't kill the task — keep it pending and retry next tick. Only give up
      // once it's clearly never coming back, so the UI stops claiming it's still rendering.
      if (age > STALE_AFTER_MS) {
        log.warn('muapi_video_abandoned', { taskId: entry.taskId, error: err.message });
        videoHistory.update(entry.id, { status: 'failed', error: 'Task did not complete — Muapi stopped reporting it.' });
      }
    }
  }
}

let timer = null;

function startVideoReconciler() {
  if (timer) return;
  // Immediate pass so anything left 'processing' by a closed app (or by the old
  // client-poll-only design) gets recovered at startup rather than sitting stuck forever.
  runOnce().catch((err) => log.warn('video_reconciler_startup_pass_failed', { error: err.message }));
  timer = setInterval(() => {
    runOnce().catch((err) => log.warn('video_reconciler_tick_failed', { error: err.message }));
  }, POLL_INTERVAL_MS);
  if (timer.unref) timer.unref();
  log.info('video_reconciler_started', { intervalMs: POLL_INTERVAL_MS });
}

function stopVideoReconciler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { reconcileMuapiEntry, startVideoReconciler, stopVideoReconciler, runOnce, pendingMuapiEntries };
