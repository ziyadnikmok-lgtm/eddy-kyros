const REALISM_DIRECTIVE = [
  '[IPHONE PHOTOGRAPHY DIRECTIVE]',
  'This must look like a real iPhone photograph — NOT digital art, anime, 3D render, illustration, cartoon, or CGI.',
  '',
  'Shot on iPhone. 24mm wide lens, handheld, slightly imperfect framing. Natural skin texture, real-world lighting, candid feel. Should look like a real Instagram post, not a magazine ad or studio shoot.',
  '',
  'Honor BRIGHTNESS score and shadow % exactly. Dark stays dark. No added fill light.',
  'Clothing fits realistically. No anatomical alteration.',
  'Deep depth of field — most of frame in focus. No heavy bokeh unless prompted.',
  '',
  'EYES: Both eyes must be even, symmetrical, and realistically matching. Irises must be the same size, color, and shape. Pupils aligned. No lazy eye, no wonky gaze, no mismatched iris size. Realistic human iris detail with natural catchlight.',
  '',
  'NEVER: hyper-realistic, 8k, masterpiece, ultra HD, cinematic lighting, studio lighting, perfect bokeh, DSLR, high-ISO, professional photography, symmetrical face, anime, CGI.',
  'NEVER draw phone UI, navigation bars, status bars, app icons, or any screen interface elements. This is a PHOTO taken by a camera, NOT a screenshot of a phone screen.',
  'BACKGROUND: Only include objects that logically belong in the described scene. Do NOT hallucinate or invent random objects (cars, animals, extra people, furniture) that were not described. Keep backgrounds clean and simple.',
  '[END IPHONE PHOTOGRAPHY DIRECTIVE]',
].join('\n');

module.exports = REALISM_DIRECTIVE;
