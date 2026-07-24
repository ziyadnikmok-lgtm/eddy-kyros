const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { getDataDir } = require('../paths');
const MAX_ENTRIES = 100;

class VideoHistoryStore {
  get _dataFile() { return path.join(getDataDir(), 'video-history.json'); }

  constructor() { /* dirs ensured on first use */ }

  list() {
    return [...this._load()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  get(id) {
    const entry = this._load().find((e) => e.id === id);
    if (!entry) throw new AppError('Video not found', 404, 'NOT_FOUND');
    return entry;
  }

  add(data) {
    const store = this._load();
    if (store.length >= MAX_ENTRIES) {
      store.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const evicted = store.shift();
      if (evicted?.localPath) {
        try { fs.unlinkSync(evicted.localPath); } catch {}
      }
    }

    const entry = {
      id: crypto.randomUUID(),
      taskId: data.taskId || '',
      provider: data.provider || 'wavespeed',
      operationName: data.operationName || null,
      model: data.model || '',
      prompt: data.prompt || '',
      sourceImageId: data.sourceImageId || null,
      status: data.status || 'processing',
      videoUrl: data.videoUrl || null,
      localPath: data.localPath || null,
      filename: data.filename || null,
      duration: data.duration || null,
      aspectRatio: data.aspectRatio || null,
      resolution: data.resolution || null,
      spendTracked: !!data.spendTracked,
      createdAt: new Date().toISOString(),
    };

    store.push(entry);
    this._persist(store);
    return entry;
  }

  update(id, data) {
    const store = this._load();
    const entry = store.find((e) => e.id === id);
    if (!entry) return null;

    if (data.status !== undefined) entry.status = data.status;
    if (data.videoUrl !== undefined) entry.videoUrl = data.videoUrl;
    if (data.localPath !== undefined) entry.localPath = data.localPath;
    if (data.filename !== undefined) entry.filename = data.filename;
    if (data.error !== undefined) entry.error = data.error;
    if (data.spendTracked !== undefined) entry.spendTracked = !!data.spendTracked;

    this._persist(store);
    return entry;
  }

  findByTaskId(taskId) {
    return this._load().find((e) => e.taskId === taskId) || null;
  }

  remove(id) {
    const store = this._load();
    const idx = store.findIndex((e) => e.id === id);
    if (idx === -1) throw new AppError('Video not found', 404, 'NOT_FOUND');
    store.splice(idx, 1);
    this._persist(store);
    return { removed: true };
  }

  _ensureDataDir() {
    const dir = path.dirname(this._dataFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      const f = this._dataFile;
      this._ensureDataDir();
      if (fs.existsSync(f)) {
        const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {
      console.warn('[videoHistory] Failed to load data:', err.message);
    }
    return [];
  }

  _persist(store) {
    atomicWriteJSON(this._dataFile, store);
  }
}

module.exports = new VideoHistoryStore();
