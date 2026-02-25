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
 * On Windows, renameSync can fail with EPERM/EBUSY if the target is open;
 * falls back to unlink-then-rename, then direct write as last resort.
 */
function atomicWriteJSON(filePath, data, indent = 2) {
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, indent);
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (renameErr) {
    // On Windows EPERM/EBUSY: unlink target first, then retry rename
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      fs.renameSync(tmp, filePath);
    } catch (fallbackErr) {
      // Last resort: write directly (non-atomic but won't crash)
      try {
        fs.writeFileSync(filePath, json, 'utf8');
      } catch (writeErr) {
        console.warn(`[atomicWriteJSON] Failed to persist ${path.basename(filePath)}: ${writeErr.message}`);
      }
      // Clean up orphaned .tmp
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

module.exports = { asText, atomicWriteJSON };
