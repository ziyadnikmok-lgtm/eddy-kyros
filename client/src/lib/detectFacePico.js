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

/**
 * How much weaker than the best detection a candidate may be and still be considered the subject.
 *
 * 0.4 was chosen from the measurement in sweepPlane: the false picks scored 3%, 7%, 12% and 26% of
 * the best in the same photo, while the one harmless disagreement — two boxes on the same face —
 * scored 59%. Anything from roughly 0.3 to 0.5 separates those two groups; 0.4 sits in the middle
 * of the gap rather than on either edge of it.
 */
const CONFIDENT_FRACTION = 0.4;

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

/** The long edge every photo is scaled to before scanning. Exported so the worker matches exactly. */
export const SCAN_EDGE = 640;

/** RGBA to the single greyscale plane pico wants. Shared with the worker. */
export function greyscalePlane(rgba, w, h) {
  const grey = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    grey[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
  }
  return grey;
}

/**
 * VERIFYING A LOOSE MATCH BY LOOKING AGAIN, CLOSER.
 *
 * The aggressive pass accepts a score of 15 where the confident one wants 50, which is how it finds
 * turned and partly-hidden faces — and also how it starts reporting chests, hips and backsides
 * (owner: "it blurred the boobs and ass"). autoBlurFace's gate throws out the ones that are large
 * AND low in the frame, but a chest in a portrait crop is neither, so it walks straight through.
 *
 * Position and size cannot separate those cases. LOOKING PROPERLY can: crop the matched region out
 * of the ORIGINAL image, blow it up to 256px so the cascade sees real detail instead of a 60px
 * smudge from the downscaled scan plane, and re-run at the CONFIDENT threshold. A real face fills
 * that crop and scores well. A chest scores nothing at 50, because it is not a face — it only ever
 * looked like one at 15 in a low-resolution sweep.
 *
 * Only loose matches pay for it, and they are rare: 25 of 25 real photos hit on the strict pass in
 * the benchmark, so this runs on the exceptions.
 */
export const VERIFY_EDGE = 256;
export const VERIFY_MARGIN = 0.3;

/**
 * @param {object} box            the loose match, in image fractions
 * @param {function} cropToPlane  (box, margin, edge) => {grey, w, h}, supplied by the caller
 *                                because one lives in the DOM and one in a worker
 */
export function verifyLooseBox(box, cropToPlane) {
  try {
    const crop = cropToPlane(box, VERIFY_MARGIN, VERIFY_EDGE);
    if (!crop) return true;                       // cannot check — keep today's behaviour
    return !!sweepPlane(crop.grey, crop.w, crop.h, false);
  } catch {
    return true;
  }
}

export async function detectFacePico(dataUrl, { aggressive = false } = {}) {
  const img = await loadImage(dataUrl);

  // pico scans at fixed scales, so a huge photo wastes time without finding more. 640px on the
  // long edge is plenty for a face that matters, and keeps this instant on a 4000px original.
  const scale = Math.min(1, SCAN_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const grey = greyscalePlane(ctx.getImageData(0, 0, w, h).data, w, h);

  const box = sweepPlane(grey, w, h, aggressive);
  // Only the loose threshold produces the false positives, so only it pays for a second look.
  if (!box || !aggressive) return box;
  const ok = verifyLooseBox(box, (b, margin, edge) => {
    const sx = Math.max(0, (b.x - b.w * margin) * img.naturalWidth);
    const sy = Math.max(0, (b.y - b.h * margin) * img.naturalHeight);
    const sw = Math.min(img.naturalWidth - sx, b.w * (1 + margin * 2) * img.naturalWidth);
    const sh = Math.min(img.naturalHeight - sy, b.h * (1 + margin * 2) * img.naturalHeight);
    if (sw < 8 || sh < 8) return null;
    const cw = edge;
    const ch = Math.max(8, Math.round((sh / sw) * edge));
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const cctx = c.getContext('2d', { willReadFrequently: true });
    cctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
    return { grey: greyscalePlane(cctx.getImageData(0, 0, cw, ch).data, cw, ch), w: cw, h: ch };
  });
  return ok ? box : null;
}

/**
 * The sweep itself — greyscale plane in, box out. NO DOM, so the worker runs the identical code.
 *
 * Split out when detection moved off the main thread: at ~945ms a photo, 500 of them is eight
 * minutes of frozen UI, and a worker pool turns that into about eighty seconds. Two copies of a
 * cascade sweep that must agree exactly is the last thing this file needs, so there is one.
 */
export function sweepPlane(grey, w, h, aggressive = false) {
  /**
   * BOTH PASSES SCAN FINELY. They differ in how much EVIDENCE they require, nothing else.
   *
   * The first pass used to step the window at 0.1 and scale at 1.1 — a coarse sweep — and that,
   * not the score threshold, is what made it miss faces. Measured on the owner's own photos by
   * running this cascade outside the browser (2026-08-17):
   *
   *     photo   coarse+strict     fine+strict
   *     SRC2    nothing           410.0     <- eight times the threshold, missed by the sweep
   *     REF3    nothing           151.7
   *     SRC1    nothing            54.7
   *
   * None of those are weak detections. The coarse sweep simply never landed a window on the face,
   * so an obvious front-facing head came back as "no face" and went to the model unblurred — the
   * single most reliable way to lose the character.
   *
   * With both passes scanning finely the difference between them is honest: pass one demands
   * upstream's confident score of 50, pass two accepts 15 for a turned or partly hidden face and
   * pays for it with the occasional false box, which is what autoBlurFace's gate is for. It also
   * means far fewer photos ever reach that second pass.
   *
   * The cost is small: detection returns at the first angle that hits, and an upright face hits at
   * 0 degrees immediately.
   */
  const params = {
    shiftfactor: 0.05,
    maxsize: Math.min(w, h),
    scalefactor: 1.05,
  };
  const minScore = aggressive ? 15.0 : 50.0;

  for (const deg of ANGLES) {
    const r = rotatePlane(grey, w, h, deg);
    const dets = pico.run_cascade(
      { pixels: r.grey, nrows: r.h, ncols: r.w, ldim: r.w },
      classifier(),
      // Same smallest-face floor on both passes, for the same reason the scan is the same: a
      // face that is small in frame is not a less certain face, it is a smaller one.
      { ...params, minsize: Math.round(Math.min(r.w, r.h) * 0.04), maxsize: Math.min(r.w, r.h) },
    );

    // Overlapping hits on one face are merged; the score threshold drops the noise.
    const clustered = pico.cluster_detections(dets, 0.2).filter((d) => d[3] > minScore);
    if (!clustered.length) continue;

    /**
     * CONFIDENCE FIRST, SIZE SECOND — and getting that order wrong is what blurred her chest.
     *
     * This was a plain sort by size: "biggest wins — on a pose photo the subject's face is the
     * large one, and a face in a poster on the wall is not what needs hiding." True, right up until
     * the biggest match is not a face at all. Then the largest box wins on size alone, and it is the
     * one that gets painted over (owner, 2026-08-17: "sometimes it blur random stuff not the face").
     *
     * MEASURED, on 60 real generated photos: 5 had more than one detection and in every one of
     * those the largest was NOT the best. The scores are not close —
     *
     *     photo      biggest (what shipped)     best score     what the big box actually was
     *     037f685c   score   61,  206px         score 2025     bare chest
     *     046f7a4c   score  224,  176px         score 1896     bikini chest
     *     00561834   score  333,  149px         score 1287     torso in a dress
     *     0102c6f9   score   60,  153px         score  854     chest and neck
     *     02d6efb8   score  257,   73px         score  434     also her face, 1px smaller
     *
     * A real face scores in the hundreds or thousands; these blobs score 60-333 and only cleared the
     * bar because the STRICT threshold is 50. Note where that leaves the other two guards: both the
     * size/position gate and the 256px re-scan apply to LOOSE matches only, so neither of them ever
     * saw any of this. It was the confident pass all along.
     *
     * So: keep only detections within a fraction of the best score, and take the biggest of THOSE.
     * The original reasoning survives intact — among candidates that are genuinely faces, the
     * subject's is still the large one and the poster on the wall still loses. The last row above is
     * why the rule is a fraction rather than "highest score wins": two boxes on the same face, one
     * pixel apart, and the bigger one is the better crop.
     */
    const topScore = clustered.reduce((best, d) => Math.max(best, d[3]), 0);
    const confident = clustered.filter((d) => d[3] >= topScore * CONFIDENT_FRACTION);
    confident.sort((a, b) => b[2] - a[2]);
    const [rowCentre, colCentre, size] = confident[0];

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
