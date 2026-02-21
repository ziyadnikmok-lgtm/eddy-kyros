const SCENE_MODE_MAP = {
  none: '',
  bathroom_mirror_snap: [
    'modern bathroom mirror setup, tiled surfaces, practical indoor lighting, candid mirror composition',
    'single-mirror realism rule: use one primary mirror plane only, no recursive mirror-within-mirror reflections, no infinite reflection tunnel',
    'mirror realism details: subtle real-world glass imperfections such as faint dust specks, tiny smudges, and light cleaning streak traces',
  ].join(', '),
  rooftop_night_city: 'rooftop night setting with visible city lights, dark sky, urban nightlife atmosphere',
  beach_sunset_glow: 'beach shoreline at sunset with warm sky gradient, natural ocean backdrop, golden-hour ambiance',
  luxury_balcony_view: 'high-rise balcony setting with premium architecture and expansive city/coastal view',
  bed_morning_soft: 'bedroom morning setting with soft natural window light, relaxed lived-in sheets, intimate candid mood',
  poolside_resort_day: 'resort poolside daylight scene with bright sun, clean deck lines, vacation lifestyle context',
  cafe_street_candid: 'street-side cafe environment with casual urban details, handheld candid framing energy',
  gym_mirror_lifestyle: [
    'fitness/gym mirror environment with clean modern interior and wellness lifestyle cues',
    'single-mirror realism rule: one dominant mirror reflection only, avoid recursive mirror duplication',
    'real mirror texture allowed: subtle dust specks and faint wipe marks visible only on close inspection',
  ].join(', '),
  old_town_evening_walk: 'old-town evening streets with textured walls and ambient warm lights, walk-by candid framing',
};

function getSceneModeList() {
  return Object.keys(SCENE_MODE_MAP);
}

function sceneForMode(mode) {
  if (!mode || typeof mode !== 'string') return '';
  return SCENE_MODE_MAP[mode] || '';
}

module.exports = {
  SCENE_MODE_MAP,
  getSceneModeList,
  sceneForMode,
};
