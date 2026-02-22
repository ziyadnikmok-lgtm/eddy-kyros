// server/services/styleFocusStore.js
// Stores reusable "Style Focus" presets — full visual DNA snapshots from post-clone analysis.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const DATA_FILE = path.join(__dirname, '..', 'data', 'style-focuses.json');
const MAX_ITEMS = 100;

const ATTRIBUTE_KEYS = ['lighting', 'camera', 'pose', 'expression', 'outfit', 'scene', 'accessories', 'details', 'format'];

class StyleFocusStore {
  constructor() {
    this._ensureDataDir();
    this._store = this._load();
  }

  list() {
    return this._store
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
    const item = this._store.find((i) => i.id === id);
    if (!item) throw new AppError('Style Focus not found', 404, 'NOT_FOUND');
    return item;
  }

  save(data) {
    if (this._store.length >= MAX_ITEMS) {
      this._store.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      this._store.shift();
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

    this._store.push(item);
    this._persist();
    return item;
  }

  remove(id) {
    const idx = this._store.findIndex((i) => i.id === id);
    if (idx === -1) throw new AppError('Style Focus not found', 404, 'NOT_FOUND');
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
    } catch { /* corrupt — start fresh */ }
    return [];
  }

  _persist() {
    atomicWriteJSON(DATA_FILE, this._store);
  }
}

module.exports = new StyleFocusStore();
