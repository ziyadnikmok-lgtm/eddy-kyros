const REALISM_DIRECTIVE = [
  '[IPHONE PHOTOGRAPHY DIRECTIVE]',
  'This must look like a real iPhone photograph — NOT digital art, anime, 3D render, illustration, cartoon, or CGI.',
  '',
  'Shot on iPhone. 26mm wide lens, handheld, slightly imperfect framing. Natural skin texture, real-world lighting, candid feel. Should look like a real Instagram post, not a magazine ad or studio shoot.',
  '',
  'Honor BRIGHTNESS score and shadow % exactly. Dark stays dark. No added fill light.',
  'Clothing fits realistically. No anatomical alteration.',
  'Deep depth of field — most of frame in focus. No heavy bokeh unless prompted.',
  '',
  'NEVER: hyper-realistic, 8k, masterpiece, ultra HD, cinematic lighting, studio lighting, perfect bokeh, DSLR, high-ISO, professional photography, symmetrical face, anime, CGI.',
  '[END IPHONE PHOTOGRAPHY DIRECTIVE]',
].join('\n');

module.exports = REALISM_DIRECTIVE;
