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

  const dets = pico.run_cascade(
    { pixels: grey, nrows: h, ncols: w, ldim: w },
    classifier(),
    {
      // Aggressive mode steps the window in finer increments and looks for smaller faces.
      // Slower, but a retry that repeats the same scan is not a retry.
      shiftfactor: aggressive ? 0.05 : 0.1,
      minsize: Math.round(Math.min(w, h) * (aggressive ? 0.04 : 0.08)),
      maxsize: Math.min(w, h),
      scalefactor: aggressive ? 1.05 : 1.1,
    },
  );

  // Overlapping hits on one face are merged; the score threshold drops the noise. 50 is what
  // upstream's own example uses.
  // 50 is upstream's threshold for a confident hit. A retry accepts weaker evidence,
  // which finds turned or partly hidden faces at the cost of the occasional false box.
  const clustered = pico.cluster_detections(dets, 0.2).filter((d) => d[3] > (aggressive ? 15.0 : 50.0));
  if (!clustered.length) return null;

  // Biggest wins: on a pose photo the subject's face is the large one, and a face in a poster
  // on the wall is not what needs hiding.
  clustered.sort((a, b) => b[2] - a[2]);
  const [rowCentre, colCentre, size] = clustered[0];

  // pico reports a circle (centre + diameter); convert to a box in image fractions.
  const half = size / 2;
  const x = (colCentre - half) / w;
  const y = (rowCentre - half) / h;
  return { x, y, w: size / w, h: size / h };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = src;
  });
}
