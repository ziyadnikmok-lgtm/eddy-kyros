const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const ffmpegPath = require('../utils/ffmpeg');
const { AppError } = require('../middleware/errorHandler');
const { createMultipartParser } = require('../middleware/multipartParser');
const { TEMP_DIR } = require('../paths');

const router = express.Router();
const parseMultipart = createMultipartParser({ maxBytes: 500 * 1024 * 1024 });

function escapeAssText(text = '') {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function assAlignmentFor(position = 'bottom') {
  if (position === 'top') return 8;
  if (position === 'center') return 5;
  return 2;
}

function buildAssSubtitle({ text, textPosition, fontSize }) {
  const alignment = assAlignmentFor(textPosition);
  const safeText = escapeAssText(text);
  const marginV = textPosition === 'top' ? 48 : textPosition === 'center' ? 0 : 48;

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,3,0,${alignment},48,48,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,9:59:59.00,Default,,0,0,0,,${safeText}
`;
}

// POST /api/video-compose
// multipart: video (file), audio (file, optional), text (string), textPosition (top|center|bottom), fontSize (number)
router.post('/', parseMultipart, async (req, res, next) => {
  const tmpFiles = [];
  try {
    const videoFile = req.files?.video;
    const audioFile = req.files?.audio;

    if (!videoFile) throw new AppError('video file is required', 400, 'VALIDATION_ERROR');

    const text = (req.body?.text || '').trim();
    const textPosition = req.body?.textPosition || 'bottom';
    const fontSize = Math.min(Math.max(parseInt(req.body?.fontSize || '48', 10), 16), 120);

    fs.mkdirSync(TEMP_DIR, { recursive: true });

    // Write buffers to temp files for ffmpeg
    const videoPath = path.join(TEMP_DIR, `vc_video_${Date.now()}.mp4`);
    const outputPath = path.join(TEMP_DIR, `vc_out_${Date.now()}.mp4`);
    tmpFiles.push(videoPath, outputPath);

    fs.writeFileSync(videoPath, videoFile.buffer);

    let audioPath = null;
    if (audioFile && audioFile.buffer) {
      audioPath = path.join(TEMP_DIR, `vc_audio_${Date.now()}.mp3`);
      tmpFiles.push(audioPath);
      fs.writeFileSync(audioPath, audioFile.buffer);
    }

    const ffmpegArgs = ['-y', '-i', videoPath];
    if (audioPath) ffmpegArgs.push('-i', audioPath);

    // Video filter: text overlay
    if (text) {
      const subtitlePath = path.join(TEMP_DIR, `vc_subs_${Date.now()}.ass`);
      tmpFiles.push(subtitlePath);
      fs.writeFileSync(subtitlePath, buildAssSubtitle({ text, textPosition, fontSize }), 'utf8');
      ffmpegArgs.push('-vf', `subtitles=${subtitlePath}`);
    }

    if (audioPath) {
      ffmpegArgs.push('-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', '-crf', '23');
    } else {
      ffmpegArgs.push('-c:v', 'libx264', '-c:a', 'copy', '-preset', 'fast', '-crf', '23');
    }

    ffmpegArgs.push(outputPath);

    await execFileAsync(ffmpegPath, ffmpegArgs, { timeout: 5 * 60_000 });

    if (!fs.existsSync(outputPath)) throw new AppError('ffmpeg failed to produce output', 500, 'FFMPEG_ERROR');

    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');
    const sizeKB = Math.round(videoBuffer.length / 1024);

    res.json({
      success: true,
      data: {
        videoBase64,
        mimeType: 'video/mp4',
        filename: `composed_${Date.now()}.mp4`,
        sizeKB,
      },
    });
  } catch (err) {
    next(err);
  } finally {
    for (const f of tmpFiles) {
      try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
});

module.exports = router;
