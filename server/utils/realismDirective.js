// server/utils/realismDirective.js
// Shared photography realism directive injected into all image generation prompts.
// Keeps the language consistent across generate, batch, postClone, and reelCopy routes.

const REALISM_DIRECTIVE = [
  '[PHOTOGRAPHY REALISM DIRECTIVE]',
  'This must look like a real photograph — NOT digital art, NOT anime, NOT 3D render, NOT an illustration, NOT a cartoon, NOT CGI.',
  '',
  'Camera feel: Shot on an iPhone. 26mm wide lens, handheld with slight tilt, uncentered framing, casual composition.',
  '',
  'NEVER use these aesthetics: hyper-realistic, 8k, masterpiece, ultra HD, sharp focus, cinematic lighting, perfect bokeh, studio lighting, symmetrical face, anime, cartoon, CGI, digital painting.',
  'The image should look like a natural photo posted on Instagram.',
  '[END PHOTOGRAPHY REALISM DIRECTIVE]',
].join('\n');

module.exports = REALISM_DIRECTIVE;
