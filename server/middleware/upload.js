// server/middleware/upload.js

const { AppError } = require('./errorHandler');

const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Express middleware that parses a single raw binary image upload
 * from a multipart/form-data request.
 *
 * We intentionally avoid heavy multipart libraries. Instead, we use
 * a minimal approach: read raw body parts from the standard `busboy`-style
 * parsing, or accept base64 JSON payloads.
 *
 * This middleware supports two upload modes:
 *
 * 1. JSON body with base64:
 *    Content-Type: application/json
 *    { "image": "data:image/png;base64,iVBOR...", "name": "ref.png", ...otherFields }
 *
 * 2. JSON body with raw base64 (no data URI prefix):
 *    { "image": "<base64string>", "mimeType": "image/png", "name": "ref.png", ...otherFields }
 *
 * After parsing, req.imageUpload is set to:
 *   { buffer: Buffer, mimeType: string, originalName: string }
 */
function parseImageUpload(req, _res, next) {
  try {
    const { image, mimeType, name } = req.body || {};

    if (!image || typeof image !== 'string') {
      throw new AppError('Image data is required (base64 string or data URI)', 400, 'VALIDATION_ERROR');
    }

    let buffer;
    let detectedMime;
    let originalName = (name && typeof name === 'string') ? name.trim() : 'upload.png';

    // --- Parse data URI format ---
    const dataUriMatch = image.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (dataUriMatch) {
      detectedMime = dataUriMatch[1];
      buffer = Buffer.from(dataUriMatch[2], 'base64');
    } else {
      // --- Raw base64 with explicit mimeType ---
      if (!mimeType || typeof mimeType !== 'string') {
        throw new AppError(
          'When sending raw base64, include "mimeType" (image/png, image/jpeg, or image/webp)',
          400,
          'VALIDATION_ERROR'
        );
      }
      detectedMime = mimeType;
      buffer = Buffer.from(image, 'base64');
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(detectedMime)) {
      throw new AppError(
        `Image type "${detectedMime}" not allowed. Use: ${ALLOWED_MIME_TYPES.join(', ')}`,
        400,
        'INVALID_FILE_TYPE'
      );
    }

    // Validate decoded buffer is actual data
    if (buffer.length === 0) {
      throw new AppError('Decoded image is empty', 400, 'VALIDATION_ERROR');
    }

    // Validate size
    if (buffer.length > MAX_SIZE) {
      throw new AppError(
        `Image exceeds max size of ${MAX_SIZE / 1024 / 1024}MB`,
        400,
        'FILE_TOO_LARGE'
      );
    }

    req.imageUpload = {
      buffer,
      mimeType: detectedMime,
      originalName,
    };

    next();
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Failed to parse image upload', 400, 'UPLOAD_PARSE_ERROR'));
  }
}

module.exports = { parseImageUpload };
