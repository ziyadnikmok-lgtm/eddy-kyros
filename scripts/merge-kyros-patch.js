const fs = require('node:fs');
const path = require('node:path');

const currentRoot = process.argv[2] || path.join(process.env.APPDATA, 'ai-content-studio');
const patchRoot = process.argv[3] || path.join(process.env.USERPROFILE, 'Desktop', 'Kyros_Update_Patch_extracted', 'Kyros_Update_Patch');

const currentData = path.join(currentRoot, 'data');
const patchData = path.join(patchRoot, 'data');
const currentUploads = path.join(currentRoot, 'uploads', 'generated');

const mergeArrayFiles = [
  'analyzedProfiles.json',
  'auto-plans.json',
  'batch-jobs.json',
  'caption-templates.json',
  'contentTypePresets.json',
  'lora-datasets.json',
  'loraPresets.json',
  'niches.json',
  'outfits.json',
  'post-clone-history.json',
  'promptKnowledge.json',
  'sceneMemory.json',
  'style-focuses.json',
  'styleLibrary.json',
  'templates.json',
  'video-history.json',
];

const replaceObjectFiles = ['brandVoice.json'];

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function keyFor(item) {
  if (!item || typeof item !== 'object') return JSON.stringify(item);
  return item.id || item.filename || item.name || item.title || item.slug || JSON.stringify(item);
}

function mergeArrays(current, patch) {
  const map = new Map();
  for (const item of Array.isArray(current) ? current : []) map.set(keyFor(item), item);
  for (const item of Array.isArray(patch) ? patch : []) map.set(keyFor(item), item);
  return [...map.values()];
}

for (const file of mergeArrayFiles) {
  const patchFile = path.join(patchData, file);
  if (!fs.existsSync(patchFile)) continue;
  const currentFile = path.join(currentData, file);
  const merged = mergeArrays(readJson(currentFile, []), readJson(patchFile, []));
  writeJson(currentFile, merged);
  console.log(`${file}: ${merged.length}`);
}

for (const file of replaceObjectFiles) {
  const patchFile = path.join(patchData, file);
  if (!fs.existsSync(patchFile)) continue;
  writeJson(path.join(currentData, file), readJson(patchFile, {}));
  console.log(`${file}: replaced`);
}

// Gallery is special: only keep entries whose files exist in current uploads.
{
  const currentGallery = readJson(path.join(currentData, 'gallery.json'), []);
  const patchGallery = readJson(path.join(patchData, 'gallery.json'), []);
  const merged = mergeArrays(currentGallery, patchGallery).filter((entry) => {
    return entry?.filename && fs.existsSync(path.join(currentUploads, entry.filename));
  });
  writeJson(path.join(currentData, 'gallery.json'), merged);
  console.log(`gallery.json: ${merged.length}`);
}

console.log('Patch merge complete.');
