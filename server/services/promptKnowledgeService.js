const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { asText, atomicWriteJSON } = require('../utils/helpers');
const log = require('../utils/logger');

const { getDataDir } = require('../paths');

const TEXT_FIELDS = [
  'lighting',
  'camera',
  'pose',
  'expression',
  'outfit',
  'scene',
  'accessories',
  'details',
  'full_prompt',
  'gemini_raw_response',
];

class PromptKnowledgeService {
  get _dataFile() { return path.join(getDataDir(), 'promptKnowledge.json'); }

  constructor() {
    // no eager load — all reads happen per-request
  }

  create(entry) {
    if (!entry || typeof entry !== 'object') {
      throw new AppError('Prompt knowledge entry is required', 400, 'VALIDATION_ERROR');
    }

    const sourceType = asText(entry.source_type).toLowerCase();
    if (!['single', 'carousel'].includes(sourceType)) {
      throw new AppError('source_type must be "single" or "carousel"', 400, 'VALIDATION_ERROR');
    }
    const mode = asText(entry.mode).toLowerCase();
    if (!['exact', 'creative'].includes(mode)) {
      throw new AppError('mode must be "exact" or "creative"', 400, 'VALIDATION_ERROR');
    }

    const normalized = {
      id: crypto.randomUUID(),
      source_url: asText(entry.source_url),
      source_type: sourceType,
      carousel_position:
        typeof entry.carousel_position === 'number' && Number.isFinite(entry.carousel_position)
          ? entry.carousel_position
          : null,
      character_id: asText(entry.character_id) || null,
      mode,
      created_at: new Date().toISOString(),
    };

    for (const field of TEXT_FIELDS) {
      normalized[field] = asText(entry[field]);
    }

    this._ensureDataFile();
    const store = this._load();
    store.push(normalized);
    this._persist(store);
    return { ...normalized };
  }

  list(filters = {}) {
    this._ensureDataFile();
    const store = this._load();

    const character = asText(filters.character);
    const sourceType = asText(filters.source_type).toLowerCase();
    const mode = asText(filters.mode).toLowerCase();
    const field = asText(filters.field);
    const q = asText(filters.q).toLowerCase();

    return store
      .filter((item) => !character || item.character_id === character)
      .filter((item) => !sourceType || item.source_type === sourceType)
      .filter((item) => !mode || item.mode === mode)
      .filter((item) => {
        if (!field) return true;
        const value = asText(item[field]);
        if (!value) return false;
        if (!q) return true;
        return value.toLowerCase().includes(q);
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map((item) => ({ ...item }));
  }

  _ensureDataFile() {
    const dataFile = this._dataFile;
    const dir = path.dirname(dataFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '[]', 'utf8');
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._dataFile, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      log.warn('promptknowledge_load_failed', { message: err.message });
    }
    fs.writeFileSync(this._dataFile, '[]', 'utf8');
    return [];
  }

  _persist(data) {
    atomicWriteJSON(this._dataFile, data);
  }
}

module.exports = new PromptKnowledgeService();
