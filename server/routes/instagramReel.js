'use strict';

// Instagram reel ingest (Phase 1, Task 2).
// One endpoint — POST /api/instagram-reel/ingest — that accepts EITHER a multipart video
// file OR JSON { url }, drops the video into a per-run temp dir, and returns
// { runId, videoPath, source: 'upload' | 'url' }. A failed URL download returns an explicit
// HTTP 422 with a plain-string { error } body — never a silent empty run (this codebase has a
// documented history of silent-failure bugs, so the failure is loud on purpose).

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getTempDir } = require('../paths');
const { createMultipartParser } = require('../middleware/multipartParser');
const log = require('../utils/logger');
const apiKeyManager = require('../services/apiKeyManager');
const { detectShots, basesToShots } = require('../services/reelRecreate/detectShots');
const { analyzeShots, buildTextTrack } = require('../services/reelRecreate/analyzeShots');
const assembleReel = require('../services/reelRecreate/assembleReel');

const router = express.Router();
const execFileAsync = promisify(execFile);

// Cap uploads at 200MB — same limit reelCopy.js uses for its dropped-video branch.
const parseMultipartIfNeeded = createMultipartParser({ maxBytes: 200 * 1024 * 1024 });

// Cap how many BASES we send to Gemini vision in one /analyze. Each base = one recreated image =
// one billed vision call, and a long or busy reel can yield many bases, so an uncapped loop is an
// unbounded spend per request. 40 comfortably covers a normal reel (usually one base photo plus a
// black slide, sometimes a handful of bases) while putting a hard ceiling on cost; beyond it we
// signal truncation instead of billing. (detectShots also caps SAMPLED FRAMES at MAX_FRAMES=120;
// this is the separate per-base ceiling on billed analysis.)
const MAX_SHOTS = 40;

// The exact fallback message the UI shows when a URL can't be fetched. Kept as a constant
// (and exported) so the copy is verifiable and can't drift between the code and the tests.
const URL_DOWNLOAD_FAILED_MSG = "Couldn't download from that link — download the reel and drop the file instead.";

// H1 (path traversal). `runId` becomes a filesystem path component (path.join(tempDir,
// 'instagram-reel', runId)). /ingest is safe (server generates a UUID) but /analyze
// takes it from the client, so a value like "../../../../Users/asusg/Desktop/x" would escape the
// temp root — reading arbitrary source.* files back as base64, writing ffmpeg output into
// arbitrary dirs, or acting as a 404-vs-200 existence oracle. path.normalize alone is NOT enough
// (it happily produces a valid escaping path); we validate the exact shape crypto.randomUUID()
// produces (UUID v4, case-insensitive) and reject anything else before any path.join.
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidRunId(runId) {
  return typeof runId === 'string' && RUN_ID_RE.test(runId);
}

// M3 (SSRF). The raw user URL is handed straight to yt-dlp, so without a guard
// http://localhost/… or http://169.254.169.254/… (cloud metadata) would be reachable from the
// server. Reject any non-http(s) scheme, localhost, and loopback/private/link-local IP LITERALS.
// We deliberately do NOT resolve DNS (too costly here) — a hostname that isn't an IP and isn't
// localhost is allowed; the scheme check + private-IP-literal check are the pragmatic guard.
function _ipv4InBlockedRange(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false; // not a valid IPv4 — treat as a hostname, not a match
  const [a, b] = o;
  if (a === 127) return true;                       // 127.0.0.0/8 loopback
  if (a === 10) return true;                        // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local (incl. metadata)
  if (a === 0) return true;                         // 0.0.0.0/8 "this host"
  return false;
}
function isAllowedReelUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false; // unparseable → not allowed
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') return false;
  // URL wraps IPv6 hosts in brackets — strip them for the literal comparison.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost') return false;
  if (_ipv4InBlockedRange(host)) return false;
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10) literals.
  if (host === '::1') return false;
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return false; // fc00::/7 (fc.. and fd..)
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return false;  // fe80::/10
  return true;
}

// Mirror of instagramFrames.js findYtDlp() — that helper is module-PRIVATE there (the module
// only exports its router), so per the plan we reproduce its exact resolution logic rather than
// invent new paths: PATH-installed yt-dlp plus the common Windows pip/WinGet install locations.
function findYtDlp() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
    'yt-dlp',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* keep trying */ }
  }
  return 'yt-dlp';
}

// Download a reel to <runDir>/source.<ext> via yt-dlp. Returns the produced videoPath.
// Throws an Error tagged { code: 'URL_DOWNLOAD_FAILED' } on non-zero exit OR when no source.*
// file landed — the caller maps that to an explicit 422. execImpl/ytDlpResolver are injectable
// so the URL-failure path is verifiable via `node -e` with a stubbed execFile.
async function downloadReelFromUrl(url, runDir, { execImpl = execFileAsync, ytDlpResolver = findYtDlp } = {}) {
  const ytDlp = ytDlpResolver();
  // yt-dlp fills the real container extension in for %(ext)s.
  const outputTemplate = path.join(runDir, 'source.%(ext)s');
  try {
    // execFile → NO shell (no injection, Windows-safe). --no-playlist so a link that resolves
    // to a playlist still yields a single video. Sane timeout so a hung fetch can't wedge.
    await execImpl(ytDlp, ['-o', outputTemplate, '--no-playlist', url], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    log.warn('instagram_reel_ingest_ytdlp_failed', { error: String(err.stderr || err.message || '').slice(0, 200) });
    const e = new Error(URL_DOWNLOAD_FAILED_MSG);
    e.code = 'URL_DOWNLOAD_FAILED';
    throw e;
  }
  // Glob the run dir for source.* — yt-dlp chose the extension, so we don't assume .mp4.
  let produced = null;
  try {
    produced = fs.readdirSync(runDir).find((f) => /^source\.[^.]+$/i.test(f));
  } catch { /* produced stays null → treated as failure below */ }
  if (!produced) {
    const e = new Error(URL_DOWNLOAD_FAILED_MSG);
    e.code = 'URL_DOWNLOAD_FAILED';
    throw e;
  }
  return path.join(runDir, produced);
}

// POST /api/instagram-reel/ingest
// Multipart file OR JSON { url } → { runId, videoPath, source }. 422 on URL failure, 400 if
// neither input was provided. Response bodies use a plain { error } string (not the global
// errorHandler shape) because the client renders that message inline.
router.post('/ingest', parseMultipartIfNeeded, async (req, res) => {
  const runId = crypto.randomUUID();
  const runDir = path.join(getTempDir(), 'instagram-reel', runId);
  try {
    fs.mkdirSync(runDir, { recursive: true });

    const uploaded = req.file && req.file.buffer && req.file.buffer.length ? req.file : null;

    // ── FILE branch ───────────────────────────────────────────────────────────
    if (uploaded) {
      const videoPath = path.join(runDir, 'source.mp4');
      fs.writeFileSync(videoPath, uploaded.buffer);
      uploaded.buffer = null; // release the (up to 200MB) buffer promptly
      log.info('instagram_reel_ingest_upload', { runId, bytes: fs.statSync(videoPath).size });
      return res.json({ runId, videoPath, source: 'upload' });
    }

    // ── URL branch ────────────────────────────────────────────────────────────
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (url) {
      // M3 (SSRF): block localhost / loopback / private / link-local (metadata) hosts BEFORE the
      // URL ever reaches yt-dlp. Loud 400 — never a silent skip.
      if (!isAllowedReelUrl(url)) {
        return res.status(400).json({ error: 'That URL host is not allowed' });
      }
      try {
        const videoPath = await downloadReelFromUrl(url, runDir);
        log.info('instagram_reel_ingest_url', { runId });
        return res.json({ runId, videoPath, source: 'url' });
      } catch (err) {
        // Explicit 422 — never a silent empty run. Phase 1 does NOT do the Apify image
        // fallback: a failed VIDEO download tells the user to drop the file instead.
        return res.status(422).json({ error: URL_DOWNLOAD_FAILED_MSG });
      }
    }

    // ── Neither ───────────────────────────────────────────────────────────────
    return res.status(400).json({ error: 'Provide a video file or a URL' });
  } catch (err) {
    log.error('instagram_reel_ingest_error', { runId, error: err.message });
    return res.status(500).json({ error: 'Ingest failed' });
  }
});

// Resolve the source video a run ingested. Ingest wrote either source.mp4 (upload) or
// source.<ext> (yt-dlp URL), so glob for source.* rather than assume .mp4. Returns the absolute
// path or null when the run dir or file is missing.
function resolveRunVideoPath(runDir) {
  let produced = null;
  try {
    produced = fs.readdirSync(runDir).find((f) => /^source\.[^.]+$/i.test(f));
  } catch {
    return null; // run dir missing → caller returns 404
  }
  return produced ? path.join(runDir, produced) : null;
}

// POST /api/instagram-reel/analyze  body { runId }
// Runs shot detection (Task 3) then per-shot Gemini analysis (Task 4) and returns
// { shots: [{ index, startSec, durationSec, kind, analysis, recreatePrompt, onScreenText,
//   analysisFailed, keyframeDataUrl }] }. `kind` is 'image' or 'black' (a free text slide the
//   client never sends to Seedream). The keyframe is returned as a data: URL so the UI can
// render it WITHOUT us leaking an absolute disk path to the client.
router.post('/analyze', express.json(), async (req, res) => {
  // apiKey may be null and that is CORRECT under the Vertex backend: analyzeImageWithPrompt
  // ignores this arg and authenticates with the stored Vertex service-account credentials via
  // getClient(), which throws its own clear "No Vertex/GCP credentials saved" error if none are
  // configured. So we pass the key through exactly as scene.js does and never gate on it — an
  // earlier 400-on-null guard here would have broken analyze for every Vertex user (the app's
  // default), since getActiveKeyOrNull() is always null in that mode.
  const apiKey = apiKeyManager.getActiveKeyOrNull();

  const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
  if (!runId) return res.status(400).json({ error: 'runId is required' });
  // H1: validate the UUID-v4 shape BEFORE runId is used in any path.join — reject path-traversal.
  if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid runId' });

  const runDir = path.join(getTempDir(), 'instagram-reel', runId);
  if (!fs.existsSync(runDir)) {
    return res.status(404).json({ error: 'That run was not found — ingest the reel again.' });
  }
  const videoPath = resolveRunVideoPath(runDir);
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'The ingested video for that run is missing — ingest the reel again.' });
  }

  try {
    // detectShots now samples at 200ms and dedups into distinct BASE images (one photo we recreate
    // once, not one per sampled frame). Convert bases -> the per-shot shape analyzeShots/the client
    // consume (one shot per base; black base -> kind:'black', a free text slide). frameTruncated is
    // true when the reel exceeded MAX_FRAMES of samples (sampled to its first 120).
    const detect = await detectShots(videoPath, runDir);
    const allShots = basesToShots(detect.bases);
    // M2: cap billed Gemini vision calls. Analyze only the first MAX_SHOTS bases (in time order) and
    // tell the UI when we truncated so it can say "reel had N bases, showing first 40" — the extra
    // bases are never silently dropped. Truncation is EITHER the per-base cap here OR the frame cap.
    const totalShots = allShots.length;
    const baseTruncated = totalShots > MAX_SHOTS;
    const truncated = baseTruncated || !!detect.truncated;
    const shots = baseTruncated ? allShots.slice(0, MAX_SHOTS) : allShots;
    const analyzed = await analyzeShots(shots, apiKey);

    // TIMED OVERLAY TRACK: read the on-screen text at each 100ms sample (deduped on an overlay-crop
    // hash so Gemini is called only when the text region changes) and collapse it into contiguous
    // {startSec,endSec,text} segments over the REEL timeline. This is what lets assembly ANIMATE the
    // counter (17→18→19→20→21) instead of burning one frozen value. One whole-reel track (these
    // reels are ~1 base); the client attaches it to the assemble segments and assembly windows each
    // entry to its segment. Emoji are stripped here (a separate compositing task owns them).
    let textTrack = [];
    try {
      const built = await buildTextTrack(detect.frames, apiKey, { totalDuration: detect.totalDuration });
      textTrack = built.textTrack;
    } catch (err) {
      // A failed track must NOT fail the whole analyze — the user can still recreate + burn the
      // static per-shot overlayText fallback. Surface it in the log, return an empty track.
      log.warn('instagram_reel_texttrack_failed', { runId, error: err.message });
    }

    // Shape the client-facing payload: keyframe as a data URL (never the disk path).
    const clientShots = analyzed.map((s) => {
      let keyframeDataUrl = null;
      try {
        keyframeDataUrl = `data:image/jpeg;base64,${fs.readFileSync(s.keyframePath).toString('base64')}`;
      } catch (err) {
        // A missing keyframe is already logged by detectShots; surface it here without a disk path.
        log.warn('instagram_reel_analyze_keyframe_read_failed', { runId, index: s.index, error: err.message });
      }
      return {
        index: s.index,
        startSec: s.startSec,
        durationSec: s.durationSec,
        // 'image' (recreated + billed) or 'black' (a free text slide, never sent to Seedream). The
        // client keys cost, dispatch and rendering off this — a black shot must add $0.
        kind: s.kind === 'black' ? 'black' : 'image',
        analysis: s.analysis,
        recreatePrompt: s.recreatePrompt,
        onScreenText: s.analysis ? s.analysis.onScreenText : '',
        analysisFailed: !!s.analysisFailed,
        // analysisError is surfaced for a failed image analysis; a black slide may also carry one
        // (its optional text read failed) even though analysisFailed is false, so include it here too.
        ...(s.analysisError ? { analysisError: s.analysisError } : {}),
        keyframeDataUrl,
      };
    });

    log.info('instagram_reel_analyze', { runId, shots: clientShots.length, totalShots, truncated, textTrackSegments: textTrack.length, failed: clientShots.filter((s) => s.analysisFailed).length });
    // Always include truncated/totalShots so the UI can surface "reel had N shots, showing first 40".
    // textTrack is the whole-reel timed overlay track (may be [] if it failed/there was no overlay).
    return res.json({ shots: clientShots, truncated, totalShots, textTrack });
  } catch (err) {
    log.error('instagram_reel_analyze_error', { runId, error: err.message });
    return res.status(500).json({ error: 'Analysis failed' });
  }
});

// POST /api/instagram-reel/assemble  body { runId, segments: [...] }
// Pure-ffmpeg final stitch (Phase 2). Takes the client's ordered segments — each pointing at a
// recreated Grace base image (or a black slide) with its timing, B&W flag, and on-screen text — and
// the run's original audio, and produces the finished MP4. Returns { galleryId, filename } of the
// clip, saved into the Video Library so it downloads metadata-stripped through the existing
// /api/video/file/:filename/clean path. Assembly calls NO paid API — it must cost $0.
router.post('/assemble', express.json(), async (req, res) => {
  const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
  if (!runId) return res.status(400).json({ error: 'runId is required' });
  // H1: validate the UUID-v4 shape BEFORE runId is used in any path.join — reject path-traversal.
  if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid runId' });

  const segments = Array.isArray(req.body?.segments) ? req.body.segments : null;
  if (!segments || segments.length === 0) {
    return res.status(400).json({ error: 'segments must be a non-empty array' });
  }

  const runDir = path.join(getTempDir(), 'instagram-reel', runId);
  if (!fs.existsSync(runDir)) {
    return res.status(404).json({ error: 'That run was not found — ingest the reel again.' });
  }

  try {
    const { galleryId, filename } = await assembleReel({ runDir, segments });
    log.info('instagram_reel_assemble', { runId, galleryId, filename, segments: segments.length });
    return res.json({ galleryId, filename });
  } catch (err) {
    log.error('instagram_reel_assemble_error', { runId, error: err.message });
    return res.status(500).json({ error: 'Assembly failed' });
  }
});

module.exports = router;
// Exported for verification (extract-and-run) and future reuse by later tasks.
module.exports.downloadReelFromUrl = downloadReelFromUrl;
module.exports.resolveRunVideoPath = resolveRunVideoPath;
module.exports.findYtDlp = findYtDlp;
module.exports.URL_DOWNLOAD_FAILED_MSG = URL_DOWNLOAD_FAILED_MSG;
module.exports.isValidRunId = isValidRunId;
module.exports.isAllowedReelUrl = isAllowedReelUrl;
module.exports.MAX_SHOTS = MAX_SHOTS;
