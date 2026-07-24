/**
 * Tiny durable key/value store for a page's in-progress sources.
 *
 * The pages already keep prompt/aspect/resolution in a module-level `_cache`, which survives
 * navigating between tabs but dies on reload — and it can't hold images anyway: a couple of
 * base64 photos blow localStorage's ~5-10MB quota, which is exactly how the Frame Library lost
 * data before it moved to IndexedDB. So sources live here instead.
 *
 * Generic on purpose: outfitSourceStore / photoMatchSourceStore / outfitShelfStore each
 * hand-rolled this same openDB boilerplate. New pages should use createPageStore().
 *
 * Records are plain {key, value} — value can be a dataUrl string, an array of them, or any
 * structured-cloneable object.
 */

const STORE = 'state';
const VERSION = 1;

function openDB(dbName) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(dbName, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function createPageStore(dbName) {
  return {
    async get(key, fallback = null) {
      try {
        const db = await openDB(dbName);
        const rec = await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).get(key);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return rec ? rec.value : fallback;
      } catch {
        return fallback;
      }
    },

    async set(key, value) {
      try {
        const db = await openDB(dbName);
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({ key, value });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        return true;
      } catch {
        // Quota/private-mode — the page still works, it just won't remember next time.
        return false;
      }
    },

    async clear() {
      try {
        const db = await openDB(dbName);
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        // Ignore.
      }
    },
  };
}
