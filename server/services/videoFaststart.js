const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const ffmpegPath = require('../utils/ffmpeg');
const log = require('../utils/logger');

const execFileAsync = promisify(execFile);

// Why this module exists: Seedance/Muapi return MP4s with the `moov` atom written AFTER the
// media (`mdat`) — i.e. NOT "faststart". A browser <video preload="metadata"> can't decode a
// frame until it has the moov box, so with moov at the tail it must download the WHOLE file
// before showing anything and the preview renders BLACK. The fix is a lossless container re-mux
// (`-c copy -movflags +faststart`) that moves moov to the front — no re-encode, so quality,
// duration and audio are byte-for-byte identical, it's just instant and streamable.

// The re-mux is a pure container copy of at most a few-second clip; a couple minutes is a
// generous ceiling that still guarantees a hung ffmpeg can't wedge startup or a download.
const FASTSTART_TIMEOUT_MS = 2 * 60 * 1000;

// Read only the head of the file: an MP4 top-level atom layout is enough to tell whether `moov`
// comes before `mdat`. These are the two big boxes; whichever byte-offset is smaller wins.
// 256 KiB comfortably covers the leading boxes (ftyp/free/moov header) without slurping a whole
// video into memory just to answer a yes/no question.
const HEAD_SCAN_BYTES = 256 * 1024;

// Does this MP4 carry a sound track?
//
// WHY WE STRIP AUDIO AT ALL: the video model generates its OWN soundtrack — clips kept coming back
// with music over them even after the prompt was stripped of every audio cue AND given an explicit
// "NO AUDIO, completely silent" instruction. The prompt cannot be relied on, so the audio track is
// removed from the FILE, which is not negotiable with the model.
//
// Detection is a byte scan for the 'soun' media-handler type that every audio trak carries in its
// hdlr box. Whole-file scan (not just the head) because with moov at the tail — which is exactly the
// un-faststart case — the handler boxes live at the END. A false POSITIVE only costs one extra
// lossless remux; a false negative would leave music on the clip, so err toward scanning it all.
function _hasAudio(filePath) {
  try {
    return fs.readFileSync(filePath).includes('soun');
  } catch (err) {
    log.warn('audio_scan_failed', { file: path.basename(filePath), error: err.message });
    return false;   // unreadable — the remux below is skipped rather than risking a bad rewrite
  }
}

// Returns true when `moov` appears before `mdat` in the file head (already faststart / streamable).
// Cheap: reads at most HEAD_SCAN_BYTES. Any read error is treated as "unknown / not confirmed
// faststart" so the caller falls through to the (safe, non-destructive) re-mux attempt.
function _isFaststart(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(HEAD_SCAN_BYTES, size);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, 0);
    const moov = buf.indexOf('moov');
    const mdat = buf.indexOf('mdat');
    // moov found and either mdat not yet seen in the head, or moov precedes it => faststart.
    if (moov !== -1 && (mdat === -1 || moov < mdat)) return true;
    return false;
  } catch (err) {
    log.warn('faststart_head_scan_failed', { file: path.basename(filePath), error: err.message });
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// Ensure `filePath` is a faststart MP4. Returns true if it re-muxed the file, false if it was
// already faststart (or a no-op). NEVER leaves a broken/empty video: it writes to a tmp file and
// only atomically renames over the original after verifying the tmp exists, is non-empty AND is
// itself faststart. On ANY failure the tmp is deleted and the original is left byte-for-byte
// untouched — a non-faststart video still plays/downloads, so degrading gracefully beats risking
// data loss.
async function ensureFaststart(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  // Two independent reasons to rewrite: not streamable, or it still has the model's generated
  // soundtrack on it. Both are fixed by the SAME lossless container pass, so they share one remux.
  const needsFaststart = !_isFaststart(filePath);
  const needsMute = _hasAudio(filePath);
  if (!needsFaststart && !needsMute) return false; // already streamable and silent — no work

  // Sibling tmp so the final rename is a same-volume (atomic) move, not a cross-device copy.
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.faststart-${process.pid}-${Date.now()}-${path.basename(filePath)}`);

  try {
    // -c copy: container-only remux, no decode/encode => lossless + fast. +faststart: relocate moov.
    // -an: DROP the audio track entirely (the model's generated soundtrack). Video is still a pure
    // stream copy, so the picture is byte-for-byte identical — only the sound track is gone.
    // windowsHide + no shell: Windows, and no user-controlled string ever reaches a shell.
    await execFileAsync(
      ffmpegPath,
      ['-y', '-i', filePath, '-c', 'copy', '-an', '-movflags', '+faststart', tmpPath],
      { windowsHide: true, timeout: FASTSTART_TIMEOUT_MS },
    );

    // Guard against a "successful" ffmpeg that produced nothing useful before trusting the output.
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      throw new Error('remux produced missing or empty output');
    }
    if (!_isFaststart(tmpPath)) {
      throw new Error('remux output is still not faststart');
    }
    if (_hasAudio(tmpPath)) {
      throw new Error('remux output still has an audio track');
    }

    // Atomic replace on the same volume — readers see either the old or the new file, never a
    // half-written one.
    fs.renameSync(tmpPath, filePath);
    log.info('video_remuxed', { file: path.basename(filePath), faststart: needsFaststart, muted: needsMute });
    return true;
  } catch (err) {
    // Leave the ORIGINAL untouched; only clean up our tmp.
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

module.exports = { ensureFaststart, _isFaststart, _hasAudio };
