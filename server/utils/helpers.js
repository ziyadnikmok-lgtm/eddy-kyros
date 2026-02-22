// server/utils/helpers.js
// Shared utility helpers — extracted from duplicated copies across routes/services.

const fs = require('node:fs');
const path = require('node:path');

/**
 * Coerce a value to a trimmed string. Returns '' for null/undefined/objects.
 */
function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Atomic JSON file write — writes to a .tmp sibling then renames.
 * Prevents file corruption if the process crashes mid-write.
 */
function atomicWriteJSON(filePath, data, indent = 2) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent), 'utf8');
  fs.renameSync(tmp, filePath);
}

module.exports = { asText, atomicWriteJSON };
