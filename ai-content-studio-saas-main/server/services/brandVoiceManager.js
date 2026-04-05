const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');
const { atomicWriteJSON } = require('../utils/helpers');

const { getDataDir } = require('../paths');

const DEFAULT_BRAND_VOICE = {
  writingStyleDescription: '',
  vocabularyPreferences: [],
  emojiFrequency: 'moderate',
  forbiddenWords: [],
  createdAt: new Date().toISOString(),
};

const VALID_EMOJI_FREQUENCIES = ['none', 'minimal', 'moderate', 'heavy'];

class BrandVoiceManager {
  get _dataFile() { return path.join(getDataDir(), 'brandVoice.json'); }

  constructor() {
    // no eager load — all reads happen per-request via _load()
  }

  getBrandVoice() {
    this._ensureDataDir();
    return { ...this._load() };
  }

  updateBrandVoice(data) {
    if (!data || typeof data !== 'object') {
      throw new AppError('Brand voice data object is required', 400, 'VALIDATION_ERROR');
    }

    this._ensureDataDir();
    const current = this._load();

    if (data.writingStyleDescription !== undefined) {
      if (typeof data.writingStyleDescription !== 'string') {
        throw new AppError('writingStyleDescription must be a string', 400, 'VALIDATION_ERROR');
      }
      if (data.writingStyleDescription.length > 5000) {
        throw new AppError('writingStyleDescription must be 5000 chars or fewer', 400, 'VALIDATION_ERROR');
      }
      current.writingStyleDescription = data.writingStyleDescription.trim();
    }

    if (data.vocabularyPreferences !== undefined) {
      if (!Array.isArray(data.vocabularyPreferences)) {
        throw new AppError('vocabularyPreferences must be an array of strings', 400, 'VALIDATION_ERROR');
      }
      current.vocabularyPreferences = data.vocabularyPreferences
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim().slice(0, 200));
    }

    if (data.emojiFrequency !== undefined) {
      if (!VALID_EMOJI_FREQUENCIES.includes(data.emojiFrequency)) {
        throw new AppError(
          `emojiFrequency must be one of: ${VALID_EMOJI_FREQUENCIES.join(', ')}`,
          400,
          'VALIDATION_ERROR'
        );
      }
      current.emojiFrequency = data.emojiFrequency;
    }

    if (data.forbiddenWords !== undefined) {
      if (!Array.isArray(data.forbiddenWords)) {
        throw new AppError('forbiddenWords must be an array of strings', 400, 'VALIDATION_ERROR');
      }
      current.forbiddenWords = data.forbiddenWords
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim().toLowerCase().slice(0, 100));
    }

    this._persist(current);
    return { ...current };
  }

  _ensureDataDir() {
    const dir = path.dirname(this._dataFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(this._dataFile)) {
        const parsed = JSON.parse(fs.readFileSync(this._dataFile, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...DEFAULT_BRAND_VOICE, ...parsed };
        }
      }
    } catch (err) {
      log.warn('brandvoice_load_failed', { message: err.message });
    }
    const data = { ...DEFAULT_BRAND_VOICE, createdAt: new Date().toISOString() };
    this._persist(data);
    return data;
  }

  _persist(data) {
    atomicWriteJSON(this._dataFile, data);
  }
}

BrandVoiceManager.VALID_EMOJI_FREQUENCIES = VALID_EMOJI_FREQUENCIES;

module.exports = new BrandVoiceManager();
