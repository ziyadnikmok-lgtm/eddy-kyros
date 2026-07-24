let ffmpegPath = 'ffmpeg';
try {
  const resolved = require('ffmpeg-static');
  if (resolved) ffmpegPath = resolved;
} catch {}

module.exports = ffmpegPath;
