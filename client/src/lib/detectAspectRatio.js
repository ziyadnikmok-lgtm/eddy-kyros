/**
 * Pick the closest supported aspect ratio for an image's real dimensions.
 *
 * Muapi's models each expose a fixed enum (Seedream: 1:1, 4:3, 3:4, 16:9, 9:16, 2:3, 3:2), so
 * "keep the original ratio" can only ever mean "snap to the nearest one it accepts" — there is
 * no passthrough option. Callers pass their own `allowed` list so this works for any model.
 *
 * Compares by absolute difference in w/h, which is good enough at these coarse steps.
 */
export function detectAspectRatio(dataUrl, allowed, fallback = '1:1') {
  return new Promise((resolve) => {
    if (!dataUrl || !Array.isArray(allowed) || !allowed.length) { resolve(fallback); return; }
    const img = new Image();
    img.onload = () => {
      if (!img.width || !img.height) { resolve(fallback); return; }
      const target = img.width / img.height;
      let best = allowed[0];
      let bestDiff = Infinity;
      for (const cand of allowed) {
        const [w, h] = String(cand).split(':').map(Number);
        if (!w || !h) continue;
        const diff = Math.abs(w / h - target);
        if (diff < bestDiff) { bestDiff = diff; best = cand; }
      }
      resolve(best);
    };
    img.onerror = () => resolve(fallback);
    img.src = dataUrl;
  });
}
