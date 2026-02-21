const fs = require('node:fs');

const DEFAULT_PROFILE_FILES = [
  'C:\\Users\\X\\Downloads\\AyuGram Desktop\\subject (2).json',
  'C:\\Users\\X\\Downloads\\AyuGram Desktop\\subject (3).json',
];

// Preset style memory from removed Generate UI presets.
const PRESET_STYLE_MEMORY = [
  {
    id: 'bathroom-mirror',
    label: 'Bathroom Mirror Snap',
    cameraProfileId: 'mirror_selfie',
    poseMode: 'mirror_selfie',
    styleHint: 'Mirror selfie, waist-up reflection framing, tiled bathroom, practical indoor light, casual phone snap realism.',
  },
  {
    id: 'overhead-bed',
    label: 'Overhead Bed Selfie',
    cameraProfileId: 'overhead_selfie',
    poseMode: 'overhead_selfie',
    styleHint: 'Close overhead selfie above bed, soft natural expression, morning side window light, textured duvet context.',
  },
  {
    id: 'living-room-friend',
    label: 'Living Room Friend Shot',
    cameraProfileId: 'friend_phone_window_harsh',
    poseMode: 'none',
    styleHint: 'Full-body friend phone snap in living room with visible room context, flat daylight, unedited mobile realism.',
  },
  {
    id: 'rooftop-night-flash',
    label: 'Rooftop Night Flash',
    cameraProfileId: 'night_street_flash',
    poseMode: 'railing_lean',
    styleHint: 'Night rooftop friend photo with direct flash, skyline background, confident pose, punchy mobile texture.',
  },
  {
    id: 'street-car-flash',
    label: 'Street Car Flash',
    cameraProfileId: 'night_street_flash',
    poseMode: 'car_lean',
    styleHint: 'Night street flash leaning on car, raw candid snapshot energy, crisp high-contrast mobile look.',
  },
];

function toText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function uniqueStrings(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((item) => toText(item))
      .filter(Boolean)
  ));
}

function flattenPoseList(poseInspiration) {
  if (!poseInspiration || typeof poseInspiration !== 'object') return [];
  const list = [];

  for (const value of Object.values(poseInspiration)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === 'string') {
        list.push(item);
        continue;
      }
      if (item && typeof item === 'object') {
        list.push(item.name || item.title || item.desc || item.description || '');
      }
    }
  }

  return uniqueStrings(list);
}

function parseProfile(raw) {
  const trimmed = toText(raw);
  if (!trimmed) return null;

  const candidates = [
    trimmed,
    `{${trimmed}`,
    `{${trimmed}}`,
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

function getProfileFiles() {
  const fromEnv = toText(process.env.AUTO_PROFILE_FILES);
  if (!fromEnv) return DEFAULT_PROFILE_FILES;
  return fromEnv
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

let cache = null;

function buildCache() {
  const files = getProfileFiles();
  const parsedProfiles = [];

  for (const filePath of files) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = parseProfile(raw);
      if (parsed) parsedProfiles.push(parsed);
    } catch {
      // Ignore missing or unreadable external profile files.
    }
  }

  const locations = [];
  const outfits = [];
  const preferredExpressions = [];
  const bannedExpressions = [];
  const posePool = [];

  for (const profile of parsedProfiles) {
    if (Array.isArray(profile.past_locations)) {
      locations.push(...profile.past_locations);
    }
    if (Array.isArray(profile.past_outfits)) {
      outfits.push(...profile.past_outfits);
    }

    const lifeStory = profile.life_story && typeof profile.life_story === 'object'
      ? profile.life_story
      : {};
    const generationRules = lifeStory.generation_rules && typeof lifeStory.generation_rules === 'object'
      ? lifeStory.generation_rules
      : {};
    const expression = generationRules.expression && typeof generationRules.expression === 'object'
      ? generationRules.expression
      : {};

    if (Array.isArray(expression.preferred_terms)) {
      preferredExpressions.push(...expression.preferred_terms);
    }
    if (Array.isArray(expression.banned_terms)) {
      bannedExpressions.push(...expression.banned_terms);
    }

    posePool.push(...flattenPoseList(lifeStory.pose_inspiration));
  }

  return {
    loaded: parsedProfiles.length > 0,
    filesRead: parsedProfiles.length,
    locations: uniqueStrings(locations),
    outfits: uniqueStrings(outfits),
    preferredExpressions: uniqueStrings(preferredExpressions),
    bannedExpressions: uniqueStrings(bannedExpressions),
    poses: uniqueStrings(posePool),
  };
}

function ensureCache() {
  if (!cache) cache = buildCache();
  return cache;
}

function randomItem(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const index = Math.floor(Math.random() * list.length);
  return list[index];
}

function randomItems(list, count) {
  if (!Array.isArray(list) || list.length === 0 || count <= 0) return [];
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

function getStyleHintBlock() {
  const memory = ensureCache();
  const preset = randomItem(PRESET_STYLE_MEMORY);
  if (!memory.loaded && !preset) return '';

  const styleLocation = randomItem(memory.locations);
  const styleOutfit = randomItem(memory.outfits);
  const preferred = randomItems(memory.preferredExpressions, 2);
  const banned = randomItems(memory.bannedExpressions, 3);

  const lines = [
    'STYLE MEMORY HINTS',
  ];
  if (styleLocation) lines.push(`location continuity: ${styleLocation}`);
  if (styleOutfit) lines.push(`wardrobe continuity: ${styleOutfit}`);
  if (preferred.length > 0) lines.push(`expression guidance: ${preferred.join(', ')}`);
  if (banned.length > 0) lines.push(`avoid expression terms: ${banned.join(', ')}`);
  if (preset && preset.styleHint) {
    lines.push(`preset-style memory (${preset.label}): ${preset.styleHint}`);
    lines.push(`preset camera hint: ${preset.cameraProfileId}`);
    if (preset.poseMode && preset.poseMode !== 'none') {
      lines.push(`preset pose hint: ${preset.poseMode}`);
    }
  }

  return lines.join('\n');
}

function sampleLocation() {
  const memory = ensureCache();
  return randomItem(memory.locations);
}

function sampleOutfit() {
  const memory = ensureCache();
  return randomItem(memory.outfits);
}

function samplePose() {
  const memory = ensureCache();
  return randomItem(memory.poses);
}

function getSummary() {
  const memory = ensureCache();
  return {
    loaded: memory.loaded,
    filesRead: memory.filesRead,
    locations: memory.locations.length,
    outfits: memory.outfits.length,
    preferredExpressions: memory.preferredExpressions.length,
    bannedExpressions: memory.bannedExpressions.length,
    poses: memory.poses.length,
  };
}

function reload() {
  cache = buildCache();
  return getSummary();
}

module.exports = {
  getStyleHintBlock,
  sampleLocation,
  sampleOutfit,
  samplePose,
  getSummary,
  reload,
};
