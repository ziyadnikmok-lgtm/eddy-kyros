const express = require('express');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const ffmpegPath = require('../utils/ffmpeg');
const { AppError } = require('../middleware/errorHandler');
const { createMultipartParser } = require('../middleware/multipartParser');
const { TEMP_DIR, UPLOADS_DIR } = require('../paths');
const videoHistory = require('../services/videoHistoryStore');
const { _hasAudio } = require('../services/videoFaststart');
const { startGenerationRun, finishGenerationRun } = require('../services/eventLogger');

const router = express.Router();
const execFileAsync = promisify(execFile);
const parseMultipart = createMultipartParser({ maxBytes: 500 * 1024 * 1024 });
const VIDEO_DIR = path.join(UPLOADS_DIR, 'videos');

// This is the export engine for the in-app video editor (the "Edit" button on a gallery clip).
// It is deliberately a SEPARATE route from /video-compose: that one drives the Instagram reel
// pipeline and is intricate, so rather than risk it we burn the editor's overlays here, in a
// self-contained single-source pipeline. Overlays arrive as PNGs the CLIENT already rendered and
// rotated on a canvas, so ffmpeg only has to scale-and-place them — no fonts, no rotation, no emoji
// rendering server-side. Everything is a lossy re-encode once (libx264), which is unavoidable when
// pixels are being composited in.

const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

// Build the single-input video filter chain (everything EXCEPT the overlays, which need
// filter_complex because they are extra inputs). Order matches the editor's slider panel.
function buildBaseChain({ brightness, contrast, saturation, blur, sharpness, warmth, vignette, zoom, panX, panY }) {
  const chain = [];

  // Zoom + pan: scale up by `zoom`, then crop the WxH window, shifting it by the pan fractions.
  if (Math.abs(zoom - 1) > 0.0001 || Math.abs(panX) > 0.0001 || Math.abs(panY) > 0.0001) {
    chain.push(`scale=iw*${zoom.toFixed(4)}:ih*${zoom.toFixed(4)}`);
    // Pan −1..1 maps across the full overscan; clamped to the available slack so it never shows edge.
    const px = `(in_w-out_w)/2*(1+${panX.toFixed(4)})`;
    const py = `(in_h-out_h)/2*(1+${panY.toFixed(4)})`;
    chain.push(`crop=w=iw/${zoom.toFixed(4)}:h=ih/${zoom.toFixed(4)}:x='${px}':y='${py}'`);
  }

  // eq: brightness/contrast/saturation in one pass.
  if (Math.abs(brightness) > 0.0001 || Math.abs(contrast - 1) > 0.0001 || Math.abs(saturation - 1) > 0.0001) {
    chain.push(`eq=brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}`);
  }
  if (blur > 0.0001) chain.push(`gblur=sigma=${blur.toFixed(3)}`);
  if (sharpness > 0.0001) chain.push(`unsharp=5:5:${sharpness.toFixed(3)}:5:5:0`);
  // Warmth: push red up / blue down (warm) or the reverse (cool) via colorbalance midtones.
  if (Math.abs(warmth) > 0.0001) chain.push(`colorbalance=rm=${warmth.toFixed(3)}:bm=${(-warmth).toFixed(3)}`);
  if (vignette > 0.0001) {
    // Stronger slider = tighter (smaller) unvignetted circle. PI/5 (mild) → PI/2.2 (heavy).
    const angle = (Math.PI / 5) + (Math.PI / 2.2 - Math.PI / 5) * vignette;
    chain.push(`vignette=angle=${angle.toFixed(4)}`);
  }
  // Even dims keep libx264 happy after odd-scaled zoom crops.
  chain.push('scale=trunc(iw/2)*2:trunc(ih/2)*2', 'format=yuv420p');
  return chain.join(',');
}

/**
 * POST /api/video-edit
 * Multipart. Fields:
 *   sourceFilename : basename of a clip already in the video gallery (preferred), OR
 *   source         : an uploaded video file
 *   overlays       : JSON [{ x,y,w,h, start,end }]  (fractions 0..1 of the frame; seconds)
 *   overlay_<i>    : the PNG for overlay i (client-rendered, already rotated)
 *   music          : optional replacement/added audio file
 *   trimStart, trimEnd, speed, brightness, contrast, saturation, blur, sharpness, warmth,
 *   vignette, zoom, panX, panY, originalAudioVolume, musicVolume, replaceOriginalAudio
 * Returns { historyId, localFilename } — the edited clip, saved into the gallery.
 */
router.post('/', parseMultipart, async (req, res, next) => {
  const token = crypto.randomUUID().slice(0, 8);
  const tmpFiles = [];
  let outputPath = null;
  let runId = null;
  let completed = false;

  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await fs.mkdir(VIDEO_DIR, { recursive: true });

    // ── resolve the source video ────────────────────────────────────────────
    let sourcePath;
    if (req.body?.sourceFilename) {
      // Gallery clip: basename only, must resolve INSIDE VIDEO_DIR (no path traversal).
      const base = path.basename(String(req.body.sourceFilename));
      const candidate = path.join(VIDEO_DIR, base);
      if (!candidate.startsWith(VIDEO_DIR) || !fsSync.existsSync(candidate)) {
        throw new AppError('Source video not found in the gallery', 404, 'NOT_FOUND');
      }
      sourcePath = candidate;
    } else if (req.files?.source) {
      sourcePath = path.join(TEMP_DIR, `ve_src_${token}.mp4`);
      tmpFiles.push(sourcePath);
      await fs.writeFile(sourcePath, req.files.source.buffer);
    } else {
      throw new AppError('A source video is required', 400, 'VALIDATION_ERROR');
    }

    // ── params ──────────────────────────────────────────────────────────────
    const trimStart = clamp(req.body?.trimStart, 0, 60 * 60, 0);
    const trimEnd = clamp(req.body?.trimEnd, trimStart + 0.1, 60 * 60, trimStart + 3600);
    const duration = Math.max(0.1, trimEnd - trimStart);
    const speed = clamp(req.body?.speed, 0.5, 2, 1);

    const base = {
      brightness: clamp(req.body?.brightness, -0.4, 0.4, 0),
      contrast: clamp(req.body?.contrast, 0.5, 1.8, 1),
      saturation: clamp(req.body?.saturation, 0, 2, 1),
      blur: clamp(req.body?.blur, 0, 4, 0),
      sharpness: clamp(req.body?.sharpness, 0, 2, 0),
      warmth: clamp(req.body?.warmth, -0.3, 0.3, 0),
      vignette: clamp(req.body?.vignette, 0, 1, 0),
      zoom: clamp(req.body?.zoom, 1, 2.5, 1),
      panX: clamp(req.body?.panX, -1, 1, 0),
      panY: clamp(req.body?.panY, -1, 1, 0),
    };

    const originalAudioVolume = clamp(req.body?.originalAudioVolume, 0, 2, 1);
    const musicVolume = clamp(req.body?.musicVolume, 0, 2, 1);
    const replaceOriginalAudio = String(req.body?.replaceOriginalAudio || '').toLowerCase() === 'true';

    let overlays = [];
    try { overlays = req.body?.overlays ? JSON.parse(req.body.overlays) : []; } catch { overlays = []; }
    if (!Array.isArray(overlays)) overlays = [];

    // Write each overlay PNG to temp, pairing it with its metadata by index.
    const overlayInputs = [];
    for (let i = 0; i < overlays.length; i += 1) {
      const meta = overlays[i] || {};
      const fileEntry = req.files?.[`overlay_${i}`];
      if (!fileEntry?.buffer?.length) continue;    // no image for this slot → skip it
      const pngPath = path.join(TEMP_DIR, `ve_ov_${token}_${i}.png`);
      tmpFiles.push(pngPath);
      await fs.writeFile(pngPath, fileEntry.buffer);
      overlayInputs.push({
        path: pngPath,
        // Each PNG is a FULL FRAME with the sticker already drawn at its exact spot, so the server
        // needs no position — only WHEN to show it. Default to the whole (trimmed, pre-speed) clip.
        start: clamp(meta.start, 0, duration, 0),
        end: clamp(meta.end, 0, duration, duration),
      });
    }

    // ── inputs ────────────────────────────────────────────────────────────────
    // Trim is applied as an input option so it decodes only the needed slice.
    const args = ['-y', '-ss', trimStart.toFixed(3), '-t', duration.toFixed(3), '-i', sourcePath];
    const overlayInputStart = 1;
    for (const ov of overlayInputs) args.push('-i', ov.path);

    let musicInputIndex = null;
    if (req.files?.music?.buffer?.length) {
      const musicPath = path.join(TEMP_DIR, `ve_music_${token}`);
      tmpFiles.push(musicPath);
      await fs.writeFile(musicPath, req.files.music.buffer);
      musicInputIndex = overlayInputStart + overlayInputs.length;
      args.push('-i', musicPath);
    }

    // ── video graph ────────────────────────────────────────────────────────────
    const parts = [];
    parts.push(`[0:v]${buildBaseChain(base)}[base]`);

    // Each overlay PNG is a full frame with the sticker already in place. scale2ref forces it to the
    // base frame's exact size (handles any 1px rounding from the base chain), then it is composited
    // at 0:0 — no positioning here, so the export matches the preview pixel-for-pixel. Visible only
    // between its start/end (pre-speed time).
    let cur = 'base';
    overlayInputs.forEach((ov, i) => {
      const inIdx = overlayInputStart + i;
      const scaled = `ovs${i}`;
      const ref = `ref${i}`;
      const out = (i === overlayInputs.length - 1) ? 'vovl' : `t${i}`;
      parts.push(`[${inIdx}:v][${cur}]scale2ref=w=main_w:h=main_h[${scaled}][${ref}]`);
      parts.push(`[${ref}][${scaled}]overlay=0:0:enable='between(t,${ov.start.toFixed(3)},${ov.end.toFixed(3)})'[${out}]`);
      cur = out;
    });
    const afterOverlays = overlayInputs.length ? 'vovl' : 'base';

    // Speed LAST, so overlay enable-times stay in real (pre-speed) seconds — intuitive in the editor.
    if (Math.abs(speed - 1) > 0.0001) {
      parts.push(`[${afterOverlays}]setpts=${(1 / speed).toFixed(6)}*PTS[vout]`);
    } else {
      parts.push(`[${afterOverlays}]null[vout]`);
    }

    // ── audio graph ────────────────────────────────────────────────────────────
    // Probe-free: build the original-audio chain only if we intend to use it; if the source has no
    // audio track the [0:a] reference would fail, so fall back to silence when muted or replaced.
    const atempo = Math.abs(speed - 1) > 0.0001 ? `atempo=${speed.toFixed(4)},` : '';
    let audioLabel = null;
    // Only reference [0:a] if the source actually HAS an audio track — mapping a missing stream is a
    // hard ffmpeg failure. _hasAudio is a cheap byte-scan (no ffprobe, which ffmpeg-static lacks).
    const srcHasAudio = _hasAudio(sourcePath);
    const wantOriginal = originalAudioVolume > 0.0001 && !replaceOriginalAudio && srcHasAudio;

    if (wantOriginal) {
      parts.push(`[0:a]${atempo}volume=${originalAudioVolume.toFixed(2)}[a0]`);
      audioLabel = 'a0';
    }
    if (musicInputIndex !== null) {
      parts.push(`[${musicInputIndex}:a]${atempo}volume=${musicVolume.toFixed(2)},atrim=duration=${(duration / speed).toFixed(3)},asetpts=PTS-STARTPTS[am]`);
      if (audioLabel) {
        parts.push(`[${audioLabel}][am]amix=inputs=2:duration=first:dropout_transition=2[aout]`);
        audioLabel = 'aout';
      } else {
        audioLabel = 'am';
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFilename = `video-edit-${stamp}-${token}.mp4`;
    outputPath = path.join(VIDEO_DIR, outputFilename);

    args.push('-filter_complex', parts.join(';'), '-map', '[vout]');
    if (audioLabel) args.push('-map', `[${audioLabel}]`, '-c:a', 'aac');
    else args.push('-an');
    // CRF 18 + slow: visually (near-)lossless re-encode. The re-encode is unavoidable once pixels
    // are composited in, so keep the quality high enough that it does not read as a downgrade.
    args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath);

    // Start the telemetry run BEFORE the encode so a failure during/after ffmpeg is actually
    // recorded — assigning runId only on the success path made the catch's finishGenerationRun
    // dead code.
    runId = startGenerationRun({ userId: req.session?.userId, feature: 'video-edit', provider: 'editor', model: 'video-edit' });

    try {
      await execFileAsync(ffmpegPath, args, { timeout: 5 * 60_000, maxBuffer: 1024 * 1024 * 16 });
    } catch (err) {
      const stderr = String(err?.stderr || '').trim();
      throw new AppError(stderr ? `Edit export failed: ${stderr.slice(-500)}` : 'Edit export failed during ffmpeg', 500, 'FFMPEG_ERROR');
    }

    const stat = await fs.stat(outputPath).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) throw new AppError('ffmpeg produced no output', 500, 'FFMPEG_ERROR');

    // The encode succeeded and the file is real — from here the output must SURVIVE. Marking complete
    // now means a later throw (history/logger/response) can't send the finally-block into deleting a
    // finished clip; at worst it leaves an orphan file with no tile, which is harmless.
    completed = true;

    const historyEntry = videoHistory.add({
      taskId: `video-edit-${token}`,
      provider: 'editor',
      model: 'video-edit',
      prompt: `Edited clip · ${overlayInputs.length} overlay${overlayInputs.length === 1 ? '' : 's'}`,
      status: 'completed',
      videoUrl: null,
      localPath: outputPath,
      filename: outputFilename,
      duration: Math.round((duration / speed) * 100) / 100,
      generateAudio: Boolean(audioLabel),
    });

    finishGenerationRun(runId, { status: 'succeeded', outputCount: 1, provider: 'editor', model: 'video-edit' });

    res.json({
      success: true,
      data: {
        historyId: historyEntry.id,
        localFilename: outputFilename,
        mimeType: 'video/mp4',
        sizeKB: Math.round(stat.size / 1024),
        overlayCount: overlayInputs.length,
        savedToGallery: true,
      },
    });
  } catch (err) {
    if (runId) finishGenerationRun(runId, { status: 'failed', outputCount: 0, errorCode: err.code || err.name || 'UNKNOWN', errorMessage: err.message, provider: 'editor' });
    next(err);
  } finally {
    await Promise.all(tmpFiles.map((f) => fs.unlink(f).catch(() => {})));
    if (!completed && outputPath) { try { await fs.unlink(outputPath); } catch {} }
  }
});

module.exports = router;
