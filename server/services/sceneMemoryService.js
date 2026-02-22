const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');
const { atomicWriteJSON } = require('../utils/helpers');

const DATA_FILE = path.join(__dirname, '..', 'data', 'sceneMemory.json');

class SceneMemoryService {
  constructor() {
    this._ensureDataFile();
    this._store = this._load();
  }

  getAllScenes() {
    return this._store.map((scene) => ({ ...scene }));
  }

  getSceneById(id) {
    this._validateId(id);
    const scene = this._store.find((item) => item.id === id);
    if (!scene) {
      throw new AppError('Scene memory not found', 404, 'SCENE_MEMORY_NOT_FOUND');
    }
    return { ...scene };
  }

  createScene(sceneObject) {
    this._validateScenePayload(sceneObject);

    const scene = {
      id: crypto.randomUUID(),
      name: sceneObject.name.trim(),
      architecture: sceneObject.architecture.trim(),
      lightingProfile: sceneObject.lightingProfile.trim(),
      colorPalette: sceneObject.colorPalette.trim(),
      recurringElements: sceneObject.recurringElements.trim(),
      timeOfDayBias: sceneObject.timeOfDayBias.trim(),
      createdAt: new Date().toISOString(),
    };

    this._store.push(scene);
    this._persist();

    return { ...scene };
  }

  deleteScene(id) {
    this._validateId(id);
    const index = this._store.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new AppError('Scene memory not found', 404, 'SCENE_MEMORY_NOT_FOUND');
    }

    this._store.splice(index, 1);
    this._persist();
    return { removed: true };
  }

  _validateId(id) {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new AppError('Scene memory ID is required', 400, 'VALIDATION_ERROR');
    }
  }

  _validateScenePayload(sceneObject) {
    if (!sceneObject || typeof sceneObject !== 'object') {
      throw new AppError('Scene object is required', 400, 'VALIDATION_ERROR');
    }

    const requiredFields = [
      'name',
      'architecture',
      'lightingProfile',
      'colorPalette',
      'recurringElements',
      'timeOfDayBias',
    ];

    for (const field of requiredFields) {
      if (typeof sceneObject[field] !== 'string' || sceneObject[field].trim().length === 0) {
        throw new AppError(`"${field}" is required and must be a non-empty string`, 400, 'VALIDATION_ERROR');
      }
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
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (err) {
      log.warn('scenememory_load_failed', { message: err.message });
      // Backup corrupted file before overwriting
      try {
        if (fs.existsSync(DATA_FILE)) {
          fs.copyFileSync(DATA_FILE, `${DATA_FILE}.corrupt.${Date.now()}`);
        }
      } catch { /* backup best-effort */ }
    }

    fs.writeFileSync(DATA_FILE, '[]', 'utf8');
    return [];
  }

  _persist() {
    atomicWriteJSON(DATA_FILE, this._store);
  }
}

module.exports = new SceneMemoryService();
