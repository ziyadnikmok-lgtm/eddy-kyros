/**
 * Shared generation queues + page-active tracking.
 *
 * The queue stores live here (not inside the page components) so a global background worker
 * can keep processing + auto-retrying jobs even when you navigate away from the page.
 * Each page marks itself active while mounted; the background worker only drives a queue
 * whose page is NOT currently mounted (the page drives it itself while open, using its
 * in-memory source files — faster). This avoids double-processing.
 */

import { createPersistentPageState } from './persistentPageState';

export const photoMatchStore = createPersistentPageState('photo-match', { result: null, history: [], queueItems: [] });
export const poseFixStore = createPersistentPageState('pose-fix', { result: null, history: [], queueItems: [] });
export const scenePageStore = createPersistentPageState('scene-recreate', { sceneData: null, editableScene: '', result: null, history: [], queueItems: [] });
export const outfitSwapStore = createPersistentPageState('outfit-swap', { result: null, history: [], queueItems: [] });

const activePages = new Set();
export function setQueuePageActive(ns, active) {
  if (active) activePages.add(ns); else activePages.delete(ns);
}
export function isQueuePageActive(ns) {
  return activePages.has(ns);
}
