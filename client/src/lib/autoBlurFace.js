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
/**
 * How big a detection may be before it is obviously not a face.
 *
 * The aggressive pass drops pico's score threshold from 50 to 15, which is how it finds turned and
 * partly-hidden faces — and also how it starts reporting body parts. Padded by 25% on every side, a
 * false positive on a hip or a backside blurs a third of the photograph (owner, 2026-08-16: 'he
 * blured the ass too').
 *
 * A face occupies well under half the frame in any photograph that also shows a body, and these are
 * always photographs of a person in a scene. Anything larger is rejected on the LOOSE pass only —
 * the confident pass keeps its own judgement, because a legitimate head-and-shoulders crop can fill
 * the frame and that one is not guessing.
 */
const MAX_LOOSE_FACE_FRACTION = 0.4;

export async function autoBlurFace(dataUrl, { aggressive = false } = {}) {
  try {
    const found = await detectFacePico(dataUrl, { aggressive });
    if (!found) return { dataUrl, blurred: false, reason: 'no face found' };
    // Rejected rather than shrunk: a box this size is not a face in the wrong place, it is not a
    // face. Reported as not-blurred so the amber badge shows and it can be blurred by hand — which
    // is the honest outcome, and far better than handing back a photo with the wrong third of it
    // smeared.
    if (aggressive && (found.w > MAX_LOOSE_FACE_FRACTION || found.h > MAX_LOOSE_FACE_FRACTION)) {
      return { dataUrl, blurred: false, reason: 'loose match was too large to be a face' };
    }
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
