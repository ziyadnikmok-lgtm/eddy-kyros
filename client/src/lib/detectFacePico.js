import pico from './vendor/pico';
import { loadCascade } from './vendor/facefinderCascade';

/**
 * Find a face with pico.js — locally, in about a millisecond, with no API call.
 *
 * Chromium's FaceDetector turned out not to exist in this Electron build, and the vision model
 * costs a request per image and hits quota. pico is a 5 KB detector with a 240 KB cascade that
 * runs on a greyscale pixel array, so it works everywhere and costs nothing.
 *
 * Returns {x, y, w, h} as fractions of the image, or null when no face is found.
 */
let _classify;      // unpacked once; the cascade is 240 KB and does not change

function classifier() {
  if (!_classify) _classify = pico.unpack_cascade(loadCascade());
  return _classify;
}

/**
 * ROTATIONS the cascade is tried at, in degrees.
 *
 * WHY THIS EXISTS: pico's cascade is trained on UPRIGHT, FRONTAL faces and has no rotation search
 * of its own. Run once on the original, it finds a face looking straight at the camera and misses
 * almost everything else — which is most of a real library. Mirror selfies tilt the head, lying-on-a-bed
 * shots are effectively sideways, over-the-shoulder poses lean, and an upside-down shot is 180°
 * off. Every one of those came back "no face found" while being obviously a face (owner,
 * 2026-08-15: "the auto face blur need more work he dont auto face detect face").
 *
 * Rotating the GREYSCALE PLANE and re-running is the standard answer, and it is cheap: the plane is
 * 640px on its long edge and the cascade runs in about a millisecond, so even nine passes stay
 * imperceptible.
 *
 * Ordered by likelihood so the common case still exits on the first pass. Upright first, then small
 * tilts either way, then the quarter turns, then upside down.
 */
const ANGLES = [0, -20, 20, -40, 40, 90, -90, 180];

/** Rotate a greyscale plane by whole degrees, returning the new plane and its dimensions. */
function rotatePlane(grey, w, h, deg) {
  if (!deg) return { grey, w, h };
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // The rotated image needs a bigger canvas or the corners are cut off — and a face in a corner is
  // exactly the one being looked for.
  const nw = Math.max(1, Math.round(Math.abs(w * cos) + Math.abs(h * sin)));
  const nh = Math.max(1, Math.round(Math.abs(w * sin) + Math.abs(h * cos)));
  const out = new Uint8Array(nw * nh);
  const cx = w / 2;
  const cy = h / 2;
  const ncx = nw / 2;
  const ncy = nh / 2;
  // Inverse map: for each destination pixel, find where it came from. Forward mapping would leave
  // holes.
  for (let y = 0; y < nh; y += 1) {
    for (let x = 0; x < nw; x += 1) {
      const dx = x - ncx;
      const dy = y - ncy;
      const sx = Math.round(cx + dx * cos + dy * sin);
      const sy = Math.round(cy - dx * sin + dy * cos);
      out[y * nw + x] = (sx >= 0 && sx < w && sy >= 0 && sy < h) ? grey[sy * w + sx] : 0;
    }
  }
  return { grey: out, w: nw, h: nh };
}

/** Map a point found in the rotated plane back to coordinates in the original. */
function unrotatePoint(col, row, deg, w, h, nw, nh) {
  if (!deg) return { col, row };
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = col - nw / 2;
  const dy = row - nh / 2;
  return { col: w / 2 + dx * cos + dy * sin, row: h / 2 - dx * sin + dy * cos };
}

export async function detectFacePico(dataUrl, { aggressive = false } = {}) {
  const img = await loadImage(dataUrl);

  // pico scans at fixed scales, so a huge photo wastes time without finding more. 640px on the
  // long edge is plenty for a face that matters, and keeps this instant on a 4000px original.
  const scale = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  // pico wants a single greyscale plane, not RGBA.
  const grey = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    grey[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
  }

  const params = {
    // Aggressive mode steps the window in finer increments and looks for smaller faces.
    // Slower, but a retry that repeats the same scan is not a retry.
    shiftfactor: aggressive ? 0.05 : 0.1,
    maxsize: Math.min(w, h),
    scalefactor: aggressive ? 1.05 : 1.1,
  };
  // 50 is upstream's threshold for a confident hit. A retry accepts weaker evidence, which finds
  // turned or partly hidden faces at the cost of the occasional false box.
  const minScore = aggressive ? 15.0 : 50.0;

  for (const deg of ANGLES) {
    const r = rotatePlane(grey, w, h, deg);
    const dets = pico.run_cascade(
      { pixels: r.grey, nrows: r.h, ncols: r.w, ldim: r.w },
      classifier(),
      { ...params, minsize: Math.round(Math.min(r.w, r.h) * (aggressive ? 0.04 : 0.08)), maxsize: Math.min(r.w, r.h) },
    );

    // Overlapping hits on one face are merged; the score threshold drops the noise.
    const clustered = pico.cluster_detections(dets, 0.2).filter((d) => d[3] > minScore);
    if (!clustered.length) continue;

    // Biggest wins: on a pose photo the subject's face is the large one, and a face in a poster
    // on the wall is not what needs hiding.
    clustered.sort((a, b) => b[2] - a[2]);
    const [rowCentre, colCentre, size] = clustered[0];

    // Back to the original frame before turning it into a box, or a face found at 90 degrees would
    // be blurred in the wrong place entirely.
    const c = unrotatePoint(colCentre, rowCentre, deg, w, h, r.w, r.h);

    // pico reports a circle (centre + diameter); convert to a box in image fractions. The box stays
    // axis-aligned in the ORIGINAL frame: a rotated face needs a slightly wider box to stay covered,
    // which the caller's padding already provides.
    const half = size / 2;
    return {
      x: (c.col - half) / w,
      y: (c.row - half) / h,
      w: size / w,
      h: size / h,
      angle: deg,
    };
  }

  return null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = src;
  });
}
