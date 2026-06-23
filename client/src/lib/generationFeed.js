'use strict';

const STORAGE_KEY = 'kyros_generation_feed_v1';
const MAX_ITEMS = 100;

// Feed items: { id, imageId, galleryId, mimeType, prompt, imageModel, aspectRatio, resolutionTier, generatedAt, status: 'pending'|'done'|'error', isVideo, videoUrl }
let _feed = [];
const _listeners = new Set();

function persist() {
  try {
    // Only persist done items that have a gallery file (galleryId) — imageId-only items
    // come from the in-memory imageStore which is cleared on restart.
    const toStore = _feed
      .filter(i => i.status === 'done' && (i.galleryId || i.isVideo))
      .slice(0, MAX_ITEMS);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch {}
}

function emit() {
  for (const fn of _listeners) fn([..._feed]);
}

// Load from sessionStorage on init — only keep items with a galleryId (file-backed)
try {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) || [];
    _feed = parsed.filter(i => i.galleryId || i.isVideo);
  }
} catch {}

// Add a pending placeholder while generating
export function pushPending({ id, prompt, imageModel, aspectRatio, resolutionTier, isVideo = false }) {
  _feed = [{ id, status: 'pending', prompt, imageModel, aspectRatio, resolutionTier, isVideo, generatedAt: Date.now() }, ..._feed];
  emit();
}

// Resolve a pending item to done
export function resolvePending(id, item) {
  _feed = _feed.map(f => f.id === id ? { ...f, ...item, id, status: 'done' } : f).slice(0, MAX_ITEMS);
  persist();
  emit();
}

// Mark a pending item as failed
export function rejectPending(id) {
  _feed = _feed.filter(f => f.id !== id);
  emit();
}

// Direct push (for batch etc.)
export function pushToFeed(item) {
  _feed = [{ ...item, status: 'done' }, ..._feed].slice(0, MAX_ITEMS);
  persist();
  emit();
}

export function getFeed() {
  return [..._feed];
}

export function subscribeFeed(fn) {
  _listeners.add(fn);
  fn([..._feed]);
  return () => _listeners.delete(fn);
}

export function removeFeedItem(id) {
  _feed = _feed.filter((item) => item.id !== id);
  persist();
  emit();
}
