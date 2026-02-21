// server/utils/helpers.js
// Shared utility helpers — extracted from duplicated copies across routes/services.

/**
 * Coerce a value to a trimmed string. Returns '' for null/undefined/objects.
 */
function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

module.exports = { asText };
