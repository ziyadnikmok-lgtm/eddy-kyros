/**
 * Remove metadata from an image before it leaves the app.
 *
 * Works at the BYTE level rather than re-encoding through a canvas. A canvas round trip would
 * also drop metadata, but it re-compresses: JPEG loses quality every pass and PNG changes size
 * for no reason. Dropping the metadata chunks leaves the pixel data bit-identical.
 *
 * What gets removed, by format:
 *   PNG   tEXt iTXt zTXt (generator name, prompt, parameters), eXIf, and caBX (the C2PA
 *         provenance box). Keeps IHDR/PLTE/IDAT/IEND and iCCP/gAMA/sRGB so colour is unchanged.
 *   JPEG  APP1 (EXIF and XMP), APP11 (JUMBF, which is how C2PA rides along), and COM comments.
 *         Keeps APP0 (JFIF) and APP2 (ICC colour profile).
 *   WebP  EXIF and XMP chunks from the RIFF container.
 *
 * Video is passed through untouched — stripping an MP4 needs a container rewrite, which belongs
 * on the server where ffmpeg already lives. stripMetadata reports what it did so a caller can
 * tell the difference between "cleaned" and "left alone".
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Anything not on this list is dropped. An allowlist rather than a blocklist on purpose: a new
// metadata chunk type should default to being removed, not silently shipped.
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',        // structural — the image itself
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', // colour: dropping these would shift how it looks
  'sBIT', 'bKGD', 'hIST', 'pHYs', 'sPLT', // harmless rendering hints
]);

function stripPng(bytes) {
  let offset = 8;                   // past the signature
  const kept = [bytes.slice(0, 8)];
  let removed = 0;

  while (offset < bytes.length) {
    // length(4) type(4) data(length) crc(4)
    const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 0 || offset + 12 + length > bytes.length) break;   // truncated file — stop, keep what parsed
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const end = offset + 12 + length;

    if (PNG_KEEP.has(type)) kept.push(bytes.slice(offset, end));
    else removed += 1;

    offset = end;
    if (type === 'IEND') break;
  }

  if (!removed) return null;        // nothing to do — hand back the original
  const total = kept.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of kept) { out.set(chunk, at); at += chunk.length; }
  return { bytes: out, removed };
}

// APP1 = EXIF/XMP, APP11 = JUMBF (C2PA), FE = comment. APP0 (JFIF) and APP2 (ICC) stay.
const JPEG_DROP = new Set([0xe1, 0xeb, 0xfe]);

function stripJpeg(bytes) {
  const kept = [bytes.slice(0, 2)];  // SOI
  let offset = 2;
  let removed = 0;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;             // not a marker — malformed, bail out safely
    const marker = bytes[offset + 1];
    // Start of scan: everything after this is compressed image data, copy it wholesale.
    if (marker === 0xda) { kept.push(bytes.slice(offset)); offset = bytes.length; break; }
    const size = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (size < 2 || offset + 2 + size > bytes.length) break;
    const end = offset + 2 + size;

    if (JPEG_DROP.has(marker)) removed += 1;
    else kept.push(bytes.slice(offset, end));

    offset = end;
  }
  if (offset < bytes.length) kept.push(bytes.slice(offset));

  if (!removed) return null;
  const total = kept.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of kept) { out.set(chunk, at); at += chunk.length; }
  return { bytes: out, removed };
}

const WEBP_DROP = new Set(['EXIF', 'XMP ']);

function stripWebp(bytes) {
  if (bytes.length < 12) return null;
  const kept = [];
  let offset = 12;                  // 'RIFF' size 'WEBP'
  let removed = 0;

  while (offset + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    if (size < 0 || offset + 8 + size > bytes.length) break;
    const padded = size + (size % 2);   // RIFF chunks are even-aligned
    const end = offset + 8 + padded;

    if (WEBP_DROP.has(fourcc)) removed += 1;
    else kept.push(bytes.slice(offset, Math.min(end, bytes.length)));

    offset = end;
  }
  if (!removed) return null;

  const body = kept.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + body);
  out.set(bytes.slice(0, 12), 0);
  let at = 12;
  for (const chunk of kept) { out.set(chunk, at); at += chunk.length; }
  // The RIFF header carries the total size; leaving the old one makes a corrupt file.
  const riffSize = out.length - 8;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >> 24) & 0xff;
  return { bytes: out, removed };
}

function detect(bytes) {
  if (bytes.length > 8 && PNG_SIG.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes.length > 12
    && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF'
    && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP') return 'webp';
  return '';
}

/**
 * Strip metadata from a Blob.
 *
 * Always resolves — a format it cannot parse comes back untouched rather than throwing, because
 * failing to clean a file must never cost you the download itself.
 *
 * @returns {Promise<{blob: Blob, cleaned: boolean, removed: number, reason?: string}>}
 */
export async function stripMetadata(blob) {
  try {
    if (!blob || typeof blob.arrayBuffer !== 'function') return { blob, cleaned: false, removed: 0, reason: 'not a blob' };
    if ((blob.type || '').startsWith('video/')) {
      return { blob, cleaned: false, removed: 0, reason: 'video — needs a container rewrite' };
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const kind = detect(bytes);
    if (!kind) return { blob, cleaned: false, removed: 0, reason: 'unrecognised format' };

    const result = kind === 'png' ? stripPng(bytes) : kind === 'jpeg' ? stripJpeg(bytes) : stripWebp(bytes);
    if (!result) return { blob, cleaned: true, removed: 0, reason: 'already clean' };

    return {
      blob: new Blob([result.bytes], { type: blob.type || `image/${kind}` }),
      cleaned: true,
      removed: result.removed,
    };
  } catch (err) {
    return { blob, cleaned: false, removed: 0, reason: err?.message || 'strip failed' };
  }
}

/** Is stripping switched on? Defaults to ON — the safe direction for content that gets posted. */
export function stripEnabled() {
  try { return localStorage.getItem('kyros.stripMetadata') !== 'off'; } catch { return true; }
}

export function setStripEnabled(on) {
  try { localStorage.setItem('kyros.stripMetadata', on ? 'on' : 'off'); } catch { /* private mode */ }
}

/**
 * The single way anything in the app saves a file. Strips first when enabled, then triggers the
 * download.
 *
 * Revoking the object URL is deferred: doing it in the same tick as the click cancels the save
 * on some builds.
 */
export async function downloadBlob(blob, filename) {
  let out = blob;
  let info = { cleaned: false, removed: 0 };
  if (stripEnabled()) {
    const res = await stripMetadata(blob);
    out = res.blob;
    info = res;
  }
  // Say so in the name. A saved file then proves on its own whether it was cleaned, instead of
  // needing the bytes probed. Only claimed when it actually happened — a passthrough keeps its
  // original name rather than being labelled something it is not.
  let name = filename;
  if (info.cleaned && !/_metadatacleaned/i.test(name)) {
    const dot = name.lastIndexOf('.');
    name = dot > 0
      ? `${name.slice(0, dot)}_metadatacleaned${name.slice(dot)}`
      : `${name}_metadatacleaned`;
  }

  const href = URL.createObjectURL(out);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
  return info;
}
