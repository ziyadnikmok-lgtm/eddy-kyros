'use strict';
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');
const ffmpegPath = require('../utils/ffmpeg');

const router = express.Router();
const execFileAsync = promisify(execFile);

const INSTAGRAM_URL_RE = /https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv|stories)\/[A-Za-z0-9_\-]+/i;
const TIKTOK_URL_RE = /https?:\/\/(www\.|vm\.|m\.|vt\.)?tiktok\.com\/([A-Za-z0-9_@\-\.\/]+)/i;
const X_URL_RE = /https?:\/\/(www\.)?(twitter|x)\.com\/[A-Za-z0-9_]+\/status\/\d+/i;
const MAX_FRAMES = 60;
const MAX_INTERVAL_MS = 5000;
const MIN_INTERVAL_MS = 50;

const IG_COOKIES_PATH = path.join(os.homedir(), '.kyros-ig-cookies.txt');
const TT_COOKIES_PATH = path.join(os.homedir(), '.kyros-tt-cookies.txt');
const X_COOKIES_PATH = path.join(os.homedir(), '.kyros-x-cookies.txt');

function detectPlatform(url) {
  if (url && INSTAGRAM_URL_RE.test(url)) return 'instagram';
  if (url && TIKTOK_URL_RE.test(url)) return 'tiktok';
  if (url && X_URL_RE.test(url)) return 'x';
  return null;
}

function getTempDir() {
  const dir = path.join(os.tmpdir(), 'kyros-ig-frames');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// Find yt-dlp on PATH or common install locations
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
    } catch {}
  }
  return 'yt-dlp';
}

function findGalleryDl() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'Scripts', 'gallery-dl.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts', 'gallery-dl.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'gallery-dl.exe'),
    'gallery-dl',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return 'gallery-dl';
}

// GET /api/instagram-frames/cookies-status
// Returns whether cookies.txt are saved and their basic info
router.get('/cookies-status', (req, res) => {
  const igExists = fs.existsSync(IG_COOKIES_PATH);
  const ttExists = fs.existsSync(TT_COOKIES_PATH);
  const xExists = fs.existsSync(X_COOKIES_PATH);
  
  let igInfo = { hasCookies: false };
  let ttInfo = { hasCookies: false };
  let xInfo = { hasCookies: false };

  if (igExists) {
    try {
      const stat = fs.statSync(IG_COOKIES_PATH);
      const content = fs.readFileSync(IG_COOKIES_PATH, 'utf8');
      const hasInstagram = content.includes('instagram.com');
      igInfo = {
        hasCookies: true,
        hasInstagram,
        savedAt: stat.mtimeMs,
        sizeBytes: stat.size,
      };
    } catch {}
  }

  if (ttExists) {
    try {
      const stat = fs.statSync(TT_COOKIES_PATH);
      const content = fs.readFileSync(TT_COOKIES_PATH, 'utf8');
      const hasTikTok = content.includes('tiktok.com');
      ttInfo = {
        hasCookies: true,
        hasTikTok,
        savedAt: stat.mtimeMs,
        sizeBytes: stat.size,
      };
    } catch {}
  }

  if (xExists) {
    try {
      const stat = fs.statSync(X_COOKIES_PATH);
      const content = fs.readFileSync(X_COOKIES_PATH, 'utf8');
      const hasX = content.includes('x.com') || content.includes('twitter.com');
      xInfo = {
        hasCookies: true,
        hasX,
        savedAt: stat.mtimeMs,
        sizeBytes: stat.size,
      };
    } catch {}
  }

  res.json({
    success: true,
    data: {
      instagram: igInfo,
      tiktok: ttInfo,
      x: xInfo,
      // Backward compatibility fields for frontend:
      hasCookies: igExists,
      hasInstagram: igExists && igInfo.hasInstagram,
      savedAt: igExists ? igInfo.savedAt : null,
      sizeBytes: igExists ? igInfo.sizeBytes : null,
    },
  });
});

// POST /api/instagram-frames/save-cookies
// Body: { cookies: "<netscape cookies.txt content>", platform?: "instagram" | "tiktok" | "x" }
router.post('/save-cookies', (req, res, next) => {
  try {
    const { cookies, platform } = req.body;
    if (!cookies || typeof cookies !== 'string' || cookies.trim().length < 20) {
      throw new AppError('Invalid cookies content', 400, 'VALIDATION_ERROR');
    }
    const trimmed = cookies.trim();
    // Validate it looks like a Netscape cookies file
    if (!trimmed.startsWith('# Netscape HTTP Cookie File') && !trimmed.includes('\tTRUE\t') && !trimmed.includes('\tFALSE\t')) {
      throw new AppError('This doesn\'t look like a Netscape cookies.txt file. Use the "Get cookies.txt LOCALLY" browser extension.', 400, 'VALIDATION_ERROR');
    }

    let targetPath = IG_COOKIES_PATH;
    let selectedPlatform = 'instagram';

    if (platform === 'tiktok' || (platform !== 'instagram' && platform !== 'x' && trimmed.includes('tiktok.com'))) {
      targetPath = TT_COOKIES_PATH;
      selectedPlatform = 'tiktok';
    } else if (platform === 'x' || (platform !== 'instagram' && platform !== 'tiktok' && (trimmed.includes('x.com') || trimmed.includes('twitter.com')))) {
      targetPath = X_COOKIES_PATH;
      selectedPlatform = 'x';
    }

    fs.writeFileSync(targetPath, trimmed, 'utf8');
    log.info('cookies_saved', { platform: selectedPlatform, size: trimmed.length });
    res.json({ success: true, data: { saved: true, platform: selectedPlatform } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/instagram-frames/cookies
// Query/Body: { platform?: "instagram" | "tiktok" | "x" }
router.delete('/cookies', (req, res) => {
  try {
    const platform = req.query.platform || req.body.platform;
    if (platform === 'tiktok') {
      if (fs.existsSync(TT_COOKIES_PATH)) fs.unlinkSync(TT_COOKIES_PATH);
    } else if (platform === 'instagram') {
      if (fs.existsSync(IG_COOKIES_PATH)) fs.unlinkSync(IG_COOKIES_PATH);
    } else if (platform === 'x') {
      if (fs.existsSync(X_COOKIES_PATH)) fs.unlinkSync(X_COOKIES_PATH);
    } else {
      if (fs.existsSync(IG_COOKIES_PATH)) fs.unlinkSync(IG_COOKIES_PATH);
      if (fs.existsSync(TT_COOKIES_PATH)) fs.unlinkSync(TT_COOKIES_PATH);
      if (fs.existsSync(X_COOKIES_PATH)) fs.unlinkSync(X_COOKIES_PATH);
    }
  } catch {}
  res.json({ success: true });
});

// POST /api/instagram-frames/extract
router.post('/extract', async (req, res, next) => {
  const sessionDir = path.join(getTempDir(), crypto.randomUUID());

  try {
    const { url, frameCount = 10, intervalMs = 200 } = req.body;

    if (!url || typeof url !== 'string') {
      throw new AppError('"url" is required', 400, 'VALIDATION_ERROR');
    }

    const platform = detectPlatform(url);
    if (!platform) {
      throw new AppError('URL must be a valid Instagram, TikTok, or X (Twitter) post/video link', 400, 'VALIDATION_ERROR');
    }

    let cookiesPath;
    let platformName;
    if (platform === 'tiktok') {
      cookiesPath = TT_COOKIES_PATH;
      platformName = 'TikTok';
    } else if (platform === 'x') {
      cookiesPath = X_COOKIES_PATH;
      platformName = 'X (Twitter)';
    } else {
      cookiesPath = IG_COOKIES_PATH;
      platformName = 'Instagram';
    }

    // Cookies are REQUIRED
    if (!fs.existsSync(cookiesPath)) {
      throw new AppError(
        `${platformName} requires cookies to download. Please set up your cookies.txt first.`,
        401,
        'NO_COOKIES'
      );
    }

    const count = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(frameCount) || 10)));
    const interval = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.round(Number(intervalMs) || 200)));

    fs.mkdirSync(sessionDir, { recursive: true });
    const videoOutputTemplate = path.join(sessionDir, 'video.%(ext)s');

    const ytDlp = findYtDlp();
    log.info('media_frames_download_start', { platform, url, count, interval });

    let fallbackToGalleryDl = false;
    let dlErrMessage = '';

    try {
      await execFileAsync(ytDlp, [
        '--no-playlist',
        '--cookies', cookiesPath,
        '--impersonate', 'chrome',
        '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--output', videoOutputTemplate,
        '--no-warnings',
        '--quiet',
        url,
      ], { timeout: 90_000 });
    } catch (dlErr) {
      dlErrMessage = dlErr.stderr || dlErr.message || '';
      log.warn('media_frames_yt_dlp_failed', { platform, error: dlErrMessage });
      fallbackToGalleryDl = true;
    }

    if (fallbackToGalleryDl) {
      log.info('media_frames_fallback_gallery_dl', { platform, url });
      const galleryDl = findGalleryDl();
      try {
        await execFileAsync(galleryDl, [
          '--cookies', cookiesPath,
          '--directory', sessionDir,
          url,
        ], { timeout: 60_000 });
      } catch (gdlErr) {
        log.warn('media_frames_gallery_dl_failed', { platform, error: gdlErr.stderr || gdlErr.message });
        const msg = gdlErr.stderr || gdlErr.message || '';
        const lowerMsg = msg.toLowerCase();
        
        let detail = `Make sure the URL is a valid public ${platformName} post or video.`;
        if (
          lowerMsg.includes('login') || lowerMsg.includes('sign in') || lowerMsg.includes('private') ||
          dlErrMessage.toLowerCase().includes('login') || dlErrMessage.toLowerCase().includes('sign in')
        ) {
          throw new AppError(
            `${platformName} rejected the cookies or it is a private post. Please export fresh cookies and save them again.`,
            401,
            'COOKIES_EXPIRED'
          );
        } else if (lowerMsg.includes('empty media response') || dlErrMessage.toLowerCase().includes('empty media response')) {
          detail = `${platformName} sent an empty media response. The post might be restricted, age-gated, or private.`;
        } else if (lowerMsg.includes('400') || dlErrMessage.toLowerCase().includes('400')) {
          detail = `${platformName} API returned 400 Bad Request. Scraper might be temporarily blocked or rate-limited.`;
        } else if (lowerMsg.includes('403') || dlErrMessage.toLowerCase().includes('403')) {
          detail = `${platformName} API returned 403 Forbidden. Your IP or cookies might be blocked.`;
        }
        
        throw new AppError(
          `Could not download this ${platformName} post. ${detail}`,
          422,
          'DOWNLOAD_FAILED'
        );
      }
    }

    // Now check what files we got.
    const videoFiles = fs.readdirSync(sessionDir).filter(f => f.startsWith('video.'));
    let frames = [];

    if (videoFiles.length > 0) {
      // Find the downloaded file (yt-dlp fills in the extension)
      const actualVideo = path.join(sessionDir, videoFiles[0]);

      // Extract frames with ffmpeg
      const framesDir = path.join(sessionDir, 'frames');
      fs.mkdirSync(framesDir, { recursive: true });

      const fpsValue = (1000 / interval).toFixed(4); // e.g. 200ms → 5fps
      const framePattern = path.join(framesDir, 'frame_%03d.jpg');

      try {
        await execFileAsync(ffmpegPath, [
          '-i', actualVideo,
          '-vf', `fps=${fpsValue}`,
          '-frames:v', String(count),
          '-q:v', '3',
          framePattern,
      ], { timeout: 30_000 });
      } catch (ffErr) {
        log.warn('ig_frames_ffmpeg_failed', { error: ffErr.message });
        throw new AppError('Frame extraction failed — the video may be in an unsupported format.', 422, 'FFMPEG_FAILED');
      }

      const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
      if (!frameFiles.length) {
        throw new AppError('No frames could be extracted from this video', 422, 'NO_FRAMES');
      }

      frames = frameFiles.map((file, idx) => {
        const buf = fs.readFileSync(path.join(framesDir, file));
        return {
          index: idx,
          timestampMs: Math.round(idx * interval),
          base64: buf.toString('base64'),
          mimeType: 'image/jpeg',
        };
      });
    } else {
      // Succeeded via gallery-dl fallback (static photo/carousel images)
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
      const imageFiles = fs.readdirSync(sessionDir)
        .filter(f => {
          const ext = path.extname(f).toLowerCase();
          return imageExtensions.includes(ext);
        })
        .sort(); // preserve carousel index order

      if (!imageFiles.length) {
        throw new AppError('No images could be extracted from this post.', 422, 'DOWNLOAD_EMPTY');
      }

      frames = imageFiles.map((file, idx) => {
        const buf = fs.readFileSync(path.join(sessionDir, file));
        const ext = path.extname(file).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return {
          index: idx,
          timestampMs: 0,
          base64: buf.toString('base64'),
          mimeType,
        };
      });
    }

    log.info('media_frames_done', { platform, url, frames: frames.length });
    res.json({ success: true, data: { frames, frameCount: frames.length, intervalMs: interval } });
  } catch (err) {
    next(err);
  } finally {
    cleanupDir(sessionDir);
  }
});

module.exports = router;
