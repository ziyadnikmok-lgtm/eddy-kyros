const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const { buildLoginCookies } = require('../utils/instagramCookies');
const apiKeyManager = require('./apiKeyManager');

const execFileAsync = promisify(execFile);
const ffmpegPath = require('../utils/ffmpeg');
const APIFY_BASE_URL = 'https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items';
const MAX_VIDEO_BYTES = 120 * 1024 * 1024;

function looksLikeHttpUrl(value) {
  const text = asText(value);
  return /^https?:\/\//i.test(text);
}

function extractVideoUrlFromApifyItem(item) {
  if (!item || typeof item !== 'object') return '';
  const candidates = [
    item.videoUrl,
    item.video_url,
    item.videoPlayUrl,
    item.video_play_url,
    item.displayUrl,
    item.display_url,
  ];
  for (const candidate of candidates) {
    const url = asText(candidate);
    if (looksLikeHttpUrl(url)) return url;
  }
  return '';
}

async function getReelVideoUrlFromApify(reelUrl, apifyToken = '') {
  const token = asText(apifyToken) || asText(apiKeyManager.getApifyKey()) || asText(process.env.APIFY_TOKEN);
  if (!token) {
    throw new AppError('Apify token is required (provide in UI or APIFY_TOKEN env)', 400, 'CONFIG_ERROR');
  }

  const endpoint = `${APIFY_BASE_URL}?token=${encodeURIComponent(token)}`;
  const loginCookies = buildLoginCookies();
  const payload = {
    directUrls: [reelUrl],
    resultsType: 'posts',
    resultsLimit: 1,
    addParentData: false,
    ...(loginCookies ? { loginCookies } : {}),
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok && loginCookies) {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directUrls: [reelUrl],
          resultsType: 'posts',
          resultsLimit: 1,
          addParentData: false,
        }),
        signal: AbortSignal.timeout(120_000),
      });
    }
  } catch (err) {
    throw new AppError(`Failed to reach Apify: ${err.message}`, 502, 'APIFY_ERROR');
  }

  const text = await response.text();
  if (!response.ok) {
    throw new AppError(`Apify request failed (${response.status}): ${text.slice(0, 300)}`, 502, 'APIFY_ERROR');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('Apify returned invalid JSON', 502, 'APIFY_PARSE_ERROR');
  }

  const firstItem = Array.isArray(parsed) ? parsed[0] : parsed;
  const videoUrl = extractVideoUrlFromApifyItem(firstItem);
  if (!videoUrl) {
    throw new AppError('No video URL found in Apify reel response', 422, 'NO_VIDEO_URL');
  }
  return { videoUrl, apifyItem: firstItem || null };
}

async function downloadVideoToTemp(videoUrl) {
  const tempDir = path.join(os.tmpdir(), 'ai-content-studio-reels');
  fs.mkdirSync(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `reel-${crypto.randomUUID()}.mp4`);

  let response;
  try {
    response = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new AppError(`Failed to download reel video: ${err.message}`, 502, 'VIDEO_DOWNLOAD_ERROR');
  }

  if (!response.ok || !response.body) {
    throw new AppError(`Failed to download reel video (${response.status})`, 502, 'VIDEO_DOWNLOAD_ERROR');
  }

  const fileStream = fs.createWriteStream(filePath);
  let streamError = null;
  fileStream.on('error', (err) => { streamError = err; });
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_VIDEO_BYTES) {
      fileStream.destroy();
      try { fs.unlinkSync(filePath); } catch {}
      throw new AppError('Reel video is too large (max 120MB)', 413, 'VIDEO_TOO_LARGE');
    }
    fileStream.write(chunk);
    if (streamError) {
      fileStream.destroy();
      try { fs.unlinkSync(filePath); } catch { }
      throw new AppError(`Disk write failed: ${streamError.message}`, 500, 'DISK_WRITE_ERROR');
    }
  }

  await new Promise((resolve, reject) => {
    fileStream.end((err) => (err ? reject(err) : resolve()));
  });

  return filePath;
}

async function extractFirstAndLastFrame(videoPath) {
  const tempDir = path.dirname(videoPath);
  const firstFramePath = path.join(tempDir, `first-${crypto.randomUUID()}.jpg`);
  const lastFramePath = path.join(tempDir, `last-${crypto.randomUUID()}.jpg`);

  try {
    await execFileAsync(ffmpegPath, ['-y', '-i', videoPath, '-frames:v', '1', firstFramePath], { timeout: 30_000 });
    await execFileAsync(ffmpegPath, ['-y', '-sseof', '-0.35', '-i', videoPath, '-frames:v', '1', lastFramePath], { timeout: 30_000 });
  } catch (err) {
    throw new AppError(
      `Frame extraction failed. Ensure ffmpeg is installed and in PATH. ${err.message}`,
      500,
      'FFMPEG_ERROR'
    );
  }

  const firstBuffer = fs.readFileSync(firstFramePath);
  const lastBuffer = fs.readFileSync(lastFramePath);

  try { fs.unlinkSync(firstFramePath); } catch {}
  try { fs.unlinkSync(lastFramePath); } catch {}

  if (!firstBuffer.length || !lastBuffer.length) {
    throw new AppError('Failed to extract first/last frame from reel', 500, 'FRAME_EXTRACTION_EMPTY');
  }

  return {
    first: { mimeType: 'image/jpeg', base64Data: firstBuffer.toString('base64') },
    last: { mimeType: 'image/jpeg', base64Data: lastBuffer.toString('base64') },
  };
}

async function resolveReelFrames(reelUrl, options = {}) {
  const cleanUrl = asText(reelUrl);
  if (!cleanUrl || !looksLikeHttpUrl(cleanUrl)) {
    throw new AppError('"reelUrl" must be a valid URL', 400, 'VALIDATION_ERROR');
  }

  const apifyToken = asText(options.apifyToken);
  const { videoUrl, apifyItem } = await getReelVideoUrlFromApify(cleanUrl, apifyToken);
  const videoPath = await downloadVideoToTemp(videoUrl);

  try {
    const frames = await extractFirstAndLastFrame(videoPath);
    return { frames, videoUrl, apifyItem };
  } finally {
    try { fs.unlinkSync(videoPath); } catch {}
  }
}

module.exports = {
  resolveReelFrames,
};
