'use strict';

// Reel ASSEMBLY (Phase 2) — the final, PURE-ffmpeg stitch that turns the user's recreated Grace
// base image(s) plus the original reel's timing/audio into the finished MP4. NO AI, NO paid API is
// ever called here: assembly is deterministic ffmpeg and MUST cost $0. (Seedream/Gemini recreate
// the base images upstream; by the time we get here the images already exist in the gallery.)
//
// The model this mirrors, per the reel-recreate design: the source reel is usually ONE base photo
// held for a while, its on-screen overlay text changing, sometimes flipping to black-and-white
// partway, sometimes cutting to a solid black text slide. detectShots already told the client which
// segment is black and (via the analysis) what text/where the B&W was; the client sends that back
// as `segments`. We hold each recreated base for its segment, desaturate the ones that were B&W in
// the original, burn the on-screen text, and lay it all over the ORIGINAL audio.
//
// Windows-only project: every ffmpeg run is execFile with NO shell (args as an array, windowsHide),
// so filtergraph strings are raw — no shell quoting. All temp files live under the run's own temp
// dir; we never write into a user content folder. Output is persisted the SAME way runVideo.js
// persists a produced clip (videoHistory + VIDEO_DIR) — that, not the image galleryManager, is what
// makes a clip appear in the Video Library and be downloadable metadata-stripped via
// GET /api/video/file/:filename/clean. galleryManager is used to READ the recreated base images.

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const ffmpegPath = require('../../utils/ffmpeg');
const log = require('../../utils/logger');
const galleryManager = require('../galleryManager');
const videoHistory = require('../videoHistoryStore');
const { UPLOADS_DIR } = require('../../paths');

const execFileAsync = promisify(execFile);

// Resolve the videos dir EXACTLY as server/routes/video.js does (module-load destructure of
// UPLOADS_DIR + '/videos'), so a file we write here is found by that router's /file/:filename and
// /file/:filename/clean routes. If these two ever diverged, the clip would save but 404 on download.
const VIDEO_DIR = path.join(UPLOADS_DIR, 'videos');

// Portrait canvas for reels — 720x1280 is 9:16, matching the detectShots/reels pipeline. Every
// segment is scaled+padded (image) or generated (black) at exactly this size so concat never trips
// on a resolution mismatch.
const CANVAS_W = 720;
const CANVAS_H = 1280;
const FPS = 30;

// Generous stderr buffer for ffmpeg's banner/progress; matches detectShots' sizing.
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * PURE. Strip color-emoji (and their joiners/modifiers) from text destined for drawtext.
 *
 * WHY: libharfbuzz/drawtext in ffmpeg renders only the GLYPHS in the chosen .ttf. A standard UI
 * font has no color-emoji glyphs, so an emoji burns as a "tofu" box (□) — a visible defect that
 * silently ships. Color-emoji fonts (Segoe UI Emoji / Apple Color Emoji) are CBDT/COLR and drawtext
 * can't rasterize them either. So rather than render boxes, we REMOVE emoji from the burned string
 * and log that we did. (Real emoji overlays are a later enhancement — a compositing pass, not
 * drawtext.) We keep letters, digits, punctuation, and normal whitespace untouched.
 *
 * @param {string} text
 * @returns {{text:string, dropped:number}} sanitized text + count of emoji-ish codepoints removed
 */
function sanitizeOverlayText(text) {
  const src = typeof text === 'string' ? text : '';
  // Extended_Pictographic covers the emoji pictographs; add ZWJ, variation selectors, regional
  // indicators, and skin-tone modifiers so a compound emoji (e.g. 👩‍🚀 or 👍🏽) is removed whole,
  // not left as orphaned joiner bytes.
  const emojiRe = /[\p{Extended_Pictographic}‍️\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu;
  let dropped = 0;
  const stripped = src.replace(emojiRe, () => { dropped++; return ''; });
  // Collapse whitespace the removed emoji left behind ("hi 🔥 there" -> "hi there", not "hi  there").
  const cleaned = stripped.replace(/\s{2,}/g, ' ').trim();
  return { text: cleaned, dropped };
}

/**
 * Find a usable bold system font for drawtext, cross-platform. Windows first (this is a
 * Windows-only project) with arialbd as the primary bold face; then common Linux/macOS paths so a
 * CI/dev box still burns text. Returns an absolute path or null (caller logs + skips the overlay
 * rather than failing the whole assembly — a missing font must not lose the video).
 */
function resolveFontFile() {
  const candidates = process.platform === 'win32'
    ? [
        'C:/Windows/Fonts/arialbd.ttf',
        'C:/Windows/Fonts/Arialbd.ttf',
        'C:/Windows/Fonts/arial.ttf',
        'C:/Windows/Fonts/segoeui.ttf',
        'C:/Windows/Fonts/tahomabd.ttf',
      ]
    : [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
        '/Library/Fonts/Arial.ttf',
      ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep trying */ }
  }
  return null;
}

/**
 * PURE. Build the drawtext filter for a burned overlay.
 *
 * WHY text= (not textfile=): our ffmpeg (6.1.x essentials) rejects `textfile` with "Both text and
 * text file provided" — that build initializes `text` to "" so any textfile trips the both-set
 * guard. So we inline the (already emoji-sanitized) text as a single-quoted `text=` value and escape
 * it for the filtergraph parser: backslashes doubled, and each literal apostrophe closed-and-reopened
 * ('\'') so it can't terminate the quoted token. The single quotes then protect `:`, `,`, `;`, `[`,
 * `]` in the text from being read as filtergraph separators. expansion=none stops drawtext from
 * interpreting %{...}/\n in the user text as ffmpeg expressions (injection + stray-% safety). The
 * font path is single-quoted too, so a drive colon / spaces need no manual escaping.
 *
 * White fill + a dark stroke (borderw) for contrast on any background, positioned lower-third.
 *
 * When `enableExpr` is given (a clip-LOCAL between(t,…) expression) the drawtext is time-gated so it
 * only shows during that window — this is how the ANIMATED overlay track renders (one drawtext per
 * track segment, each enabled for its own timestamp range). The single quotes around the expression
 * protect its commas from being read as filtergraph separators. Omit it for the static single-value
 * fallback (drawtext always on).
 *
 * @param {string} fontFile   absolute font path (already verified to exist)
 * @param {string} text       the burned text (already sanitized/emoji-stripped, non-empty)
 * @param {string} [enableExpr]  e.g. "between(t,0.100,1.400)" — clip-local seconds; optional
 */
function buildDrawText(fontFile, text, enableExpr) {
  const font = String(fontFile).replace(/\\/g, '/'); // forward slashes; single-quoted below
  const esc = String(text).replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
  const opts = [
    `drawtext=fontfile='${font}'`,
    `text='${esc}'`,
    'expansion=none',
    'fontcolor=white',
    'fontsize=52',
    'borderw=4',
    'bordercolor=black@0.85',
    'x=(w-text_w)/2',
    // Lower third: sit the baseline ~120px above the bottom edge of the 1280-tall canvas.
    'y=h-text_h-120',
  ];
  // Single-quote the expression so its commas survive the filtergraph parser.
  if (enableExpr) opts.push(`enable='${enableExpr}'`);
  return opts.join(':');
}

/**
 * PURE. Assemble the -vf filtergraph for ONE segment.
 *  - image: scale to fit inside the canvas keeping aspect, then pad the rest black -> consistent
 *    720x1280 regardless of the recreated image's shape.
 *  - bw: hue=s=0 fully desaturates -> grayscale. Applied ONLY to image segments; a black slide is
 *    already achromatic so desaturating it is a pointless no-op (and we skip it for clarity).
 *  - drawtext appended last so text sits on top of the (possibly B&W) image.
 * A black segment with no overlay yields '' (no -vf needed; the color source is already sized).
 *
 * @param {{black?:boolean,bw?:boolean}} seg
 * @param {string[]} [drawTexts]  zero or more drawtext filter strings (the animated track = many,
 *                                the static fallback = one). Appended in order, so later track
 *                                entries draw over earlier ones (only one is enabled at a time).
 * @returns {string} filtergraph or '' when no filter is required
 */
function buildSegmentFilters(seg, drawTexts = []) {
  const filters = [];
  if (!seg.black) {
    // force_original_aspect_ratio=decrease + pad = letterbox/pillarbox to the exact canvas.
    filters.push(`scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease`);
    filters.push(`pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=black`);
    if (seg.bw) filters.push('hue=s=0'); // grayscale — mirror the original's B&W filter on this base
  }
  // Accept a single string for back-compat with the static path, or an array for the timed track.
  const texts = Array.isArray(drawTexts) ? drawTexts : (drawTexts ? [drawTexts] : []);
  for (const dt of texts) if (dt) filters.push(dt);
  return filters.join(',');
}

/**
 * PURE. Turn a reel-timeline overlay-text track into clip-LOCAL drawtext filters for ONE segment.
 *
 * The track's start/end are REEL-absolute; each concatenated clip restarts t at 0, so we subtract
 * the segment's own startSec to get clip-local times and clamp to [0, dur]. Entries that don't
 * overlap this segment's window are dropped. Text is emoji-stripped here too (the track should
 * already be clean, but assembly is the last line of defense against a tofu box shipping), and the
 * strip count is reported so it can be logged. Only non-empty text within the window produces a
 * drawtext, each gated by enable='between(t,localStart,localEnd)'.
 *
 * @param {Array<{startSec:number,endSec:number,text:string}>} textTrack
 * @param {string} fontFile
 * @param {number} segStartSec  segment start on the reel timeline
 * @param {number} dur          segment duration (clip length)
 * @returns {{drawTexts:string[], dropped:number}}
 */
function buildTrackDrawTexts(textTrack, fontFile, segStartSec, dur) {
  const out = [];
  let dropped = 0;
  for (const entry of Array.isArray(textTrack) ? textTrack : []) {
    const localStart = Math.max(0, Number(entry.startSec) - segStartSec);
    const localEnd = Math.min(dur, Number(entry.endSec) - segStartSec);
    if (!(localEnd > localStart)) continue; // entry outside this segment's window
    const { text, dropped: d } = sanitizeOverlayText(entry.text);
    dropped += d;
    if (!text) continue; // emoji-only / empty entry — nothing to burn
    const enableExpr = `between(t,${localStart.toFixed(3)},${localEnd.toFixed(3)})`;
    out.push(buildDrawText(fontFile, text, enableExpr));
  }
  return { drawTexts: out, dropped };
}

// Run ffmpeg, no shell, windowsHide, rooted at the run dir so relative textfile/concat names
// resolve there. Rejects (loudly) on non-zero exit — assembly never swallows an ffmpeg failure.
async function runFfmpeg(args, cwd) {
  try {
    await execFileAsync(ffmpegPath, args, { cwd, windowsHide: true, maxBuffer: MAX_BUFFER });
  } catch (err) {
    const detail = String(err.stderr || err.message || '').slice(0, 600);
    const e = new Error(`ffmpeg failed: ${detail}`);
    e.code = 'FFMPEG_FAILED';
    throw e;
  }
}

/**
 * Assemble the finished reel MP4 from ordered segments and persist it to the Video Library.
 *
 * @param {object} args
 * @param {string} args.runDir  the run's own temp dir (caller already UUID-validated runId + built this)
 * @param {Array<{galleryId:?string,startSec:number,durationSec:number,black:boolean,bw:boolean,overlayText:string,textTrack?:Array<{startSec:number,endSec:number,text:string}>}>} args.segments
 *   Each segment optionally carries a `textTrack` (reel-timeline {startSec,endSec,text} entries). When
 *   present + non-empty it ANIMATES the overlay (timed drawtext per entry); otherwise the static
 *   `overlayText` is burned for the whole segment (back-compat fallback).
 * @returns {Promise<{galleryId:string, filename:string}>} the saved clip (galleryId = videoHistory entry id)
 */
async function assembleReel({ runDir, segments }) {
  if (!runDir || typeof runDir !== 'string') throw new Error('assembleReel: runDir is required');
  if (!fs.existsSync(runDir)) throw new Error(`assembleReel: run dir not found: ${runDir}`);
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('assembleReel: at least one segment is required');
  }

  const fontFile = resolveFontFile();
  if (!fontFile) {
    // Loud, not silent: overlays will be skipped for the whole run. The video still assembles.
    log.warn('reel_assemble_no_font', { note: 'no system font found; on-screen text will NOT be burned' });
  }

  // (1) Original audio, ripped by detectShots. Missing => assemble silent (a reel with no audio is
  // still a valid deliverable; we log it rather than fail).
  const audioPath = path.join(runDir, 'audio.m4a');
  const hasAudio = fs.existsSync(audioPath);
  if (!hasAudio) log.info('reel_assemble_no_audio', { runDir, note: 'audio.m4a absent — assembling silent' });

  // (2) Build one clip per segment. Track total duration so the final mux can trim/pad audio to it.
  const clipNames = [];
  let totalDuration = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] || {};
    const dur = Number(seg.durationSec);
    if (!Number.isFinite(dur) || dur <= 0) {
      throw new Error(`assembleReel: segment ${i} has invalid durationSec (${seg.durationSec})`);
    }
    const durStr = dur.toFixed(3);
    totalDuration += dur;

    // A segment is a black slide when explicitly flagged OR when it carries no recreated image.
    const isBlack = !!seg.black || seg.galleryId == null;

    // Build the overlay drawtext filter(s). Emoji are stripped and the drop is logged so boxes never
    // ship silently. TWO modes:
    //  - ANIMATED (preferred): seg.textTrack is a non-empty array → one timed drawtext per entry,
    //    each gated to its own timestamp window so the burned text CHANGES over the segment (the
    //    counter ticking). This is the fix for the frozen-single-value bug.
    //  - STATIC (fallback): no textTrack → burn the single seg.overlayText for the whole segment,
    //    exactly as before. Keeps older callers and black slides working unchanged.
    let drawTexts = [];
    const hasTrack = Array.isArray(seg.textTrack) && seg.textTrack.length > 0;
    if (fontFile && hasTrack) {
      const { drawTexts: tdt, dropped } = buildTrackDrawTexts(seg.textTrack, fontFile, Number(seg.startSec) || 0, dur);
      if (dropped > 0) {
        log.info('reel_assemble_emoji_stripped', { segment: i, dropped, mode: 'track', note: 'color emoji removed from timed overlay track (drawtext cannot render them)' });
      }
      drawTexts = tdt;
    } else if (fontFile && typeof seg.overlayText === 'string' && seg.overlayText.length) {
      const { text, dropped } = sanitizeOverlayText(seg.overlayText);
      if (dropped > 0) {
        log.info('reel_assemble_emoji_stripped', { segment: i, dropped, mode: 'static', note: 'color emoji removed from burned text (drawtext cannot render them)' });
      }
      // Inline the sanitized text (escaped) rather than a textfile — see buildDrawText for why.
      if (text) drawTexts = [buildDrawText(fontFile, text)];
    }

    const clipName = `clip_${i}.mp4`;
    const filterStr = buildSegmentFilters({ black: isBlack, bw: !!seg.bw }, drawTexts);

    let args;
    if (isBlack) {
      // Solid black source at the canvas size — nothing to recreate for a text slide.
      args = ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${CANVAS_W}x${CANVAS_H}:r=${FPS}:d=${durStr}`];
      if (filterStr) args.push('-vf', filterStr);
    } else {
      // Read the recreated base image straight off disk via galleryManager (same source runVideo.js
      // uses for a galleryId). getFilePath throws a clear 404 if the id is unknown — surfaced below.
      let filePath;
      try {
        ({ filePath } = galleryManager.getFilePath(seg.galleryId));
      } catch (err) {
        throw new Error(`assembleReel: segment ${i} image (galleryId=${seg.galleryId}) not found: ${err.message}`);
      }
      // -loop 1 -t holds the still for the segment length; -vf sizes/pads/desaturates/overlays it.
      args = ['-y', '-loop', '1', '-t', durStr, '-i', filePath, '-vf', filterStr];
    }
    // Common video-encode tail. -t (output) guarantees the exact segment length in both branches.
    args.push('-r', String(FPS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', durStr, clipName);

    await runFfmpeg(args, runDir);
    clipNames.push(clipName);
  }

  totalDuration = Number(totalDuration.toFixed(3));

  // (3) Concat via the demuxer with an intermediate list file in the run dir. All clips share codec,
  // pixel format, size, and fps, so the join is clean. Filenames are safe literals (clip_N.mp4).
  const listPath = path.join(runDir, 'concat.txt');
  fs.writeFileSync(listPath, clipNames.map((n) => `file '${n}'`).join('\n') + '\n', 'utf8');

  // (4) Mux to the final MP4. Original audio is trimmed/padded to the video's exact length: apad
  // pads short audio with silence, -t caps long audio — either way audio == video length, no
  // -shortest surprise cutting the picture. faststart moves the moov atom up for web playback.
  const outName = 'reel_out.mp4';
  const outPath = path.join(runDir, outName);
  const muxArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt'];
  if (hasAudio) {
    muxArgs.push(
      '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-af', 'apad',
      '-t', String(totalDuration),
      '-movflags', '+faststart',
      outName
    );
  } else {
    muxArgs.push(
      '-map', '0:v:0', '-an',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-t', String(totalDuration),
      '-movflags', '+faststart',
      outName
    );
  }
  await runFfmpeg(muxArgs, runDir);

  if (!fs.existsSync(outPath)) {
    // Loud: ffmpeg exited 0 but produced nothing — never return a phantom success.
    throw new Error('assembleReel: ffmpeg reported success but reel_out.mp4 is missing');
  }

  // (5) Persist EXACTLY like runVideo.js persists a produced clip: copy into VIDEO_DIR and register
  // a videoHistory entry (status 'completed', localPath + filename set). That is what surfaces it in
  // the Video Library and makes it downloadable metadata-stripped via GET /api/video/file/:name/clean
  // (the image galleryManager has no video path). galleryId returned = the videoHistory entry id.
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  const filename = `reel-${require('node:crypto').randomUUID()}.mp4`;
  const destPath = path.join(VIDEO_DIR, filename);
  fs.copyFileSync(outPath, destPath);

  const entry = videoHistory.add({
    provider: 'assembly',            // not a paid provider — this clip cost $0 to produce
    model: 'ffmpeg-reel-assembly',
    prompt: 'Instagram reel recreation (assembled from recreated bases + original audio)',
    status: 'completed',
    localPath: destPath,
    filename,
    duration: totalDuration,
    aspectRatio: '9:16',
    resolution: `${CANVAS_W}x${CANVAS_H}`,
  });

  log.info('reel_assemble_done', { galleryId: entry.id, filename, segments: segments.length, totalDuration, hasAudio });
  return { galleryId: entry.id, filename };
}

module.exports = assembleReel;
// Exported for verification (extract-and-run) and reuse.
module.exports.assembleReel = assembleReel;
module.exports.sanitizeOverlayText = sanitizeOverlayText;
module.exports.resolveFontFile = resolveFontFile;
module.exports.buildSegmentFilters = buildSegmentFilters;
module.exports.buildDrawText = buildDrawText;
module.exports.buildTrackDrawTexts = buildTrackDrawTexts;
module.exports.VIDEO_DIR = VIDEO_DIR;
module.exports.CANVAS_W = CANVAS_W;
module.exports.CANVAS_H = CANVAS_H;
