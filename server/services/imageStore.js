const crypto = require('node:crypto');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');
const cfg = require('../config');

const IMAGE_TTL_MS = cfg.IMAGE_TTL_MS;
const CLEANUP_INTERVAL_MS = cfg.IMAGE_CLEANUP_INTERVAL_MS;
const MAX_STORE_BYTES = cfg.MAX_STORE_BYTES;
const ENTRY_OVERHEAD_BYTES = 512;

const images = new Map();
let _totalBytes = 0;

function _estimateEntryBytes(entry) {
  let bytes = ENTRY_OVERHEAD_BYTES;
  if (entry.image && entry.image.base64Data) {
    bytes += entry.image.base64Data.length;
  }
  if (entry.basePrompt) bytes += entry.basePrompt.length;
  return bytes;
}

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

class ImageStore {
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

    const validSources = ['generate', 'batch', 'carousel', 'tweak', 'reel-copy', 'reel-recreate', 'nsfw-generate', 'photo-match'];
    if (source && !validSources.includes(source)) {
      throw new AppError(`source must be one of: ${validSources.join(', ')}`, 500, 'STORE_ERROR');
    }

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

    if (_totalBytes > MAX_STORE_BYTES) {
      let evicted = 0;
      for (const [oldId, oldEntry] of images) {
        if (_totalBytes <= MAX_STORE_BYTES) break;
        _totalBytes = Math.max(0, _totalBytes - (oldEntry._estimatedBytes || 0));
        images.delete(oldId);
        evicted++;
      }
      if (evicted > 0) {
        log.info('imagestore_eviction', { evicted, remainingEntries: images.size, totalBytes: _totalBytes });
      }
    }

    images.set(imageId, entry);

    if (parentImageId) {
      const parent = images.get(parentImageId);
      if (parent && parent.children.length < 100) {
        parent.children.push(imageId);
      }
    }

    return this._toSafe(entry);
  }

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

  _getInternal(imageId) {
    const entry = images.get(imageId);
    if (!entry) {
      throw new AppError('Image not found', 404, 'IMAGE_NOT_FOUND');
    }
    return entry;
  }

  list() {
    const result = [];
    for (const entry of images.values()) {
      result.push(this._toSafe(entry, false));
    }
    return result;
  }

  getChildren(imageId) {
    const entry = this._getInternal(imageId);
    return entry.children
      .filter((cid) => images.has(cid))
      .map((cid) => this._toSafe(images.get(cid), false));
  }

  getChildCount(imageId) {
    const entry = images.get(imageId);
    if (!entry) return 0;
    return entry.children.filter((cid) => images.has(cid)).length;
  }

  has(imageId) {
    return images.has(imageId);
  }

  stats() {
    return {
      entries: images.size,
      estimatedBytes: _totalBytes,
      estimatedMB: Math.round(_totalBytes / (1024 * 1024) * 10) / 10,
      capMB: Math.round(MAX_STORE_BYTES / (1024 * 1024)),
    };
  }

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

module.exports = new ImageStore();
