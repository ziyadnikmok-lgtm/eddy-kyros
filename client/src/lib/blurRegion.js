/**
 * Blur a rectangle of an image, locally on canvas. No model, no API call, no cost.
 *
 * This exists so a pose reference can keep its body and lose its face: Seedream anchors on any
 * face it is shown, and no amount of prompt wording reliably beats a visible one. Removing the
 * face from the input removes the problem at its source.
 *
 * The region is blurred by downscaling and scaling back up rather than with a blur filter —
 * a filter softens detail but leaves enough structure for a model to reconstruct a likeness.
 * Destroying the pixels is the point.
 *
 * @param {string} dataUrl  source image
 * @param {{x:number,y:number,w:number,h:number}} box  fractions of width/height, 0..1
 * @returns {Promise<string>} a new data URL
 */
export async function blurRegion(dataUrl, box) {
  const img = await load(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const x = Math.max(0, Math.round(box.x * canvas.width));
  const y = Math.max(0, Math.round(box.y * canvas.height));
  const w = Math.min(canvas.width - x, Math.round(box.w * canvas.width));
  const h = Math.min(canvas.height - y, Math.round(box.h * canvas.height));
  if (w < 2 || h < 2) return dataUrl;

  // Downscale the region to a handful of pixels, then stretch it back. What comes back is
  // colour and nothing else — no eyes, no jawline, nothing to rebuild a face from.
  const tiny = document.createElement('canvas');
  tiny.width = Math.max(2, Math.round(w / 24));
  tiny.height = Math.max(2, Math.round(h / 24));
  const tctx = tiny.getContext('2d');
  tctx.drawImage(canvas, x, y, w, h, 0, 0, tiny.width, tiny.height);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.filter = 'blur(6px)';          // softens the block edges so it reads as a blur
  ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, x, y, w, h);
  ctx.restore();

  // JPEG at high quality: a pose reference does not need lossless, and the file is uploaded.
  return canvas.toDataURL('image/jpeg', 0.92);
}

function load(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = src;
  });
}
