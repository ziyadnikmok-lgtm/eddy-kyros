/**
 * Restore audio to videos whose local copy was muted.
 *
 * WHY THIS EXISTS: audio-stripping was briefly applied to EVERY downloaded video (the model kept
 * inventing music on pose clips). That was too broad — a scripted scene's sound is the point — and
 * `-an` is destructive: the track is gone from the file and cannot be recovered from it.
 *
 * It CAN be recovered from the provider: video-history keeps each clip's original CDN URL, and
 * Muapi still serves them. So for every local file that has no audio, re-download the original and
 * put it back if the original actually had a track.
 *
 * SAFE BY CONSTRUCTION:
 *   - only touches files that currently have NO audio (a clip with sound is never re-fetched)
 *   - only replaces when the re-downloaded original genuinely HAS audio
 *   - writes to a temp file and swaps atomically; any failure leaves the local file untouched
 *   - re-muxes to faststart so previews stay instant
 *
 *   node tools/restore-video-audio.js          # report only
 *   node tools/restore-video-audio.js --apply  # actually restore
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const ffmpegPath = require('../server/utils/ffmpeg');
const { _hasAudio, _isFaststart } = require('../server/services/videoFaststart');

const APPLY = process.argv.includes('--apply');
const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
const ROOT = path.join(APPDATA, 'ai-content-studio');
const HISTORY = path.join(ROOT, 'data', 'video-history.json');
const VIDEO_DIR = path.join(ROOT, 'uploads', 'generated', 'videos');

function loadHistory() {
  const raw = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
  return Array.isArray(raw) ? raw : (raw.items || raw.videos || []);
}

(async () => {
  const items = loadHistory().filter((x) => x.status === 'completed' && x.videoUrl && x.filename);
  const muted = [];
  for (const it of items) {
    const fp = path.join(VIDEO_DIR, it.filename);
    if (!fs.existsSync(fp)) continue;
    if (!_hasAudio(fp)) muted.push({ it, fp });
  }

  console.log(`completed clips with a provider URL : ${items.length}`);
  console.log(`local copies currently SILENT       : ${muted.length}`);
  if (!muted.length) { console.log('\nNothing to restore.'); return; }
  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to restore audio from the provider originals.');
    return;
  }

  let restored = 0; let noAudioAtSource = 0; let failed = 0;
  for (const { it, fp } of muted) {
    // Both temps keep a .mp4 extension: ffmpeg picks the muxer from the output filename, and a
    // bare '.tmp' makes it fail with "Unable to choose an output format".
    const tmp = `${fp}.restore.mp4`;
    const dl = `${fp}.dl.mp4`;
    try {
      const resp = await fetch(it.videoUrl);
      if (!resp.ok) { failed++; continue; }
      fs.writeFileSync(dl, Buffer.from(await resp.arrayBuffer()));

      // The original may legitimately have no audio (older clips, or ones the model made silent).
      // Nothing to restore there — leave the local file exactly as it is.
      if (!_hasAudio(dl)) { noAudioAtSource++; fs.unlinkSync(dl); continue; }

      // Keep BOTH tracks, and faststart so the preview stays instant. Pure container copy.
      await execFileAsync(
        ffmpegPath,
        ['-y', '-i', dl, '-c', 'copy', '-movflags', '+faststart', tmp],
        { windowsHide: true, timeout: 2 * 60 * 1000 },
      );
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error('empty remux');
      if (!_hasAudio(tmp)) throw new Error('remux lost the audio');
      if (!_isFaststart(tmp)) throw new Error('remux is not faststart');

      fs.renameSync(tmp, fp);          // atomic swap, same volume
      restored++;
      console.log(`  restored  ${it.filename}`);
    } catch (err) {
      failed++;
      console.log(`  FAILED    ${it.filename} — ${err.message}`);
    } finally {
      for (const f of [tmp, dl]) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best effort */ } }
    }
  }

  console.log(`\nrestored              : ${restored}`);
  console.log(`original had no audio : ${noAudioAtSource}`);
  console.log(`failed                : ${failed}`);
})();
