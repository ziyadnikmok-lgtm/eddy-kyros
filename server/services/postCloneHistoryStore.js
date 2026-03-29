const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { getDataDir } = require('../paths');

const MAX_ITEMS = 50;

class PostCloneHistoryStore {
  get _dataFile() { return path.join(getDataDir(), 'post-clone-history.json'); }

  constructor() {
    // no eager load — all reads happen per-request
  }

  list() {
    this._ensureDataDir();
    return this._load()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  save(data) {
    const galleryIds = Array.isArray(data.galleryIds) ? data.galleryIds.filter(Boolean) : [];
    if (galleryIds.length === 0) return null;

    this._ensureDataDir();
    const store = this._load();

    if (store.length >= MAX_ITEMS) {
      store.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      store.shift();
    }

    const item = {
      id: crypto.randomUUID(),
      sourceUrl: typeof data.sourceUrl === 'string' ? data.sourceUrl.trim().slice(0, 500) : '',
      type: data.type || 'single',
      mode: data.mode || 'exact',
      characterId: data.characterId || null,
      slideCount: galleryIds.length,
      galleryIds,
      createdAt: new Date().toISOString(),
    };

    store.push(item);
    this._persist(store);
    return item;
  }

  remove(id) {
    this._ensureDataDir();
    const store = this._load();
    const idx = store.findIndex((i) => i.id === id);
    if (idx === -1) throw new AppError('History entry not found', 404, 'NOT_FOUND');
    store.splice(idx, 1);
    this._persist(store);
    return { removed: true };
  }

  _ensureDataDir() {
    const dir = path.dirname(this._dataFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(this._dataFile)) {
        const parsed = JSON.parse(fs.readFileSync(this._dataFile, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {
      console.warn('[postCloneHistory] Failed to load data:', err.message);
    }
    return [];
  }

  _persist(data) {
    atomicWriteJSON(this._dataFile, data);
  }
}

module.exports = new PostCloneHistoryStore();
