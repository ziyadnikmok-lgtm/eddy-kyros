// Shared photo-mode constants used across Generate, Batch, Carousel, and Scene pages.
// Single source of truth — update here, all pages reflect the change.

export const RESOLUTION_TIERS = ['1K', '2K', '4K'];

/** Full aspect-ratio set (Generate, Scene Recreate). */
export const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:5', '5:4', '3:2', '2:3', '3:4', '4:3'];

/** Compact aspect-ratio set matching server-validated ratios (Batch, Carousel). */
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
