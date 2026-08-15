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

/**
 * ONE CONNECTION PER DATABASE, KEPT OPEN.
 *
 * Every get and every set used to call indexedDB.open() and throw the handle away. Measured on the
 * owner's machine (2026-08-15) that is ~34 ms per read on the Eddy Library — and the Library asks
 * for one read per row, of which there are 2,298. Seventy-eight seconds of connection overhead to
 * paint one tab, all of it on the thread the grid renders on. The same handle reused: 2.5 ms.
 *
 * Safe to hold: the schema is version 1 and never changes, so a live connection can never block an
 * upgrade. The two ways a held handle can go stale — another context upgrading (`versionchange`) or
 * the browser closing it under us (`close`) — both evict it here, and withDB() retries once.
 */
const _conns = new Map();

function openDB(dbName) {
  const cached = _conns.get(dbName);
  if (cached) return cached;

  const p = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(dbName, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      const evict = () => { if (_conns.get(dbName) === p) _conns.delete(dbName); };
      // Someone else wants a new schema version: let go, or we block them forever.
      db.onversionchange = () => { evict(); try { db.close(); } catch { /* already gone */ } };
      db.onclose = evict;   // closed out from under us (storage pressure, tab discarded)
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });

  // A failed open must not stay in the map, or one bad moment poisons the store for the session.
  p.catch(() => { if (_conns.get(dbName) === p) _conns.delete(dbName); });
  _conns.set(dbName, p);
  return p;
}

/**
 * Run `fn` against the shared connection, once more with a fresh one if the first attempt failed.
 *
 * A cached handle can be closed between being handed out and being used, which surfaces as
 * InvalidStateError on transaction(). That is not a real failure — reopening fixes it.
 *
 * ONLY that error retries. A quota failure is a real answer ("storage is full"), and retrying it
 * would reopen the database on every write once the disk is full — turning a slow save into a
 * slower one at exactly the moment things are already going wrong.
 */
const isDeadConnection = (err) => (
  err?.name === 'InvalidStateError' || /closing|closed/i.test(err?.message || '')
);

async function withDB(dbName, fn) {
  for (let attempt = 0; ; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- two attempts, strictly in order
    const db = await openDB(dbName);
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn(db);
    } catch (err) {
      if (attempt > 0 || !isDeadConnection(err)) throw err;
      _conns.delete(dbName);
    }
  }
}

export function createPageStore(dbName) {
  return {
    async get(key, fallback = null) {
      try {
        const rec = await withDB(dbName, (db) => new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).get(key);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }));
        return rec ? rec.value : fallback;
      } catch {
        return fallback;
      }
    },

    /**
     * Several keys in ONE transaction.
     *
     * The image pump reads eight pictures at a time. Eight `get`s is eight transactions, each with
     * its own round trip; one transaction with eight requests is a single trip. Returns values
     * positionally, `fallback` where a key is absent, so the caller can zip it back against its ids.
     */
    async getMany(keys, fallback = null) {
      if (!Array.isArray(keys) || !keys.length) return [];
      try {
        return await withDB(dbName, (db) => new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly');
          const os = tx.objectStore(STORE);
          const out = new Array(keys.length).fill(fallback);
          keys.forEach((key, i) => {
            const req = os.get(key);
            req.onsuccess = () => { if (req.result) out[i] = req.result.value; };
          });
          tx.oncomplete = () => resolve(out);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }));
      } catch {
        return keys.map(() => fallback);
      }
    },

    /**
     * Every key in the store, WITHOUT reading a single value.
     *
     * This is what makes "does this row have a picture of its own?" free. Asking by reading the
     * value costs the bytes; getAllKeys costs one small list, and the Eddy Library — where every
     * row points at a server URL and not one has local bytes — goes from 2,298 reads to zero.
     */
    async keys() {
      try {
        return await withDB(dbName, (db) => new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).getAllKeys();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        }));
      } catch {
        return [];
      }
    },

    async set(key, value) {
      try {
        await withDB(dbName, (db) => new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({ key, value });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }));
        return true;
      } catch {
        // Quota/private-mode — the page still works, it just won't remember next time.
        return false;
      }
    },

    async clear() {
      try {
        await withDB(dbName, (db) => new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }));
      } catch {
        // Ignore.
      }
    },
  };
}
