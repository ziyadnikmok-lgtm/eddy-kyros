'use strict';

// 100ms frame sampling + perceptual dedup for the Instagram-reel recreate pipeline (Phase 1).
//
// WHY THIS REPLACED SCENE-CUT DETECTION: the reels we recreate are frequently ONE base photo
// whose on-screen OVERLAY (a ticking counter + rotating emojis) changes every ~100-200ms, often
// with a colour->black-and-white FILTER switch partway through and a solid black final frame.
// ffmpeg's scene-change detector collapses all of that into a single shot and misses the structure
// — we never learn there is one base photo animated by an overlay, nor where the overlay ticks.
//
// The correct model: sample every 100ms, then GROUP consecutive near-identical frames into distinct
// BASE images. We recreate each BASE exactly once (never bill per sampled frame). Black frames are
// flagged (free text slides, never recreated). Every 100ms sample is also returned (with its
// timeSec) so the analysis stage can build a TIMED overlay-text track and the assembly stage can
// ANIMATE that overlay at its real timestamps over the one recreated base — a static single-value
// burn was the bug this 100ms cadence fixes (a 200ms sample read one counter value and froze it).
//
// WHY 100ms (10fps) not 200ms: the counter in these reels ticks roughly every 100-200ms, so 200ms
// sampling aliases — it captures one value and misses the intermediate ticks, which is exactly what
// made the assembled reel burn a single frozen number. 100ms captures each tick. The base-dedup
// below keeps the NUMBER OF RECREATED IMAGES unchanged (still ~1 for a one-photo reel) regardless
// of how fast we sample — sampling rate drives the overlay track, not the recreate bill.
//
// DEDUP IS ON A GRAYSCALE dHASH — this is load-bearing. A colour->B&W filter of the SAME photo
// keeps the same LUMINANCE STRUCTURE, so its grayscale dHash is (near-)identical to the colour
// frame's. Hashing grayscale therefore groups colour and B&W of one photo into ONE base instead of
// two, so we recreate that photo once, not twice. A perceptual (structure) hash is also robust to
// the small localized overlay changes (counter digits, emojis) that a pixel diff would trip on.
//
// Windows-only project: ffmpeg is invoked via execFile with NO shell (args as an array), so filter
// strings are the raw filtergraph WITHOUT the shell quotes you'd type on a CLI. windowsHide keeps
// the console window from flashing. sharp (an existing dependency) does the hashing/luma — no new dep.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const ffmpegPath = require('../../utils/ffmpeg');
const log = require('../../utils/logger');

// Sampling rate. 10fps = one frame every 100ms — fast enough to capture every counter tick these
// reels animate (they change roughly every 100-200ms); 200ms aliased and froze the overlay.
const SAMPLE_FPS = 10;
const FRAME_INTERVAL_SEC = 1 / SAMPLE_FPS; // 0.1s

// Offset the FIRST sampled frame to t=0.1s (one interval in), not t=0. WHY: the very first video
// frame is often a fade-in / mid-transition render where the overlay hasn't drawn yet, so sampling
// at t=0 can capture a blank or half-drawn counter as the base. Starting at 0.1s lands on the first
// settled frame. We seek with `-ss 0.1` before `-i` (input seek) and label each sample with its
// REAL video time (FRAME_START_SEC + index*interval) so the overlay track's timestamps are honest.
const FRAME_START_SEC = 0.1;

// Abuse cap: at most 240 sampled frames (= 24s at 100ms). A longer reel is sampled to its first 240
// frames and the result is flagged `truncated:true` — never silently cut. Keeps hashing/analysis
// bounded regardless of input length. (Doubled from 120 when the cadence halved to 100ms so the
// same 24s ceiling holds.)
const MAX_FRAMES = 240;

// dHash side length. 8 -> a 9x8 grayscale downscale compared column-to-column = 8*8 = 64 bits.
const HASH_SIZE = 8;

// Two frames belong to the SAME base while their grayscale dHash Hamming distance stays <= this.
// 10/64 bits (~16%) absorbs an overlay tick (a couple of changed digits/emojis nudge only a few of
// the 64 structural bits) while a genuinely different photo — a real cut — moves far more bits and
// starts a new base. Tuned for the overlay-on-one-photo case these reels are; a real multi-scene
// reel still splits because each scene's structure hashes far apart.
const BASE_HASH_THRESHOLD = 10;

// A base made of fewer than this many sampled frames is a TRANSIENT (e.g. a one-frame crossfade
// blend between two photos) and is merged into a neighbouring base rather than billed as its own
// image — UNLESS it is black. A black frame, even a single final one, is always its own free base
// (it carries overlay text to re-render and must never be folded into a photo we'd recreate).
const MIN_BASE_FRAMES = 2;

// Mean-luminance ceiling (0-255) under which a frame is BLACK: a text slide, not a photographable
// scene. Viral reels cut to a black background carrying only on-screen text/emoji; there is nothing
// to recreate, so a black base is never sent to Seedream (no model, no bill) — Phase 2 re-renders
// its overlay text onto a black slide. 16 ~= 6% of full white: high enough to catch a true black
// frame that JPEG nudges a few levels off pure 0, low enough that a merely dim/night photo (real
// content to recreate) stays non-black. Matches the previous pipeline's black threshold.
const BLACK_LUMA_THRESHOLD = 16;

// Generous stderr buffer for ffmpeg's banner/progress output.
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Run ffmpeg and ALWAYS resolve with its output — even on a non-zero exit. Some invocations we need
 * (e.g. `-i` with no output file) exit non-zero BY DESIGN but still print the data we want to
 * stderr, so the caller inspects `error`/`stderr` rather than us throwing.
 */
function runFfmpeg(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      args,
      { maxBuffer: MAX_BUFFER, windowsHide: true, ...opts },
      (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

// Parse `Duration: HH:MM:SS.ss` out of ffmpeg's `-i` banner. Returns seconds, or NaN if absent.
function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr || ''));
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * PURE. Hamming distance between two dHashes represented as equal-length bit arrays (0/1 numbers).
 * A length mismatch counts every extra bit as differing (defensive — real hashes are always 64 bit).
 */
function hamming(a, b) {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  const n = Math.min(aa.length, bb.length);
  let d = 0;
  for (let i = 0; i < n; i++) if (aa[i] !== bb[i]) d++;
  return d + Math.abs(aa.length - bb.length);
}

/**
 * Compute a GRAYSCALE dHash + mean luma for one image on disk, using sharp (no ffmpeg re-decode).
 *
 * dHash: grayscale-downscale to (HASH_SIZE+1) x HASH_SIZE, then for each row emit 1 when a pixel is
 * brighter than the pixel to its right. This encodes horizontal luminance GRADIENTS (structure),
 * which is why a colour frame and its B&W-filtered twin — same luminance structure — hash the same.
 * Mean luma: the grayscale channel mean of the full frame (0-255), used for the black test.
 *
 * @param {string} imgPath
 * @returns {Promise<{hash:number[], luma:number}>}
 */
async function computeFrameHash(imgPath) {
  // 9x8 grayscale raw bytes: row-major, one byte per pixel. fit:'fill' forces the exact grid so the
  // column comparison below is well-defined regardless of the source aspect ratio.
  const raw = await sharp(imgPath)
    .grayscale()
    .resize(HASH_SIZE + 1, HASH_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer();
  const hash = [];
  const rowStride = HASH_SIZE + 1;
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      const left = raw[y * rowStride + x];
      const right = raw[y * rowStride + x + 1];
      hash.push(left > right ? 1 : 0);
    }
  }
  // Full-frame grayscale mean for an accurate black test (a tiny 9x8 mean would be noisy).
  const stats = await sharp(imgPath).grayscale().stats();
  const luma = stats.channels && stats.channels[0] ? stats.channels[0].mean : NaN;
  return { hash, luma };
}

/**
 * PURE. Group an ordered list of sampled frames into distinct BASE images by perceptual dedup.
 *
 * Each input frame: { index, timeSec, keyframePath, luma, black, hash }. We walk them in time order:
 * a frame joins the current base while its black-state MATCHES the base AND its Hamming distance to
 * the base's representative hash is <= hashThreshold; a bigger jump OR a black/non-black flip starts
 * a new base. We compare against the base's FIRST frame (its representative) rather than the previous
 * frame so slow overlay drift can't creep the base off the original photo one small step at a time.
 *
 * Then a merge pass folds any TRANSIENT non-black base (< minBaseFrames frames — e.g. a one-frame
 * crossfade) into an adjacent non-black base, so we don't bill a recreate for a blend frame. Black
 * bases are never merged (a single black final frame stays its own free slide).
 *
 * @param {Array} frames  ordered sampled frames (see above)
 * @param {{hashThreshold?:number, minBaseFrames?:number, frameInterval?:number, totalDuration?:number}} [opts]
 * @returns {{frames: Array, bases: Array}}
 *   frames: input frames each tagged with its final `baseId`.
 *   bases:  [{ baseId, representativeFrameIndex, keyframePath, startSec, endSec, black }].
 */
function groupFramesIntoBases(frames, opts = {}) {
  const hashThreshold = Number.isFinite(opts.hashThreshold) ? opts.hashThreshold : BASE_HASH_THRESHOLD;
  const minBaseFrames = Number.isFinite(opts.minBaseFrames) ? opts.minBaseFrames : MIN_BASE_FRAMES;
  const frameInterval = Number.isFinite(opts.frameInterval) ? opts.frameInterval : FRAME_INTERVAL_SEC;
  const totalDuration = Number.isFinite(opts.totalDuration) ? opts.totalDuration : null;

  const list = Array.isArray(frames) ? frames : [];

  // ── Pass 1: greedy grouping vs each base's representative (first) frame. ──
  const groups = [];
  let cur = null;
  for (const f of list) {
    if (!cur) {
      cur = { frames: [f], black: !!f.black, repHash: f.hash };
      groups.push(cur);
      continue;
    }
    const sameBlack = !!f.black === cur.black;
    // A black/non-black flip ALWAYS starts a new base (Infinity distance), even if the raw hashes
    // happen to be close — black state is a hard boundary the money path keys off.
    const dist = sameBlack ? hamming(f.hash, cur.repHash) : Infinity;
    if (sameBlack && dist <= hashThreshold) {
      cur.frames.push(f);
    } else {
      cur = { frames: [f], black: !!f.black, repHash: f.hash };
      groups.push(cur);
    }
  }

  // ── Pass 2: fold transient non-black groups into an adjacent non-black neighbour. ──
  const merged = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const transient = !g.black && g.frames.length < minBaseFrames;
    if (transient) {
      const prev = merged.length ? merged[merged.length - 1] : null;
      if (prev && !prev.black) {
        // Fold backward into the previous (non-black) base. Keep prev's representative hash.
        prev.frames.push(...g.frames);
        continue;
      }
      const next = i + 1 < groups.length ? groups[i + 1] : null;
      if (next && !next.black) {
        // No usable previous base — fold forward: prepend to the next (non-black) base so its
        // representative recomputes over the combined frames on the next iteration.
        next.frames.unshift(...g.frames);
        next.repHash = next.frames[0].hash;
        continue;
      }
      // Surrounded by black bases (rare): keep the transient as its own base rather than merge a
      // photo into a black slide — losing a real base is worse than an extra tiny one.
    }
    merged.push(g);
  }

  // ── Emit final frames (tagged with baseId) + the bases list. ──
  const outFrames = [];
  const bases = [];
  merged.forEach((g, baseId) => {
    const fr = g.frames;
    // Representative = the most CENTRAL frame of the base: away from the fade-in/out edges, it is the
    // steadiest render of the base photo (and deterministic — no extra decode to measure sharpness).
    const rep = fr[Math.floor(fr.length / 2)];
    // The FIRST base starts at reel time 0, not at the first sample's 0.1s: sampling is offset one
    // interval in (see FRAME_START_SEC), but the base is on screen from the very start, so its
    // segment must cover [0 … ] or the assembled reel loses its opening 0.1s. Later bases start at
    // their first sample's real time.
    const startSec = baseId === 0 ? 0 : fr[0].timeSec;
    let endSec = fr[fr.length - 1].timeSec + frameInterval; // span covers the last sample's 100ms
    if (totalDuration != null) endSec = Math.min(endSec, totalDuration);
    bases.push({
      baseId,
      representativeFrameIndex: rep.index,
      keyframePath: rep.keyframePath,
      startSec,
      endSec,
      black: g.black,
    });
    for (const f of fr) outFrames.push({ ...f, baseId });
  });
  outFrames.sort((a, b) => a.index - b.index);

  return { frames: outFrames, bases };
}

/**
 * PURE. Convert the per-base list into the legacy per-SHOT shape the analysis step + route consume
 * (one shot per base). `kind` is derived from `black`: a black base is a free text slide ('black');
 * everything else is a recreatable image ('image'). Keeps `analyzeShots`/`instagramReel.js` working
 * against the new bases without either needing to know the frame/base internals.
 *
 * @param {Array} bases  from detectShots().bases
 * @returns {Array<{index:number,startSec:number,durationSec:number,keyframePath:string,kind:'image'|'black',baseId:number,representativeFrameIndex:number}>}
 */
function basesToShots(bases) {
  return (Array.isArray(bases) ? bases : []).map((b, i) => ({
    index: i,
    startSec: b.startSec,
    durationSec: Math.max(0, (Number(b.endSec) || 0) - (Number(b.startSec) || 0)),
    keyframePath: b.keyframePath,
    kind: b.black ? 'black' : 'image',
    baseId: b.baseId,
    representativeFrameIndex: b.representativeFrameIndex,
  }));
}

/**
 * Sample the video every 200ms, dedup the samples into distinct base images, flag black frames, and
 * rip the audio track once. Everything is written under the run's own temp dir — never a user folder.
 *
 * @param {string} videoPath source video on disk
 * @param {string} runDir    the run's own temp dir (frames + audio written here)
 * @returns {Promise<{
 *   fps:number,
 *   totalDuration:number,
 *   audioPath:string|null,
 *   frames: Array<{index:number,timeSec:number,keyframePath:string,luma:number,black:boolean,baseId:number}>,
 *   bases:  Array<{baseId:number,representativeFrameIndex:number,keyframePath:string,startSec:number,endSec:number,black:boolean}>,
 *   truncated:boolean
 * }>}
 */
async function detectShots(videoPath, runDir) {
  if (!fs.existsSync(videoPath)) throw new Error(`detectShots: video not found: ${videoPath}`);
  fs.mkdirSync(runDir, { recursive: true });

  // (1) Total duration — from ffmpeg's `-i` banner (exits non-zero, so read stderr off `error`).
  const probe = await runFfmpeg(['-i', videoPath]);
  const totalDuration = parseDuration(probe.stderr);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    // Loud failure: without a duration we can't bound the final base. Surface, don't guess.
    throw new Error(`detectShots: could not read duration for ${videoPath}`);
  }

  // (2) Sample at 10fps to frame_%03d.jpg, starting at t=FRAME_START_SEC. `-ss` BEFORE `-i` is an
  // input seek (fast, resets output PTS to 0 at the seek point — we don't rely on those PTS; we
  // compute each frame's real time as FRAME_START_SEC + index*interval below). `-frames:v MAX_FRAMES`
  // hard-caps the OUTPUT frame count (post-fps-filter) so a long reel can't explode into thousands
  // of JPEGs. NO shell quotes on -vf (execFile, no shell).
  const framePattern = path.join(runDir, 'frame_%03d.jpg');
  const sample = await runFfmpeg([
    '-ss', String(FRAME_START_SEC),
    '-i', videoPath,
    '-vf', `fps=${SAMPLE_FPS}`,
    '-frames:v', String(MAX_FRAMES),
    '-q:v', '2',
    '-y', framePattern,
  ]);

  // Collect the produced frames in numeric order (frame_001, frame_002, …).
  let frameFiles = [];
  try {
    frameFiles = fs.readdirSync(runDir)
      .filter((f) => /^frame_\d+\.jpg$/i.test(f))
      .sort(); // zero-padded names sort correctly lexicographically
  } catch { /* frameFiles stays [] → loud failure below */ }
  if (!frameFiles.length) {
    // No frames means ffmpeg could not decode the video — a real problem, not a silent empty run.
    throw new Error(`detectShots: no frames sampled from ${videoPath}${sample.error ? ` (${sample.error.message})` : ''}`);
  }

  // Truncated when the reel is longer than MAX_FRAMES worth of samples (we only kept the first 240).
  // Samples start at FRAME_START_SEC, so the count available is over (totalDuration - FRAME_START_SEC).
  const expectedFrames = Math.ceil(Math.max(0, totalDuration - FRAME_START_SEC) * SAMPLE_FPS);
  const truncated = expectedFrames > MAX_FRAMES;
  if (truncated) {
    log.info('reel_frames_truncated', { videoPath, totalDuration, expectedFrames, kept: frameFiles.length, MAX_FRAMES });
  }

  // (3) Hash + luma every sampled frame. index is 0-based; timeSec = FRAME_START_SEC + index * 100ms
  // (the frame's REAL position in the source video, so the overlay-text track's timings are honest).
  const sampledFrames = [];
  for (let i = 0; i < frameFiles.length; i++) {
    const keyframePath = path.join(runDir, frameFiles[i]);
    let hash = [];
    let luma = NaN;
    try {
      const r = await computeFrameHash(keyframePath);
      hash = r.hash;
      luma = r.luma;
    } catch (err) {
      // Do NOT swallow: a frame we can't hash would silently mis-group. Log it and treat the frame
      // as an all-zero hash / unknown luma — it can still be sampled/animated, just grouped weakly.
      log.warn('reel_frame_hash_failed', { index: i, keyframePath, error: err && err.message ? err.message : String(err) });
      hash = new Array(HASH_SIZE * HASH_SIZE).fill(0);
    }
    const black = Number.isFinite(luma) && luma < BLACK_LUMA_THRESHOLD;
    sampledFrames.push({
      index: i,
      timeSec: Number((FRAME_START_SEC + i * FRAME_INTERVAL_SEC).toFixed(3)),
      keyframePath,
      luma: Number.isFinite(luma) ? luma : 0,
      black,
      hash,
    });
  }

  // (4) Dedup into bases.
  const grouped = groupFramesIntoBases(sampledFrames, { totalDuration });
  // Strip the internal `hash` from the returned frames — callers need index/time/luma/black/baseId,
  // not the 64-bit array. (Kept in-function only for grouping.)
  const frames = grouped.frames.map(({ hash, ...rest }) => rest);
  const bases = grouped.bases;
  log.info('reel_detect_bases', {
    videoPath, totalDuration, sampledFrames: frames.length,
    bases: bases.map((b) => ({ baseId: b.baseId, startSec: b.startSec, endSec: b.endSec, black: b.black })),
    truncated,
  });

  // (5) Audio, ripped once. Stream-copy first (fast, lossless); fall back to AAC re-encode for
  // containers m4a can't hold. If BOTH fail the source has no usable audio — return null with a
  // logged note rather than throwing (a silent reel is still recreatable).
  const audioPath = path.join(runDir, 'audio.m4a');
  const copyTry = await runFfmpeg(['-i', videoPath, '-vn', '-c:a', 'copy', '-y', audioPath]);
  let audioOut = null;
  if (!copyTry.error && fs.existsSync(audioPath)) {
    audioOut = audioPath;
  } else {
    const aacTry = await runFfmpeg(['-i', videoPath, '-vn', '-c:a', 'aac', '-y', audioPath]);
    if (!aacTry.error && fs.existsSync(audioPath)) {
      audioOut = audioPath;
    } else {
      log.warn('reel_audio_extract_failed', {
        videoPath,
        copyError: copyTry.error ? copyTry.error.message : null,
        aacError: aacTry.error ? aacTry.error.message : null,
        note: 'source appears to have no usable audio track — continuing without audio',
      });
    }
  }

  return { fps: SAMPLE_FPS, totalDuration, audioPath: audioOut, frames, bases, truncated };
}

module.exports = {
  detectShots,
  // Pure helpers exported for verification (extract-and-run) and route reuse.
  groupFramesIntoBases,
  basesToShots,
  hamming,
  computeFrameHash,
  parseDuration,
  SAMPLE_FPS,
  FRAME_INTERVAL_SEC,
  FRAME_START_SEC,
  MAX_FRAMES,
  BASE_HASH_THRESHOLD,
  MIN_BASE_FRAMES,
  BLACK_LUMA_THRESHOLD,
  HASH_SIZE,
};
