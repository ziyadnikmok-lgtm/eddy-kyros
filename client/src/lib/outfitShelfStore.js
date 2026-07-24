/**
 * Durable "shelf" of saved/favourite OUTFIT images for Outfit Swap · Seedream.
 *
 * Same IndexedDB pattern as outfitSourceStore / frameLibraryStore. IndexedDB (not
 * localStorage) because these records hold full base64 images — a handful of them blows
 * localStorage's ~5-10MB quota outright, which either throws or silently drops the write.
 *
 * Unlike outfitSourceStore (which clear()s on every save because it only tracks the CURRENT
 * source), this is an append/remove collection the user curates over time.
 *
 * Each record: { id, name, dataUrl, savedAt, prompt, galleryId, sourceUrl }
 * `prompt`/`galleryId`/`sourceUrl` are provenance carried over when the outfit was picked from
 * the real gallery — so the shelf keeps the image AND the prompt that generated it. They're
 * empty/null for uploaded/pasted outfits, which genuinely have no prompt.
 */

const DB_NAME = 'kyros-outfit-shelf';
const STORE = 'outfits';
const VERSION = 1;
const MAX_ITEMS = 60;

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Newest first. */
export async function loadShelf() {
  try {
    const db = await openDB();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } catch {
    return [];
  }
}

export async function addToShelf(item) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    // Trim oldest beyond the cap so the shelf can't grow without bound.
    const all = await loadShelf();
    if (all.length > MAX_ITEMS) {
      for (const stale of all.slice(MAX_ITEMS)) await removeFromShelf(stale.id);
    }
    return true;
  } catch {
    return false;
  }
}

export async function removeFromShelf(id) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore — shelf is a convenience, never block the swap on it.
  }
}
