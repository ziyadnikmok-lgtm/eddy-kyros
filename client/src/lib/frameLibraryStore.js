/**
 * Frame Library storage on IndexedDB (was localStorage, which caps ~5–10MB — far too small
 * for a big batch of full-res frames). Migrates any existing localStorage frames once.
 */

const DB_NAME = 'kyros-frame-library';
const STORE = 'frames';
const VERSION = 1;
const LEGACY_KEY = 'kyros.frameLibrary.items';
const MAX_ITEMS = 2000;

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readLegacy() {
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function saveAllFrames(items) {
  try {
    const list = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS);
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      for (const it of list) { if (it && it.id) store.put(it); }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

export async function loadFrames() {
  try {
    const db = await openDB();
    const items = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error);
    });
    if (items.length) return items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    // First run: migrate any localStorage frames into IndexedDB.
    const legacy = readLegacy();
    if (legacy.length) {
      await saveAllFrames(legacy);
      try { window.localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
      return legacy;
    }
    return [];
  } catch {
    return readLegacy();
  }
}

// Append new frames (dedup by dataUrl), migrating legacy first. Returns how many were added.
export async function appendFrames(newItems) {
  try {
    const existing = await loadFrames();
    const seen = new Set(existing.map((e) => e.dataUrl));
    const fresh = (Array.isArray(newItems) ? newItems : []).filter((f) => f && f.dataUrl && !seen.has(f.dataUrl));
    if (!fresh.length) return 0;
    await saveAllFrames([...fresh, ...existing]);
    return fresh.length;
  } catch { return 0; }
}
