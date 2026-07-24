const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');
const { getDataDir } = require('../paths');
const { getUserId } = require('../userContext');

function getStorePath() {
  return path.join(getDataDir(), 'lora-datasets.json');
}

function ensureStoreDir() {
  const dir = path.dirname(getStorePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readAll() {
  ensureStoreDir();
  const storePath = getStorePath();
  try {
    if (!fs.existsSync(storePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(entries) {
  ensureStoreDir();
  atomicWriteJSON(getStorePath(), entries);
}

class LoraDatasetStore {
  list() {
    const userId = getUserId() || '__anon__';
    return readAll()
      .filter((entry) => entry.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  get(id) {
    const userId = getUserId() || '__anon__';
    const entry = readAll().find((item) => item.id === id && item.userId === userId);
    if (!entry) throw new AppError('LoRA dataset not found', 404, 'NOT_FOUND');
    return entry;
  }

  create(data) {
    const userId = getUserId() || '__anon__';
    const entries = readAll();
    const entry = {
      id: crypto.randomUUID(),
      userId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data,
    };
    entries.push(entry);
    writeAll(entries);
    return entry;
  }

  update(id, patch) {
    const userId = getUserId() || '__anon__';
    const entries = readAll();
    const idx = entries.findIndex((item) => item.id === id && item.userId === userId);
    if (idx === -1) throw new AppError('LoRA dataset not found', 404, 'NOT_FOUND');
    entries[idx] = {
      ...entries[idx],
      ...patch,
      id: entries[idx].id,
      userId: entries[idx].userId,
      createdAt: entries[idx].createdAt,
      updatedAt: new Date().toISOString(),
    };
    writeAll(entries);
    return entries[idx];
  }
}

module.exports = new LoraDatasetStore();
