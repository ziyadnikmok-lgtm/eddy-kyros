/**
 * Frame Grabber (InstagramFramesPage) session state, on IndexedDB.
 *
 * This used to live in localStorage, which caps out around 5-10MB — nowhere near enough for
 * a real batch of extracted frames (263 frames × ~100-300KB base64 each = tens of MB). So the
 * old code stripped each frame's base64 before saving ("too large for localStorage quota") and
 * kept only metadata. That's fine while the tab stays open (frames stay in memory) — but on
 * reload/restart, the stripped metadata-only version got loaded back in as if it were the full
 * state, so every frame thumbnail rendered black (frame.base64 was simply missing).
 *
 * IndexedDB has no such tiny cap, so we persist the FULL state (base64 included) and drop the
 * localStorage version entirely — reloading a big batch now shows the real thumbnails again.
 */

const DB_NAME = 'kyros-ig-frames-state';
const STORE = 'state';
const VERSION = 1;
const KEY = 'current';
const LEGACY_KEY = 'kyros.igFrames.state'; // old localStorage key — metadata-only, not recoverable

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function clearIgFramesState() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

export async function saveIgFramesState(state) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

// Returns the saved state, or a small metadata-only fallback recovered from the old localStorage
// key (urlList/frameCount/intervalMs only — allFrames/selected are dropped since the old format
// never actually saved the image data, so "restoring" them would just show black frames again).
export async function loadIgFramesState() {
  try {
    const db = await openDB();
    const state = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (state) return state;
  } catch { /* fall through to legacy */ }

  try {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    window.localStorage.removeItem(LEGACY_KEY); // one-time: never useful again, drop it
    if (!raw) return null;
    const legacy = JSON.parse(raw);
    return { urlList: legacy.urlList, frameCount: legacy.frameCount, intervalMs: legacy.intervalMs };
  } catch {
    return null;
  }
}
