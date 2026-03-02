const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');
const { atomicWriteJSON } = require('../utils/helpers');

const { DATA_DIR } = require('../paths');
const DATA_FILE = path.join(DATA_DIR, 'brandVoice.json');

const DEFAULT_BRAND_VOICE = {
  writingStyleDescription: '',
  vocabularyPreferences: [],
  emojiFrequency: 'moderate',
  forbiddenWords: [],
  createdAt: new Date().toISOString(),
};

const VALID_EMOJI_FREQUENCIES = ['none', 'minimal', 'moderate', 'heavy'];

class BrandVoiceManager {
  constructor() {
    this._ensureDataDir();
    this._data = this._load();
  }

  getBrandVoice() {
    return { ...this._data };
  }

  updateBrandVoice(data) {
    if (!data || typeof data !== 'object') {
      throw new AppError('Brand voice data object is required', 400, 'VALIDATION_ERROR');
    }

    if (data.writingStyleDescription !== undefined) {
      if (typeof data.writingStyleDescription !== 'string') {
        throw new AppError('writingStyleDescription must be a string', 400, 'VALIDATION_ERROR');
      }
      if (data.writingStyleDescription.length > 5000) {
        throw new AppError('writingStyleDescription must be 5000 chars or fewer', 400, 'VALIDATION_ERROR');
      }
      this._data.writingStyleDescription = data.writingStyleDescription.trim();
    }

    if (data.vocabularyPreferences !== undefined) {
      if (!Array.isArray(data.vocabularyPreferences)) {
        throw new AppError('vocabularyPreferences must be an array of strings', 400, 'VALIDATION_ERROR');
      }
      this._data.vocabularyPreferences = data.vocabularyPreferences
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
      this._data.emojiFrequency = data.emojiFrequency;
    }

    if (data.forbiddenWords !== undefined) {
      if (!Array.isArray(data.forbiddenWords)) {
        throw new AppError('forbiddenWords must be an array of strings', 400, 'VALIDATION_ERROR');
      }
      this._data.forbiddenWords = data.forbiddenWords
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim().toLowerCase().slice(0, 100));
    }

    this._save();
    return { ...this._data };
  }

  _ensureDataDir() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...DEFAULT_BRAND_VOICE, ...parsed };
        }
      }
    } catch (err) {
      log.warn('brandvoice_load_failed', { message: err.message });
    }
    const data = { ...DEFAULT_BRAND_VOICE, createdAt: new Date().toISOString() };
    this._data = data;
    this._save();
    return data;
  }

  _save() {
    atomicWriteJSON(DATA_FILE, this._data);
  }
}

BrandVoiceManager.VALID_EMOJI_FREQUENCIES = VALID_EMOJI_FREQUENCIES;

module.exports = new BrandVoiceManager();
