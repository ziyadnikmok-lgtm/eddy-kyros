const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { DATA_DIR } = require('../paths');
const DATA_FILE = path.join(DATA_DIR, 'templates.json');
const VALID_PAGES = ['generate', 'batch'];

class TemplateManager {
  constructor() {
    this._ensureDataDir();
    this._store = this._load();
  }

  list(page) {
    let result = this._store;
    if (page && VALID_PAGES.includes(page)) {
      result = result.filter((t) => t.page === page);
    }
    return result
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((t) => this._toSafe(t));
  }

  get(id) {
    const t = this._store.find((t) => t.id === id);
    if (!t) throw new AppError('Template not found', 404, 'NOT_FOUND');
    return this._toSafe(t);
  }

  create(data) {
    this._validate(data);

    const template = {
      id: crypto.randomUUID(),
      name: data.name.trim(),
      page: data.page,
      config: data.config,
      createdAt: new Date().toISOString(),
    };

    this._store.push(template);
    this._persist();
    return this._toSafe(template);
  }

  update(id, data) {
    const t = this._store.find((t) => t.id === id);
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

    this._persist();
    return this._toSafe(t);
  }

  remove(id) {
    const idx = this._store.findIndex((t) => t.id === id);
    if (idx === -1) throw new AppError('Template not found', 404, 'NOT_FOUND');
    this._store.splice(idx, 1);
    this._persist();
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

module.exports = new TemplateManager();
