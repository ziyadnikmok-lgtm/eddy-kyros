// server/services/captionTemplateService.js

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { DATA_DIR } = require('../paths');
const DATA_FILE = path.join(DATA_DIR, 'caption-templates.json');
const VALID_CATEGORIES = ['lifestyle', 'personality', 'teasing', 'engagement', 'general'];
const MAX_TEMPLATES = 200;

class CaptionTemplateService {
  constructor() {
    this._ensureDataDir();
    this._store = this._load();
  }

  list(category) {
    let result = this._store;
    if (category && VALID_CATEGORIES.includes(category)) {
      result = result.filter((t) => t.category === category);
    }
    return result
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((t) => this._toSafe(t));
  }

  get(id) {
    const t = this._store.find((t) => t.id === id);
    if (!t) throw new AppError('Caption template not found', 404, 'NOT_FOUND');
    return this._toSafe(t);
  }

  create(data) {
    this._validate(data);
    if (this._store.length >= MAX_TEMPLATES) {
      throw new AppError(`Maximum ${MAX_TEMPLATES} caption templates allowed`, 400, 'LIMIT_REACHED');
    }

    const template = {
      id: crypto.randomUUID(),
      title: data.title.trim(),
      category: data.category || 'general',
      body: data.body.trim(),
      hashtags: Array.isArray(data.hashtags) ? data.hashtags.map(h => h.trim()).filter(Boolean).slice(0, 30) : [],
      cta: (data.cta || '').trim(),
      placeholders: this._extractPlaceholders(data.body),
      usageCount: 0,
      createdAt: new Date().toISOString(),
    };

    this._store.push(template);
    this._persist();
    return this._toSafe(template);
  }

  update(id, data) {
    const t = this._store.find((t) => t.id === id);
    if (!t) throw new AppError('Caption template not found', 404, 'NOT_FOUND');

    if (data.title !== undefined) {
      if (typeof data.title !== 'string' || data.title.trim().length === 0) {
        throw new AppError('Title must be a non-empty string', 400, 'VALIDATION_ERROR');
      }
      t.title = data.title.trim();
    }
    if (data.body !== undefined) {
      if (typeof data.body !== 'string' || data.body.trim().length === 0) {
        throw new AppError('Body must be a non-empty string', 400, 'VALIDATION_ERROR');
      }
      t.body = data.body.trim();
      t.placeholders = this._extractPlaceholders(data.body);
    }
    if (data.category !== undefined) {
      if (!VALID_CATEGORIES.includes(data.category)) {
        throw new AppError(`Category must be one of: ${VALID_CATEGORIES.join(', ')}`, 400, 'VALIDATION_ERROR');
      }
      t.category = data.category;
    }
    if (data.hashtags !== undefined) {
      t.hashtags = Array.isArray(data.hashtags) ? data.hashtags.map(h => h.trim()).filter(Boolean).slice(0, 30) : [];
    }
    if (data.cta !== undefined) {
      t.cta = (data.cta || '').trim();
    }

    this._persist();
    return this._toSafe(t);
  }

  remove(id) {
    const idx = this._store.findIndex((t) => t.id === id);
    if (idx === -1) throw new AppError('Caption template not found', 404, 'NOT_FOUND');
    this._store.splice(idx, 1);
    this._persist();
    return { removed: true };
  }

  incrementUsage(id) {
    const t = this._store.find((t) => t.id === id);
    if (t) { t.usageCount = (t.usageCount || 0) + 1; this._persist(); }
  }

  suggest(category, limit = 5) {
    const matching = this._store
      .filter(t => !category || t.category === category || t.category === 'general')
      .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
    return matching.slice(0, limit).map(t => this._toSafe(t));
  }

  _validate(data) {
    if (!data || typeof data !== 'object') {
      throw new AppError('Caption template data is required', 400, 'VALIDATION_ERROR');
    }
    if (!data.title || typeof data.title !== 'string' || data.title.trim().length === 0) {
      throw new AppError('Title is required', 400, 'VALIDATION_ERROR');
    }
    if (data.title.trim().length > 100) {
      throw new AppError('Title must be 100 characters or fewer', 400, 'VALIDATION_ERROR');
    }
    if (!data.body || typeof data.body !== 'string' || data.body.trim().length === 0) {
      throw new AppError('Body text is required', 400, 'VALIDATION_ERROR');
    }
    if (data.body.trim().length > 2200) {
      throw new AppError('Body must be 2200 characters or fewer (Instagram limit)', 400, 'VALIDATION_ERROR');
    }
    if (data.category && !VALID_CATEGORIES.includes(data.category)) {
      throw new AppError(`Category must be one of: ${VALID_CATEGORIES.join(', ')}`, 400, 'VALIDATION_ERROR');
    }
  }

  _extractPlaceholders(text) {
    const matches = text.match(/\{\{(\w+)\}\}/g) || [];
    return [...new Set(matches.map(m => m.replace(/[{}]/g, '')))];
  }

  _toSafe(t) {
    return {
      id: t.id,
      title: t.title,
      category: t.category,
      body: t.body,
      hashtags: t.hashtags || [],
      cta: t.cta || '',
      placeholders: t.placeholders || [],
      usageCount: t.usageCount || 0,
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
    } catch { /* corrupt — start fresh */ }
    return [];
  }

  _persist() {
    atomicWriteJSON(DATA_FILE, this._store);
  }
}

module.exports = new CaptionTemplateService();
