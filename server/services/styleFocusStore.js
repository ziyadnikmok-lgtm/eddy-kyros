const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { getDataDir } = require('../paths');

const MAX_ITEMS = 100;

const ATTRIBUTE_KEYS = ['lighting', 'camera', 'pose', 'expression', 'outfit', 'scene', 'accessories', 'details', 'format'];

class StyleFocusStore {
  get _dataFile() { return path.join(getDataDir(), 'style-focuses.json'); }

  constructor() {
    // no eager load — all reads happen per-request
  }

  list() {
    this._ensureDataDir();
    return this._load()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((item) => ({
        id: item.id,
        name: item.name,
        sourceUrl: item.sourceUrl,
        attributeCount: ATTRIBUTE_KEYS.filter((k) => item.attributes[k]).length,
        createdAt: item.createdAt,
      }));
  }

  get(id) {
    this._ensureDataDir();
    const store = this._load();
    const item = store.find((i) => i.id === id);
    if (!item) throw new AppError('Style Focus not found', 404, 'NOT_FOUND');
    return item;
  }

  save(data) {
    this._ensureDataDir();
    const store = this._load();

    if (store.length >= MAX_ITEMS) {
      store.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      store.shift();
    }

    const attributes = {};
    for (const key of ATTRIBUTE_KEYS) {
      attributes[key] = typeof data.attributes?.[key] === 'string' ? data.attributes[key].trim() : '';
    }

    const item = {
      id: crypto.randomUUID(),
      name: String(data.name || 'Untitled Focus').trim().slice(0, 100),
      sourceUrl: typeof data.sourceUrl === 'string' ? data.sourceUrl.trim().slice(0, 500) : '',
      attributes,
      fullPrompt: typeof data.fullPrompt === 'string' ? data.fullPrompt.trim() : '',
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
    if (idx === -1) throw new AppError('Style Focus not found', 404, 'NOT_FOUND');
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
      console.warn('[styleFocus] Failed to load data:', err.message);
    }
    return [];
  }

  _persist(data) {
    atomicWriteJSON(this._dataFile, data);
  }
}

module.exports = new StyleFocusStore();
