const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const ffmpegPath = require('../utils/ffmpeg');
const { AppError } = require('../middleware/errorHandler');
const { createMultipartParser } = require('../middleware/multipartParser');
const { TEMP_DIR, UPLOADS_DIR } = require('../paths');
const videoHistory = require('../services/videoHistoryStore');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiBackend');
const directGeminiService = require('../services/geminiService');

const router = express.Router();
const parseMultipart = createMultipartParser({ maxBytes: 500 * 1024 * 1024 });
const VIDEO_DIR = path.join(UPLOADS_DIR, 'videos');

const FILTER_PRESETS = {
  none: { brightness: 0, contrast: 1, saturation: 1, blur: 0, warmth: 0, sharpness: 0, vignette: 0 },
  clean: { brightness: 0.01, contrast: 1.04, saturation: 1.03, blur: 0, warmth: 0.03, sharpness: 0.35, vignette: 0 },
  cinematic: { brightness: -0.03, contrast: 1.15, saturation: 0.92, blur: 0.2, warmth: -0.02, sharpness: 0.2, vignette: 0.45 },
  warm: { brightness: 0.02, contrast: 1.05, saturation: 1.08, blur: 0, warmth: 0.12, sharpness: 0.1, vignette: 0 },
  cool: { brightness: 0, contrast: 1.06, saturation: 0.94, blur: 0, warmth: -0.1, sharpness: 0.15, vignette: 0 },
  dramatic: { brightness: -0.05, contrast: 1.2, saturation: 0.88, blur: 0, warmth: -0.03, sharpness: 0.45, vignette: 0.55 },
  mono: { brightness: 0, contrast: 1.08, saturation: 0, blur: 0, warmth: 0, sharpness: 0.2, vignette: 0 },
  glam: { brightness: 0.03, contrast: 1.08, saturation: 1.15, blur: 0.15, warmth: 0.08, sharpness: 0.15, vignette: 0.1 },
};

function safeTempExtension(filename, fallback) {
  const rawExt = path.extname(String(filename || '')).toLowerCase();
  if (!rawExt || rawExt.length > 10) return fallback;
  return /^[a-z0-9.]+$/.test(rawExt) ? rawExt : fallback;
}

function isImageUpload(file) {
  if (!file) return false;
  const type = String(file.mimetype || file.type || '').toLowerCase();
  const ext = safeTempExtension(file.originalname || file.filename || '', '').toLowerCase();
  return type.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext);
}

async function buildStillVideoFromImage({
  inputPath,
  outputPath,
  durationSeconds,
  width = 1080,
  height = 1920,
}) {
  const safeDuration = Math.max(0.1, Number(durationSeconds) || 5);
  await execFileAsync(ffmpegPath, [
    '-y',
    '-loop', '1',
    '-i', inputPath,
    '-t', safeDuration.toFixed(3),
    '-vf', `fps=30,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-an',
    outputPath,
  ], { timeout: 2 * 60_000 });
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function escapeAssText(text = '') {
  return String(text)
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map((line) => line
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}'))
    .join('\\N');
}

function assAlignmentFor(position = 'bottom') {
  if (position === 'top') return 8;
  if (position === 'center') return 5;
  return 2;
}

function formatAssTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const centis = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function toSubtitleFilterPath(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/'/g, "\\'");
}

function normalizeTextClips(rawClips, fallbackText, fallbackPosition, fallbackFontSize, maxDuration = null) {
  const clips = Array.isArray(rawClips) ? rawClips : [];
  const normalized = clips
    .map((clip, index) => {
      const text = String(clip?.text || '').trim();
      if (!text) return null;
      const start = clampNumber(clip?.start, 0, maxDuration ?? 60 * 60, 0);
      const end = clampNumber(clip?.end, start + 0.1, maxDuration ?? 60 * 60, start + 2);
      return {
        id: String(clip?.id || `clip-${index + 1}`),
        text,
        start,
        end,
        position: ['top', 'center', 'bottom'].includes(clip?.position) ? clip.position : fallbackPosition,
        x: typeof clip?.x === 'number' ? clip.x : null,
        y: typeof clip?.y === 'number' ? clip.y : null,
        fontSize: Math.round(clampNumber(clip?.fontSize, 16, 160, fallbackFontSize)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  if (normalized.length > 0) return normalized;
  if (!fallbackText) return [];

  return [{
    id: 'clip-1',
    text: String(fallbackText).trim(),
    start: 0,
    end: maxDuration && maxDuration > 0 ? maxDuration : 10 * 60 * 60,
    position: fallbackPosition,
    fontSize: fallbackFontSize,
  }];
}

function buildAssSubtitle({ textClips, width = 1080, height = 1920 }) {
  const playResX = Math.max(16, Math.round(width));
  const playResY = Math.max(16, Math.round(height));
  const marginBase = Math.max(24, Math.round(playResY * 0.045));

  const styleLines = [];
  const eventLines = [];

  for (const clip of textClips) {
    const styleName = `Clip${clip.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const isCustomPos = typeof clip.x === 'number' && typeof clip.y === 'number';
    const alignment = isCustomPos ? 5 : assAlignmentFor(clip.position);
    const marginV = clip.position === 'center' || isCustomPos ? 0 : marginBase;

    styleLines.push(
      `Style: ${styleName},Arial Black,${clip.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,3,${alignment},${marginBase},${marginBase},${marginV},1`
    );

    let text = escapeAssText(clip.text);
    if (isCustomPos) {
      const absX = Math.round(playResX * Math.max(0, Math.min(1, clip.x)));
      const absY = Math.round(playResY * Math.max(0, Math.min(1, clip.y)));
      text = `{\\pos(${absX},${absY})}${text}`;
    }

    eventLines.push(
      `Dialogue: 0,${formatAssTime(clip.start)},${formatAssTime(clip.end)},${styleName},,0,0,0,,${text}`
    );
  }

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLines.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${eventLines.join('\n')}
`;
}

async function probeVideoInfo(videoPath) {
  try {
    await execFileAsync(ffmpegPath, ['-i', videoPath], { timeout: 30_000 });
  } catch (err) {
    const stderr = String(err?.stderr || '');
    const videoMatch = stderr.match(/Video:\s.*?(\d{2,5})x(\d{2,5})/);
    const durationMatch = stderr.match(/Duration:\s(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const hasAudio = /Audio:\s/.test(stderr);
    const width = videoMatch ? Number(videoMatch[1]) : 1080;
    const height = videoMatch ? Number(videoMatch[2]) : 1920;
    const durationSeconds = durationMatch
      ? (Number(durationMatch[1]) * 3600) + (Number(durationMatch[2]) * 60) + Number(durationMatch[3])
      : null;
    return { width, height, durationSeconds, hasAudio };
  }
  return { width: 1080, height: 1920, durationSeconds: null, hasAudio: false };
}

async function extractOverlayFrames(videoPath, token, count = 4) {
  const framePattern = path.join(TEMP_DIR, `vc_overlay_${token}_%02d.jpg`);
  await execFileAsync(ffmpegPath, [
    '-y',
    '-i', videoPath,
    '-vf', `fps=1,scale=720:-1:force_original_aspect_ratio=decrease`,
    '-frames:v', String(count),
    framePattern,
  ], { timeout: 60_000 });

  const frames = [];
  for (let i = 1; i <= count; i += 1) {
    const framePath = path.join(TEMP_DIR, `vc_overlay_${token}_${String(i).padStart(2, '0')}.jpg`);
    const buffer = await fs.readFile(framePath).catch(() => null);
    if (buffer?.length) {
      frames.push({ path: framePath, mimeType: 'image/jpeg', base64Data: buffer.toString('base64') });
    }
  }
  return frames;
}

function parseOverlayTextResponse(rawText, timelineDuration) {
  const cleaned = String(rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
    }
  }
  const sourceClips = Array.isArray(parsed?.clips) ? parsed.clips : [];
  const maxDuration = Math.max(0.1, Number(timelineDuration) || 6);
  return sourceClips
    .map((clip, index) => {
      const text = String(clip?.text || '').replace(/\\n/g, '\n').trim();
      if (!text) return null;
      const start = clampNumber(clip?.start, 0, Math.max(0, maxDuration - 0.1), Math.min(index * 2, maxDuration - 0.1));
      const end = clampNumber(clip?.end, start + 0.1, maxDuration, Math.min(maxDuration, start + 2));
      return {
        text,
        start,
        end,
        position: ['top', 'center', 'bottom'].includes(clip?.position) ? clip.position : 'center',
        fontSize: Math.round(clampNumber(clip?.fontSize, 16, 160, 64)),
      };
    })
    .filter(Boolean);
}

async function analyzeOverlayFramesWithFallback(apiKey, frames, prompt) {
  try {
    return await geminiService.analyzeImagesWithPrompt(
      apiKey,
      frames.map((frame) => ({ mimeType: frame.mimeType, base64Data: frame.base64Data })),
      prompt,
    );
  } catch (err) {
    const canFallbackToGeminiKey = Boolean(apiKey);
    const shouldFallback = ['INVALID_CREDENTIALS', 'CONFIG_ERROR', 'NO_VERTEX_CREDENTIALS'].includes(err.code);
    if (!canFallbackToGeminiKey || !shouldFallback || !apiKeyManager.shouldUseVertexBackend()) {
      throw err;
    }

    console.warn('[video-compose] Vertex overlay extraction failed; falling back to active Gemini API key:', err.message);
    return directGeminiService.__direct.analyzeImagesWithPrompt(
      apiKey,
      frames.map((frame) => ({ mimeType: frame.mimeType, base64Data: frame.base64Data })),
      prompt,
    );
  }
}

// Compute the combined CSS sepia × hue-rotate colour matrix for cool warmth.
function _coolMatrix(sepiaAmt, hueDeg) {
  const s = sepiaAmt;
  const sep = [
    [1 - 0.607 * s, 0.769 * s, 0.189 * s],
    [0.349 * s, 1 - 0.314 * s, 0.168 * s],
    [0.272 * s, 0.534 * s, 1 - 0.869 * s],
  ];
  const rad = (hueDeg * Math.PI) / 180;
  const c = Math.cos(rad), sn = Math.sin(rad);
  const hr = [
    [c + 0.213 * (1 - c), 0.715 * (1 - c) - 0.787 * sn, 0.072 * (1 - c) + 0.928 * sn],
    [0.213 * (1 - c) + 0.143 * sn, c + 0.285 * (1 - c), 0.072 * (1 - c) - 0.283 * sn],
    [0.213 * (1 - c) - 0.787 * sn, 0.715 * (1 - c) + 0.928 * sn, c + 0.072 * (1 - c)],
  ];
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      m[i][j] = sep[i][0] * hr[0][j] + sep[i][1] * hr[1][j] + sep[i][2] * hr[2][j];
  return m;
}

function buildVideoFilter({
  presetId,
  speed,
  brightness,
  contrast,
  saturation,
  blur,
  warmth,
  sharpness,
  vignette,
  subtitlePath,
  sourceWidth,
  sourceHeight,
  zoom,
  panX,
  panY,
}) {
  const preset = FILTER_PRESETS[presetId] || FILTER_PRESETS.none;
  const finalBrightness = Math.max(-1, Math.min(1, preset.brightness + brightness));
  const finalContrast = Math.max(0, Math.min(3, preset.contrast * contrast));
  const finalSaturation = Math.max(0, Math.min(3, preset.saturation * saturation));
  const finalBlur = Math.max(0, Math.min(8, preset.blur + blur));
  const finalWarmth = Math.max(-0.35, Math.min(0.35, preset.warmth + warmth));
  const finalSharpness = Math.max(0, Math.min(2.5, preset.sharpness + sharpness));
  const finalVignette = Math.max(0, Math.min(1, preset.vignette + vignette));

  const filters = [];
  if (Math.abs(speed - 1) > 0.0001) {
    filters.push(`setpts=${(1 / speed).toFixed(6)}*PTS`);
  }

  const framingChain = buildFramingChain(sourceWidth, sourceHeight, zoom, panX, panY);
  if (framingChain) filters.push(framingChain);

  // Brightness — CSS brightness(factor) multiplies RGB values.  FFmpeg
  // eq=brightness is *additive* and washes highlights.  Using eq=gamma
  // gives a power-curve lift that preserves tonal relationships, calibrated
  // so the midtone (input 0.5) matches CSS output exactly.
  const brightFactor = Math.max(0.01, 1 + finalBrightness);
  let eqGamma = 1;
  if (Math.abs(finalBrightness) > 0.005) {
    eqGamma = Math.max(0.1, Math.min(10,
      Math.log(0.5) / Math.log(Math.max(0.001, 0.5 * brightFactor))
    ));
  }
  filters.push(
    `eq=brightness=0:gamma=${eqGamma.toFixed(4)}:contrast=${finalContrast.toFixed(3)}:saturation=${finalSaturation.toFixed(3)}`
  );

  // Warmth — replicate the exact CSS sepia colour-matrix via
  // colorchannelmixer instead of the old colorbalance approximation.
  // For cool (negative) warmth CSS layers hue-rotate on top of sepia;
  // we pre-multiply the two 3×3 matrices into one mixer call.
  if (Math.abs(finalWarmth) > 0.005) {
    const s = Math.min(0.5, Math.abs(finalWarmth) * 1.6);
    let rr, rg, rb, gr, gg, gb, br, bg, bb;
    if (finalWarmth > 0) {
      rr = 1 - 0.607 * s; rg = 0.769 * s; rb = 0.189 * s;
      gr = 0.349 * s; gg = 1 - 0.314 * s; gb = 0.168 * s;
      br = 0.272 * s; bg = 0.534 * s; bb = 1 - 0.869 * s;
    } else {
      const m = _coolMatrix(s, Math.abs(finalWarmth) * 40);
      [[rr, rg, rb], [gr, gg, gb], [br, bg, bb]] = m;
    }
    filters.push(
      `colorchannelmixer=rr=${rr.toFixed(4)}:rg=${rg.toFixed(4)}:rb=${rb.toFixed(4)}` +
      `:gr=${gr.toFixed(4)}:gg=${gg.toFixed(4)}:gb=${gb.toFixed(4)}` +
      `:br=${br.toFixed(4)}:bg=${bg.toFixed(4)}:bb=${bb.toFixed(4)}`
    );
  }

  // Sharpness — CSS uses a subtle white drop-shadow for pseudo-sharpening.
  // Use a smaller 3×3 kernel with reduced amount to match the gentle effect.
  if (finalSharpness > 0.01) {
    filters.push(`unsharp=3:3:${(finalSharpness * 0.4).toFixed(2)}:3:3:0.0`);
  }
  if (finalBlur > 0.01) filters.push(`gblur=sigma=${finalBlur.toFixed(2)}`);

  // Vignette — recalibrated to match the CSS radial-gradient spread
  // (gentler than the old formula which over-darkened edges).
  if (finalVignette > 0.01) {
    const angle = Math.max(1.8, 5.0 - finalVignette * 2.8);
    filters.push(`vignette=angle=PI/${angle.toFixed(2)}:eval=frame`);
  }
  if (subtitlePath) filters.push(`subtitles='${toSubtitleFilterPath(subtitlePath)}'`);
  return filters.join(',');
}

function buildAtempoFilter(speed) {
  if (!Number.isFinite(speed) || speed <= 0) return null;
  if (Math.abs(speed - 1) <= 0.0001) return null;

  const parts = [];
  let remaining = speed;
  while (remaining > 2.0) {
    parts.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    parts.push('atempo=0.5');
    remaining /= 0.5;
  }
  parts.push(`atempo=${remaining.toFixed(6)}`);
  return parts.join(',');
}

function buildNormalizeVideoChain(width, height) {
  const safeWidth = Math.max(16, Math.round(width || 1080));
  const safeHeight = Math.max(16, Math.round(height || 1920));
  return `fps=30,scale=${safeWidth}:${safeHeight}:force_original_aspect_ratio=increase,crop=${safeWidth}:${safeHeight},setsar=1,format=yuv420p`;
}

function buildFramingChain(width, height, zoom, panX, panY) {
  const safeWidth = Math.max(16, Math.round(width || 1080));
  const safeHeight = Math.max(16, Math.round(height || 1920));
  const safeZoom = clampNumber(zoom, 1, 2.5, 1);
  const safePanX = clampNumber(panX, -1, 1, 0);
  const safePanY = clampNumber(panY, -1, 1, 0);

  if (Math.abs(safeZoom - 1) < 0.0001 && Math.abs(safePanX) < 0.0001 && Math.abs(safePanY) < 0.0001) {
    return '';
  }

  const scaledWidth = Math.max(safeWidth, Math.round((safeWidth * safeZoom) / 2) * 2);
  const scaledHeight = Math.max(safeHeight, Math.round((safeHeight * safeZoom) / 2) * 2);
  const xRatio = ((safePanX + 1) / 2).toFixed(4);
  const yRatio = ((safePanY + 1) / 2).toFixed(4);

  return `scale=${scaledWidth}:${scaledHeight},crop=${safeWidth}:${safeHeight}:(iw-ow)*${xRatio}:(ih-oh)*${yRatio}`;
}

router.post('/extract-text-overlay', parseMultipart, async (req, res, next) => {
  const tmpFiles = [];
  try {
    const videoFile = req.files?.video;
    if (!videoFile?.buffer) throw new AppError('video file is required', 400, 'VALIDATION_ERROR');

    await fs.mkdir(TEMP_DIR, { recursive: true });
    const token = crypto.randomUUID();
    const ext = safeTempExtension(videoFile.originalname || videoFile.filename || 'overlay.mp4', '.mp4');
    const videoPath = path.join(TEMP_DIR, `vc_overlay_source_${token}${ext}`);
    tmpFiles.push(videoPath);
    await fs.writeFile(videoPath, videoFile.buffer);

    const timelineDuration = clampNumber(req.body?.timelineDuration, 0.1, 60 * 60, 6);
    const frames = await extractOverlayFrames(videoPath, token, 4);
    tmpFiles.push(...frames.map((frame) => frame.path));
    if (frames.length === 0) {
      throw new AppError('Could not read frames from video', 400, 'VIDEO_FRAME_ERROR');
    }

    const prompt = `You are extracting ONLY visible text overlays/captions from a short social video.
Look at these frames and ignore people, background, UI, watermarks, usernames, logos, subtitles from apps, and interface text.
Return ONLY valid JSON with this shape:
{
  "clips": [
    { "text": "line 1\\nline 2", "start": 0, "end": 2.5, "position": "top|center|bottom", "fontSize": 64 }
  ]
}
Rules:
- Preserve line breaks exactly when the overlay is stacked on multiple lines.
- If one overlay has a list, keep it as multiple lines in a single text string.
- Use approximate timing across a ${timelineDuration.toFixed(1)} second target timeline.
- If no overlay text exists, return {"clips":[]}.`;

    const apiKey = apiKeyManager.getActiveKey();
    const text = await analyzeOverlayFramesWithFallback(apiKey, frames, prompt);
    const clips = parseOverlayTextResponse(text, timelineDuration);
    res.json({ success: true, data: { clips } });
  } catch (err) {
    next(err);
  } finally {
    await Promise.all(tmpFiles.map(async (filePath) => {
      try { await fs.unlink(filePath); } catch {}
    }));
  }
});

router.post('/', parseMultipart, async (req, res, next) => {
  const tmpFiles = [];
  let outputPath = null;
  let completed = false;
  try {
    const videoFile = req.files?.video;
    const secondVideoFile = req.files?.video2;
    const audioFile = req.files?.audio;
    if (!videoFile) throw new AppError('video file is required', 400, 'VALIDATION_ERROR');

    const text = String(req.body?.text || '').trim();
    const textPosition = ['top', 'center', 'bottom'].includes(req.body?.textPosition) ? req.body.textPosition : 'bottom';
    const fontSize = Math.min(Math.max(parseInt(req.body?.fontSize || '48', 10), 16), 160);
    const presetId = Object.prototype.hasOwnProperty.call(FILTER_PRESETS, req.body?.preset) ? req.body.preset : 'none';
    const speed = clampNumber(req.body?.speed, 0.5, 2, 1);
    const brightness = clampNumber(req.body?.brightness, -0.4, 0.4, 0);
    const contrast = clampNumber(req.body?.contrast, 0.5, 1.8, 1);
    const saturation = clampNumber(req.body?.saturation, 0, 2, 1);
    const blur = clampNumber(req.body?.blur, 0, 4, 0);
    const warmth = clampNumber(req.body?.warmth, -0.3, 0.3, 0);
    const sharpness = clampNumber(req.body?.sharpness, 0, 2, 0);
    const vignette = clampNumber(req.body?.vignette, 0, 1, 0);
    const primaryZoom = clampNumber(req.body?.primaryZoom, 1, 2.5, 1);
    const primaryPanX = clampNumber(req.body?.primaryPanX, -1, 1, 0);
    const primaryPanY = clampNumber(req.body?.primaryPanY, -1, 1, 0);
    const secondaryZoom = clampNumber(req.body?.secondaryZoom, 1, 2.5, 1);
    const secondaryPanX = clampNumber(req.body?.secondaryPanX, -1, 1, 0);
    const secondaryPanY = clampNumber(req.body?.secondaryPanY, -1, 1, 0);
    const musicVolume = clampNumber(req.body?.musicVolume, 0, 2, 1);
    const originalAudioVolume = clampNumber(req.body?.originalAudioVolume, 0, 2, 1);
    const replaceOriginalAudio = String(req.body?.replaceOriginalAudio || '').toLowerCase() === 'true';
    const imageDuration = clampNumber(req.body?.imageDuration, 0.1, 60, 5);
    const imageDuration2 = clampNumber(req.body?.imageDuration2, 0.1, 60, 5);

    await fs.mkdir(TEMP_DIR, { recursive: true });
    await fs.mkdir(VIDEO_DIR, { recursive: true });

    const stamp = Date.now();
    const token = crypto.randomUUID();
    const videoExt = safeTempExtension(videoFile?.originalname || videoFile?.filename || 'video.mp4', '.mp4');
    const videoPath = path.join(TEMP_DIR, `vc_video_${token}${videoExt}`);
    const outputFilename = `video-compose-${stamp}-${token}.mp4`;
    outputPath = path.join(VIDEO_DIR, outputFilename);
    tmpFiles.push(videoPath);

    await fs.writeFile(videoPath, videoFile.buffer);

    let primaryProbeSourcePath = videoPath;
    if (isImageUpload(videoFile)) {
      const primaryStillPath = path.join(TEMP_DIR, `vc_video_${token}_still.mp4`);
      tmpFiles.push(primaryStillPath);
      await buildStillVideoFromImage({
        inputPath: videoPath,
        outputPath: primaryStillPath,
        durationSeconds: imageDuration,
      });
      primaryProbeSourcePath = primaryStillPath;
    }

    let secondVideoPath = null;
    let secondProbe = null;
    if (secondVideoFile?.buffer) {
      const secondExt = safeTempExtension(secondVideoFile?.originalname || secondVideoFile?.filename || 'video2.mp4', '.mp4');
      secondVideoPath = path.join(TEMP_DIR, `vc_video2_${token}${secondExt}`);
      tmpFiles.push(secondVideoPath);
      await fs.writeFile(secondVideoPath, secondVideoFile.buffer);
      if (isImageUpload(secondVideoFile)) {
        const secondStillPath = path.join(TEMP_DIR, `vc_video2_${token}_still.mp4`);
        tmpFiles.push(secondStillPath);
        await buildStillVideoFromImage({
          inputPath: secondVideoPath,
          outputPath: secondStillPath,
          durationSeconds: imageDuration2,
        });
        secondVideoPath = secondStillPath;
      }
      secondProbe = await probeVideoInfo(secondVideoPath);
    }

    let audioPath = null;
    let audioProbe = null;
    if (audioFile?.buffer) {
      const audioExt = safeTempExtension(audioFile?.originalname || audioFile?.filename || 'audio.bin', '.bin');
      audioPath = path.join(TEMP_DIR, `vc_audio_${token}${audioExt}`);
      tmpFiles.push(audioPath);
      await fs.writeFile(audioPath, audioFile.buffer);
      audioProbe = await probeVideoInfo(audioPath);
    }

    const probe = await probeVideoInfo(primaryProbeSourcePath);
    const sourceDuration = probe.durationSeconds || null;
    const trimStart = clampNumber(req.body?.trimStart, 0, sourceDuration ?? 60 * 60, 0);
    const trimEndFallback = sourceDuration && sourceDuration > 0 ? sourceDuration : trimStart + 10;
    const trimEnd = clampNumber(req.body?.trimEnd, trimStart + 0.1, sourceDuration ?? 60 * 60, trimEndFallback);
    const trimmedDuration = Math.max(0.1, trimEnd - trimStart);
    const secondTrimmedDuration = secondProbe?.durationSeconds ? Math.max(0.1, secondProbe.durationSeconds) : 0;
    const combinedDuration = trimmedDuration + secondTrimmedDuration;
    const audioSourceDuration = audioProbe?.durationSeconds || combinedDuration || trimmedDuration;
    const audioStart = clampNumber(req.body?.audioStart, 0, audioSourceDuration, 0);
    const timelineDuration = combinedDuration || trimmedDuration;
    const audioEnd = clampNumber(req.body?.audioEnd, audioStart + 0.1, audioSourceDuration || timelineDuration, Math.min(audioSourceDuration || timelineDuration, audioStart + timelineDuration));
    const audioOffset = clampNumber(req.body?.audioOffset, 0, timelineDuration, 0);
    const audioWindow = Math.max(0.1, audioEnd - audioStart);

    let rawTextClips = [];
    try {
      rawTextClips = req.body?.textClips ? JSON.parse(req.body.textClips) : [];
    } catch {
      rawTextClips = [];
    }
    const textClips = normalizeTextClips(rawTextClips, text, textPosition, fontSize, combinedDuration || trimmedDuration);

    let subtitlePath = null;
    if (textClips.length > 0) {
      subtitlePath = path.join(TEMP_DIR, `vc_subs_${token}.ass`);
      tmpFiles.push(subtitlePath);
      await fs.writeFile(subtitlePath, buildAssSubtitle({
        textClips,
        width: probe.width,
        height: probe.height,
      }), 'utf8');
    }

    const ffmpegArgs = ['-y', '-ss', trimStart.toFixed(3), '-t', trimmedDuration.toFixed(3), '-i', primaryProbeSourcePath];
    if (secondVideoPath && secondTrimmedDuration > 0) {
      ffmpegArgs.push('-t', secondTrimmedDuration.toFixed(3), '-i', secondVideoPath);
    }
    if (audioPath) ffmpegArgs.push('-i', audioPath);

    const videoFilter = buildVideoFilter({
      presetId,
      speed,
      brightness,
      contrast,
      saturation,
      blur,
      warmth,
      sharpness,
      vignette,
      subtitlePath,
      sourceWidth: probe.width,
      sourceHeight: probe.height,
      zoom: primaryZoom,
      panX: primaryPanX,
      panY: primaryPanY,
    });
    const hasVideoFilter = Boolean(videoFilter);

    const speedAudioFilter = buildAtempoFilter(speed);
    const hasOriginalAudio = !!probe.hasAudio;
    const hasSecondVideo = !!(secondVideoPath && secondTrimmedDuration > 0);
    const hasSecondAudio = !!secondProbe?.hasAudio;

    if (hasSecondVideo) {
      const normalizeChainPrimary = [buildNormalizeVideoChain(probe.width, probe.height), buildFramingChain(probe.width, probe.height, primaryZoom, primaryPanX, primaryPanY)].filter(Boolean).join(',');
      const normalizeChainSecondary = [buildNormalizeVideoChain(probe.width, probe.height), buildFramingChain(probe.width, probe.height, secondaryZoom, secondaryPanX, secondaryPanY)].filter(Boolean).join(',');
      const normalizeAudioChain = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
      const speedVideoFilter = Math.abs(speed - 1) > 0.0001 ? `setpts=${(1 / speed).toFixed(6)}*PTS,` : '';
      const postVideoFilter = buildVideoFilter({
        presetId,
        speed: 1,
        brightness,
        contrast,
        saturation,
        blur,
        warmth,
        sharpness,
        vignette,
        subtitlePath,
        sourceWidth: probe.width,
        sourceHeight: probe.height,
        zoom: 1,
        panX: 0,
        panY: 0,
      });

      const musicInputIndex = audioPath ? 2 : null;
      const complexParts = [
        `[0:v]${normalizeChainPrimary}[v0]`,
        hasOriginalAudio
          ? `[0:a]atrim=start=0:end=${trimmedDuration.toFixed(3)},asetpts=PTS-STARTPTS,${normalizeAudioChain}[a0]`
          : `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=start=0:end=${trimmedDuration.toFixed(3)},${normalizeAudioChain}[a0]`,
        `[1:v]${normalizeChainSecondary}[v1]`,
        hasSecondAudio
          ? `[1:a]atrim=start=0:end=${secondTrimmedDuration.toFixed(3)},asetpts=PTS-STARTPTS,${normalizeAudioChain}[a1]`
          : `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=start=0:end=${secondTrimmedDuration.toFixed(3)},${normalizeAudioChain}[a1]`,
        `[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][acat]`,
      ];

      const baseAudioChain = [];
      if (speedAudioFilter) baseAudioChain.push(speedAudioFilter);
      baseAudioChain.push(`volume=${originalAudioVolume.toFixed(2)}`);
      complexParts.push(`[acat]${baseAudioChain.join(',')}[abase]`);

      const finalVideoChain = [`${speedVideoFilter}${postVideoFilter}`.replace(/^,|,$/g, '')].filter(Boolean).join(',');
      complexParts.push(finalVideoChain ? `[vcat]${finalVideoChain}[vout]` : '[vcat]null[vout]');

      if (musicInputIndex !== null) {
        const musicChain = [
          `atrim=start=${audioStart.toFixed(3)}:end=${audioEnd.toFixed(3)}`,
          'asetpts=PTS-STARTPTS',
        ];
        if (audioOffset > 0.0001) {
          const delayMs = Math.round(audioOffset * 1000);
          musicChain.push(`adelay=${delayMs}|${delayMs}`);
        }
        if (speedAudioFilter) musicChain.push(speedAudioFilter);
        musicChain.push(`volume=${musicVolume.toFixed(2)}`);
        complexParts.push(`[${musicInputIndex}:a]${musicChain.join(',')}[amusic]`);
        if (replaceOriginalAudio) {
          complexParts.push('[amusic]anull[aout]');
        } else {
          complexParts.push('[abase][amusic]amix=inputs=2:duration=first:dropout_transition=2[aout]');
        }
      } else {
        complexParts.push('[abase]anull[aout]');
      }

      ffmpegArgs.push(
        '-filter_complex',
        complexParts.join(';'),
        '-map', '[vout]',
        '-map', '[aout]',
        '-c:v', 'libx264',
        '-c:a', 'aac'
      );
    } else

    if (audioPath) {
      const trimmedAudioChain = [
        `atrim=start=${audioStart.toFixed(3)}:end=${audioEnd.toFixed(3)}`,
        'asetpts=PTS-STARTPTS',
      ];
      if (audioOffset > 0.0001) {
        const delayMs = Math.round(audioOffset * 1000);
        trimmedAudioChain.push(`adelay=${delayMs}|${delayMs}`);
      }
      if (replaceOriginalAudio || !hasOriginalAudio) {
        const audioFilters = [...trimmedAudioChain];
        if (speedAudioFilter) audioFilters.push(speedAudioFilter);
        audioFilters.push(`volume=${musicVolume.toFixed(2)}`);
        if (hasVideoFilter) {
          ffmpegArgs.push(
            '-filter_complex',
            `[0:v]${videoFilter}[vout];[1:a]${audioFilters.join(',')}[aout]`,
            '-map', '[vout]',
            '-map', '[aout]',
            '-c:v', 'libx264',
            '-c:a', 'aac'
          );
        } else {
          ffmpegArgs.push(
            '-map', '0:v',
            '-map', '1:a',
            '-filter:a', audioFilters.join(','),
            '-c:v', 'libx264',
            '-c:a', 'aac'
          );
        }
      } else {
        const complexParts = [];
        const originalChain = [`volume=${originalAudioVolume.toFixed(2)}`];
        const musicChain = [...trimmedAudioChain, `volume=${musicVolume.toFixed(2)}`];
        if (speedAudioFilter) {
          originalChain.unshift(speedAudioFilter);
          musicChain.push(speedAudioFilter);
        }
        if (hasVideoFilter) complexParts.push(`[0:v]${videoFilter}[vout]`);
        complexParts.push(`[0:a]${originalChain.join(',')}[a0]`);
        complexParts.push(`[1:a]${musicChain.join(',')}[a1]`);
        complexParts.push('[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]');
        ffmpegArgs.push(
          '-filter_complex',
          complexParts.join(';'),
          '-map', hasVideoFilter ? '[vout]' : '0:v',
          '-map', '[aout]',
          '-c:v', 'libx264',
          '-c:a', 'aac'
        );
      }
    } else {
      if (hasVideoFilter) {
        ffmpegArgs.push('-vf', videoFilter);
      }
      ffmpegArgs.push('-c:v', 'libx264');
      if (hasOriginalAudio) {
        if (speedAudioFilter) {
          ffmpegArgs.push('-filter:a', `${speedAudioFilter},volume=${originalAudioVolume.toFixed(2)}`, '-c:a', 'aac');
        } else if (Math.abs(originalAudioVolume - 1) > 0.0001) {
          ffmpegArgs.push('-filter:a', `volume=${originalAudioVolume.toFixed(2)}`, '-c:a', 'aac');
        } else {
          ffmpegArgs.push('-c:a', 'copy');
        }
      } else {
        ffmpegArgs.push('-an');
      }
    }

    ffmpegArgs.push('-preset', 'medium', '-crf', '20', outputPath);

    try {
      await execFileAsync(ffmpegPath, ffmpegArgs, { timeout: 5 * 60_000 });
    } catch (err) {
      const stderr = String(err?.stderr || '').trim();
      throw new AppError(
        stderr ? `Video compose failed: ${stderr.slice(-500)}` : 'Video compose failed during ffmpeg export',
        500,
        'FFMPEG_ERROR'
      );
    }

    const outputStat = await fs.stat(outputPath).catch(() => null);
    if (!outputStat?.isFile()) {
      throw new AppError('ffmpeg failed to produce output', 500, 'FFMPEG_ERROR');
    }

    const historyEntry = videoHistory.add({
      taskId: `video-compose-${token}`,
      provider: 'composer',
      model: 'video-compose',
      prompt: textClips.map((clip) => clip.text).join(' | '),
      status: 'completed',
      videoUrl: null,
      localPath: outputPath,
      filename: outputFilename,
      duration: Math.round((timelineDuration / speed) * 100) / 100,
      aspectRatio: probe.width && probe.height ? `${probe.width}:${probe.height}` : null,
      resolution: probe.height >= 1080 ? '1080p' : probe.height >= 720 ? '720p' : null,
      generateAudio: !replaceOriginalAudio,
    });

    res.json({
      success: true,
      data: {
        historyId: historyEntry.id,
        localFilename: outputFilename,
        mimeType: 'video/mp4',
        sizeKB: Math.round(outputStat.size / 1024),
        preset: presetId,
        speed,
        trimStart,
        trimEnd,
        combinedDuration: timelineDuration,
        audioStart,
        audioEnd,
        audioOffset,
        textClipCount: textClips.length,
        replaceOriginalAudio,
        savedToGallery: true,
      },
    });
    completed = true;
  } catch (err) {
    next(err);
  } finally {
    await Promise.all(tmpFiles.map(async (filePath) => {
      try { await fs.unlink(filePath); } catch {}
    }));
    if (!completed && outputPath) {
      try { await fs.unlink(outputPath); } catch {}
    }
  }
});

module.exports = router;
