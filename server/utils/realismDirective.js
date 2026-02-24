// server/utils/realismDirective.js
// Shared photography realism directive injected into all image generation prompts.
// Keeps the language consistent across generate, batch, postClone, and reelCopy routes.

const REALISM_DIRECTIVE = [
  '[PHOTOGRAPHY REALISM DIRECTIVE]',
  'This must look like a REAL candid smartphone photo taken by an amateur — NOT a professional studio shot, NOT digital art, NOT anime, NOT 3D render, NOT an illustration.',
  '',
  'Camera feel: Shot on an iPhone or Samsung Galaxy. 26mm wide lens, handheld with slight tilt, uncentered framing, casual composition.',
  'Skin: Visible pores, natural uneven skin tone, slight oiliness, peach fuzz, minor blemishes — NO airbrushed/porcelain/smooth skin.',
  'Hair: Flyaway strands, frizz, stray hairs across face, imperfect volume — NOT salon-perfect or shampoo-commercial.',
  'Clothing: Wrinkled fabric, visible stitching, natural creases and folds — NOT pressed/pristine/CGI-smooth.',
  'Lighting: Authentic ambient light (overhead fluorescent, window light, phone flash, streetlamp). Uneven exposure, blown highlights near light sources, crushed shadows in dark areas.',
  'Texture: Visible sensor grain/noise especially in shadows, slight JPEG compression artifacts, minor focus softness on edges.',
  'Color: Slightly desaturated or warm-shifted from auto white balance — NOT vibrant/HDR/color-graded.',
  'Eyes: Natural asymmetry, candid glance, mid-blink allowed — NOT piercing/symmetrical/intense stare.',
  '',
  'NEVER use these aesthetics: hyper-realistic, 8k, masterpiece, ultra HD, sharp focus, cinematic lighting, perfect bokeh, studio lighting, symmetrical face, anime, cartoon, CGI, digital painting.',
  'The image must be indistinguishable from a real unedited phone photo posted on Instagram.',
  '[END PHOTOGRAPHY REALISM DIRECTIVE]',
].join('\n');

module.exports = REALISM_DIRECTIVE;
