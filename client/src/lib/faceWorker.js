/**
 * Face detection and blurring, off the main thread.
 *
 * WHY THIS EXISTS, measured rather than assumed. pico is plain JavaScript, and one photo costs
 * ~945ms of pure sweep (median 918, worst 1633) — benchmarked over 25 real photos at the exact
 * parameters detectFacePico uses. `Promise.all` does not help: JavaScript is single-threaded, so
 * awaiting a hundred of them still runs them one after another on the UI thread. Five hundred
 * photos is therefore about EIGHT MINUTES of a completely frozen window (owner, 2026-08-17: "500
 * can get blurred at once").
 *
 * A worker pool is the only thing that changes that number. Six workers turn eight frozen minutes
 * into roughly eighty seconds with the window still usable and a counter ticking.
 *
 * The BLUR happens here too, not just the detection. Otherwise every full-size photo has to come
 * back to the main thread to be drawn, re-encoded and handed over again — the decode and the JPEG
 * encode of a 4000px original are not free, and five hundred of them is its own freeze.
 *
 * There is no DOM here: OffscreenCanvas and createImageBitmap do the drawing, FileReaderSync turns
 * the result back into a data URL. The SWEEP is imported from detectFacePico rather than copied —
 * two cascade implementations that must agree exactly is how they stop agreeing.
 */
/*
 * eslint-env worker
 *
 * Not decoration: this file runs in a Worker, and its globals are not the browser's. Without this,
 * FileReaderSync — which exists only in workers, and is the one way to turn a Blob into a data URL
 * without a callback — reads as an undefined variable and check-lint.js fails the whole client.
 */
/* global FileReaderSync, OffscreenCanvas, createImageBitmap, self */
import { sweepPlane, greyscalePlane, verifyLooseBox, SCAN_EDGE } from './detectFacePico';

/**
 * How big a detection may be before it is not a face — the same gate as autoBlurFace.
 *
 * Duplicated as three numbers rather than imported, because autoBlurFace pulls in blurRegion and
 * its DOM canvas. check-blur-gate.js asserts the two sets match, so a change in one that is not
 * made in the other fails the suite rather than silently diverging.
 */
const ABSURD_FRACTION = 0.65;
const LOW_MATCH_FRACTION = 0.3;
const LOW_CENTRE = 0.55;

function looksLikeAFace(box) {
  const centreY = box.y + box.h / 2;
  return !(box.w > ABSURD_FRACTION || box.h > ABSURD_FRACTION)
    && !(box.h > LOW_MATCH_FRACTION && centreY > LOW_CENTRE);
}

/** Widen the box a little: detectors hug the face and leave hair and jaw showing. Matches pad(). */
function pad(box) {
  const grow = 0.25;
  const x = Math.max(0, box.x - box.w * grow);
  const y = Math.max(0, box.y - box.h * grow);
  return { x, y, w: Math.min(1 - x, box.w * (1 + grow * 2)), h: Math.min(1 - y, box.h * (1 + grow * 2)) };
}

/**
 * data: URL to Blob, by hand — NOT with fetch().
 *
 * fetch('data:...') is subject to connect-src, and the server's CSP is
 * `connectSrc: ["'self'", 'https:']` with no data:. So the obvious one-liner throws on every photo,
 * every worker result comes back ok:false, and the whole pool silently degrades to the main-thread
 * fallback it was built to replace — a 6x slowdown that looks exactly like it working.
 *
 * Decoding it here touches no CSP directive at all, so it cannot be broken by a header change
 * either.
 */
function dataUrlToBlob(dataUrl) {
  const comma = String(dataUrl).indexOf(',');
  if (comma < 0) throw new Error('not a data URL');
  const header = dataUrl.slice(0, comma);
  const mime = (/data:([^;,]+)/.exec(header) || [])[1] || 'image/png';
  const body = dataUrl.slice(comma + 1);
  if (!/;base64/i.test(header)) return new Blob([decodeURIComponent(body)], { type: mime });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function decode(dataUrl) {
  return createImageBitmap(dataUrlToBlob(dataUrl));
}

/** Strict first, loose only if that finds nothing — the same escalation as findFace(). */
function findFaceIn(bitmap) {
  const scale = Math.min(1, SCAN_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const grey = greyscalePlane(ctx.getImageData(0, 0, w, h).data, w, h);

  const strict = sweepPlane(grey, w, h, false);
  if (strict) return { box: strict, confident: true, present: true };
  const loose = sweepPlane(grey, w, h, true);
  if (!loose) return { box: null, confident: false, present: false };
  // A rejected loose match still means a face is probably there — it just is not this box.
  if (!looksLikeAFace(loose)) return { box: null, confident: false, present: true, rejected: true };
  // Then look again, closer: crop the match out of the ORIGINAL at 256px and demand a confident
  // score. A chest or a hip only ever looked like a face at 15 on a downscaled sweep.
  const verified = verifyLooseBox(loose, (b, margin, edge) => {
    const sx = Math.max(0, (b.x - b.w * margin) * bitmap.width);
    const sy = Math.max(0, (b.y - b.h * margin) * bitmap.height);
    const sw = Math.min(bitmap.width - sx, b.w * (1 + margin * 2) * bitmap.width);
    const sh = Math.min(bitmap.height - sy, b.h * (1 + margin * 2) * bitmap.height);
    if (sw < 8 || sh < 8) return null;
    const cw = edge;
    const ch = Math.max(8, Math.round((sh / sw) * edge));
    const c = new OffscreenCanvas(cw, ch);
    const cctx = c.getContext('2d', { willReadFrequently: true });
    cctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, cw, ch);
    return { grey: greyscalePlane(cctx.getImageData(0, 0, cw, ch).data, cw, ch), w: cw, h: ch };
  });
  if (!verified) return { box: null, confident: false, present: true, rejected: true };
  return { box: loose, confident: false, present: true };
}

/** blurRegion, on an OffscreenCanvas. Same downscale-and-stretch: destroying the pixels is the point. */
async function blurInto(bitmap, box) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);

  const x = Math.max(0, Math.round(box.x * canvas.width));
  const y = Math.max(0, Math.round(box.y * canvas.height));
  const w = Math.min(canvas.width - x, Math.round(box.w * canvas.width));
  const h = Math.min(canvas.height - y, Math.round(box.h * canvas.height));
  if (w < 2 || h < 2) return null;

  const tiny = new OffscreenCanvas(Math.max(2, Math.round(w / 24)), Math.max(2, Math.round(h / 24)));
  tiny.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, tiny.width, tiny.height);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.filter = 'blur(6px)';
  ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, x, y, w, h);
  ctx.restore();

  // JPEG at high quality, exactly as blurRegion does — a source photo is uploaded, not archived.
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return new FileReaderSync().readAsDataURL(blob);
}

self.onmessage = async (e) => {
  const { id, dataUrl, blur } = e.data || {};
  try {
    const bitmap = await decode(dataUrl);
    const face = findFaceIn(bitmap);
    let out = dataUrl;
    let blurred = false;
    if (blur && face.box) {
      const painted = await blurInto(bitmap, pad(face.box));
      if (painted) { out = painted; blurred = true; }
    }
    bitmap.close?.();
    self.postMessage({
      id,
      ok: true,
      dataUrl: out,
      blurred,
      present: face.present,
      rejected: !!face.rejected,
      // Why nothing was blurred, in the same words blurFound uses, so the badge reads the same.
      reason: blurred ? null : (face.rejected ? 'loose match was not face-shaped or face-placed' : (face.box ? 'blur failed' : 'no face found')),
    });
  } catch (err) {
    // Never drop the photo: the caller falls back to the main-thread path for this one.
    self.postMessage({ id, ok: false, error: err?.message || 'worker failed' });
  }
};
