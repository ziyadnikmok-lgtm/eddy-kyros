/**
 * Cross-tool retry: move a batch of FAILED jobs from one generator to another (Photo Match ⇄
 * Scene Recreate ⇄ Pose Remix), reusing each job's SAME character + SAME source frame. Only
 * the generation settings switch to the destination tool's own (a Scene job can't run with
 * Photo Match settings and vice-versa) — the model/provider/aspect/resolution carry over when
 * they map cleanly.
 *
 * Writes directly to the destination's IndexedDB source store + queue store (awaited before
 * we navigate), so the moved jobs are ready the moment the destination page mounts — the
 * background worker or the page then processes them like any other queued job.
 */

import { makePersistentJobId } from './persistentPageState';
import { photoMatchStore, poseFixStore, scenePageStore } from './generationQueues';
import { DEFAULT_IMAGE_MODEL } from '../config/photoModes';
import * as pmSrc from './photoMatchSourceStore';
import * as poseSrc from './poseFixSourceStore';
import * as sceneSrc from './sceneSourceStore';

const TOOLS = {
  photoMatch: { store: photoMatchStore, src: pmSrc, page: 'photoMatch', label: 'Photo Match' },
  poseFix: { store: poseFixStore, src: poseSrc, page: 'poseFix', label: 'Pose Remix' },
  scene: { store: scenePageStore, src: sceneSrc, page: 'scene', label: 'Scene Recreate' },
};

export const crossToolLabel = (key) => TOOLS[key]?.label || key;

// Pull settings that are shared across tools out of a source job's opts (the shapes differ
// per tool, so read both spellings).
function commonSettings(opts = {}) {
  return {
    model: opts.imgModel ?? opts.imageModel ?? DEFAULT_IMAGE_MODEL,
    provider: opts.prov ?? opts.provider,
    aspectRatio: opts.ar ?? opts.aspectRatio,
    resolutionTier: opts.resTier ?? opts.resolutionTier,
  };
}

// Build a destination-tool job (default settings for that tool) carrying the same character,
// references, source frame and traceability link.
function buildJob(toKey, { job, newFileId, srcName }) {
  const c = commonSettings(job.opts);
  const base = {
    id: makePersistentJobId(toKey),
    status: 'pending',
    fileId: newFileId,
    characterId: job.characterId,
    activeReferenceIds: Array.isArray(job.activeReferenceIds) ? job.activeReferenceIds : [],
    sourceUrl: job.sourceUrl || null,
    sourceName: job.sourceName || srcName || null,
    summary: srcName || 'Moved from another tool',
  };
  if (toKey === 'scene') {
    return {
      ...base, kind: 'scene', label: 'Scene Recreate',
      opts: {
        aspectRatio: c.aspectRatio || '4:5', resolutionTier: c.resolutionTier || '1K', imageModel: c.model,
        provider: c.provider || 'auto', sameBackground: false, samePose: false, sameHair: false, sameTattoos: false, editableScene: '',
      },
    };
  }
  const isPose = toKey === 'poseFix';
  return {
    ...base, kind: 'match', label: isPose ? 'Pose Remix' : 'Photo Match',
    opts: {
      bgStr: 85, poseStr: 85, exact: false, varyBg: false,
      ar: c.aspectRatio || (isPose ? '3:4' : '9:16'), resTier: c.resolutionTier || '1K',
      imgModel: c.model, prov: c.provider || 'gemini',
      ...(isPose ? { poseStyle: 'sexy_confident' } : {}),
    },
  };
}

/**
 * Move all failed jobs from `fromKey` → `toKey`.
 * Returns { moved, skipped, page }. `page` is the destination page id to navigate to.
 */
export async function moveFailedJobsToTool(fromKey, toKey) {
  const from = TOOLS[fromKey];
  const to = TOOLS[toKey];
  if (!from || !to || fromKey === toKey) return { moved: 0, skipped: 0 };

  const failed = (from.store.getSnapshot().queueItems || []).filter((j) => j.status === 'error');
  if (!failed.length) return { moved: 0, skipped: 0, page: to.page };

  const fromSources = await from.src.loadSources();
  const byId = new Map((fromSources || []).map((s) => [s.id, s]));
  const existing = await to.src.loadSources();
  // Reuse a matching frame already in the destination instead of piling up duplicates.
  const destByKey = new Map((existing || []).map((s) => [`${s.name}::${s.size}`, s]));

  const newSources = [];
  const newJobs = [];
  const movedIds = [];
  let skipped = 0;
  for (const job of failed) {
    const src = byId.get(job.fileId);
    if (!src || !src.dataUrl) { skipped += 1; continue; } // source frame gone — can't move
    const key = `${src.name}::${src.size}`;
    let destId = destByKey.get(key)?.id;
    if (!destId) {
      destId = `${src.name || 'frame'}-${Date.now()}-${Math.random()}`;
      const ns = { id: destId, name: src.name, type: src.type, size: src.size, dataUrl: src.dataUrl };
      newSources.push(ns);
      destByKey.set(key, ns); // later jobs on the same image reuse this one
    }
    newJobs.push(buildJob(toKey, { job, newFileId: destId, srcName: src.name }));
    movedIds.push(job.id);
  }
  if (!newJobs.length) return { moved: 0, skipped, page: to.page };

  // Persist destination sources (append new, awaited) BEFORE navigating, so the runner can
  // load them by fileId, then queue the jobs and drop the moved ones from the source queue.
  if (newSources.length) await to.src.saveSources([...(existing || []), ...newSources]);
  to.store.setValue('queueItems', (prev) => [...prev, ...newJobs]);
  from.store.setValue('queueItems', (prev) => prev.filter((j) => !movedIds.includes(j.id)));

  // Prune source frames the moved jobs leave orphaned so the source tool's picker doesn't
  // keep the old images around. (The source page unmounts on navigate, so its persist effect
  // won't re-save them; next visit hydrates the pruned set.)
  const stillNeeded = new Set((from.store.getSnapshot().queueItems || []).map((j) => j.fileId));
  const prunedSources = (fromSources || []).filter((s) => stillNeeded.has(s.id));
  if (prunedSources.length !== (fromSources || []).length) await from.src.saveSources(prunedSources);

  return { moved: newJobs.length, skipped, page: to.page };
}
