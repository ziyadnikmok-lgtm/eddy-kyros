const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { getCharactersDir } = require('../paths');
const CHARACTER_JSON = 'character.json';
const PRIMARY_IMAGE = 'primary.png';
const REFERENCES_DIR = 'references';

const VALID_CATEGORIES = [
  'Clothing',
  'Hairstyle',
  'Pose',
  'Accessory',
  'Expression',
  'Lighting',
  'Custom',
];

const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_IMAGE_SIZE_MB = MAX_IMAGE_SIZE / 1024 / 1024;
const SUPPORTED_FORMATS_TEXT = 'PNG, JPG, or WEBP';

const _characterCache = new Map();

class ReferenceManager {
  constructor() {
    this._ensureCharactersDir();
  }

  createCharacter(name, masterPrompt, primaryImage) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new AppError('Character name is required', 400, 'VALIDATION_ERROR');
    }
    const sanitizedName = this._sanitizeName(name.trim());
    if (sanitizedName.length === 0) {
      throw new AppError('Character name contains only invalid characters', 400, 'VALIDATION_ERROR');
    }

    if (!masterPrompt || typeof masterPrompt !== 'string' || masterPrompt.trim().length === 0) {
      throw new AppError('Master prompt is required', 400, 'VALIDATION_ERROR');
    }
    if (masterPrompt.trim().length > 10000) {
      throw new AppError('Master prompt must be 10,000 characters or fewer', 400, 'VALIDATION_ERROR');
    }

    this._validateImage(primaryImage, 'Primary image');

    const charDir = path.join(getCharactersDir(), sanitizedName);
    if (fs.existsSync(charDir)) {
      throw new AppError(`Character "${sanitizedName}" already exists`, 409, 'DUPLICATE_CHARACTER');
    }

    fs.mkdirSync(charDir, { recursive: true });
    fs.mkdirSync(path.join(charDir, REFERENCES_DIR), { recursive: true });

    try {
      const primaryExt = this._extensionForMime(primaryImage.mimeType);
      const primaryFileName = `primary_${crypto.randomUUID().slice(0, 8)}${primaryExt}`;
      const primaryFilePath = path.join(charDir, primaryFileName);
      fs.writeFileSync(primaryFilePath, primaryImage.buffer);

      const id = crypto.randomUUID();
      const characterData = {
        id,
        name: sanitizedName,
        masterPrompt: masterPrompt.trim(),
        primaryImageFile: primaryFileName,
        primaryImageFiles: [primaryFileName],
        references: [],
        createdAt: new Date().toISOString(),
      };
      this._writeCharacterJson(charDir, characterData);

      return this._toSafeCharacter(characterData);
    } catch (err) {
      try { fs.rmSync(charDir, { recursive: true, force: true }); } catch {}
      throw err;
    }
  }

  updateMasterPrompt(characterId, masterPrompt) {
    if (!masterPrompt || typeof masterPrompt !== 'string' || masterPrompt.trim().length === 0) {
      throw new AppError('"masterPrompt" is required', 400, 'VALIDATION_ERROR');
    }
    if (masterPrompt.length > 10000) {
      throw new AppError('Master prompt must be under 10,000 characters', 400, 'VALIDATION_ERROR');
    }
    const { data, charDir } = this._findCharacterById(characterId);
    data.masterPrompt = masterPrompt.trim();
    this._writeCharacterJson(charDir, data);
    return this._toSafeCharacter(data);
  }

  deleteCharacter(characterId) {
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('Character ID is required', 400, 'VALIDATION_ERROR');
    }

    const { charDir } = this._findCharacterById(characterId);

    fs.rmSync(charDir, { recursive: true, force: true });
    _characterCache.delete(characterId);

    return { removed: true };
  }

  listCharacters() {
    this._ensureCharactersDir();

    const entries = fs.readdirSync(getCharactersDir(), { withFileTypes: true });
    const characters = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jsonPath = path.join(getCharactersDir(), entry.name, CHARACTER_JSON);
      if (!fs.existsSync(jsonPath)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        characters.push(this._toSafeCharacter(data));
      } catch {}
    }

    return characters;
  }

  getCharacter(characterId) {
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('Character ID is required', 400, 'VALIDATION_ERROR');
    }
    const { data } = this._findCharacterById(characterId);
    return data;
  }

  getCharacterSafe(characterId) {
    const data = this.getCharacter(characterId);
    return this._toSafeCharacter(data);
  }

  addReference(characterId, image, category, overridePrompt) {
    const { data, charDir } = this._findCharacterById(characterId);

    if (!category || !VALID_CATEGORIES.includes(category)) {
      throw new AppError(
        `Category must be one of: ${VALID_CATEGORIES.join(', ')}`,
        400,
        'VALIDATION_ERROR'
      );
    }

    if (!overridePrompt || typeof overridePrompt !== 'string' || overridePrompt.trim().length === 0) {
      throw new AppError('Override prompt is required', 400, 'VALIDATION_ERROR');
    }
    if (overridePrompt.trim().length > 5000) {
      throw new AppError('Override prompt must be 5,000 characters or fewer', 400, 'VALIDATION_ERROR');
    }

    this._validateImage(image, 'Reference image');

    const refId = crypto.randomUUID();
    const ext = this._extensionForMime(image.mimeType);
    const safeOriginal = this._sanitizeFileName(image.originalName || 'reference');
    const fileName = `${safeOriginal}_${refId.slice(0, 8)}${ext}`;
    const filePath = path.join(charDir, REFERENCES_DIR, fileName);
    fs.writeFileSync(filePath, image.buffer);

    const reference = {
      id: refId,
      fileName,
      category,
      overridePrompt: overridePrompt.trim(),
      isActive: false,
      createdAt: new Date().toISOString(),
    };
    data.references.push(reference);
    this._writeCharacterJson(charDir, data);

    return this._toSafeReference(reference);
  }

  toggleReference(characterId, referenceId) {
    if (!referenceId || typeof referenceId !== 'string') {
      throw new AppError('Reference ID is required', 400, 'VALIDATION_ERROR');
    }

    const { data, charDir } = this._findCharacterById(characterId);
    const ref = data.references.find((r) => r.id === referenceId);
    if (!ref) {
      throw new AppError('Reference not found', 404, 'REFERENCE_NOT_FOUND');
    }

    ref.isActive = !ref.isActive;
    this._writeCharacterJson(charDir, data);

    return this._toSafeReference(ref);
  }

  removeReference(characterId, referenceId) {
    if (!referenceId || typeof referenceId !== 'string') {
      throw new AppError('Reference ID is required', 400, 'VALIDATION_ERROR');
    }

    const { data, charDir } = this._findCharacterById(characterId);
    const refIndex = data.references.findIndex((r) => r.id === referenceId);
    if (refIndex === -1) {
      throw new AppError('Reference not found', 404, 'REFERENCE_NOT_FOUND');
    }

    const ref = data.references[refIndex];

    const filePath = path.join(charDir, REFERENCES_DIR, ref.fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    data.references.splice(refIndex, 1);
    this._writeCharacterJson(charDir, data);

    return { removed: true };
  }

  getActiveReferences(characterId, referenceIds = null) {
    const data = this.getCharacter(characterId);

    let refs = data.references.filter((r) => r.isActive);

    if (Array.isArray(referenceIds) && referenceIds.length > 0) {
      refs = data.references.filter((r) => referenceIds.includes(r.id));
    }

    return refs;
  }

  addPrimaryImage(characterId, image) {
    const { data, charDir } = this._findCharacterById(characterId);

    this._validateImage(image, 'Primary image');

    this._migratePrimaryImages(data);

    if (data.primaryImageFiles.length >= 10) {
      throw new AppError('Maximum 10 primary images per character', 400, 'VALIDATION_ERROR');
    }

    const ext = this._extensionForMime(image.mimeType);
    const fileName = `primary_${crypto.randomUUID().slice(0, 8)}${ext}`;
    fs.writeFileSync(path.join(charDir, fileName), image.buffer);

    data.primaryImageFiles.push(fileName);
    data.primaryImageFile = data.primaryImageFiles[0];
    this._writeCharacterJson(charDir, data);

    return this._toSafeCharacter(data);
  }

  removePrimaryImage(characterId, imageIndex) {
    const { data, charDir } = this._findCharacterById(characterId);

    this._migratePrimaryImages(data);

    if (typeof imageIndex !== 'number' || imageIndex < 0 || imageIndex >= data.primaryImageFiles.length) {
      throw new AppError('Invalid image index', 400, 'VALIDATION_ERROR');
    }
    if (data.primaryImageFiles.length <= 1) {
      throw new AppError('Cannot remove the only primary image', 400, 'VALIDATION_ERROR');
    }

    const [removed] = data.primaryImageFiles.splice(imageIndex, 1);

    const filePath = path.join(charDir, removed);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    data.primaryImageFile = data.primaryImageFiles[0];
    this._writeCharacterJson(charDir, data);

    return this._toSafeCharacter(data);
  }

  getPrimaryImage(characterId) {
    const { data, charDir } = this._findCharacterById(characterId);
    const filePath = path.join(charDir, data.primaryImageFile);
    if (!fs.existsSync(filePath)) {
      throw new AppError('Primary image file missing', 500, 'FILE_MISSING');
    }
    const ext = path.extname(data.primaryImageFile).toLowerCase();
    return {
      buffer: fs.readFileSync(filePath),
      mimeType: this._mimeForExtension(ext),
    };
  }

  getPrimaryImages(characterId) {
    const { data, charDir } = this._findCharacterById(characterId);
    this._migratePrimaryImages(data);

    const images = [];
    for (const fileName of data.primaryImageFiles) {
      const filePath = path.join(charDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      const ext = path.extname(fileName).toLowerCase();
      images.push({
        buffer: fs.readFileSync(filePath),
        mimeType: this._mimeForExtension(ext),
      });
    }
    return images;
  }

  getReferenceImage(characterId, referenceId) {
    const { data, charDir } = this._findCharacterById(characterId);
    const ref = data.references.find((r) => r.id === referenceId);
    if (!ref) {
      throw new AppError('Reference not found', 404, 'REFERENCE_NOT_FOUND');
    }
    const filePath = path.join(charDir, REFERENCES_DIR, ref.fileName);
    if (!fs.existsSync(filePath)) {
      throw new AppError('Reference image file missing', 500, 'FILE_MISSING');
    }
    const ext = path.extname(ref.fileName).toLowerCase();
    return {
      buffer: fs.readFileSync(filePath),
      mimeType: this._mimeForExtension(ext),
    };
  }

  _ensureCharactersDir() {
    if (!fs.existsSync(getCharactersDir())) {
      fs.mkdirSync(getCharactersDir(), { recursive: true });
    }
  }

  _findCharacterById(characterId) {
    if (_characterCache.has(characterId)) {
      const cached = _characterCache.get(characterId);
      if (fs.existsSync(path.join(cached.charDir, CHARACTER_JSON))) {
        return cached;
      }
      _characterCache.delete(characterId);
    }

    this._ensureCharactersDir();
    const entries = fs.readdirSync(getCharactersDir(), { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const charDir = path.join(getCharactersDir(), entry.name);
      const jsonPath = path.join(charDir, CHARACTER_JSON);
      if (!fs.existsSync(jsonPath)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        _characterCache.set(data.id, { data, charDir });
        if (data.id === characterId) {
          return { data, charDir };
        }
      } catch {
        continue;
      }
    }

    throw new AppError('Character not found', 404, 'CHARACTER_NOT_FOUND');
  }

  _writeCharacterJson(charDir, data) {
    const jsonPath = path.join(charDir, CHARACTER_JSON);
    atomicWriteJSON(jsonPath, data);
    _characterCache.set(data.id, { data, charDir });
  }

  _validateImage(image, label = 'Image') {
    if (!image || !image.buffer || !image.mimeType) {
      throw new AppError(`${label} is required (buffer + mimeType)`, 400, 'VALIDATION_ERROR');
    }

    if (!Buffer.isBuffer(image.buffer)) {
      throw new AppError(`${label} buffer is invalid`, 400, 'VALIDATION_ERROR');
    }

    if (image.buffer.length === 0) {
      throw new AppError(`${label} is empty`, 400, 'VALIDATION_ERROR');
    }

    if (image.buffer.length > MAX_IMAGE_SIZE) {
      throw new AppError(
        `${label} is too large. Use a ${SUPPORTED_FORMATS_TEXT} file under ${MAX_IMAGE_SIZE_MB}MB.`,
        400,
        'FILE_TOO_LARGE'
      );
    }

    if (!ALLOWED_MIME_TYPES.includes(image.mimeType)) {
      throw new AppError(
        `${label} must be ${SUPPORTED_FORMATS_TEXT}. HEIC/HEIF is not supported yet.`,
        400,
        'INVALID_FILE_TYPE'
      );
    }

    this._validateMagicBytes(image.buffer, image.mimeType, label);
  }

  _validateMagicBytes(buffer, mimeType, label) {
    const signatures = {
      'image/png': [0x89, 0x50, 0x4e, 0x47],
      'image/jpeg': [0xff, 0xd8, 0xff],
      'image/webp': null,
    };

    if (mimeType === 'image/webp') {
      if (
        buffer.length < 12 ||
        buffer[0] !== 0x52 || buffer[1] !== 0x49 || buffer[2] !== 0x46 || buffer[3] !== 0x46 ||
        buffer[8] !== 0x57 || buffer[9] !== 0x45 || buffer[10] !== 0x42 || buffer[11] !== 0x50
      ) {
        throw new AppError(`${label} looks corrupted or doesn't match the selected file type. Re-export it as ${SUPPORTED_FORMATS_TEXT}.`, 400, 'INVALID_FILE_CONTENT');
      }
      return;
    }

    const expected = signatures[mimeType];
    if (!expected) return;

    for (let i = 0; i < expected.length; i++) {
      if (buffer[i] !== expected[i]) {
        throw new AppError(`${label} looks corrupted or doesn't match the selected file type. Re-export it as ${SUPPORTED_FORMATS_TEXT}.`, 400, 'INVALID_FILE_CONTENT');
      }
    }
  }

  _sanitizeName(name) {
    return name
      .replace(/[/\\:*?"<>|.]/g, '')
      .replace(/\.\./g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 100);
  }

  _sanitizeFileName(originalName) {
    const base = path.basename(originalName, path.extname(originalName));
    return base
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\.\./g, '')
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 60) || 'file';
  }

  _extensionForMime(mimeType) {
    const map = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
    };
    return map[mimeType] || '.png';
  }

  _mimeForExtension(ext) {
    const map = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    return map[ext] || 'application/octet-stream';
  }

  _migratePrimaryImages(data) {
    if (!data.primaryImageFiles) {
      data.primaryImageFiles = data.primaryImageFile ? [data.primaryImageFile] : [];
    }
  }

  _toSafeCharacter(data) {
    this._migratePrimaryImages(data);
    return {
      id: data.id,
      name: data.name,
      masterPrompt: data.masterPrompt,
      hasPrimaryImage: !!data.primaryImageFile,
      primaryImageCount: data.primaryImageFiles.length,
      references: (data.references || []).map((r) => this._toSafeReference(r)),
      createdAt: data.createdAt,
    };
  }

  _toSafeReference(ref) {
    return {
      id: ref.id,
      category: ref.category,
      overridePrompt: ref.overridePrompt,
      isActive: ref.isActive,
      createdAt: ref.createdAt,
    };
  }
}

ReferenceManager.VALID_CATEGORIES = VALID_CATEGORIES;
ReferenceManager.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;

module.exports = new ReferenceManager();
