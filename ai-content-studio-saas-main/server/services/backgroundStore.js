const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { AppError } = require('../middleware/errorHandler');
const { getDataDir } = require('../paths');

const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const REF_MAX_DIMENSION = 2048; // max px for reference images sent to Gemini

function _bgDir() {
  return path.join(getDataDir(), 'backgrounds');
}

function _metaFile() {
  return path.join(_bgDir(), 'backgrounds.json');
}

function _ensureDir() {
  const bgDir = _bgDir();
  if (!fs.existsSync(bgDir)) {
    fs.mkdirSync(bgDir, { recursive: true });
  }
}

function _loadMeta() {
  _ensureDir();
  try {
    const metaFile = _metaFile();
    if (fs.existsSync(metaFile)) {
      return JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function _saveMeta(items) {
  _ensureDir();
  fs.writeFileSync(_metaFile(), JSON.stringify(items, null, 2), 'utf-8');
}

function list() {
  return _loadMeta();
}

function add({ name, mimeType, base64Data }) {
  if (!name || typeof name !== 'string') {
    throw new AppError('Background name is required', 400, 'VALIDATION_ERROR');
  }
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new AppError(`Unsupported image type: ${mimeType}`, 400, 'VALIDATION_ERROR');
  }
  const buf = Buffer.from(base64Data, 'base64');
  if (buf.length > MAX_IMAGE_SIZE) {
    throw new AppError('Image exceeds 10MB limit', 400, 'VALIDATION_ERROR');
  }

  const id = crypto.randomUUID();
  const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
  const filename = `${id}${ext}`;
  const filepath = path.join(_bgDir(), filename);

  _ensureDir();
  fs.writeFileSync(filepath, buf);

  const items = _loadMeta();
  const entry = { id, name: name.trim(), filename, mimeType, createdAt: new Date().toISOString() };
  items.push(entry);
  _saveMeta(items);

  return entry;
}

function remove(id) {
  const items = _loadMeta();
  const idx = items.findIndex((b) => b.id === id);
  if (idx === -1) throw new AppError('Background not found', 404, 'NOT_FOUND');

  const entry = items[idx];
  const filepath = path.join(_bgDir(), entry.filename);
  try { fs.unlinkSync(filepath); } catch { /* file may already be gone */ }

  items.splice(idx, 1);
  _saveMeta(items);
  return { success: true };
}

/**
 * Get background image data resized for use as a Gemini reference.
 * Downsizes large images to REF_MAX_DIMENSION to avoid bloating API requests.
 */
async function getImageData(id) {
  const items = _loadMeta();
  const entry = items.find((b) => b.id === id);
  if (!entry) return null;

  const filepath = path.join(_bgDir(), entry.filename);
  if (!fs.existsSync(filepath)) return null;

  try {
    const resized = await sharp(filepath)
      .resize(REF_MAX_DIMENSION, REF_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    return { base64Data: resized.toString('base64'), mimeType: 'image/jpeg', name: entry.name };
  } catch {
    // Fallback: return raw file if sharp fails
    const buf = fs.readFileSync(filepath);
    return { base64Data: buf.toString('base64'), mimeType: entry.mimeType, name: entry.name };
  }
}

function getImageFile(id) {
  const items = _loadMeta();
  const entry = items.find((b) => b.id === id);
  if (!entry) return null;

  const filepath = path.join(_bgDir(), entry.filename);
  if (!fs.existsSync(filepath)) return null;

  return { filepath, mimeType: entry.mimeType };
}

module.exports = { list, add, remove, getImageData, getImageFile };
