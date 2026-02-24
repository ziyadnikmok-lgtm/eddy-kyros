// server/utils/ffmpeg.js
// Resolves the ffmpeg binary path: uses bundled ffmpeg-static if available,
// otherwise falls back to system PATH.

let ffmpegPath = 'ffmpeg';
try {
  ffmpegPath = require('ffmpeg-static');
} catch {
  // ffmpeg-static not installed — rely on system PATH
}

module.exports = ffmpegPath;
