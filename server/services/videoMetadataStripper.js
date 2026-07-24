'use strict';
/**
 * Strip tooling fingerprints out of an MP4 before it leaves the app.
 *
 * `-map_metadata -1` on its own is NOT enough. Scanning a file cleaned that way turned up three
 * identifiers that all survive it:
 *
 *   1. The x264 SEI block lives INSIDE the H.264 bitstream, so `-c:v copy` carries it through
 *      untouched. It names the encoder build and every setting used — including `threads=40`,
 *      which describes a datacentre CPU and nothing a phone would ever report.
 *      `filter_units=remove_types=6` drops SEI NAL units and removes it.
 *
 *   2. `Lavc<version>` is written into the AAC payload itself rather than the container, so no
 *      metadata flag can reach it. Only re-encoding the audio clears it — 128k AAC, which is
 *      imperceptible and costs about a second.
 *
 *   3. ffmpeg stamps its own `Lavf<version>` and writes VideoHandler/SoundHandler. `-bitexact`
 *      suppresses the version. The handler names are set to what an iPhone writes rather than
 *      blanked, because empty handlers are themselves unusual.
 *
 * The video stream is copied, never re-encoded, so picture quality is untouched.
 */
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const ffmpegPath = require('../utils/ffmpeg');
const log = require('../utils/logger');

const TIMEOUT_MS = 180_000;   // a long clip on a busy machine; the audio re-encode dominates

function buildArgs(input, output) {
  return [
    '-y',
    '-i', input,
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    // Removes SEI NAL units — where the x264 settings string hides.
    '-bsf:v', 'filter_units=remove_types=6',
    '-c:v', 'copy',
    // Audio MUST be re-encoded: Lavc sits in the AAC payload, out of reach of any flag.
    '-c:a', 'aac', '-b:a', '128k',
    // Stops ffmpeg writing its own version into the container.
    '-fflags', '+bitexact',
    '-flags:v', '+bitexact',
    '-flags:a', '+bitexact',
    '-metadata:s:v', 'handler_name=Core Media Video',
    '-metadata:s:a', 'handler_name=Core Media Audio',
    '-movflags', '+faststart',
    output,
  ];
}

/**
 * Clean one file on disk.
 *
 * @returns {Promise<{filePath: string, cleanup: () => void}>} a temp file plus its remover.
 *   Throws if ffmpeg fails — the caller decides whether to serve the original instead, since
 *   silently handing back an uncleaned file would be worse than an error.
 */
async function stripFile(inputPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyros-strip-'));
  const output = path.join(dir, `clean${path.extname(inputPath) || '.mp4'}`);
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } };

  try {
    await execFileAsync(ffmpegPath, buildArgs(inputPath, output), { timeout: TIMEOUT_MS });
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
      throw new Error('ffmpeg produced no output');
    }
    return { filePath: output, cleanup };
  } catch (err) {
    cleanup();
    log.error('video_strip_failed', { error: err.message?.slice(0, 300) });
    throw err;
  }
}

module.exports = { stripFile, buildArgs };
