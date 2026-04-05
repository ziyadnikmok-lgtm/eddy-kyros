const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../middleware/errorHandler');
const { getDataDir } = require('../paths');
const { getUserId } = require('../userContext');

const router = express.Router();

function isLocalAppRuntime() {
  return !!process.env.ELECTRON_USER_DATA;
}

function getDataFile() {
  return path.join(getDataDir(), 'loraPresets.json');
}

function ensureStoreDir() {
  const dir = path.dirname(getDataFile());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readPresets() {
  try {
    ensureStoreDir();
    const dataFile = getDataFile();
    if (fs.existsSync(dataFile)) return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch {}
  return [];
}

function writePresets(presets) {
  ensureStoreDir();
  fs.writeFileSync(getDataFile(), JSON.stringify(presets, null, 2));
}

function listVisiblePresets(presets, userId) {
  if (isLocalAppRuntime()) return presets;
  return presets.filter((preset) => preset.userId === userId);
}

function findPresetIndex(presets, presetId, userId) {
  if (isLocalAppRuntime()) {
    return presets.findIndex((preset) => preset.id === presetId);
  }
  return presets.findIndex((preset) => preset.id === presetId && preset.userId === userId);
}

// List all presets
router.get('/', (_req, res) => {
  const userId = getUserId() || '__anon__';
  res.json({ success: true, data: listVisiblePresets(readPresets(), userId) });
});

// Create preset
router.post('/', (req, res, next) => {
  try {
    const userId = getUserId() || '__anon__';
    const { name, path: loraPath, scale } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new AppError('Name is required', 400, 'VALIDATION_ERROR');
    }
    if (!loraPath || typeof loraPath !== 'string' || !loraPath.trim()) {
      throw new AppError('LoRA path/URL is required', 400, 'VALIDATION_ERROR');
    }
    const presets = readPresets();
    const preset = {
      id: crypto.randomUUID(),
      userId,
      name: name.trim(),
      path: loraPath.trim(),
      scale: typeof scale === 'number' ? scale : 1.0,
      createdAt: new Date().toISOString(),
    };
    presets.push(preset);
    writePresets(presets);
    res.json({ success: true, data: preset });
  } catch (err) { next(err); }
});

// Update preset
router.patch('/:id', (req, res, next) => {
  try {
    const userId = getUserId() || '__anon__';
    const presets = readPresets();
    const idx = findPresetIndex(presets, req.params.id, userId);
    if (idx === -1) throw new AppError('Preset not found', 404, 'NOT_FOUND');
    const { name, path: loraPath, scale } = req.body;
    if (name !== undefined) presets[idx].name = String(name).trim();
    if (loraPath !== undefined) presets[idx].path = String(loraPath).trim();
    if (scale !== undefined) presets[idx].scale = typeof scale === 'number' ? scale : presets[idx].scale;
    writePresets(presets);
    res.json({ success: true, data: presets[idx] });
  } catch (err) { next(err); }
});

// Delete preset
router.delete('/:id', (req, res, next) => {
  try {
    const userId = getUserId() || '__anon__';
    const presets = readPresets();
    const idx = findPresetIndex(presets, req.params.id, userId);
    if (idx === -1) throw new AppError('Preset not found', 404, 'NOT_FOUND');
    presets.splice(idx, 1);
    writePresets(presets);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
