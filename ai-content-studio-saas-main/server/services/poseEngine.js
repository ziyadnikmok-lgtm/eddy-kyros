const POSE_CATEGORIES = [
  'standing power pose',
  'walking candid',
  'sitting relaxed',
  'leaning pose',
  'over-shoulder look',
  'mirror selfie',
  'floor pose',
  'back arch pose',
  'lying down soft pose',
  'weight on one hip with slight S-curve posture',
  'leaning back on railing with crossed ankles',
  'front-facing friend shot from 4 meters',
  'lying on stomach propped on elbows with feet kicked up',
  'overhead arm-length selfie angle',
  'leaning against car front bumper with hip pop',
  'torso twist over-shoulder look with chin slightly raised',
  'upright kneeling pose on heels with long posture',
  'sitting on stool with tightly crossed legs and pointed toe',
  'sitting on edge of seat with upright posture and hands on knees',
  'leaning against wall with one foot popped behind',
  'walking shoreline candid with natural swing',
  'pool edge lean with crossed arms and chin resting on forearms',
  'sunbed kneel back-look pose for hourglass silhouette',
  'high-angle full-outfit selfie framing',
  'bench forward lean with elbows on knees',
  'balcony back-facing stance looking at view',
];

const POSE_MODE_MAP = {
  none: '',
  auto: '',
  mirror_selfie: 'mirror selfie stance with one hand on hip and phone at chest height',
  hip_pop_stand: 'standing with weight on one hip and a subtle S-curve',
  railing_lean: 'leaning back against railing, legs crossed at the ankles',
  bed_elbows: 'lying on stomach, propped up on elbows, legs bent with feet up',
  overhead_selfie: 'slight forward lean with overhead arm-length selfie angle',
  car_lean: 'leaning against car bumper with one hip popped and ankles crossed',
  over_shoulder_twist: 'body angled away with a 90-degree torso twist, looking back over shoulder with chin slightly raised',
  upright_kneel: 'kneeling upright on heels with long posture and legs together',
  stool_leg_cross: 'sitting on a high stool with tightly crossed legs and pointed top toe',
  edge_sit_upright: 'sitting on the very edge of a bed/seat with upright posture and hands on knees',
  wall_lean_pop: 'leaning back against a wall with one foot popped up for a relaxed cool stance',
  shoreline_walk: 'walking along shoreline in a candid stride with hips swaying naturally',
  pool_edge_lean: 'leaning forward on pool edge with crossed arms and chin resting on forearms',
  sunbed_kneel_lookback: 'kneeling on sunbed with back angle and looking back over shoulder',
  high_angle_outfit_selfie: 'high-angle selfie that captures full outfit and shoes',
  bench_forward_lean: 'sitting on a bench leaning forward with elbows on knees',
  balcony_back_view: 'standing on balcony with back to camera looking over the view',
  sofa_tucked_sit: 'sitting back on sofa with legs tucked to one side and upper body facing forward',
  railing_elbow_lean: 'leaning back on railing with elbows resting and one leg crossed casually',
};

function getRandomPose() {
  const index = Math.floor(Math.random() * POSE_CATEGORIES.length);
  return POSE_CATEGORIES[index];
}

function getUniquePoses(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('count must be a non-negative integer');
  }
  if (count > POSE_CATEGORIES.length) {
    throw new Error(`count cannot exceed ${POSE_CATEGORIES.length}`);
  }

  const pool = [...POSE_CATEGORIES];
  const selected = [];

  for (let i = 0; i < count; i += 1) {
    const idx = Math.floor(Math.random() * pool.length);
    selected.push(pool[idx]);
    pool.splice(idx, 1);
  }

  return selected;
}

function getPoseList() {
  return [...POSE_CATEGORIES];
}

function getPoseModeList() {
  return Object.keys(POSE_MODE_MAP);
}

function poseForMode(mode) {
  if (!mode || typeof mode !== 'string') return '';
  return POSE_MODE_MAP[mode] || '';
}

module.exports = {
  POSE_CATEGORIES,
  POSE_MODE_MAP,
  getRandomPose,
  getUniquePoses,
  getPoseList,
  getPoseModeList,
  poseForMode,
};
