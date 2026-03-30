const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const ffmpegPath = require('../utils/ffmpeg');
const { ApifyClient } = require('apify-client');
const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const { sharedHttpsAgent } = require('../utils/httpAgent');
const cfg = require('../config');
const apiKeyManager = require('../services/apiKeyManager');
const { TEMP_DIR } = require('../paths');

const router = express.Router();
const DEFAULT_ACTOR_ID = process.env.APIFY_REEL_ACTOR_ID || 'apify/instagram-scraper';

async function resolveVideoUrl(reelUrl, apifyToken) {
  const token = asText(apifyToken) || asText(apiKeyManager.getApifyKey()) || asText(process.env.APIFY_TOKEN);
  if (!token) throw new AppError('Apify token required to download Instagram videos', 400, 'CONFIG_ERROR');

  const client = new ApifyClient({ token });
  const run = await client.actor(DEFAULT_ACTOR_ID).call({
    directUrls: [reelUrl],
    resultsType: 'posts',
    resultsLimit: 1,
    addParentData: false,
  }, { waitSecs: 120 });

  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 5 });
  if (!items?.length) throw new AppError('Apify returned no items for this URL', 502, 'APIFY_NO_ITEMS');

  const item = items[0];
  const videoUrl = item.videoUrl || item.video_url || item.url;
  if (!videoUrl) throw new AppError('No video URL found in Apify result', 502, 'NO_VIDEO_URL');

  return videoUrl;
}

async function downloadVideo(videoUrl, destPath) {
  const response = await axios.get(videoUrl, {
    responseType: 'stream',
    httpsAgent: sharedHttpsAgent,
    timeout: 60_000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// POST /api/insta-frame
// Body: { url, apifyApiKey }
// Returns: { imageBase64, mimeType: 'image/jpeg', filename }
router.post('/', async (req, res, next) => {
  const tmpFiles = [];
  try {
    const { url, apifyApiKey } = req.body || {};
    if (!url) throw new AppError('url is required', 400, 'VALIDATION_ERROR');

    const cleanUrl = asText(url).trim();
    const videoPath = path.join(TEMP_DIR, `instaframe_${Date.now()}.mp4`);
    const framePath = path.join(TEMP_DIR, `instaframe_${Date.now()}_frame.jpg`);
    tmpFiles.push(videoPath, framePath);

    // Resolve video URL via Apify
    const videoUrl = await resolveVideoUrl(cleanUrl, apifyApiKey);

    // Download video
    await downloadVideo(videoUrl, videoPath);

    // Extract first frame with ffmpeg
    await execFileAsync(ffmpegPath, [
      '-y', '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      framePath,
    ]);

    if (!fs.existsSync(framePath)) {
      throw new AppError('Failed to extract frame from video', 500, 'FFMPEG_ERROR');
    }

    const imageBuffer = fs.readFileSync(framePath);
    const imageBase64 = imageBuffer.toString('base64');

    res.json({
      success: true,
      data: {
        imageBase64,
        mimeType: 'image/jpeg',
        filename: `insta_frame_${Date.now()}.jpg`,
      },
    });
  } catch (err) {
    next(err);
  } finally {
    for (const f of tmpFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
});

module.exports = router;
