/**
 * Frame Library Collections (Folders)
 * Stored in localStorage as an array of collection objects.
 * Each collection: { id, name, color, createdAt, frameIds: string[] }
 */

const KEY = 'kyros.frameLibrary.collections';

const COLORS = [
  '#a855f7', // purple
  '#ec4899', // pink
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#06b6d4', // cyan
  '#f97316', // orange
];

export function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

export function loadCollections() {
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveCollections(cols) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(Array.isArray(cols) ? cols : []));
  } catch {}
}

export function createCollection(name, color) {
  const cols = loadCollections();
  const col = {
    id: `col-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || 'Untitled',
    color: color || randomColor(),
    createdAt: Date.now(),
    frameIds: [],
  };
  saveCollections([...cols, col]);
  return col;
}

export function deleteCollection(id) {
  saveCollections(loadCollections().filter((c) => c.id !== id));
}

export function renameCollection(id, name) {
  saveCollections(loadCollections().map((c) => c.id === id ? { ...c, name: name.trim() || c.name } : c));
}

export function addFrameToCollection(collectionId, frameId) {
  saveCollections(loadCollections().map((c) =>
    c.id === collectionId
      ? { ...c, frameIds: Array.from(new Set([...(c.frameIds || []), frameId])) }
      : c
  ));
}

export function removeFrameFromCollection(collectionId, frameId) {
  saveCollections(loadCollections().map((c) =>
    c.id === collectionId
      ? { ...c, frameIds: (c.frameIds || []).filter((id) => id !== frameId) }
      : c
  ));
}

export function removeFrameFromAllCollections(frameId) {
  saveCollections(loadCollections().map((c) => ({
    ...c,
    frameIds: (c.frameIds || []).filter((id) => id !== frameId),
  })));
}

export function addFramesToCollection(collectionId, frameIds) {
  const set = new Set(frameIds);
  saveCollections(loadCollections().map((c) =>
    c.id === collectionId
      ? { ...c, frameIds: Array.from(new Set([...(c.frameIds || []), ...set])) }
      : c
  ));
}
