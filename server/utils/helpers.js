const fs = require('node:fs');
const path = require('node:path');

function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function atomicWriteJSON(filePath, data, indent = 2) {
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, indent);
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (renameErr) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      fs.renameSync(tmp, filePath);
    } catch (fallbackErr) {
      try {
        fs.writeFileSync(filePath, json, 'utf8');
      } catch (writeErr) {
        console.warn(`[atomicWriteJSON] Failed to persist ${path.basename(filePath)}: ${writeErr.message}`);
      }
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

module.exports = { asText, atomicWriteJSON };
