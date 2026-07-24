/**
 * Shared frame-link extractor with retry + a concurrency pool, so big batches (100+ links)
 * run many-at-once instead of one-at-a-time.
 */

// Instagram rate-limits bursts from a single IP hard (it returns "login required", which
// looks like a cookie failure). Keep concurrency modest without a proxy. Raise it only
// when scraping through a rotating proxy.
export const EXTRACT_CONCURRENCY = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Small de-sync so the pool's workers don't all hit Instagram at the exact same instant.
const jitter = () => sleep(150 + Math.floor(Math.random() * 500));

// Failures worth auto-retrying (network / rate / timeout). Permanent ones (private,
// bad cookies, deleted, 404) are not retried — it won't help.
const isTransientExtractError = (msg) => {
  const m = String(msg || '').toLowerCase();
  if (/private|cookie|not found|404|deleted|removed|no frames/.test(m)) return false;
  return true;
};

// Short post id from an IG/TikTok/X link — for traceable filenames.
function linkShortId(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const known = ['p', 'reel', 'reels', 'tv', 'video', 'status'];
    const idx = parts.findIndex((p) => known.includes(p.toLowerCase()));
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1].slice(0, 24);
    return (parts[parts.length - 1] || '').slice(0, 24);
  } catch { return ''; }
}

// Extract the chosen frame for one link. Up to 3 attempts with backoff on transient errors.
// frameMode: 'brain' (AI picks best), 'quick' (2nd/3rd frame at 200ms), 'thumb' (ffmpeg thumbnail)
// Returns { ok:true, url, dataUrl, mimeType, name, source, sourceUrl } or { ok:false, url, error }.
export async function extractOneLink(url, frameMode = 'brain') {
  // Backwards compat: boolean true = 'brain', false = 'thumb'
  if (frameMode === true) frameMode = 'brain';
  if (frameMode === false) frameMode = 'thumb';
  const isTikTok = url.toLowerCase().includes('tiktok.com');
  const isX = url.toLowerCase().includes('x.com') || url.toLowerCase().includes('twitter.com');
  const platformName = isTikTok ? 'TikTok' : isX ? 'X' : 'Instagram';
  const filePrefix = isTikTok ? 'tiktok' : isX ? 'x' : 'instagram';
  await jitter(); // spread requests so concurrent workers don't burst Instagram at once
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const extractBody = frameMode === 'brain'
        ? { url, frameCount: 3, intervalMs: 200, smartPick: false, smart: true }
        : frameMode === 'quick'
          ? { url, frameCount: 3, intervalMs: 200, smartPick: false, smart: false }
          : { url, frameCount: 1, intervalMs: 300, smartPick: true, smart: false };
      const res = await fetch('/api/instagram-frames/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(extractBody),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        const em = (typeof json.error === 'object' ? json.error?.message : json.error) || json.message || 'Extraction failed';
        throw new Error(em);
      }
      const frames = json.data?.frames || [];
      if (frames.length === 0) throw new Error('No frames returned');
      // If the server returned labelled frames (face/best/outfit from AI picker), keep them all.
      if (frames.some((f) => f.label)) {
        const shortId2 = linkShortId(url);
        return {
          ok: true, url, platformName, source: `${platformName} Frames`, sourceUrl: url,
          frames: frames.map((f) => {
            const mime = f.mimeType || 'image/jpeg';
            return { dataUrl: `data:${mime};base64,${f.base64}`, mimeType: mime, label: f.label || 'frame',
              name: `${filePrefix}_${shortId2 || Date.now()}_${f.label || 'frame'}.jpg` };
          }),
        };
      }
      let sel = null;
      if (frames.length >= 2 && frames[1].timestampMs > 0) sel = frames[1];
      else {
        let imgIndex = null;
        try {
          const u = new URL(url);
          const v = u.searchParams.get('img_index');
          if (v) { const p = parseInt(v, 10); if (!isNaN(p) && p > 0) imgIndex = p; }
        } catch {}
        sel = (imgIndex !== null && frames[imgIndex - 1]) ? frames[imgIndex - 1] : frames[0];
      }
      if (!sel) throw new Error('No frame selected');
      const mimeType = sel.mimeType || 'image/jpeg';
      const shortId = linkShortId(url);
      return {
        ok: true,
        url,
        platformName,
        mimeType,
        dataUrl: `data:${mimeType};base64,${sel.base64}`,
        name: `${filePrefix}_${shortId || Date.now()}.jpg`,
        source: `${platformName} Frames`,
        sourceUrl: url,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < 3 && isTransientExtractError(err.message)) { await sleep(1000 * attempt); continue; }
      break;
    }
  }
  return { ok: false, url, error: lastErr?.message || 'Unknown error' };
}

function linkMeta(url) {
  const isTikTok = url.toLowerCase().includes('tiktok.com');
  const isX = url.toLowerCase().includes('x.com') || url.toLowerCase().includes('twitter.com');
  return {
    isIG: !isTikTok && !isX,
    platformName: isTikTok ? 'TikTok' : isX ? 'X' : 'Instagram',
    filePrefix: isTikTok ? 'tiktok' : isX ? 'x' : 'instagram',
  };
}

// Apify path: no cookies, no IP blocks. Resolve all Instagram links in ONE Apify run,
// then download each public CDN media url in parallel (safe to go hard — no login).
// TikTok/X fall back to the cookie extractor.
// Resolve Instagram links in SMALL chunks (one modest Apify run each — big runs time out
// and Apify returns 400), extracting + saving each chunk's frames before the next chunk.
const APIFY_CHUNK = 8;

export async function extractLinksViaApify(urls, onProgress, onResult, frameMode = 'brain') {
  const smart = frameMode === 'brain'; // backwards compat for inner logic
  const igUrls = urls.filter((u) => linkMeta(u).isIG);
  const otherUrls = urls.filter((u) => !linkMeta(u).isIG);
  const resultByUrl = new Map();
  let done = 0;
  const total = urls.length;
  const norm = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();
  const finish = (url, r) => {
    resultByUrl.set(url, r);
    done += 1;
    if (onProgress) onProgress(done, total);
    if (onResult) { try { onResult(r); } catch { /* ignore */ } }
  };

  const extractFromMedia = async (url, it, allowReresolve = true) => {
    const meta = linkMeta(url);
    if (!it) {
      finish(url, { ok: false, url, error: 'No media found (private / deleted?)' });
      return;
    }
    // Carousels (Sidecar) only carry a cover at the top level — drill into the slides and
    // pick a real one: prefer a video slide (we frame it), else a genuine image slide.
    const slides = (String(it.type) === 'Sidecar' && Array.isArray(it.childPosts) && it.childPosts.length)
      ? it.childPosts
      : [it];
    const chosen = slides.find((c) => c.videoUrl) || slides.find((c) => c.displayUrl) || slides[0] || {};
    const chosenType = String(chosen.type || it.productType || it.type || '').toLowerCase();
    const hasVideoSignal = !!chosen.videoUrl || /video|clip|reel/.test(chosenType);
    const isConfirmedImage = /image|photo/.test(chosenType);
    // Only use a still image (displayUrl) when the post is CONFIRMED an image. A video with no
    // resolved url, OR an ambiguous item with no type (partial Apify batch response), could be
    // a reel whose cover has a ▶ baked in. First try ONE fresh single-resolve (returns fuller
    // data — usually the real videoUrl, or a confirmed Image type); only then give up.
    if (!chosen.videoUrl && (hasVideoSignal || !isConfirmedImage)) {
      if (allowReresolve) {
        try {
          const fresh = (await resolveChunk([url]))[0];
          if (fresh) { await extractFromMedia(url, fresh, false); return; }
        } catch { /* fall through to fail */ }
      }
      finish(url, { ok: false, url, error: 'Media not fully resolved (possible video cover) — Retry to re-fetch' });
      return;
    }
    const mediaUrl = chosen.videoUrl || chosen.displayUrl;
    if (!mediaUrl) {
      finish(url, { ok: false, url, error: it.error || 'No media found (private / deleted?)' });
      return;
    }
    const mediaType = chosen.videoUrl ? 'Video' : 'Image';
    // Smart mode on a real video → let Gemini vision pick the face + outfit frames (multiple).
    if (smart && chosen.videoUrl) {
      try {
        const rs = await fetch('/api/instagram-frames/extract-smart-from-media', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mediaUrl: chosen.videoUrl }),
        });
        const js = await rs.json();
        if (!rs.ok || !js.success) throw new Error(js?.error?.message || js?.error || 'Smart extract failed');
        const frames = (js.data?.frames || []).map((f) => {
          const mime = f.mimeType || 'image/jpeg';
          return { dataUrl: `data:${mime};base64,${f.base64}`, mimeType: mime, label: f.label || 'frame',
            name: `${meta.filePrefix}_${linkShortId(url) || Date.now()}_${f.label || 'frame'}.jpg` };
        });
        if (!frames.length) throw new Error('No frames');
        finish(url, { ok: true, url, platformName: meta.platformName, frames, source: `${meta.platformName} Frames`, sourceUrl: url });
        return;
      } catch { /* fall through to a normal single frame */ }
    }
    try {
      const r = await fetch('/api/instagram-frames/extract-from-media', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaUrl, mediaType, smartPick: true }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || j?.error || 'Extract failed');
      const f = (j.data?.frames || [])[0];
      if (!f) throw new Error('No frame');
      const mime = f.mimeType || 'image/jpeg';
      finish(url, {
        ok: true, url, platformName: meta.platformName, mimeType: mime,
        dataUrl: `data:${mime};base64,${f.base64}`,
        name: `${meta.filePrefix}_${linkShortId(url) || Date.now()}.jpg`,
        source: `${meta.platformName} Frames`, sourceUrl: url,
      });
    } catch (e) {
      finish(url, { ok: false, url, error: e.message || 'Extract failed' });
    }
  };

  const resolveChunk = async (chunkUrls) => {
    const resp = await fetch('/api/instagram-frames/resolve-media-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: chunkUrls }),
    });
    const json = await resp.json();
    if (!resp.ok || !json.success) throw new Error(json?.error?.message || json?.error || 'Apify resolve failed');
    return json.data?.items || [];
  };

  for (let i = 0; i < igUrls.length; i += APIFY_CHUNK) {
    const chunk = igUrls.slice(i, i + APIFY_CHUNK);
    let items = [];
    try {
      items = await resolveChunk(chunk);
    } catch {
      // Batch failed (usually one bad post takes down the whole run). Resolve each link on
      // its own so only the truly-bad one fails — and singles return fuller data (videoUrl).
      const singles = await runWithConcurrency(chunk, async (u) => {
        try { return await resolveChunk([u]); } catch { return []; }
      }, 4);
      items = singles.flat();
    }
    const byUrl = new Map(items.map((it) => [norm(it.url), it]));
    await runWithConcurrency(chunk, (url) => extractFromMedia(url, byUrl.get(norm(url))), APIFY_CHUNK);
  }

  await runWithConcurrency(otherUrls, async (url) => { finish(url, await extractOneLink(url, frameMode)); }, 3);

  return urls.map((u) => resultByUrl.get(u) || { ok: false, url: u, error: 'Unknown' });
}

// Run worker over items with a fixed concurrency; results preserve input order.
// onResult(result) fires as each item finishes (for incremental saving).
export async function runWithConcurrency(items, worker, concurrency = EXTRACT_CONCURRENCY, onProgress, onResult) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  async function runner() {
    while (idx < items.length) {
      const cur = idx++;
      // eslint-disable-next-line no-await-in-loop
      const r = await worker(items[cur], cur);
      results[cur] = r;
      done += 1;
      if (onProgress) onProgress(done, items.length);
      if (onResult) { try { onResult(r); } catch { /* ignore */ } }
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => runner()));
  return results;
}
