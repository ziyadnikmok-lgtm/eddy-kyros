// server/services/imageStore.js

const crypto = require('node:crypto');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');
const cfg = require('../config');

// ---------------------------------------------------------------------------
// Constants (from central config)
// ---------------------------------------------------------------------------

const IMAGE_TTL_MS = cfg.IMAGE_TTL_MS;
const CLEANUP_INTERVAL_MS = cfg.IMAGE_CLEANUP_INTERVAL_MS;
const MAX_STORE_BYTES = cfg.MAX_STORE_BYTES;
const ENTRY_OVERHEAD_BYTES = 512;           // approximate per-entry metadata overhead

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const images = new Map();
let _totalBytes = 0;

function _estimateEntryBytes(entry) {
  let bytes = ENTRY_OVERHEAD_BYTES;
  if (entry.image && entry.image.base64Data) {
    bytes += entry.image.base64Data.length; // string length ≈ byte count for base64
  }
  if (entry.basePrompt) bytes += entry.basePrompt.length;
  return bytes;
}

// Periodic cleanup — collects expired IDs first, then deletes in batches
// via setImmediate to avoid blocking the event loop with large maps.
const CLEANUP_BATCH_SIZE = 50;
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const expired = [];
  for (const [id, entry] of images) {
    if (now - entry._storedAt > IMAGE_TTL_MS) expired.push(id);
  }
  if (expired.length === 0) return;

  let offset = 0;
  function deleteBatch() {
    const end = Math.min(offset + CLEANUP_BATCH_SIZE, expired.length);
    for (let i = offset; i < end; i++) {
      const entry = images.get(expired[i]);
      if (entry) {
        _totalBytes -= (entry._estimatedBytes || 0);
        images.delete(expired[i]);
      }
    }
    offset = end;
    if (offset < expired.length) {
      setImmediate(deleteBatch);
    } else if (_totalBytes < 0) {
      _totalBytes = 0;
    }
  }
  deleteBatch();
}, CLEANUP_INTERVAL_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

// ---------------------------------------------------------------------------
// ImageStore
// ---------------------------------------------------------------------------

class ImageStore {
  /**
   * Store metadata (and optionally image data) for a generated image.
   *
   * @param {object} params
   * @param {string}  params.basePrompt        - The full prompt that produced this image
   * @param {string} [params.characterId]      - Character used (if any)
   * @param {string[]} [params.activeReferenceIds] - References that were active
   * @param {string} [params.sceneDescription] - Extracted or user-provided scene description
   * @param {string} [params.modelUsed]        - Gemini model string
   * @param {number} [params.seed]             - Seed used
   * @param {string} [params.parentImageId]    - Parent image (for tweaks / carousel chains)
   * @param {number} [params.variationIndex]   - Index within parent's children
   * @param {object} [params.image]            - { mimeType, base64Data }
   * @param {string} [params.source]           - Origin: 'generate' | 'batch' | 'tweak' | 'reel-copy' | 'reel-recreate'
   * @returns {object} Stored entry (safe for API)
   */
  store(params) {
    const {
      basePrompt,
      characterId = null,
      activeReferenceIds = null,
      sceneDescription = null,
      modelUsed = null,
      seed = null,
      parentImageId = null,
      variationIndex = null,
      image = null,
      source = 'generate',
    } = params || {};

    if (!basePrompt || typeof basePrompt !== 'string' || basePrompt.trim().length === 0) {
      throw new AppError('basePrompt is required to store image metadata', 500, 'STORE_ERROR');
    }

    const validSources = ['generate', 'batch', 'tweak', 'reel-copy', 'reel-recreate'];
    if (source && !validSources.includes(source)) {
      throw new AppError(`source must be one of: ${validSources.join(', ')}`, 500, 'STORE_ERROR');
    }

    // Validate parent exists if specified
    if (parentImageId && !images.has(parentImageId)) {
      throw new AppError('Parent image not found', 404, 'PARENT_NOT_FOUND');
    }

    const imageId = crypto.randomUUID();
    const entry = {
      imageId,
      basePrompt,
      characterId,
      activeReferenceIds: Array.isArray(activeReferenceIds) ? activeReferenceIds : null,
      sceneDescription,
      modelUsed,
      seed,
      parentImageId,
      variationIndex,
      image: image || null,
      source,
      children: [],
      createdAt: new Date().toISOString(),
      _storedAt: Date.now(),
      _estimatedBytes: 0,
    };
    entry._estimatedBytes = _estimateEntryBytes(entry);
    _totalBytes += entry._estimatedBytes;

    // LRU eviction: drop oldest entries until under memory cap
    if (_totalBytes > MAX_STORE_BYTES) {
      let evicted = 0;
      for (const [oldId, oldEntry] of images) {
        if (_totalBytes <= MAX_STORE_BYTES) break;
        _totalBytes -= (oldEntry._estimatedBytes || 0);
        images.delete(oldId);
        evicted++;
      }
      if (evicted > 0) {
        log.info('imagestore_eviction', { evicted, remainingEntries: images.size, totalBytes: _totalBytes });
      }
    }

    images.set(imageId, entry);

    // Register as child of parent (cap at 100 to prevent unbounded growth)
    if (parentImageId) {
      const parent = images.get(parentImageId);
      if (parent && parent.children.length < 100) {
        parent.children.push(imageId);
      }
    }

    return this._toSafe(entry);
  }

  /**
   * Get image metadata by ID.
   */
  get(imageId) {
    if (!imageId || typeof imageId !== 'string') {
      throw new AppError('Image ID is required', 400, 'VALIDATION_ERROR');
    }
    const entry = images.get(imageId);
    if (!entry) {
      throw new AppError('Image not found', 404, 'IMAGE_NOT_FOUND');
    }
    return this._toSafe(entry);
  }

  /**
   * Get the raw internal entry (for tweak builder — never expose to API).
   */
  _getInternal(imageId) {
    const entry = images.get(imageId);
    if (!entry) {
      throw new AppError('Image not found', 404, 'IMAGE_NOT_FOUND');
    }
    return entry;
  }

  /**
   * List all stored images (metadata only, no base64 data).
   */
  list() {
    const result = [];
    for (const entry of images.values()) {
      result.push(this._toSafe(entry, false));
    }
    return result;
  }

  /**
   * Get children of an image (carousel chain).
   */
  getChildren(imageId) {
    const entry = this._getInternal(imageId);
    return entry.children
      .filter((cid) => images.has(cid))
      .map((cid) => this._toSafe(images.get(cid), false));
  }

  /**
   * Count how many children (variations) an image has.
   */
  getChildCount(imageId) {
    const entry = images.get(imageId);
    if (!entry) return 0;
    return entry.children.filter((cid) => images.has(cid)).length;
  }

  /**
   * Check if an image exists.
   */
  has(imageId) {
    return images.has(imageId);
  }

  /**
   * Memory stats for monitoring.
   */
  stats() {
    return {
      entries: images.size,
      estimatedBytes: _totalBytes,
      estimatedMB: Math.round(_totalBytes / (1024 * 1024) * 10) / 10,
      capMB: Math.round(MAX_STORE_BYTES / (1024 * 1024)),
    };
  }

  /**
   * Strip internal fields for API output.
   * @param {boolean} includeImage - whether to include base64 data
   */
  _toSafe(entry, includeImage = true) {
    const safe = {
      imageId: entry.imageId,
      basePrompt: entry.basePrompt,
      characterId: entry.characterId,
      activeReferenceIds: entry.activeReferenceIds,
      sceneDescription: entry.sceneDescription,
      modelUsed: entry.modelUsed,
      seed: entry.seed,
      parentImageId: entry.parentImageId,
      variationIndex: entry.variationIndex,
      source: entry.source,
      children: entry.children.filter((cid) => images.has(cid)),
      createdAt: entry.createdAt,
    };

    if (includeImage && entry.image) {
      safe.image = {
        mimeType: entry.image.mimeType,
        base64Data: entry.image.base64Data,
      };
    } else {
      safe.hasImage = !!entry.image;
    }

    return safe;
  }
}

// Singleton
module.exports = new ImageStore();
