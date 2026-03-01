const REALISM_DIRECTIVE = [
  '[PHOTOGRAPHY REALISM DIRECTIVE]',
  'This must look like a real photograph — NOT digital art, NOT anime, NOT 3D render, NOT an illustration, NOT a cartoon, NOT CGI.',
  '',
  'Camera feel: Shot on an iPhone. 26mm wide lens, handheld with slight tilt, uncentered framing, casual composition.',
  '',
  'NATURAL PHOTO QUALITY: Keep the output looking like a real, naturally-taken photo. Do NOT upgrade to professional studio lighting, commercial retouching, or editorial polish. Preserve a candid, authentic, slightly imperfect feel — natural skin texture, casual framing, real-world lighting. The result should look like it belongs on a real Instagram feed, not in a magazine ad.',
  '',
  'LIGHTING PRESERVATION: If the prompt specifies a BRIGHTNESS score or shadow percentages, honor them exactly. Dark scenes must stay dark. Do NOT brighten, add fill light, or soften shadows beyond what is described. Match the described color temperature.',
  '',
  'BODY LOCK: Clothing fits realistically without altering the underlying anatomical scale.',
  '',
  'DEPTH OF FIELD: Keep background sharpness consistent with a real phone camera. Do NOT add heavy artificial bokeh or background blur unless the prompt explicitly requests it. Phone cameras have deep depth of field — most of the frame should be in focus.',
  '',
  'NEVER use these aesthetics: hyper-realistic, 8k, masterpiece, ultra HD, sharp focus, cinematic lighting, perfect bokeh, heavy bokeh, studio lighting, symmetrical face, anime, cartoon, CGI, digital painting.',
  'The image should look like a natural photo posted on Instagram.',
  '[END PHOTOGRAPHY REALISM DIRECTIVE]',
].join('\n');

module.exports = REALISM_DIRECTIVE;
