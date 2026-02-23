// server/services/referenceManager.js

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { CHARACTERS_DIR } = require('../paths');
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

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

// In-memory character metadata cache — avoids repeated synchronous disk scans
// during generation. Invalidated on create/update/delete.
const _characterCache = new Map();

class ReferenceManager {
  constructor() {
    this._ensureCharactersDir();
  }

  // =========================================================================
  // Character CRUD
  // =========================================================================

  /**
   * Create a new character with a master prompt and primary image.
   *
   * @param {string} name - Character name (used for folder)
   * @param {string} masterPrompt - Identity-locking master prompt
   * @param {{ buffer: Buffer, originalName: string, mimeType: string }} primaryImage
   * @returns {object} Character metadata (safe for API response)
   */
  createCharacter(name, masterPrompt, primaryImage) {
    // --- Validate name ---
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new AppError('Character name is required', 400, 'VALIDATION_ERROR');
    }
    const sanitizedName = this._sanitizeName(name.trim());
    if (sanitizedName.length === 0) {
      throw new AppError('Character name contains only invalid characters', 400, 'VALIDATION_ERROR');
    }

    // --- Validate master prompt ---
    if (!masterPrompt || typeof masterPrompt !== 'string' || masterPrompt.trim().length === 0) {
      throw new AppError('Master prompt is required', 400, 'VALIDATION_ERROR');
    }
    if (masterPrompt.trim().length > 10000) {
      throw new AppError('Master prompt must be 10,000 characters or fewer', 400, 'VALIDATION_ERROR');
    }

    // --- Validate primary image ---
    this._validateImage(primaryImage, 'Primary image');

    // --- Check uniqueness ---
    const charDir = path.join(CHARACTERS_DIR, sanitizedName);
    if (fs.existsSync(charDir)) {
      throw new AppError(`Character "${sanitizedName}" already exists`, 409, 'DUPLICATE_CHARACTER');
    }

    // --- Create directory structure (rollback on failure) ---
    fs.mkdirSync(charDir, { recursive: true });
    fs.mkdirSync(path.join(charDir, REFERENCES_DIR), { recursive: true });

    try {
      // --- Write primary image ---
      const primaryExt = this._extensionForMime(primaryImage.mimeType);
      const primaryFileName = `primary_${crypto.randomUUID().slice(0, 8)}${primaryExt}`;
      const primaryFilePath = path.join(charDir, primaryFileName);
      fs.writeFileSync(primaryFilePath, primaryImage.buffer);

      // --- Write character.json ---
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
      // Rollback: remove partially-created character directory
      try { fs.rmSync(charDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      throw err;
    }
  }

  /**
   * Delete a character by ID.
   */
  deleteCharacter(characterId) {
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('Character ID is required', 400, 'VALIDATION_ERROR');
    }

    const { charDir } = this._findCharacterById(characterId);

    // Recursively remove the character directory
    fs.rmSync(charDir, { recursive: true, force: true });
    // Invalidate cache
    _characterCache.delete(characterId);

    return { removed: true };
  }

  /**
   * List all characters (metadata only, no internal paths exposed).
   */
  listCharacters() {
    this._ensureCharactersDir();

    const entries = fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true });
    const characters = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jsonPath = path.join(CHARACTERS_DIR, entry.name, CHARACTER_JSON);
      if (!fs.existsSync(jsonPath)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        characters.push(this._toSafeCharacter(data));
      } catch {
        // Skip corrupted character folders silently
      }
    }

    return characters;
  }

  /**
   * Get a single character by ID (full data for internal use).
   */
  getCharacter(characterId) {
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('Character ID is required', 400, 'VALIDATION_ERROR');
    }
    const { data } = this._findCharacterById(characterId);
    return data;
  }

  /**
   * Get a single character safe for API response.
   */
  getCharacterSafe(characterId) {
    const data = this.getCharacter(characterId);
    return this._toSafeCharacter(data);
  }

  // =========================================================================
  // Reference Management
  // =========================================================================

  /**
   * Add a reference image to a character.
   *
   * @param {string} characterId
   * @param {{ buffer: Buffer, originalName: string, mimeType: string }} image
   * @param {string} category - One of VALID_CATEGORIES
   * @param {string} overridePrompt - Prompt fragment for this reference
   * @returns {object} Reference metadata (safe)
   */
  addReference(characterId, image, category, overridePrompt) {
    // --- Validate character ---
    const { data, charDir } = this._findCharacterById(characterId);

    // --- Validate category ---
    if (!category || !VALID_CATEGORIES.includes(category)) {
      throw new AppError(
        `Category must be one of: ${VALID_CATEGORIES.join(', ')}`,
        400,
        'VALIDATION_ERROR'
      );
    }

    // --- Validate override prompt ---
    if (!overridePrompt || typeof overridePrompt !== 'string' || overridePrompt.trim().length === 0) {
      throw new AppError('Override prompt is required', 400, 'VALIDATION_ERROR');
    }
    if (overridePrompt.trim().length > 5000) {
      throw new AppError('Override prompt must be 5,000 characters or fewer', 400, 'VALIDATION_ERROR');
    }

    // --- Validate image ---
    this._validateImage(image, 'Reference image');

    // --- Write file ---
    const refId = crypto.randomUUID();
    const ext = this._extensionForMime(image.mimeType);
    const safeOriginal = this._sanitizeFileName(image.originalName || 'reference');
    const fileName = `${safeOriginal}_${refId.slice(0, 8)}${ext}`;
    const filePath = path.join(charDir, REFERENCES_DIR, fileName);
    fs.writeFileSync(filePath, image.buffer);

    // --- Update character.json ---
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

  /**
   * Toggle a reference's isActive state.
   */
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

  /**
   * Remove a reference image and its metadata.
   */
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

    // Remove file from disk
    const filePath = path.join(charDir, REFERENCES_DIR, ref.fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Remove from metadata
    data.references.splice(refIndex, 1);
    this._writeCharacterJson(charDir, data);

    return { removed: true };
  }

  /**
   * Get active references for a character, optionally filtered by IDs.
   * Returns internal data (with overridePrompt) for prompt building.
   */
  getActiveReferences(characterId, referenceIds = null) {
    const data = this.getCharacter(characterId);

    let refs = data.references.filter((r) => r.isActive);

    // If explicit IDs provided, use those instead of the isActive flag
    if (Array.isArray(referenceIds) && referenceIds.length > 0) {
      refs = data.references.filter((r) => referenceIds.includes(r.id));
    }

    return refs;
  }

  // =========================================================================
  // Primary image management
  // =========================================================================

  /**
   * Add an additional primary reference image to a character.
   */
  addPrimaryImage(characterId, image) {
    const { data, charDir } = this._findCharacterById(characterId);

    this._validateImage(image, 'Primary image');

    // Migrate legacy single-file format
    this._migratePrimaryImages(data);

    if (data.primaryImageFiles.length >= 10) {
      throw new AppError('Maximum 10 primary images per character', 400, 'VALIDATION_ERROR');
    }

    const ext = this._extensionForMime(image.mimeType);
    const fileName = `primary_${crypto.randomUUID().slice(0, 8)}${ext}`;
    fs.writeFileSync(path.join(charDir, fileName), image.buffer);

    data.primaryImageFiles.push(fileName);
    // Keep legacy field pointing to first image
    data.primaryImageFile = data.primaryImageFiles[0];
    this._writeCharacterJson(charDir, data);

    return this._toSafeCharacter(data);
  }

  /**
   * Remove a primary image by index (cannot remove the last one).
   */
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

    // Delete file from disk
    const filePath = path.join(charDir, removed);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    // Keep legacy field in sync
    data.primaryImageFile = data.primaryImageFiles[0];
    this._writeCharacterJson(charDir, data);

    return this._toSafeCharacter(data);
  }

  // =========================================================================
  // Primary image serving (returns buffer + mime for route handlers)
  // =========================================================================

  /**
   * Get first primary image buffer for a character (backwards compat).
   */
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

  /**
   * Get ALL primary images for a character.
   */
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

  /**
   * Get reference image buffer.
   */
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

  // =========================================================================
  // Internal helpers
  // =========================================================================

  _ensureCharactersDir() {
    if (!fs.existsSync(CHARACTERS_DIR)) {
      fs.mkdirSync(CHARACTERS_DIR, { recursive: true });
    }
  }

  /**
   * Find a character by UUID across all character folders.
   * Uses in-memory cache to avoid repeated synchronous disk scans.
   * Returns { data, charDir }.
   */
  _findCharacterById(characterId) {
    // Check cache first
    if (_characterCache.has(characterId)) {
      const cached = _characterCache.get(characterId);
      // Verify file still exists (guard against manual deletion)
      if (fs.existsSync(path.join(cached.charDir, CHARACTER_JSON))) {
        return cached;
      }
      _characterCache.delete(characterId);
    }

    this._ensureCharactersDir();
    const entries = fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const charDir = path.join(CHARACTERS_DIR, entry.name);
      const jsonPath = path.join(charDir, CHARACTER_JSON);
      if (!fs.existsSync(jsonPath)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        // Populate cache for all characters we scan
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
    // Update cache
    _characterCache.set(data.id, { data, charDir });
  }

  /**
   * Validate an image upload object.
   */
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
        `${label} exceeds maximum size of ${MAX_IMAGE_SIZE / 1024 / 1024}MB`,
        400,
        'FILE_TOO_LARGE'
      );
    }

    if (!ALLOWED_MIME_TYPES.includes(image.mimeType)) {
      throw new AppError(
        `${label} must be one of: ${ALLOWED_MIME_TYPES.join(', ')}`,
        400,
        'INVALID_FILE_TYPE'
      );
    }

    // Validate magic bytes match declared MIME type
    this._validateMagicBytes(image.buffer, image.mimeType, label);
  }

  /**
   * Check file magic bytes to prevent spoofed MIME types.
   */
  _validateMagicBytes(buffer, mimeType, label) {
    const signatures = {
      'image/png': [0x89, 0x50, 0x4e, 0x47],
      'image/jpeg': [0xff, 0xd8, 0xff],
      'image/webp': null, // special: RIFF....WEBP
    };

    if (mimeType === 'image/webp') {
      // RIFF at offset 0, WEBP at offset 8
      if (
        buffer.length < 12 ||
        buffer[0] !== 0x52 || buffer[1] !== 0x49 || buffer[2] !== 0x46 || buffer[3] !== 0x46 ||
        buffer[8] !== 0x57 || buffer[9] !== 0x45 || buffer[10] !== 0x42 || buffer[11] !== 0x50
      ) {
        throw new AppError(`${label} content does not match declared WebP type`, 400, 'INVALID_FILE_CONTENT');
      }
      return;
    }

    const expected = signatures[mimeType];
    if (!expected) return;

    for (let i = 0; i < expected.length; i++) {
      if (buffer[i] !== expected[i]) {
        throw new AppError(`${label} content does not match declared ${mimeType} type`, 400, 'INVALID_FILE_CONTENT');
      }
    }
  }

  /**
   * Sanitize a character name for use as a directory name.
   * Prevents path traversal and filesystem issues.
   */
  _sanitizeName(name) {
    return name
      .replace(/[/\\:*?"<>|.]/g, '') // remove dangerous filesystem chars
      .replace(/\.\./g, '')            // no path traversal
      .replace(/\s+/g, '_')           // spaces to underscores
      .replace(/_+/g, '_')            // collapse multiple underscores
      .replace(/^_|_$/g, '')          // trim leading/trailing underscores
      .slice(0, 100);                 // reasonable length limit
  }

  /**
   * Sanitize a file name (strip extension, remove dangerous chars).
   */
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

  /**
   * Migrate legacy single primaryImageFile to primaryImageFiles array.
   */
  _migratePrimaryImages(data) {
    if (!data.primaryImageFiles) {
      data.primaryImageFiles = data.primaryImageFile ? [data.primaryImageFile] : [];
    }
  }

  /**
   * Strip internal file paths from character data for API responses.
   */
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

// Expose constants for route validation
ReferenceManager.VALID_CATEGORIES = VALID_CATEGORIES;
ReferenceManager.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;

// Singleton
module.exports = new ReferenceManager();
