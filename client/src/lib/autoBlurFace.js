import { blurRegion } from './blurRegion';
import { detectFacePico } from './detectFacePico';

/**
 * Find the face in an image and blur it out. Automatic, and free when it can be.
 *
 * Seedream anchors on any face it is shown. A pose reference is a photo of a different woman,
 * so her face keeps arriving in the result no matter how firmly the prompt says not to. Prompt
 * wording cannot reliably beat a visible face — removing it from the input can.
 *
 * Detection is pico.js: a 5 KB classifier running on greyscale pixels, entirely local. It
 * replaced two earlier attempts — Chromium's FaceDetector, which is not present in this
 * Electron build, and the vision model, which costs a request per image and hits quota.
 *
 */
export async function autoBlurFace(dataUrl, { aggressive = false } = {}) {
  try {
    const found = await detectFacePico(dataUrl, { aggressive });
    if (!found) return { dataUrl, blurred: false, reason: 'no face found' };
    const box = pad(found);
    return { dataUrl: await blurRegion(dataUrl, box), blurred: true };
  } catch (err) {
    return { dataUrl, blurred: false, reason: err?.message || 'blur failed' };
  }
}

/** Widen the box a little: detectors tend to hug the face and leave hair and jaw showing. */
function pad(box) {
  const grow = 0.25;
  const x = Math.max(0, box.x - box.w * grow);
  const y = Math.max(0, box.y - box.h * grow);
  return {
    x,
    y,
    w: Math.min(1 - x, box.w * (1 + grow * 2)),
    h: Math.min(1 - y, box.h * (1 + grow * 2)),
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = src;
  });
}
