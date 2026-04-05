const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { getDataDir } = require('../paths');

const VALID_PAGES = ['generate', 'batch'];

class TemplateManager {
  get _dataFile() { return path.join(getDataDir(), 'templates.json'); }

  constructor() {
    // no eager load — all reads happen per-request
  }

  list(page) {
    this._ensureDataDir();
    let result = this._load();
    if (page && VALID_PAGES.includes(page)) {
      result = result.filter((t) => t.page === page);
    }
    return result
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((t) => this._toSafe(t));
  }

  get(id) {
    this._ensureDataDir();
    const store = this._load();
    const t = store.find((t) => t.id === id);
    if (!t) throw new AppError('Template not found', 404, 'NOT_FOUND');
    return this._toSafe(t);
  }

  create(data) {
    this._validate(data);
    this._ensureDataDir();
    const store = this._load();

    const template = {
      id: crypto.randomUUID(),
      name: data.name.trim(),
      page: data.page,
      config: data.config,
      createdAt: new Date().toISOString(),
    };

    store.push(template);
    this._persist(store);
    return this._toSafe(template);
  }

  update(id, data) {
    this._ensureDataDir();
    const store = this._load();
    const t = store.find((t) => t.id === id);
    if (!t) throw new AppError('Template not found', 404, 'NOT_FOUND');

    if (data.name !== undefined) {
      if (typeof data.name !== 'string' || data.name.trim().length === 0) {
        throw new AppError('Template name must be a non-empty string', 400, 'VALIDATION_ERROR');
      }
      if (data.name.trim().length > 100) {
        throw new AppError('Template name must be 100 characters or fewer', 400, 'VALIDATION_ERROR');
      }
      t.name = data.name.trim();
    }
    if (data.config !== undefined) {
      if (!data.config || typeof data.config !== 'object') {
        throw new AppError('Config must be an object', 400, 'VALIDATION_ERROR');
      }
      t.config = data.config;
    }

    this._persist(store);
    return this._toSafe(t);
  }

  remove(id) {
    this._ensureDataDir();
    const store = this._load();
    const idx = store.findIndex((t) => t.id === id);
    if (idx === -1) throw new AppError('Template not found', 404, 'NOT_FOUND');
    store.splice(idx, 1);
    this._persist(store);
    return { removed: true };
  }

  _validate(data) {
    if (!data || typeof data !== 'object') {
      throw new AppError('Template data is required', 400, 'VALIDATION_ERROR');
    }
    if (!data.name || typeof data.name !== 'string' || data.name.trim().length === 0) {
      throw new AppError('Template name is required', 400, 'VALIDATION_ERROR');
    }
    if (data.name.trim().length > 100) {
      throw new AppError('Template name must be 100 characters or fewer', 400, 'VALIDATION_ERROR');
    }
    if (!VALID_PAGES.includes(data.page)) {
      throw new AppError('Page must be "generate" or "batch"', 400, 'VALIDATION_ERROR');
    }
    if (!data.config || typeof data.config !== 'object') {
      throw new AppError('Config object is required', 400, 'VALIDATION_ERROR');
    }
  }

  _toSafe(t) {
    return {
      id: t.id,
      name: t.name,
      page: t.page,
      config: t.config,
      createdAt: t.createdAt,
    };
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
      console.warn('[templateManager] Failed to load data:', err.message);
    }
    return [];
  }

  _persist(data) {
    atomicWriteJSON(this._dataFile, data);
  }
}

module.exports = new TemplateManager();
