function normalizeArray(value) {
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null) : [];
}

function toText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';

  if (typeof value.name === 'string') return value.name;
  if (typeof value.title === 'string') return value.title;
  if (typeof value.description === 'string') return value.description;

  return JSON.stringify(value);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(array) {
  if (!array.length) return null;
  return array[randomInt(0, array.length - 1)];
}

function shuffle(array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

function scoreByKeywords(candidate, keywords) {
  const hay = toText(candidate).toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (hay.includes(keyword)) score += 1;
  }
  return score;
}

function pickOutfit(outfitCombos, keywords) {
  const outfits = normalizeArray(outfitCombos);
  if (!outfits.length) return null;

  let best = null;
  let bestScore = 0;

  for (const outfit of outfits) {
    const score = scoreByKeywords(outfit, keywords);
    if (score > bestScore) {
      bestScore = score;
      best = outfit;
    }
  }

  return bestScore > 0 ? best : pickRandom(outfits);
}

function pickLocation(characterConfig, dayPlan) {
  const pastLocations = normalizeArray(characterConfig && characterConfig.past_locations);
  if (pastLocations.length) return pickRandom(pastLocations);
  return dayPlan && dayPlan.location_description ? dayPlan.location_description : null;
}

function pickPosePool(poseInspiration) {
  const poses = Array.from(new Set(normalizeArray(poseInspiration).map((pose) => toText(pose).trim()).filter(Boolean)));
  if (!poses.length) return [];

  const maxUnique = Math.min(4, poses.length);
  const minUnique = Math.min(2, maxUnique);
  const desired = minUnique === maxUnique ? maxUnique : randomInt(minUnique, maxUnique);

  return shuffle(poses).slice(0, desired);
}

function buildDayImages({
  dayPlan,
  characterConfig,
  carouselCount = 3,
  includeReels = true,
  reelCount,
}) {
  const safeDayPlan = dayPlan || {};
  const safeConfig = characterConfig || {};

  const keywords = tokenize(`${safeDayPlan.vibe || ''} ${safeDayPlan.theme || ''}`);

  const outfit = pickOutfit(
    safeConfig.life_story && safeConfig.life_story.outfit_combos,
    keywords
  );

  const location = pickLocation(safeConfig, safeDayPlan);
  const selectedLighting = safeDayPlan.lighting_style || null;

  const posePool = pickPosePool(safeConfig.life_story && safeConfig.life_story.pose_inspiration);
  const fallbackPose = 'natural candid pose';
  const posesForUse = posePool.length ? posePool : [fallbackPose];

  const totalCarousel = Math.max(1, Number.isFinite(carouselCount) ? Math.floor(carouselCount) : 3);
  const carouselImages = [];
  for (let i = 0; i < totalCarousel; i += 1) {
    carouselImages.push({
      pose: posesForUse[i % posesForUse.length],
      outfit,
      location,
      lighting_style: selectedLighting,
    });
  }

  const lifestyleInsert = {
    description: safeDayPlan.lifestyle_insert || '',
  };

  let reelImages = [];
  if (includeReels) {
    const desiredReels = Number.isFinite(reelCount)
      ? Math.max(1, Math.min(10, Math.floor(reelCount)))
      : randomInt(1, 2);
    const reelPoses = shuffle(posesForUse).slice(0, Math.min(desiredReels, posesForUse.length));

    reelImages = reelPoses.map((pose, index) => ({
      pose,
      motion_hint: safeDayPlan.reel_motion_hint || `vertical motion beat ${index + 1}`,
      lighting_style: selectedLighting,
    }));

    while (reelImages.length < desiredReels) {
      reelImages.push({
        pose: posesForUse[reelImages.length % posesForUse.length],
        motion_hint: safeDayPlan.reel_motion_hint || `vertical motion beat ${reelImages.length + 1}`,
        lighting_style: selectedLighting,
      });
    }
  }

  return {
    carouselImages: carouselImages.map(({ pose, outfit: selectedOutfit, location: selectedLocation }) => ({
      pose,
      outfit: selectedOutfit,
      location: selectedLocation,
    })),
    lifestyleInsert,
    reelImages: reelImages.map(({ pose, motion_hint }) => ({ pose, motion_hint })),
  };
}

module.exports = {
  buildDayImages,
};

