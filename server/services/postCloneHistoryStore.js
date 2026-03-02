const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { DATA_DIR } = require('../paths');
const DATA_FILE = path.join(DATA_DIR, 'post-clone-history.json');
const MAX_ITEMS = 50;

class PostCloneHistoryStore {
  constructor() {
    this._ensureDataDir();
    this._store = this._load();
  }

  list() {
    return this._store
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  save(data) {
    const galleryIds = Array.isArray(data.galleryIds) ? data.galleryIds.filter(Boolean) : [];
    if (galleryIds.length === 0) return null;

    if (this._store.length >= MAX_ITEMS) {
      this._store.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      this._store.shift();
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

    this._store.push(item);
    this._persist();
    return item;
  }

  remove(id) {
    const idx = this._store.findIndex((i) => i.id === id);
    if (idx === -1) throw new AppError('History entry not found', 404, 'NOT_FOUND');
    this._store.splice(idx, 1);
    this._persist();
    return { removed: true };
  }

  _ensureDataDir() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  }

  _persist() {
    atomicWriteJSON(DATA_FILE, this._store);
  }
}

module.exports = new PostCloneHistoryStore();
