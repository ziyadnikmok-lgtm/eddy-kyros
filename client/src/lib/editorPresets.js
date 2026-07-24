export const EDITOR_PRESETS = [
  { name: 'Film', values: { contrast: 15, saturation: -15, grain: 25, fade: 20, warmth: 10 } },
  { name: 'Moody', values: { brightness: -15, contrast: 20, saturation: -10, vignette: 40, warmth: -15, fade: 10 } },
  { name: 'Warm Glow', values: { brightness: 8, warmth: 35, saturation: 10, fade: 5, vignette: 15 } },
  { name: 'Night Flash', values: { contrast: 25, brightness: -10, grain: 30, sharpness: 20, vignette: 30 } },
  { name: 'Gym', values: { brightness: -25, contrast: 45, saturation: -15, warmth: -10, sharpness: 35, grain: 5, vignette: 40, fade: 5, hue: 0, rgbSplitDistance: 0 } },
  { name: 'Soft Dreamy', values: { brightness: 12, contrast: -10, saturation: -5, fade: 25, warmth: 15, sharpness: 0 } },
  { name: 'Goth', values: { brightness: -20, contrast: 30, saturation: -30, grain: 20, vignette: 50, warmth: -20 } },
  { name: 'Cosplay Pop', values: { saturation: 25, contrast: 15, sharpness: 30, vignette: 10, warmth: 5 } },
];

const CUSTOM_PRESETS_KEY = 'imageEditor_customPresets';

export function loadCustomPresets() {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveCustomPresets(presets) {
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
}
