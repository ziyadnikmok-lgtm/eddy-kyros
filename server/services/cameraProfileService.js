const { AppError } = require('../middleware/errorHandler');

const CAMERA_PROFILES = [
  {
    id: 'iphone_selfie',
    lens: '26mm equivalent wide selfie lens',
    depth: 'moderate depth with natural face-background separation',
    lighting: 'soft front-lit smartphone exposure with gentle highlight rolloff',
    realism: 'real iPhone selfie with visible sensor grain, slight color cast, natural skin texture with pores — NOT airbrushed, NOT anime, NOT studio-lit',
  },
  {
    id: 'mirror_selfie',
    lens: '28mm equivalent mirror-perspective lens look',
    depth: 'deep to moderate depth preserving room context',
    lighting: 'mixed ambient indoor light with practical highlights',
    realism: 'authentic handheld mirror shot with slight motion softness, uneven white balance, natural imperfections — real phone photo look',
  },
  {
    id: 'cinematic_wide',
    lens: '24mm cinematic wide lens',
    depth: 'deep environmental depth with layered foreground and background',
    lighting: 'dramatic directional lighting with cinematic contrast',
    realism: 'filmic realism with natural grain and grounded tones — real camera footage feel, not CGI or digital art',
  },
  {
    id: 'friend_phone_flash',
    lens: '26-28mm handheld smartphone lens at social distance',
    depth: 'deep to moderate depth keeping subject and environment visible',
    lighting: 'direct on-camera flash with hard shadow edges and bright highlights',
    realism: 'raw unedited friend photo with harsh flash falloff, slight red-eye risk, grainy shadows, uneven exposure — authentic party/night out phone snap',
  },
  {
    id: 'friend_phone_window_harsh',
    lens: '26mm smartphone lens with casual handheld framing',
    depth: 'deep room context with flat perspective',
    lighting: 'harsh side window light with blown highlights and hard transitions',
    realism: 'quick candid mobile capture with compressed JPEG texture, slight overexposure near window, authentic casual snapshot quality',
  },
  {
    id: 'overhead_selfie',
    lens: '24-26mm arm-length selfie lens from high angle',
    depth: 'moderate depth with close subject emphasis',
    lighting: 'bright natural light with selfie-friendly exposure',
    realism: 'authentic social selfie with slight arm-shake softness, visible sensor noise in shadows, natural unretouched skin — real Instagram selfie',
  },
  {
    id: 'night_street_flash',
    lens: '26mm smartphone lens at medium distance',
    depth: 'subject-priority with darker receding background layers',
    lighting: 'strong flash key against night ambient for punchy contrast',
    realism: 'night out mobile snapshot with crisp flash on subject, grainy dark background, slight color noise — real nightlife phone photo',
  },
  {
    id: 'paparazzi_flash',
    lens: '26-28mm handheld smartphone lens with social-distance framing',
    depth: 'deep environment retention with subject-forward exposure',
    lighting: 'hard direct flash against low-light ambient for bold contrast',
    realism: 'celebrity nightlife candid with raw flash falloff, motion blur edges, compressed shadows — authentic paparazzi phone snap',
  },
  {
    id: 'golden_hour_glow',
    lens: '26mm mobile lens with sun-facing or side-lit composition',
    depth: 'natural depth with soft atmospheric rolloff',
    lighting: 'low-angle warm sun with flare and hazy highlights',
    realism: 'warm mobile golden hour capture with natural lens flare, slight haze, uneven warm color cast — real sunset phone photo, not digitally graded',
  },
  {
    id: 'ultrawide_baddie_05x',
    lens: '13mm equivalent ultrawide phone lens (0.5x look)',
    depth: 'deep perspective exaggeration with strong foreground-to-background stretch',
    lighting: 'clean daylight or flash-balanced mobile exposure',
    realism: 'trendy 0.5x ultrawide phone aesthetic with barrel distortion, slight edge softness, casual handheld feel — real iPhone 0.5x snap',
  },
  {
    id: 'ring_light_vanity',
    lens: '26mm phone lens at arm length or vanity distance',
    depth: 'moderate depth with face-priority sharpness',
    lighting: 'frontal ring-light illumination with circular catchlights',
    realism: 'ring light selfie with visible circular catchlights, natural skin texture, slight phone compression — real beauty selfie, not retouched',
  },
  {
    id: 'led_room_ambient',
    lens: '26mm handheld smartphone lens, casual framing',
    depth: 'deep depth keeping subject and room visible',
    lighting: 'ambient RGB LED room lighting with colored reflections on skin and fabric',
    realism: 'candid iPhone photo in LED-lit room, high ISO grain in shadows, colored light reflecting naturally on skin, slight warmth from LEDs — real phone photo, not studio',
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
