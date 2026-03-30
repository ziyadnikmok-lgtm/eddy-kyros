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
      // Arial Bold first (matches social caption style), then fallbacks
      const FONT_CANDIDATES = [
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
        '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/System/Library/Fonts/Arial.ttf',
        '/Library/Fonts/Arial Bold.ttf',
        '/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
      ];
      const fontfile = FONT_CANDIDATES.find(f => fs.existsSync(f)) || '';
      const fontfileParam = fontfile ? `fontfile='${fontfile}':` : '';

      // Word-wrap: respect explicit newlines first, then wrap long segments
      // maxChars based on video width (~1080px) — bigger font = fewer chars per line
      const maxChars = Math.max(16, Math.min(40, Math.round(1400 / fontSize)));

      function wrapSegment(segment, max) {
        const words = segment.trim().split(/\s+/);
        const lines = [];
        let cur = '';
        for (const word of words) {
          if (cur.length > 0 && cur.length + 1 + word.length > max) {
            lines.push(cur);
            cur = word;
          } else {
            cur = cur ? `${cur} ${word}` : word;
          }
        }
        if (cur) lines.push(cur);
        return lines;
      }

      // Split on hard newlines first, then word-wrap each segment
      const lines = text
        .split(/\r?\n/)
        .flatMap(seg => seg.trim() ? wrapSegment(seg, maxChars) : []);

      function escapeDrawtext(s) {
        return s
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'")
          .replace(/\[/g, '\\[')
          .replace(/\]/g, '\\]');
      }

      // Line height ≈ fontSize * 1.25; total block height used to anchor position
      const lineH = Math.round(fontSize * 1.25);
      const totalH = lineH * lines.length;

      // Base Y for each position so the whole block sits in the right zone
      const baseYExpr = {
        top:    `60`,
        center: `(h-${totalH})/2`,
        bottom: `h-${totalH}-60`,
      }[textPosition] || `h-${totalH}-60`;

      // Build one drawtext filter per line, chained with comma
      const drawtextFilters = lines.map((line, i) => {
        const safe = escapeDrawtext(line);
        const yExpr = i === 0 ? baseYExpr : `${baseYExpr}+${i * lineH}`;
        return `drawtext=${fontfileParam}text='${safe}':fontsize=${fontSize}:fontcolor=white:bordercolor=black:borderw=4:x=(w-text_w)/2:y=${yExpr}`;
      });

      ffmpegArgs.push('-vf', drawtextFilters.join(','));
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
