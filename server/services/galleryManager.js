const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { DATA_DIR, UPLOADS_DIR } = require('../paths');
const DATA_FILE = path.join(DATA_DIR, 'gallery.json');

class GalleryManager {
  constructor() {
    this._ensureDirs();
    this._store = this._load();
    this._validFiles = new Set();
    this._validFilesAt = 0;
  }

  save({ base64Data, mimeType, prompt, source, characterId, aspectRatio, seed, tags, personaMode }) {
    if (!base64Data || !mimeType) {
      throw new AppError('Image data required for gallery', 400, 'VALIDATION_ERROR');
    }

    const id = crypto.randomUUID();
    const ext = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
    const filename = `${id}${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer); // sync is intentional — entry depends on file being written
    this._validFiles.add(filename);

    const entry = {
      id,
      filename,
      mimeType,
      prompt: (prompt || '').slice(0, 500),
      source: source || 'generate',
      characterId: characterId || null,
      aspectRatio: aspectRatio || null,
      seed: seed || null,
      tags: Array.isArray(tags) ? tags.filter(t => typeof t === 'string').map(t => t.trim().toLowerCase()).slice(0, 20) : [],
      personaMode: personaMode || null,
      fileSize: buffer.length,
      isFavorite: false,
      createdAt: new Date().toISOString(),
    };

    this._store.push(entry);
    this._persist();

    return entry;
  }

  list({ page, limit, tag } = {}) {
    const now = Date.now();
    // Revalidate file list every 2 minutes (was 30s — too aggressive for large galleries)
    if (now - this._validFilesAt > 120_000) {
      this._validFilesAt = now; // set immediately to prevent thundering herd
      try {
        const files = fs.readdirSync(UPLOADS_DIR);
        this._validFiles = new Set(files);
      } catch { this._validFiles = new Set(); }
    }

    let results = this._store
      .filter((e) => this._validFiles.has(e.filename));

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
    const entry = this._store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    return this._toSafe(entry);
  }

  getFilePath(id) {
    const entry = this._store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    const fp = path.join(UPLOADS_DIR, entry.filename);
    if (!path.resolve(fp).startsWith(path.resolve(UPLOADS_DIR))) {
      throw new AppError('Invalid file path', 403, 'INVALID_PATH');
    }
    if (!fs.existsSync(fp)) throw new AppError('Image file missing from disk', 404, 'FILE_MISSING');
    return { filePath: fp, mimeType: entry.mimeType };
  }

  remove(id) {
    const idx = this._store.findIndex((e) => e.id === id);
    if (idx === -1) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');

    const entry = this._store[idx];
    const fp = path.join(UPLOADS_DIR, entry.filename);
    if (path.resolve(fp).startsWith(path.resolve(UPLOADS_DIR)) && fs.existsSync(fp)) fs.unlinkSync(fp);
    this._validFiles.delete(entry.filename);

    this._store.splice(idx, 1);
    this._persist();
    return { removed: true };
  }

  toggleFavorite(id) {
    const entry = this._store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    entry.isFavorite = !entry.isFavorite;
    this._persist();
    return this._toSafe(entry);
  }

  updateTags(id, tags) {
    const entry = this._store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    if (!Array.isArray(tags)) throw new AppError('tags must be an array', 400, 'VALIDATION_ERROR');
    entry.tags = tags.filter(t => typeof t === 'string').map(t => t.trim().toLowerCase()).slice(0, 20);
    this._persist();
    return this._toSafe(entry);
  }

  addTag(id, tag) {
    const entry = this._store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    if (!tag || typeof tag !== 'string') throw new AppError('tag must be a non-empty string', 400, 'VALIDATION_ERROR');
    const normalized = tag.trim().toLowerCase();
    if (!entry.tags) entry.tags = [];
    if (!entry.tags.includes(normalized)) {
      entry.tags.push(normalized);
      if (entry.tags.length > 20) entry.tags = entry.tags.slice(0, 20);
      this._persist();
    }
    return this._toSafe(entry);
  }

  removeTag(id, tag) {
    const entry = this._store.find((e) => e.id === id);
    if (!entry) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');
    if (!tag || typeof tag !== 'string') throw new AppError('tag must be a non-empty string', 400, 'VALIDATION_ERROR');
    const normalized = tag.trim().toLowerCase();
    if (!entry.tags) entry.tags = [];
    entry.tags = entry.tags.filter(t => t !== normalized);
    this._persist();
    return this._toSafe(entry);
  }

  getAllTags() {
    const tagSet = new Set();
    for (const entry of this._store) {
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
    const idSet = new Set(ids);
    const removed = [];
    this._store = this._store.filter((entry) => {
      if (!idSet.has(entry.id)) return true;
      const fp = path.join(UPLOADS_DIR, entry.filename);
      if (path.resolve(fp).startsWith(path.resolve(UPLOADS_DIR)) && fs.existsSync(fp)) fs.unlinkSync(fp);
      this._validFiles.delete(entry.filename);
      removed.push(entry.id);
      return false;
    });
    this._persist();
    return { removed, count: removed.length };
  }

  getMultipleFilePaths(ids) {
    const results = [];
    for (const id of ids) {
      const entry = this._store.find((e) => e.id === id);
      if (!entry) continue;
      const fp = path.join(UPLOADS_DIR, entry.filename);
      if (!path.resolve(fp).startsWith(path.resolve(UPLOADS_DIR))) continue;
      if (fs.existsSync(fp)) {
        results.push({ filePath: fp, filename: entry.filename, mimeType: entry.mimeType });
      }
    }
    return results;
  }

  getFolderPath() {
    return UPLOADS_DIR;
  }

  _toSafe(entry) {
    return {
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
      createdAt: entry.createdAt,
    };
  }

  _ensureDirs() {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const dataDir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {
      console.warn('[gallery] Failed to load gallery data:', err.message);
    }
    return [];
  }

  _persist() {
    atomicWriteJSON(DATA_FILE, this._store);
  }
}

module.exports = new GalleryManager();
