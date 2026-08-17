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
/**
 * SIZE ALONE WAS THE WRONG TEST, and it cost a real detection.
 *
 * This was a flat 40% cap on the loose pass. A close-up selfie's head is easily half the frame, so
 * an obvious, front-facing, well-lit face came back unblurred with "no face" (owner, 2026-08-17).
 * The caveat was even written down here — a head-and-shoulders crop can fill the frame — but only
 * the confident pass was exempted, and a slightly turned face misses that pass and lands on this
 * one.
 *
 * What the gate is actually for is the case it was written for: a bent-over pose where the loose
 * threshold reports a hip or a backside. Those are large AND LOW. A face in a photograph of a
 * person is large and HIGH — that is where heads are. So position does the work size cannot, and
 * only an absurd match is rejected on size by itself.
 */
const ABSURD_FRACTION = 0.65;   // nothing in a photo of a person is a face at two thirds of the frame
const LOW_MATCH_FRACTION = 0.3; // a big match whose centre sits below the midline is a body part
const LOW_CENTRE = 0.55;

/** Does a loose match look like a face, or like a body part? See the note above. */
function looksLikeAFace(box) {
  const centreY = box.y + box.h / 2;
  const absurd = box.w > ABSURD_FRACTION || box.h > ABSURD_FRACTION;
  const bigAndLow = box.h > LOW_MATCH_FRACTION && centreY > LOW_CENTRE;
  return !absurd && !bigAndLow;
}

/**
 * FIND THE FACE ONCE, and answer both questions from it.
 *
 * Adding a source photo used to run the detector THREE times: once to decide whether the shot is
 * a back view, then a confident blur pass, then a loose one. Each decodes the image, scales it,
 * builds a greyscale plane and sweeps eight rotations — and the page waited for all of it before
 * the thumbnail appeared (owner, 2026-08-17: 'sometimes slow to put the image there').
 *
 * Worse than slow, they could DISAGREE: the back-view check ran loose and ungated while the blur
 * ran strict, so one could see a face the other did not, and a photo could be treated as
 * back-facing while its face was blurred.
 *
 * One detection, strict first and loose only if that finds nothing, and both answers come from
 * the same result.
 */
export async function findFace(dataUrl) {
  const strict = await detectFacePico(dataUrl, { aggressive: false });
  // A confident hit is never second-guessed — the gate exists for the loose threshold only.
  if (strict) return { box: strict, confident: true, present: true };
  const loose = await detectFacePico(dataUrl, { aggressive: true });
  if (!loose) return { box: null, confident: false, present: false };
  // A rejected loose match still means a face is PROBABLY there — it just is not one this box
  // describes. So it counts as present (the shot is not a back view) but is not blurred.
  //
  // `unverified` is the same verdict from the other direction: detectFacePico cropped the match out
  // of the original at 256px, re-scanned it at the confident threshold and did not find a face
  // there. Treated identically, and deliberately NOT as "no face in this photograph" — that answer
  // would flip the source to back view and take the face rules out of the prompt.
  if (loose.unverified || !looksLikeAFace(loose)) return { box: null, confident: false, present: true, rejected: true };
  return { box: loose, confident: false, present: true };
}

/**
 * Blur the face in a photo.
 *
 * Kept for callers that only want a blurred picture back — "Blur all faces", and anything that does
 * not also need to know whether a face was there. Anything that needs BOTH answers should call
 * findFace once and blurFound with the result, rather than detecting twice.
 */
export async function autoBlurFace(dataUrl) {
  try {
    const face = await findFace(dataUrl);
    return await blurFound(dataUrl, face);
  } catch (err) {
    return { dataUrl, blurred: false, reason: err?.message || 'blur failed' };
  }
}

/** Apply a face found earlier, so the detection is not repeated. */
export async function blurFound(dataUrl, face) {
  try {
    if (!face?.box) {
      // Rejected rather than shrunk: a box the gate refused is not a face in the wrong place, it is
      // not a face. Reported as not-blurred so the amber badge shows and it can be done by hand —
      // far better than handing back a photo with the wrong third of it smeared.
      return {
        dataUrl,
        blurred: false,
        reason: face?.rejected ? 'loose match was not face-shaped or face-placed' : 'no face found',
      };
    }
    return { dataUrl: await blurRegion(dataUrl, pad(face.box)), blurred: true };
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
