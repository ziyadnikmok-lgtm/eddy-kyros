'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const ffmpegPath = require('../../utils/ffmpeg');
const { AppError } = require('../../middleware/errorHandler');
const { asText } = require('../../utils/helpers');
const { sharedHttpsAgent } = require('../../utils/httpAgent');
const { TEMP_DIR } = require('../../paths');
const log = require('../../utils/logger');

const THUMB_DIR = path.join(TEMP_DIR, 'thumbs');
const THUMB_MAX_AGE_MS = 30 * 60_000;

const TATTOO_TERMS_REGEX = /\b(?:tattoo(?:s|ed|ing)?|body\s*ink|inked|inkwork|sleeve\s+tattoo|tribal\s+ink)\b/i;
const TATTOO_SENTENCE_REGEX = /[^.!?\n]*\b(?:tattoo(?:s|ed|ing)?|body\s*ink|inked|inkwork|sleeve\s+tattoo|tribal\s+ink)\b[^.!?\n]*[.!?]?/gi;

// ── Directory helpers ──────────────────────────────────────────────────────────

function ensureTempDir() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function ensureThumbDir() {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
}

// ── Thumbnail cache ────────────────────────────────────────────────────────────

async function cacheThumbnail(imageUrl) {
  if (!isHttpUrl(imageUrl)) return '';
  const id = crypto.randomUUID();
  const filename = `${id}.jpg`;
  const filePath = path.join(THUMB_DIR, filename);
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      httpsAgent: sharedHttpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'image/*,*/*;q=0.8',
        'Referer': 'https://www.instagram.com/',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const buffer = Buffer.from(response.data);
    const ct = (response.headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html') || buffer.length < 100) return '';
    fs.writeFileSync(filePath, buffer);
    return filename;
  } catch {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
    return '';
  }
}

function cleanStaleThumbs() {
  try {
    if (!fs.existsSync(THUMB_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(THUMB_DIR)) {
      const fp = path.join(THUMB_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > THUMB_MAX_AGE_MS) fs.unlinkSync(fp);
      } catch { }
    }
  } catch { }
}
setInterval(cleanStaleThumbs, 5 * 60_000).unref();

// ── URL helpers ────────────────────────────────────────────────────────────────

function isHttpUrl(value) {
  return /^https?:\/\//i.test(asText(value));
}

function looksLikeDirectImageUrl(url) {
  const value = asText(url);
  if (!isHttpUrl(value)) return false;
  const lower = value.toLowerCase();
  if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(lower)) return true;
  if (lower.includes('fbcdn.net') || lower.includes('cdninstagram.com')) return true;
  return false;
}

// ── Image extraction from Apify items ─────────────────────────────────────────

function extractImageUrlFromMedia(item) {
  if (typeof item === 'string') {
    const clean = asText(item);
    return looksLikeDirectImageUrl(clean) ? clean : '';
  }
  const iv2 = item?.image_versions2?.candidates;
  const iv2Best = Array.isArray(iv2) && iv2.length > 0
    ? iv2.reduce((best, c) => ((c.width || 0) > (best.width || 0) ? c : best), iv2[0])?.url
    : undefined;
  const candidates = [
    item?.displayUrl, item?.display_url, item?.thumbnailSrc, item?.thumbnail_src,
    item?.imageUrl, item?.image_url, item?.image, iv2Best,
    item?.thumbnailUrl, item?.thumbnail_url, item?.url, item?.src,
  ];
  for (const candidate of candidates) {
    const clean = asText(candidate);
    if (looksLikeDirectImageUrl(clean)) return clean;
  }
  return '';
}

function isVideoItem(item) {
  if (typeof item === 'string') return /\.(mp4|mov|avi|webm)(\?|$)/i.test(item);
  if (!item || typeof item !== 'object') return false;
  if (item.isVideo === true || item.video === true || item.is_video === true) return true;
  if (item.media_type === 2 || item.mediaType === 2) return true;
  if (isHttpUrl(item.videoUrl) || isHttpUrl(item.video_url) || isHttpUrl(item.video_versions?.[0]?.url)) return true;
  const typeName = asText(item.type || item.__typename || item.productType || '').toLowerCase();
  return typeName.includes('video') || typeName.includes('reel') || typeName === 'graphvideo';
}

function extractPostImages(postItem) {
  if (!postItem || typeof postItem !== 'object') return null;

  const itemTypeName = asText(postItem.type || postItem.__typename || postItem.productType || '').toLowerCase();
  const isCarouselType = itemTypeName.includes('sidecar') || itemTypeName.includes('carousel')
    || postItem.media_type === 8 || postItem.mediaType === 8 || (postItem.mediaCount || 0) > 1;
  if (!isCarouselType && isVideoItem(postItem)) return null;

  const sidecarCandidates = []
    .concat(Array.isArray(postItem.images) ? postItem.images : [])
    .concat(Array.isArray(postItem.carouselMedia) ? postItem.carouselMedia : [])
    .concat(Array.isArray(postItem.carousel_media) ? postItem.carousel_media : [])
    .concat(Array.isArray(postItem.childPosts) ? postItem.childPosts : [])
    .concat(Array.isArray(postItem.sidecarChildren) ? postItem.sidecarChildren : [])
    .concat(Array.isArray(postItem.children) ? postItem.children : [])
    .concat(Array.isArray(postItem.media) ? postItem.media : []);

  const edges = postItem.edgeSidecarToChildren?.edges;
  if (Array.isArray(edges)) for (const edge of edges) sidecarCandidates.push(edge?.node || edge);
  const sideCar = postItem.sideCar || postItem.sidecar;
  if (Array.isArray(sideCar)) for (const item of sideCar) sidecarCandidates.push(item);
  const edgeAlt = postItem.edge_sidecar_to_children?.edges;
  if (Array.isArray(edgeAlt)) for (const edge of edgeAlt) sidecarCandidates.push(edge?.node || edge);

  const carouselImages = sidecarCandidates
    .filter((m) => m && !isVideoItem(m))
    .map((m) => extractImageUrlFromMedia(m))
    .filter((u) => isHttpUrl(u));

  if (carouselImages.length === 0) {
    for (const child of sidecarCandidates) {
      if (!child || isVideoItem(child)) continue;
      const resources = child.display_resources || child.displayResources;
      if (Array.isArray(resources) && resources.length > 0) {
        const best = resources[resources.length - 1];
        const url = asText(best?.src || best?.url);
        if (isHttpUrl(url)) carouselImages.push(url);
      }
    }
  }

  if (carouselImages.length === 0 && sidecarCandidates.length > 0) {
    for (const child of sidecarCandidates) {
      if (!child) continue;
      const thumbUrl = asText(child.thumbnailUrl || child.thumbnail_url || child.displayUrl || child.display_url);
      if (isHttpUrl(thumbUrl)) carouselImages.push(thumbUrl);
    }
  }

  const postLevelImage = extractImageUrlFromMedia(postItem);

  if (carouselImages.length > 1) {
    const deduped = Array.from(new Set(carouselImages));
    if (postLevelImage && isHttpUrl(postLevelImage) && !deduped.includes(postLevelImage)) deduped.push(postLevelImage);
    return {
      type: 'carousel',
      sourceUrl: asText(postItem.url || postItem.inputUrl || postItem.shortCodeUrl || ''),
      imageUrls: deduped,
    };
  }

  if (postLevelImage && !isVideoItem(postItem)) {
    const typeName = asText(postItem.type || postItem.__typename || postItem.productType || '').toLowerCase();
    if (typeName.includes('sidecar') || typeName.includes('carousel') || postItem.mediaCount > 1) {
      log.warn('post_clone_carousel_underextracted', { typeName, mediaCount: postItem.mediaCount, extracted: 1 });
    }
    return {
      type: 'single',
      sourceUrl: asText(postItem.url || postItem.inputUrl || postItem.shortCodeUrl || postLevelImage),
      imageUrls: [postLevelImage],
    };
  }

  return null;
}

// ── Image download ─────────────────────────────────────────────────────────────

async function downloadImageToTemp(imageUrl, filePath) {
  const maxAttempts = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        httpsAgent: sharedHttpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'image/*,*/*;q=0.8',
          'Referer': 'https://www.instagram.com/',
        },
        validateStatus: (status) => status >= 200 && status < 400,
      });
      const contentType = asText(response.headers?.['content-type']).toLowerCase();
      const buffer = Buffer.from(response.data);
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        throw new AppError(`Image download returned non-image content-type: ${contentType || 'unknown'}`, 502, 'IMAGE_DOWNLOAD_ERROR');
      }
      if (!buffer || buffer.length < 64) {
        throw new AppError('Downloaded image is empty or too small', 502, 'IMAGE_DOWNLOAD_ERROR');
      }
      fs.writeFileSync(filePath, buffer);
      return { contentType, size: buffer.length };
    } catch (err) {
      lastErr = err;
      if (err instanceof AppError) throw err;
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new AppError(
    `Image download failed after ${maxAttempts} attempts: ${lastErr?.message || 'unknown'}`,
    502,
    'IMAGE_DOWNLOAD_ERROR'
  );
}

async function resolveDownloadableImageUrl(url) {
  const clean = asText(url);
  if (!isHttpUrl(clean)) return '';
  if (looksLikeDirectImageUrl(clean)) return clean;

  try {
    const res = await axios.get(clean, {
      responseType: 'text',
      timeout: 45000,
      httpsAgent: sharedHttpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const html = asText(res.data);
    const ogMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch && isHttpUrl(ogMatch[1])) return ogMatch[1].replace(/&amp;/g, '&');
  } catch { }

  return clean;
}

function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function safeJpegFromAnyImage(inputPath, tempFiles) {
  const outputPath = path.join(TEMP_DIR, `post-clone-xcode-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
  tempFiles.push(outputPath);
  await execFileAsync(ffmpegPath, ['-y', '-i', inputPath, '-frames:v', '1', outputPath], { timeout: 30000 });
  return outputPath;
}

module.exports = {
  TEMP_DIR, THUMB_DIR, THUMB_MAX_AGE_MS,
  TATTOO_TERMS_REGEX, TATTOO_SENTENCE_REGEX,
  ensureTempDir, ensureThumbDir, cacheThumbnail, cleanStaleThumbs,
  isHttpUrl, looksLikeDirectImageUrl,
  extractImageUrlFromMedia, isVideoItem, extractPostImages,
  downloadImageToTemp, resolveDownloadableImageUrl, mimeFromExt, safeJpegFromAnyImage,
};
