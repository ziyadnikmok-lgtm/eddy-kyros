const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();
const DATA_FILE = path.join(__dirname, '..', 'data', 'loraPresets.json');

function readPresets() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return [];
}

function writePresets(presets) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(presets, null, 2));
}

// List all presets
router.get('/', (_req, res) => {
  res.json({ success: true, data: readPresets() });
});

// Create preset
router.post('/', (req, res, next) => {
  try {
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
    const presets = readPresets();
    const idx = presets.findIndex((p) => p.id === req.params.id);
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
    const presets = readPresets();
    const idx = presets.findIndex((p) => p.id === req.params.id);
    if (idx === -1) throw new AppError('Preset not found', 404, 'NOT_FOUND');
    presets.splice(idx, 1);
    writePresets(presets);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
