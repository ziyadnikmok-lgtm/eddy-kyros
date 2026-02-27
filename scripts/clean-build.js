// scripts/clean-build.js
// Generates empty seed data for the "clean" (share/sell) build.
// Run before electron-builder to ensure no personal data leaks.

const fs = require('node:fs');
const path = require('node:path');

const SEED_DIR = path.join(__dirname, 'seed-data');

// Empty seed files — just enough structure so services don't crash on first load
const seedFiles = {
  'gallery.json': [],
  'auto-plans.json': [],
  'brandVoice.json': {
    writingStyleDescription: '',
    vocabularyPreferences: [],
    emojiFrequency: 'moderate',
    forbiddenWords: [],
    hashtagSets: [],
  },
  'sceneMemory.json': [],
  'outfits.json': [],
  'post-clone-history.json': [],
  'promptKnowledge.json': [],
  'analyzedProfiles.json': [],
  'niches.json': [],
  'caption-templates.json': [],
  'templates.json': [],
  'style-focuses.json': [],
  'batch-jobs.json': [],
};

// Copy contentTypePresets.json from server/data if it exists (it's app config, not personal data)
const presetsSource = path.join(__dirname, '..', 'server', 'data', 'contentTypePresets.json');

if (!fs.existsSync(SEED_DIR)) {
  fs.mkdirSync(SEED_DIR, { recursive: true });
}

for (const [filename, data] of Object.entries(seedFiles)) {
  fs.writeFileSync(
    path.join(SEED_DIR, filename),
    JSON.stringify(data, null, 2) + '\n'
  );
}

// Copy presets file if available
if (fs.existsSync(presetsSource)) {
  fs.copyFileSync(presetsSource, path.join(SEED_DIR, 'contentTypePresets.json'));
} else {
  fs.writeFileSync(path.join(SEED_DIR, 'contentTypePresets.json'), '[]\n');
}

// Copy niches from server/data if it exists (app config, not personal data)
const nichesSource = path.join(__dirname, '..', 'server', 'data', 'niches.json');
if (fs.existsSync(nichesSource)) {
  fs.copyFileSync(nichesSource, path.join(SEED_DIR, 'niches.json'));
}

// Copy style library from server/data if it exists (ships as starter base)
const styleLibSource = path.join(__dirname, '..', 'server', 'data', 'styleLibrary.json');
if (fs.existsSync(styleLibSource)) {
  fs.copyFileSync(styleLibSource, path.join(SEED_DIR, 'styleLibrary.json'));
} else {
  fs.writeFileSync(path.join(SEED_DIR, 'styleLibrary.json'), '[]\n');
}

console.log(`[clean-build] Generated ${Object.keys(seedFiles).length + 1} seed files in ${SEED_DIR}`);
