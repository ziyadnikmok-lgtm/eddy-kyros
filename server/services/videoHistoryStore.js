const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { DATA_DIR } = require('../paths');
const DATA_FILE = path.join(DATA_DIR, 'video-history.json');
const MAX_ENTRIES = 100;

class VideoHistoryStore {
  constructor() {
    this._ensureDataDir();
    this._store = this._load();
  }

  list() {
    return [...this._store].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  get(id) {
    const entry = this._store.find((e) => e.id === id);
    if (!entry) throw new AppError('Video not found', 404, 'NOT_FOUND');
    return entry;
  }

  add(data) {
    if (this._store.length >= MAX_ENTRIES) {
      this._store.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const evicted = this._store.shift();
      if (evicted?.localPath) {
        try { fs.unlinkSync(evicted.localPath); } catch {}
      }
    }

    const entry = {
      id: crypto.randomUUID(),
      taskId: data.taskId || '',
      model: data.model || '',
      prompt: data.prompt || '',
      sourceImageId: data.sourceImageId || null,
      status: data.status || 'processing',
      videoUrl: data.videoUrl || null,
      localPath: data.localPath || null,
      filename: data.filename || null,
      duration: data.duration || null,
      createdAt: new Date().toISOString(),
    };

    this._store.push(entry);
    this._persist();
    return entry;
  }

  update(id, data) {
    const entry = this._store.find((e) => e.id === id);
    if (!entry) return null;

    if (data.status !== undefined) entry.status = data.status;
    if (data.videoUrl !== undefined) entry.videoUrl = data.videoUrl;
    if (data.localPath !== undefined) entry.localPath = data.localPath;
    if (data.filename !== undefined) entry.filename = data.filename;
    if (data.error !== undefined) entry.error = data.error;

    this._persist();
    return entry;
  }

  findByTaskId(taskId) {
    return this._store.find((e) => e.taskId === taskId) || null;
  }

  remove(id) {
    const idx = this._store.findIndex((e) => e.id === id);
    if (idx === -1) throw new AppError('Video not found', 404, 'NOT_FOUND');
    this._store.splice(idx, 1);
    this._persist();
    return { removed: true };
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
    } catch {}
    return [];
  }

  _persist() {
    atomicWriteJSON(DATA_FILE, this._store);
  }
}

module.exports = new VideoHistoryStore();
