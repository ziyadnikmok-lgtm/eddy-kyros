const EXPRESSION_MODE_MAP = {
  none: '',
  relaxed_neutral_smile_hint: 'relaxed neutral with hint of a smile',
  playful_soft_pout: 'playful soft pout',
  relaxed_soft_smile: 'relaxed gaze, soft smile',
  confident_smirk_direct: 'confident smirk, direct gaze, relaxed jaw',
  confident_smirk_tilt: 'confident eyes, confident smirk, slight head tilt',
  warm_happy_smile: 'warm smile, genuine happiness, eyes sparkling',
  direct_gaze_smirk: 'direct gaze, confident smirk',
  dreamy_relaxed_pout: 'dreamy eyes, soft relaxed pout',
  fresh_faced_playful: 'playful smirk, soft eyes, relaxed jaw, fresh-faced morning glow',
  doe_eyes_down_chin: 'chin tilted down, eyes looking up through lashes, doe eyes',
  sun_squint_scrunch: 'slight sun squint with subtle nose scrunch',
  head_tilt_back_calm: 'head tilted back, relaxed eyes, calm expression',
  over_shoulder_wide_smirk: 'looking over shoulder, eyes wide, slight smirk',
  direct_confident_no_smile: 'direct confident stare, relaxed jaw, no smile',
  slight_smile_looking_down: 'slight smile while looking down',
  soft_confident_smirk_raised_chin: 'soft confident smirk, chin slightly raised',
  subtle_pout_raised_brows: 'subtle pout with lightly raised eyebrows',
  intense_direct_gaze: 'direct gaze, confident smirk',
};

function getExpressionModeList() {
  return Object.keys(EXPRESSION_MODE_MAP);
}

function expressionForMode(mode) {
  if (!mode || typeof mode !== 'string') return '';
  return EXPRESSION_MODE_MAP[mode] || '';
}

module.exports = {
  EXPRESSION_MODE_MAP,
  getExpressionModeList,
  expressionForMode,
};
