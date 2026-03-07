const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');
const { atomicWriteJSON } = require('../utils/helpers');

const { DATA_DIR } = require('../paths');
const DATA_FILE = path.join(DATA_DIR, 'outfits.json');

class OutfitMemoryService {
  constructor() {
    this._ensureDataFile();
    this._store = this._load();
  }

  getAllOutfits() {
    return this._store.map((outfit) => ({ ...outfit }));
  }

  getOutfitById(id) {
    this._validateId(id);
    const outfit = this._store.find((item) => item.id === id);
    if (!outfit) {
      throw new AppError('Outfit not found', 404, 'OUTFIT_NOT_FOUND');
    }
    return { ...outfit };
  }

  getOutfitsByCharacter(characterId) {
    if (!characterId) return this._store.filter((o) => !o.characterId).map((o) => ({ ...o }));
    return this._store.filter((o) => o.characterId === characterId || !o.characterId).map((o) => ({ ...o }));
  }

  createOutfit(data) {
    this._validateOutfitPayload(data);

    const outfit = {
      id: crypto.randomUUID(),
      name: data.name.trim(),
      top: data.top.trim(),
      bottom: data.bottom.trim(),
      accessories: data.accessories.trim(),
      footwear: data.footwear.trim(),
      characterId: typeof data.characterId === 'string' && data.characterId.trim().length > 0
        ? data.characterId.trim() : null,
      tags: Array.isArray(data.tags)
        ? data.tags.filter((t) => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
        : [],
      ...(typeof data.hairstyleOverride === 'string' && data.hairstyleOverride.trim().length > 0
        ? { hairstyleOverride: data.hairstyleOverride.trim() }
        : {}),
      ...(typeof data.makeupOverride === 'string' && data.makeupOverride.trim().length > 0
        ? { makeupOverride: data.makeupOverride.trim() }
        : {}),
      createdAt: new Date().toISOString(),
    };

    this._store.push(outfit);
    this._persist();

    return { ...outfit };
  }

  updateOutfit(id, data) {
    this._validateId(id);
    const outfit = this._store.find((item) => item.id === id);
    if (!outfit) {
      throw new AppError('Outfit not found', 404, 'OUTFIT_NOT_FOUND');
    }

    const updatable = ['name', 'top', 'bottom', 'accessories', 'footwear', 'hairstyleOverride', 'makeupOverride'];
    for (const field of updatable) {
      if (typeof data[field] === 'string') {
        const trimmed = data[field].trim();
        if (trimmed.length > 0) {
          outfit[field] = trimmed;
        } else if (field === 'hairstyleOverride' || field === 'makeupOverride') {
          delete outfit[field];
        }
      }
    }

    if (data.characterId !== undefined) {
      outfit.characterId = typeof data.characterId === 'string' && data.characterId.trim().length > 0
        ? data.characterId.trim() : null;
    }

    if (Array.isArray(data.tags)) {
      outfit.tags = data.tags.filter((t) => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim());
    }

    outfit.updatedAt = new Date().toISOString();
    this._persist();

    return { ...outfit };
  }

  deleteOutfit(id) {
    this._validateId(id);
    const index = this._store.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new AppError('Outfit not found', 404, 'OUTFIT_NOT_FOUND');
    }

    this._store.splice(index, 1);
    this._persist();
    return { removed: true };
  }

  _validateId(id) {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new AppError('Outfit ID is required', 400, 'VALIDATION_ERROR');
    }
  }

  _validateOutfitPayload(data) {
    if (!data || typeof data !== 'object') {
      throw new AppError('Outfit data is required', 400, 'VALIDATION_ERROR');
    }

    const requiredFields = ['name', 'top', 'bottom', 'accessories', 'footwear'];

    for (const field of requiredFields) {
      if (typeof data[field] !== 'string' || data[field].trim().length === 0) {
        throw new AppError(`"${field}" is required and must be a non-empty string`, 400, 'VALIDATION_ERROR');
      }
    }

    if (data.hairstyleOverride !== undefined && typeof data.hairstyleOverride !== 'string') {
      throw new AppError('"hairstyleOverride" must be a string', 400, 'VALIDATION_ERROR');
    }

    if (data.makeupOverride !== undefined && typeof data.makeupOverride !== 'string') {
      throw new AppError('"makeupOverride" must be a string', 400, 'VALIDATION_ERROR');
    }
  }

  _ensureDataFile() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, '[]', 'utf8');
    }
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (err) {
      log.warn('outfit_load_failed', { message: err.message });
    }

    fs.writeFileSync(DATA_FILE, '[]', 'utf8');
    return [];
  }

  _persist() {
    atomicWriteJSON(DATA_FILE, this._store);
  }
}

module.exports = new OutfitMemoryService();
