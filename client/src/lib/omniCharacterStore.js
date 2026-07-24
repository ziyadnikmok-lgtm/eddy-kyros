/**
 * Trained Seedance Omni characters.
 *
 * Muapi's Omni Reference Train endpoint mints a durable `character_id` (e.g.
 * char_1775422630065_4vbana) that you then reference in prompts as @omni-character:<id>.
 * Muapi gives us no "list my characters" endpoint, so the mapping id -> name/thumbnail only
 * exists here. Training costs $0.50 a pop, so losing this list means paying again — hence
 * IndexedDB (durable, holds the base64 thumbnail) rather than localStorage, whose ~5-10MB
 * quota base64 images blow outright.
 *
 * Each record: { id, characterId, name, description, thumb, createdAt }
 */

const DB_NAME = 'kyros-omni-characters';
const STORE = 'characters';
const VERSION = 1;

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
export async function loadOmniCharacters() {
  try {
    const db = await openDB();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch {
    return [];
  }
}

export async function saveOmniCharacter(item) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

export async function removeOmniCharacter(id) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore — never block on the convenience list.
  }
}
