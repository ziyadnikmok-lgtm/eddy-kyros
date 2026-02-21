const { AppError } = require('../middleware/errorHandler');

const CAMERA_PROFILES = [
  {
    id: 'iphone_selfie',
    lens: '26mm equivalent wide selfie lens',
    depth: 'moderate depth with natural face-background separation',
    lighting: 'soft front-lit smartphone exposure with gentle highlight rolloff',
    realism: 'high realism with subtle mobile HDR processing',
  },
  {
    id: 'mirror_selfie',
    lens: '28mm equivalent mirror-perspective lens look',
    depth: 'deep to moderate depth preserving room context',
    lighting: 'mixed ambient indoor light with practical highlights',
    realism: 'authentic handheld mirror shot realism with minor imperfections',
  },
  {
    id: 'cinematic_wide',
    lens: '24mm cinematic wide lens',
    depth: 'deep environmental depth with layered foreground and background',
    lighting: 'dramatic directional lighting with cinematic contrast',
    realism: 'filmic realism with natural grain and grounded tones',
  },
  {
    id: 'friend_phone_flash',
    lens: '26-28mm handheld smartphone lens at social distance',
    depth: 'deep to moderate depth keeping subject and environment visible',
    lighting: 'direct on-camera flash with hard shadow edges and bright highlights',
    realism: 'raw unedited friend photo aesthetic with natural imperfections',
  },
  {
    id: 'friend_phone_window_harsh',
    lens: '26mm smartphone lens with casual handheld framing',
    depth: 'deep room context with flat perspective',
    lighting: 'harsh side window light with blown highlights and hard transitions',
    realism: 'quick candid mobile capture with compressed texture',
  },
  {
    id: 'overhead_selfie',
    lens: '24-26mm arm-length selfie lens from high angle',
    depth: 'moderate depth with close subject emphasis',
    lighting: 'bright natural light with selfie-friendly exposure',
    realism: 'authentic social selfie look with slight sensor grain',
  },
  {
    id: 'night_street_flash',
    lens: '26mm smartphone lens at medium distance',
    depth: 'subject-priority with darker receding background layers',
    lighting: 'strong flash key against night ambient for punchy contrast',
    realism: 'night out mobile snapshot with crisp flash texture',
  },
  {
    id: 'paparazzi_flash',
    lens: '26-28mm handheld smartphone lens with social-distance framing',
    depth: 'deep environment retention with subject-forward exposure',
    lighting: 'hard direct flash against low-light ambient for bold contrast',
    realism: 'celebrity nightlife candid look with raw flash falloff',
  },
  {
    id: 'golden_hour_glow',
    lens: '26mm mobile lens with sun-facing or side-lit composition',
    depth: 'natural depth with soft atmospheric rolloff',
    lighting: 'low-angle warm sun with flare and hazy highlights',
    realism: 'dreamy warm mobile realism with gentle contrast',
  },
  {
    id: 'ultrawide_baddie_05x',
    lens: '13mm equivalent ultrawide phone lens (0.5x look)',
    depth: 'deep perspective exaggeration with strong foreground-to-background stretch',
    lighting: 'clean daylight or flash-balanced mobile exposure',
    realism: 'trendy social ultrawide aesthetic with perspective distortion',
  },
  {
    id: 'ring_light_vanity',
    lens: '26mm phone lens at arm length or vanity distance',
    depth: 'moderate depth with face-priority sharpness',
    lighting: 'frontal ring-light illumination with circular catchlights',
    realism: 'beauty-ready indoor selfie realism with polished skin detail',
  },
];

class CameraProfileService {
  getAllProfiles() {
    return CAMERA_PROFILES.map((profile) => ({ ...profile }));
  }

  getProfileById(id) {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new AppError('Camera profile ID is required', 400, 'VALIDATION_ERROR');
    }

    const profile = CAMERA_PROFILES.find((item) => item.id === id);
    if (!profile) {
      throw new AppError('Camera profile not found', 404, 'CAMERA_PROFILE_NOT_FOUND');
    }

    return { ...profile };
  }
}

module.exports = new CameraProfileService();
