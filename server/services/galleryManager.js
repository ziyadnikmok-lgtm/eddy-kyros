const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { getDataDir, getUploadsDir } = require('../paths');
const { getUserId } = require('../userContext');

class GalleryManager {
  constructor() {
    // Per-user state: userId -> { store, validFiles, validFilesAt }
    this._userStates = new Map();
  }

  get _dataFile() { return path.join(getDataDir(), 'gallery.json'); }
  get _uploadsDir() { return getUploadsDir(); }

  // Returns (and lazily initialises) per-user in-memory state
  _getState() {
    const userId = getUserId() || '__anon__';
    if (!this._userStates.has(userId)) {
      this._ensureDirs();
      this._userStates.set(userId, {
        store: this._load(),
        validFiles: new Set(),
        validFilesAt: 0,
      });
    }
    return this._userStates.get(userId);
  }

  // Invalidate cached state for the current user (e.g. after data-dir changes)
  _invalidateState() {
    const userId = getUserId() || '__anon__';
    this._userStates.delete(userId);
  }

  save({ base64Data, mimeType, prompt, source, characterId, aspectRatio, seed, tags, personaMode, sessionId, sourceUrl }) {
    if (!base64Data || !mimeType) {
      throw new AppError('Image data required for gallery', 400, 'VALIDATION_ERROR');
    }

    const state = this._getState();
    const uploadsDir = this._uploadsDir;

    const id = crypto.randomUUID();
    const ext = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
    const filename = `${id}${ext}`;
    const filePath = path.join(uploadsDir, filename);

    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer); // sync is intentional — entry depends on file being written
    state.validFiles.add(filename);

    const entry = {
      id,
      filename,
      mimeType,
      prompt: (prompt || '').slice(0, 4000),
      source: source || 'generate',
      characterId: characterId || null,
      aspectRatio: aspectRatio || null,
      seed: seed || null,
      tags: Array.isArray(tags) ? tags.filter(t => typeof t === 'string').map(t => t.trim().toLowerCase()).slice(0, 20) : [],
      personaMode: personaMode || null,
      sessionId: sessionId || null,
      // The originating IG/TikTok/X post link, when this image was generated from a frame
      // pulled off a video — lets the user copy the source link from a generated image later.
      sourceUrl: (typeof sourceUrl === 'string' && sourceUrl.startsWith('http')) ? sourceUrl.slice(0, 2000) : null,
      fileSize: buffer.length,
      isFavorite: false,
      createdAt: new Date().toISOString(),
    };

    state.store.push(entry);
    this._persist(state);

    return entry;
  }

  list({ page, limit, tag } = {}) {
    const state = this._getState();
    const uploadsDir = this._uploadsDir;
    const now = Date.now();
    // Revalidate file list every 2 minutes (was 30s — too aggressive for large galleries)
    if (now - state.validFilesAt > 120_000) {
      state.validFilesAt = now; // set immediately to prevent thundering herd
      try {
        const files = fs.readdirSync(uploadsDir);
        state.validFiles = new Set(files);
        this._pruneMissingEntries(state);
      } catch { state.validFiles = new Set(); }
    }

    let results = state.store
      .filter((e) => state.validFiles.has(e.filename));

    if (tag) {
      const t = tag.toLowerCase();
      results = results.filter(e => Array.isArray(e.tags) && e.tags.includes(t));
    }

    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const total = results.length;

    const pg = parseInt(page, 10);
    const lim = parseInt(limit, 10);
    if (lim > 0 && pg > 0) {
      const start = (pg - 1) * lim;
      results = results.slice(start, start + lim);
    }

    return { images: results.map((e) => this._toSafe(e)), total, page: pg || 1, pages: lim > 0 ? Math.ceil(total / lim) : 1 };
  }

  get(id) {
    const state = this._getState();
    const entry = state.store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    return this._toSafe(entry);
  }

  getFilePath(id) {
    const state = this._getState();
    const uploadsDir = this._uploadsDir;
    const entryIndex = state.store.findIndex((e) => e.id === id);
    const entry = entryIndex >= 0 ? state.store[entryIndex] : null;
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    const fp = path.join(uploadsDir, entry.filename);
    if (!path.resolve(fp).startsWith(path.resolve(uploadsDir))) {
      throw new AppError('Invalid file path', 403, 'INVALID_PATH');
    }
    if (!fs.existsSync(fp)) {
      state.validFiles.delete(entry.filename);
      state.store.splice(entryIndex, 1);
      this._persist(state);
      throw new AppError('Image file missing from disk', 404, 'FILE_MISSING');
    }
    return { filePath: fp, mimeType: entry.mimeType };
  }

  remove(id) {
    const state = this._getState();
    const uploadsDir = this._uploadsDir;
    const idx = state.store.findIndex((e) => e.id === id);
    if (idx === -1) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');

    const entry = state.store[idx];
    const fp = path.join(uploadsDir, entry.filename);
    if (path.resolve(fp).startsWith(path.resolve(uploadsDir)) && fs.existsSync(fp)) fs.unlinkSync(fp);
    state.validFiles.delete(entry.filename);

    state.store.splice(idx, 1);
    this._persist(state);
    return { removed: true };
  }

  toggleFavorite(id) {
    const state = this._getState();
    const entry = state.store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    entry.isFavorite = !entry.isFavorite;
    this._persist(state);
    return this._toSafe(entry);
  }

  updateTags(id, tags) {
    const state = this._getState();
    const entry = state.store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    if (!Array.isArray(tags)) throw new AppError('tags must be an array', 400, 'VALIDATION_ERROR');
    entry.tags = tags.filter(t => typeof t === 'string').map(t => t.trim().toLowerCase()).slice(0, 20);
    this._persist(state);
    return this._toSafe(entry);
  }

  addTag(id, tag) {
    const state = this._getState();
    const entry = state.store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    if (!tag || typeof tag !== 'string') throw new AppError('tag must be a non-empty string', 400, 'VALIDATION_ERROR');
    const normalized = tag.trim().toLowerCase();
    if (!entry.tags) entry.tags = [];
    if (!entry.tags.includes(normalized)) {
      entry.tags.push(normalized);
      if (entry.tags.length > 20) entry.tags = entry.tags.slice(0, 20);
      this._persist(state);
    }
    return this._toSafe(entry);
  }

  removeTag(id, tag) {
    const state = this._getState();
    const entry = state.store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    if (!tag || typeof tag !== 'string') throw new AppError('tag must be a non-empty string', 400, 'VALIDATION_ERROR');
    const normalized = tag.trim().toLowerCase();
    if (!entry.tags) entry.tags = [];
    entry.tags = entry.tags.filter(t => t !== normalized);
    this._persist(state);
    return this._toSafe(entry);
  }

  updateMetadata(id, patch) {
    const state = this._getState();
    const entry = state.store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    if (!patch || typeof patch !== 'object') return this._toSafe(entry);

    const ALLOWED_KEYS = ['qualityScore', 'qualityReasons', 'parentId', 'sessionId', 'personaMode'];
    for (const key of Object.keys(patch)) {
      if (ALLOWED_KEYS.includes(key)) {
        entry[key] = patch[key];
      }
    }
    this._persist(state);
    return this._toSafe(entry);
  }

  getAllTags() {
    const state = this._getState();
    const tagSet = new Set();
    for (const entry of state.store) {
      if (Array.isArray(entry.tags)) {
        for (const t of entry.tags) tagSet.add(t);
      }
    }
    return [...tagSet].sort();
  }

  bulkRemove(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('No IDs provided', 400, 'VALIDATION_ERROR');
    }
    const state = this._getState();
    const uploadsDir = this._uploadsDir;
    const idSet = new Set(ids);
    const removed = [];
    state.store = state.store.filter((entry) => {
      if (!idSet.has(entry.id)) return true;
      const fp = path.join(uploadsDir, entry.filename);
      if (path.resolve(fp).startsWith(path.resolve(uploadsDir)) && fs.existsSync(fp)) fs.unlinkSync(fp);
      state.validFiles.delete(entry.filename);
      removed.push(entry.id);
      return false;
    });
    this._persist(state);
    return { removed, count: removed.length };
  }

  getMultipleFilePaths(ids) {
    const state = this._getState();
    const uploadsDir = this._uploadsDir;
    const results = [];
    for (const id of ids) {
      const entry = state.store.find((e) => e.id === id);
      if (!entry) continue;
      const fp = path.join(uploadsDir, entry.filename);
      if (!path.resolve(fp).startsWith(path.resolve(uploadsDir))) continue;
      if (fs.existsSync(fp)) {
        results.push({ filePath: fp, filename: entry.filename, mimeType: entry.mimeType });
      }
    }
    return results;
  }

  getFolderPath() {
    return this._uploadsDir;
  }

  _toSafe(entry) {
    const safe = {
      id: entry.id,
      filename: entry.filename,
      mimeType: entry.mimeType,
      prompt: entry.prompt,
      source: entry.source,
      characterId: entry.characterId,
      aspectRatio: entry.aspectRatio,
      seed: entry.seed,
      tags: entry.tags || [],
      fileSize: entry.fileSize,
      isFavorite: entry.isFavorite || false,
      sourceUrl: entry.sourceUrl || null,
      createdAt: entry.createdAt,
    };
    if (entry.qualityScore != null) safe.qualityScore = entry.qualityScore;
    if (entry.qualityReasons) safe.qualityReasons = entry.qualityReasons;
    if (entry.parentId) safe.parentId = entry.parentId;
    if (entry.sessionId) safe.sessionId = entry.sessionId;
    if (entry.personaMode) safe.personaMode = entry.personaMode;
    return safe;
  }

  _ensureDirs() {
    const uploadsDir = this._uploadsDir;
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const dataDir = path.dirname(this._dataFile);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  }

  _load() {
    try {
      const dataFile = this._dataFile;
      if (fs.existsSync(dataFile)) {
        const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {
      console.warn('[gallery] Failed to load gallery data:', err.message);
    }
    return [];
  }

  _persist(state) {
    atomicWriteJSON(this._dataFile, state.store);
  }

  _pruneMissingEntries(state) {
    if (!state?.store?.length) return;

    const originalLength = state.store.length;
    state.store = state.store.filter((entry) => state.validFiles.has(entry.filename));

    if (state.store.length !== originalLength) {
      this._persist(state);
    }
  }
}

module.exports = new GalleryManager();
