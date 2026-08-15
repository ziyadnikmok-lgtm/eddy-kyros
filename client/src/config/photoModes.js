export const RESOLUTION_TIERS = ['1K', '2K', '4K'];
export const DEFAULT_IMAGE_MODEL = 'nano-bypass-experimental';
export const DEFAULT_RESOLUTION_TIER = '1K';
export const EXPERIMENTAL_NANO_BYPASS_MODEL = 'nano-bypass-experimental';
export const IMAGE_MODEL_OPTIONS = [
  { value: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro (Old)' },
  { value: 'gemini-3.1-flash-image', label: 'Nano Banana 2 (New)' },
  { value: EXPERIMENTAL_NANO_BYPASS_MODEL, label: 'Nano Bypass (Experimental)' },
];

export const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:5', '5:4', '3:2', '2:3', '3:4', '4:3'];

export const ASPECT_RATIOS_COMPACT = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5'];

export const CAMERA_PROFILES = [
  { value: 'iphone_selfie', label: 'iPhone Selfie' },
  { value: 'mirror_selfie', label: 'Mirror Selfie' },
  { value: 'cinematic_wide', label: 'Cinematic Wide' },
  { value: 'friend_phone_flash', label: 'Friend Phone Flash' },
  { value: 'friend_phone_window_harsh', label: 'Window Harsh Light' },
  { value: 'overhead_selfie', label: 'Overhead Selfie' },
  { value: 'night_street_flash', label: 'Night Street Flash' },
  { value: 'paparazzi_flash', label: 'Paparazzi Flash' },
  { value: 'golden_hour_glow', label: 'Golden Hour Glow' },
  { value: 'ultrawide_baddie_05x', label: 'Ultrawide 0.5x' },
  { value: 'ring_light_vanity', label: 'Ring Light Vanity' },
];

export const POSE_MODES = [
  { value: 'auto', label: 'Auto Rotate' },
  { value: 'none', label: 'None' },
  { value: 'mirror_selfie', label: 'Mirror Selfie' },
  { value: 'hip_pop_stand', label: 'Hip Pop Stand' },
  { value: 'railing_lean', label: 'Railing Lean' },
  { value: 'bed_elbows', label: 'Bed Elbows Pose' },
  { value: 'overhead_selfie', label: 'Overhead Selfie' },
  { value: 'car_lean', label: 'Car Lean Pose' },
  { value: 'over_shoulder_twist', label: 'Over-Shoulder Twist' },
  { value: 'upright_kneel', label: 'Upright Kneel' },
  { value: 'stool_leg_cross', label: 'Stool Leg Cross' },
  { value: 'edge_sit_upright', label: 'Edge Sit Upright' },
  { value: 'wall_lean_pop', label: 'Wall Lean Pop' },
  { value: 'shoreline_walk', label: 'Shoreline Walk' },
  { value: 'pool_edge_lean', label: 'Pool Edge Lean' },
  { value: 'sunbed_kneel_lookback', label: 'Sunbed Kneel Lookback' },
  { value: 'high_angle_outfit_selfie', label: 'High-Angle Outfit Selfie' },
  { value: 'bench_forward_lean', label: 'Bench Forward Lean' },
  { value: 'balcony_back_view', label: 'Balcony Back View' },
  { value: 'sofa_tucked_sit', label: 'Sofa Tucked Sit' },
  { value: 'railing_elbow_lean', label: 'Railing Elbow Lean' },
];

export const EXPRESSION_MODES = [
  { value: 'none', label: 'None' },
  { value: 'relaxed_neutral_smile_hint', label: 'Relaxed Neutral + Smile Hint' },
  { value: 'playful_soft_pout', label: 'Playful Soft Pout' },
  { value: 'relaxed_soft_smile', label: 'Relaxed Gaze + Soft Smile' },
  { value: 'confident_smirk_direct', label: 'Confident Smirk + Direct Gaze' },
  { value: 'confident_smirk_tilt', label: 'Confident Smirk + Slight Head Tilt' },
  { value: 'direct_gaze_smirk', label: 'Direct Gaze + Confident Smirk' },
  { value: 'dreamy_relaxed_pout', label: 'Dreamy Relaxed Pout' },
  { value: 'warm_happy_smile', label: 'Warm Happy Smile (Sparkling Eyes)' },
  { value: 'fresh_faced_playful', label: 'Fresh-Faced Playful Smirk' },
  { value: 'doe_eyes_down_chin', label: 'Doe Eyes (Down Chin)' },
  { value: 'sun_squint_scrunch', label: 'Sun Squint + Nose Scrunch' },
  { value: 'head_tilt_back_calm', label: 'Head Tilt Back Calm' },
  { value: 'over_shoulder_wide_smirk', label: 'Over-Shoulder Wide Smirk' },
  { value: 'direct_confident_no_smile', label: 'Direct Confident No Smile' },
  { value: 'slight_smile_looking_down', label: 'Slight Smile Looking Down' },
  { value: 'soft_confident_smirk_raised_chin', label: 'Soft Smirk + Raised Chin' },
  { value: 'subtle_pout_raised_brows', label: 'Subtle Pout + Raised Brows' },
];

export const VIDEO_MODELS = [
  { id: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast', desc: 'Google AI Studio key, faster with audio', durations: [4, 8], prices: { 4: 0.60, 8: 1.20 } },
  { id: 'veo-3.1-generate-preview', label: 'Veo 3.1', desc: 'Google AI Studio key, higher quality with audio', durations: [4, 8], prices: { 4: 1.60, 8: 3.20 } },
  { id: 'kling-v2.5-turbo-std', label: 'Kling v2.5 Std', desc: 'Fast standard quality', durations: [5, 10], prices: { 5: 0.21, 10: 0.42 } },
  { id: 'kling-v2.5-turbo-pro', label: 'Kling v2.5 Pro', desc: 'Higher quality, end-frame support', durations: [5, 10], prices: { 5: 0.35, 10: 0.70 } },
  { id: 'grok-imagine-video', label: 'Grok Video', desc: 'X.AI model, 720p/480p', durations: [6, 10], prices: { 6: 0.33, 10: 0.55 } },
  { id: 'kling-v2.6-motion', label: 'Kling v2.6 Motion', desc: 'Transfer motion from reference video', durations: [5], prices: { 5: 0.35 } },
  { id: 'kling-v2.6-motion-pro', label: 'Kling v2.6 Pro Motion', desc: 'Pro quality motion transfer', durations: [5], prices: { 5: 0.56 } },
];

// Seedance 2 has its own dedicated page (SeedanceVideoPage) since its real constraints
// (duration 4-15s continuous, 6-value aspect ratio enum) don't fit VideoPage's fixed-duration-button UI.
// Ground truth from Muapi's OpenAPI spec (Seedance2PiapiI2VRequest) — not guessed.
export const SEEDANCE_MODELS = [
  { id: 'seedance-2-fast', label: 'Seedance 2 Fast', desc: 'Quick image-to-video via Muapi', pricePerSecond: 0.15 },
  { id: 'seedance-2-vip', label: 'Seedance 2 VIP', desc: 'Higher fidelity image-to-video via Muapi', pricePerSecond: 0.21 },
];
export const SEEDANCE_ASPECT_RATIOS = ['16:9', '9:16', '21:9', '4:3', '1:1', '3:4'];
export const SEEDANCE_DURATION_MIN = 4;
export const SEEDANCE_DURATION_MAX = 15;
export const SEEDANCE_DURATION_DEFAULT = 5;

// Seedance 2 Omni Reference (Muapi) — reference videos + images + trained characters.
// Schema from Muapi's OpenAPI spec; prices from their public pricing page. Not guessed.
export const OMNI_MODELS = [
  // imagesOnly = reference photos, NO reference video. Listed FIRST so it's the pinned default on
  // the images-only Seedance Video page; the video-reference Omni page filters imagesOnly out.
  // Price UNCONFIRMED (Muapi's pages are JS-gated) — set to the fast rate as a safe estimate.
  { id: 'omni-no-video-fast', label: 'Omni No-Video Fast', desc: '720p · images-only reference (pinned)', pricePerSecond: 0.21, quality: false, imagesOnly: true },
  { id: 'omni-fast', label: 'Omni Fast', desc: '720p · quickest, best value', pricePerSecond: 0.21, quality: false },
  { id: 'omni-best', label: 'Omni Best', desc: '720p · highest fidelity, quality toggle', pricePerSecond: 0.30, quality: true },
  { id: 'omni-fast-1080p', label: 'Omni Fast 1080p', desc: '1080p · fast', pricePerSecond: 0.4725, quality: false },
  { id: 'omni-1080p', label: 'Omni 1080p', desc: '1080p · full quality', pricePerSecond: 0.675, quality: false },
  { id: 'omni-4k', label: 'Omni 4K', desc: '4K · maximum resolution', pricePerSecond: 1.35, quality: false },
];
export const OMNI_MAX_VIDEOS = 3;
export const OMNI_MAX_IMAGES = 9;
export const OMNI_TRAIN_COST = 0.50;
export const OMNI_VIDEO_MAX_SECONDS = 15;
// Muapi's own /upload_file caps — check client-side so an oversized file fails
// instantly instead of after a long upload.
export const MUAPI_MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MUAPI_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Seedream 5.0 Pro Edit (Muapi, image-to-image).
// Ground truth from Muapi's OpenAPI spec (Seedream5ProEditRequest) — not guessed.
// 21:9 added 2026-08-15 (owner: "i need 21:9 in kyros in photo match everywhere can select").
// Ultrawide sits at the front of the landscape run so the list still reads widest-to-tallest.
export const SEEDREAM_ASPECT_RATIOS = ['1:1', '21:9', '16:9', '3:2', '4:3', '3:4', '2:3', '9:16'];
export const SEEDREAM_RESOLUTIONS = ['1K', '2K'];
export const SEEDREAM_MAX_IMAGES = 10;
// Muapi's published rates: base per resolution + $0.003 per EXTRA image (first image is free).
export const SEEDREAM_BASE_COST = { '1K': 0.045, '2K': 0.090 };
export const SEEDREAM_EXTRA_IMAGE_COST = 0.003;
export function seedreamCost(resolution, imageCount) {
  const base = SEEDREAM_BASE_COST[resolution] ?? SEEDREAM_BASE_COST['1K'];
  return base + Math.max(0, imageCount - 1) * SEEDREAM_EXTRA_IMAGE_COST;
}

export const SCENE_MODES = [
  { value: 'none', label: 'None' },
  { value: 'bathroom_mirror_snap', label: 'Bathroom Mirror Snap' },
  { value: 'rooftop_night_city', label: 'Rooftop Night City' },
  { value: 'beach_sunset_glow', label: 'Beach Sunset Glow' },
  { value: 'luxury_balcony_view', label: 'Luxury Balcony View' },
  { value: 'bed_morning_soft', label: 'Bed Morning Soft' },
  { value: 'poolside_resort_day', label: 'Poolside Resort Day' },
  { value: 'cafe_street_candid', label: 'Cafe Street Candid' },
  { value: 'gym_mirror_lifestyle', label: 'Gym Mirror Lifestyle' },
  { value: 'old_town_evening_walk', label: 'Old Town Evening Walk' },
];
