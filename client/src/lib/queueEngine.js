/**
 * Global background queue worker. Keeps dispatching pending jobs and auto-retrying failures
 * for Photo Match / Pose Remix / Scene Recreate even when you've navigated away from the page.
 *
 * While a page is open it drives its own queue (faster — in-memory source files). When you
 * leave, this worker takes over: it only dispatches PENDING jobs and runs the auto-retry
 * loop. It never re-touches RUNNING jobs — an in-flight job's promise keeps updating the
 * (module-level) store after unmount, so it finishes on its own with no double-generation.
 */

import { pushPending, resolvePending, rejectPending } from './generationFeed';
import { photoMatch as photoMatchApi, scene as sceneApi, outfitSwap as outfitSwapApi } from '../services/api';
import * as pmSrc from './photoMatchSourceStore';
import * as poseSrc from './poseFixSourceStore';
import * as sceneSrc from './sceneSourceStore';
import * as outfitSrc from './outfitSourceStore';
import * as outfitTargetSrc from './outfitSwapTargetSourceStore';
import { photoMatchStore, poseFixStore, scenePageStore, outfitSwapStore, isQueuePageActive } from './generationQueues';
import { markFrameFailed, clearFrameFailed } from './frameOutcomes';

const RATE_LIMIT_COOLDOWN_BASE_MS = 8000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 45000;
const rateLimitCooldown = (a) => Math.min(RATE_LIMIT_COOLDOWN_BASE_MS * (2 ** Math.max(0, (a || 1) - 1)), RATE_LIMIT_COOLDOWN_MAX_MS);
const AUTO_RETRY_COOLDOWN_MS = 8000;
const GIVE_UP_AFTER_ATTEMPTS = 5;
const isRateLimitMessage = (m) => /rate limit|quota|resource[_ ]exhausted|\b429\b/i.test(String(m || ''));
const isPermanentFailure = (m) => /source image was removed|no character identity|add it again/i.test(String(m || ''));
const getAutoRetry = (key) => { try { const v = window.localStorage.getItem(key); return v === null ? true : v === '1'; } catch { return true; } };
const dataUrlToBase64 = (d) => String(d || '').split(',')[1] || '';

// Auto-retry is fully governed by the "Keep retrying" toggle: on = retry every non-permanent
// failure (incl. rate-limits) until it succeeds; off = fully manual (nothing auto-retries).
function isAutoRetryReady(job, now, autoRetryAll) {
  if (!autoRetryAll) return false;
  if (job.status !== 'error' || job.permanent) return false;
  if (!job.retryAt || now < job.retryAt) return false;
  return true;
}

async function loadSource(loadSources, fileId) {
  const list = await loadSources();
  return (list || []).find((s) => s.id === fileId) || null;
}

// Once a source frame has no more jobs (all done), drop it from the store so the picker
// doesn't pile up with already-generated frames. Runs only while the page is unmounted
// (the engine is activity-gated), so it can't race the page's own persist effect.
async function pruneOrphanSource(store, srcMod, fileId) {
  if ((store.getSnapshot().queueItems || []).some((j) => j.fileId === fileId)) return;
  try {
    const list = await srcMod.loadSources();
    const pruned = (list || []).filter((s) => s.id !== fileId);
    if (pruned.length !== (list || []).length) await srcMod.saveSources(pruned);
  } catch { /* ignore */ }
}

// Throws on failure; on success updates the store + generation feed.
async function runPhotoMatchLike(job, store, srcMod, poseFix) {
  const opts = job.opts || {};
  const src = await loadSource(srcMod.loadSources, job.fileId);
  if (!src) throw new Error('Source image was removed. Add it again to retry.');
  const label = job.label || (poseFix ? 'Pose Remix' : 'Photo Match');
  pushPending({ id: job.id, prompt: label, imageModel: opts.imgModel || '', aspectRatio: opts.ar, resolutionTier: opts.resTier });
  let data;
  try {
    data = await photoMatchApi.recreate({
      image: dataUrlToBase64(src.dataUrl), mimeType: src.type || 'image/jpeg',
      characterId: job.characterId,
      activeReferenceIds: job.activeReferenceIds?.length ? job.activeReferenceIds : undefined,
      bgStrength: opts.bgStr, poseStrength: opts.poseStr,
      matchMode: opts.exact != null ? (opts.exact ? 'exact' : 'match') : undefined,
      varyBackground: opts.varyBg,
      poseFix: poseFix || undefined, poseStyle: opts.poseStyle,
      aspectRatio: opts.ar, resolutionTier: opts.resTier, imageModel: opts.imgModel, provider: opts.prov,
      sourceUrl: job.sourceUrl || undefined,
    });
  } catch (e) { rejectPending(job.id); throw e; }
  store.setValue('result', data);
  store.setValue('history', (prev) => [data, ...prev].slice(0, 12));
  store.setValue('queueItems', (prev) => prev.filter((j) => j.id !== job.id));
  await pruneOrphanSource(store, srcMod, job.fileId);
  if (job.sourceName) clearFrameFailed([job.sourceName]);
  resolvePending(job.id, { imageId: data.imageId, galleryId: data.galleryId || data.imageId, mimeType: data.image?.mimeType, prompt: label, imageModel: opts.imgModel || '', aspectRatio: opts.ar, resolutionTier: opts.resTier, generatedAt: Date.now(), characterId: job.characterId || null, sourceUrl: job.sourceUrl || data.sourceUrl || null });
}

async function runSceneJob(job, store, srcMod) {
  const opts = job.opts || {};
  const src = await loadSource(srcMod.loadSources, job.fileId);
  if (!src) throw new Error('Source image was removed. Add it again to retry.');
  pushPending({ id: job.id, prompt: 'Scene Recreate', imageModel: opts.imageModel || '', aspectRatio: opts.aspectRatio, resolutionTier: opts.resolutionTier });
  let data;
  try {
    const base64 = dataUrlToBase64(src.dataUrl);
    const analyzed = await sceneApi.analyze(base64, src.type || 'image/jpeg');
    const text = Object.entries(analyzed).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
    const parsed = {};
    (opts.editableScene || text).split('\n').forEach((line) => { const idx = line.indexOf(':'); if (idx > 0) parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim(); });
    data = await sceneApi.recreate({
      sceneData: { ...analyzed, ...parsed }, characterId: job.characterId,
      activeReferenceIds: job.activeReferenceIds?.length ? job.activeReferenceIds : undefined,
      masterPromptOverride: job.masterPromptOverride || undefined,
      aspectRatio: opts.aspectRatio, resolutionTier: opts.resolutionTier, imageModel: opts.imageModel,
      sameBackground: opts.sameBackground, samePose: opts.samePose, sameHair: opts.sameHair, sameTattoos: opts.sameTattoos, provider: opts.provider,
      sourceUrl: job.sourceUrl || undefined,
    });
  } catch (e) { rejectPending(job.id); throw e; }
  store.setValue('result', data);
  store.setValue('history', (prev) => [data, ...prev].slice(0, 10));
  store.setValue('queueItems', (prev) => prev.filter((j) => j.id !== job.id));
  await pruneOrphanSource(store, srcMod, job.fileId);
  if (job.sourceName) clearFrameFailed([job.sourceName]);
  resolvePending(job.id, { imageId: data.imageId, galleryId: data.galleryId || data.imageId, mimeType: data.image?.mimeType, prompt: job.masterPromptOverride || 'Scene Recreate', imageModel: opts.imageModel || '', aspectRatio: opts.aspectRatio, resolutionTier: opts.resolutionTier, generatedAt: Date.now(), characterId: job.characterId || null, sourceUrl: job.sourceUrl || data.sourceUrl || null });
}

async function runOutfitSwapJob(job, store, srcMod) {
  const opts = job.opts || {};
  const target = await loadSource(srcMod.loadSources, job.fileId);
  const outfit = await loadSource(outfitSrc.loadSources, job.outfitSourceId);
  if (!target) throw new Error('Target image was removed. Add it again to retry.');
  if (!outfit) throw new Error('Outfit source image was removed. Add it again to retry.');
  pushPending({ id: job.id, prompt: 'Outfit Swap', imageModel: '', aspectRatio: opts.ar, resolutionTier: opts.imgSize });
  let data;
  try {
    const outfitObj = { base64: dataUrlToBase64(outfit.dataUrl), mimeType: outfit.type || 'image/jpeg' };
    const targetObj = { base64: dataUrlToBase64(target.dataUrl), mimeType: target.type || 'image/jpeg' };
    const res = await outfitSwapApi.swap({
      outfitImage: outfitObj, targetImage: targetObj,
      characterId: job.characterId || undefined,
      aspectRatio: opts.ar, imageSize: opts.imgSize,
      sourceUrl: job.sourceUrl || undefined,
    });
    data = res?.data;
    if (!data?.base64Data) throw new Error('No image returned');
  } catch (e) { rejectPending(job.id); throw e; }
  const resultUrl = `data:${data.mimeType || 'image/png'};base64,${data.base64Data}`;
  store.setValue('result', { imageUrl: resultUrl, galleryId: data.galleryId });
  store.setValue('history', (prev) => [{ imageUrl: resultUrl, galleryId: data.galleryId, ts: Date.now() }, ...(prev || [])].slice(0, 24));
  store.setValue('queueItems', (prev) => prev.filter((j) => j.id !== job.id));
  await pruneOrphanSource(store, srcMod, job.fileId); // target only — the outfit is reused across jobs
  if (job.sourceName) clearFrameFailed([job.sourceName]);
  resolvePending(job.id, { galleryId: data.galleryId, mimeType: data.mimeType || 'image/png', prompt: 'Outfit Swap', aspectRatio: opts.ar, resolutionTier: opts.imgSize, generatedAt: Date.now(), characterId: job.characterId || null, sourceUrl: job.sourceUrl || data.sourceUrl || null });
}

const CONFIGS = [
  { ns: 'photo-match', store: photoMatchStore, max: 2, autoRetryKey: 'kyros.photoMatch.autoRetryAll', srcMod: pmSrc, run: (job) => runPhotoMatchLike(job, photoMatchStore, pmSrc, false) },
  { ns: 'pose-fix', store: poseFixStore, max: 2, autoRetryKey: 'kyros.poseFix.autoRetryAll', srcMod: poseSrc, run: (job) => runPhotoMatchLike(job, poseFixStore, poseSrc, true) },
  { ns: 'scene-recreate', store: scenePageStore, max: 2, autoRetryKey: 'kyros.sceneRecreate.autoRetryAll', srcMod: sceneSrc, run: (job) => runSceneJob(job, scenePageStore, sceneSrc) },
  { ns: 'outfit-swap', store: outfitSwapStore, max: 2, autoRetryKey: 'kyros.outfitSwap.autoRetryAll', srcMod: outfitTargetSrc, run: (job) => runOutfitSwapJob(job, outfitSwapStore, outfitTargetSrc) },
];

const running = {}; // ns -> Set of job ids the worker is executing

function handleFailure(store, job, err, autoRetryKey, srcMod) {
  const msg = err?.message || 'Failed';
  const rateLimited = isRateLimitMessage(msg);
  const permanent = isPermanentFailure(msg);
  const autoOn = getAutoRetry(autoRetryKey);
  const attempts = ((store.getSnapshot().queueItems || []).find((x) => x.id === job.id)?.rlAttempts || 0) + 1;
  const gaveUp = attempts >= GIVE_UP_AFTER_ATTEMPTS; // failed too many times → mark Failed
  // Governed by the "Keep retrying" toggle, but always stops at the give-up cap.
  const willAutoRetry = !permanent && !gaveUp && autoOn;
  store.setValue('queueItems', (prev) => prev.map((j) => {
    if (j.id !== job.id) return j;
    const cooldown = rateLimited ? rateLimitCooldown(attempts) : AUTO_RETRY_COOLDOWN_MS;
    return {
      ...j, status: 'error', rateLimited, permanent: permanent || gaveUp, rlAttempts: attempts,
      retryAt: willAutoRetry ? Date.now() + cooldown : null,
      errorMessage: gaveUp ? `${msg} — failed ${attempts}× (marked Failed in Library)` : (willAutoRetry ? `${msg} — retrying…` : msg),
    };
  }));
  if (gaveUp) reportFailedFrame(job, srcMod);
}

// Load the source frame's data and mark it Failed in the Library (async, fire-and-forget).
async function reportFailedFrame(job, srcMod) {
  let dataUrl;
  try { dataUrl = (await srcMod.loadSources()).find((s) => s.id === job.fileId)?.dataUrl; } catch { /* ignore */ }
  markFrameFailed(job.sourceName || job.summary, dataUrl, 'Generator');
}

function tick(cfg) {
  if (isQueuePageActive(cfg.ns)) return; // page is open → it drives its own queue
  const store = cfg.store;
  const set = running[cfg.ns] || (running[cfg.ns] = new Set());
  const autoRetryAll = getAutoRetry(cfg.autoRetryKey);
  const now = Date.now();
  let items = store.getSnapshot().queueItems || [];

  if (autoRetryAll && items.some((j) => j.status === 'error' && !j.permanent && !j.retryAt)) {
    store.setValue('queueItems', (prev) => prev.map((j) => (j.status === 'error' && !j.permanent && !j.retryAt ? { ...j, retryAt: Date.now() + AUTO_RETRY_COOLDOWN_MS } : j)));
    items = store.getSnapshot().queueItems || [];
  }
  if (items.some((j) => isAutoRetryReady(j, now, autoRetryAll))) {
    store.setValue('queueItems', (prev) => prev.map((j) => (isAutoRetryReady(j, now, autoRetryAll) ? { ...j, status: 'pending', rateLimited: false, retryAt: null, errorMessage: '' } : j)));
    items = store.getSnapshot().queueItems || [];
  }

  const runningCount = items.filter((j) => j.status === 'running').length;
  const slots = cfg.max - runningCount;
  if (slots <= 0) return;
  const next = items.filter((j) => j.status === 'pending' && !set.has(j.id)).slice(0, slots);
  if (!next.length) return;
  store.setValue('queueItems', (prev) => prev.map((j) => (next.some((n) => n.id === j.id) ? { ...j, status: 'running', errorMessage: '' } : j)));
  for (const job of next) {
    set.add(job.id);
    cfg.run(job).catch((err) => handleFailure(store, job, err, cfg.autoRetryKey, cfg.srcMod)).finally(() => set.delete(job.id));
  }
}

let started = false;
export function startBackgroundQueues() {
  if (started) return;
  started = true;
  setInterval(() => { for (const cfg of CONFIGS) { try { tick(cfg); } catch { /* ignore */ } } }, 2500);
}
