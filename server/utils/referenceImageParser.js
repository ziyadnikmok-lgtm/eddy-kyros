const { AppError } = require('../middleware/errorHandler');

const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

function parseReferenceImagePayload(value, fieldName = 'referenceImage') {
  if (!value) return null;

  const source = typeof value === 'string'
    ? value
    : (typeof value === 'object' && typeof value.image === 'string' ? value.image : null);

  if (!source) {
    throw new AppError(`${fieldName} must be a data URI string or an object with { image }`, 400, 'VALIDATION_ERROR');
  }

  const dataUriMatch = source.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (dataUriMatch) {
    const mimeType = dataUriMatch[1];
    const base64Data = dataUriMatch[2];
    const byteLength = Buffer.byteLength(base64Data, 'base64');
    if (byteLength > MAX_REFERENCE_BYTES) {
      throw new AppError(`${fieldName} exceeds max size of 10MB`, 400, 'FILE_TOO_LARGE');
    }
    return { mimeType, base64Data };
  }

  if (typeof value !== 'object') {
    throw new AppError(`${fieldName} must be a valid data URI`, 400, 'VALIDATION_ERROR');
  }

  const mimeType = typeof value.mimeType === 'string' ? value.mimeType.trim() : '';
  const base64Data = typeof value.base64Data === 'string' ? value.base64Data.trim() : '';

  if (!mimeType || !base64Data) {
    throw new AppError(`${fieldName} object must include mimeType and base64Data`, 400, 'VALIDATION_ERROR');
  }
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw new AppError(`${fieldName} mimeType must be one of: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}`, 400, 'INVALID_FILE_TYPE');
  }

  const byteLength = Buffer.byteLength(base64Data, 'base64');
  if (byteLength > MAX_REFERENCE_BYTES) {
    throw new AppError(`${fieldName} exceeds max size of 10MB`, 400, 'FILE_TOO_LARGE');
  }

  return { mimeType, base64Data };
}

function parseCustomReferenceImages(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  return value.map((item, index) => {
    const parsed = parseReferenceImagePayload(item, `customReferenceImages[${index}]`);
    const referenceType = (item && typeof item.referenceType === 'string')
      ? item.referenceType.trim().toLowerCase()
      : 'item';
    const note = (item && typeof item.note === 'string')
      ? item.note.trim()
      : '';
    return {
      ...parsed,
      referenceType: referenceType || 'item',
      note,
    };
  });
}

module.exports = { parseReferenceImagePayload, parseCustomReferenceImages, ALLOWED_IMAGE_MIME_TYPES, MAX_REFERENCE_BYTES };
