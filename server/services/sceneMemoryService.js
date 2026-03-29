const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');
const { atomicWriteJSON } = require('../utils/helpers');

const { getDataDir } = require('../paths');

class SceneMemoryService {
  get _dataFile() { return path.join(getDataDir(), 'sceneMemory.json'); }

  constructor() {
    // no eager load — all reads happen per-request
  }

  getAllScenes() {
    this._ensureDataFile();
    return this._load().map((scene) => ({ ...scene }));
  }

  getSceneById(id) {
    this._validateId(id);
    this._ensureDataFile();
    const store = this._load();
    const scene = store.find((item) => item.id === id);
    if (!scene) {
      throw new AppError('Scene memory not found', 404, 'SCENE_MEMORY_NOT_FOUND');
    }
    return { ...scene };
  }

  createScene(sceneObject) {
    this._validateScenePayload(sceneObject);
    this._ensureDataFile();

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

    const store = this._load();
    store.push(scene);
    this._persist(store);

    return { ...scene };
  }

  deleteScene(id) {
    this._validateId(id);
    this._ensureDataFile();
    const store = this._load();
    const index = store.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new AppError('Scene memory not found', 404, 'SCENE_MEMORY_NOT_FOUND');
    }

    store.splice(index, 1);
    this._persist(store);
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
    const dataFile = this._dataFile;
    const dir = path.dirname(dataFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(dataFile)) {
      fs.writeFileSync(dataFile, '[]', 'utf8');
    }
  }

  _load() {
    const dataFile = this._dataFile;
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (err) {
      log.warn('scenememory_load_failed', { message: err.message });
      try {
        if (fs.existsSync(dataFile)) {
          fs.copyFileSync(dataFile, `${dataFile}.corrupt.${Date.now()}`);
        }
      } catch {}
    }

    fs.writeFileSync(dataFile, '[]', 'utf8');
    return [];
  }

  _persist(data) {
    atomicWriteJSON(this._dataFile, data);
  }
}

module.exports = new SceneMemoryService();
