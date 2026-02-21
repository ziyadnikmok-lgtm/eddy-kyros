// server/services/galleryManager.js

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads', 'generated');
const DATA_FILE = path.join(__dirname, '..', 'data', 'gallery.json');

class GalleryManager {
  constructor() {
    this._ensureDirs();
    this._store = this._load();
    // Cache of filenames known to exist on disk — avoids N sync existsSync per list()
    this._validFiles = new Set();
    this._validFilesAt = 0;
  }

  /**
   * Save a generated image to gallery. Returns gallery entry.
   */
  save({ base64Data, mimeType, prompt, source, characterId, aspectRatio, seed }) {
    if (!base64Data || !mimeType) {
      throw new AppError('Image data required for gallery', 400, 'VALIDATION_ERROR');
    }

    const id = crypto.randomUUID();
    const ext = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
    const filename = `${id}${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    // Write image to disk
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);
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
      fileSize: buffer.length,
      isFavorite: false,
      createdAt: new Date().toISOString(),
    };

    this._store.push(entry);
    this._persist();

    return entry;
  }

  list() {
    // Rebuild the on-disk file set at most once per 30 seconds to avoid
    // N sync existsSync calls per request (can be thousands of images).
    const now = Date.now();
    if (now - this._validFilesAt > 30_000) {
      try {
        const files = fs.readdirSync(UPLOADS_DIR);
        this._validFiles = new Set(files);
      } catch { this._validFiles = new Set(); }
      this._validFilesAt = now;
    }

    return this._store
      .filter((e) => this._validFiles.has(e.filename))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((e) => this._toSafe(e));
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
    if (!fs.existsSync(fp)) throw new AppError('Image file missing from disk', 404, 'FILE_MISSING');
    return { filePath: fp, mimeType: entry.mimeType };
  }

  remove(id) {
    const idx = this._store.findIndex((e) => e.id === id);
    if (idx === -1) throw new AppError('Gallery image not found', 404, 'NOT_FOUND');

    const entry = this._store[idx];
    const fp = path.join(UPLOADS_DIR, entry.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
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

  bulkRemove(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('No IDs provided', 400, 'VALIDATION_ERROR');
    }
    const idSet = new Set(ids);
    const removed = [];
    this._store = this._store.filter((entry) => {
      if (!idSet.has(entry.id)) return true;
      const fp = path.join(UPLOADS_DIR, entry.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
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
    } catch { /* corrupt/missing gallery store — start fresh */ }
    return [];
  }

  _persist() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(this._store, null, 2), 'utf8');
  }
}

module.exports = new GalleryManager();
