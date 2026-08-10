let _sharp; const sharp = (...a) => { if (!_sharp) _sharp = require('sharp'); return _sharp(...a); };
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * What a downloaded photo claims to be.
 *
 * This is a METADATA CLEANER, not a disguise: every tag the generator wrote is removed, and what
 * replaces it is the ordinary EXIF a phone photo carries. A file with NO metadata at all is itself
 * unusual -- ordinary photos have a camera and a date -- so the point is to look like a normal
 * photo, not like a scrubbed one.
 *
 * Lens numbers are the real 17 Pro Max main camera (24mm equivalent, f/1.78). Invented ones would
 * be worse than none: a focal length no Apple lens has is a stronger tell than a missing tag.
 */
const IPHONE_EXIF = {
  IFD0: {
    Make: 'Apple',
    Model: 'iPhone 17 Pro Max',
    Software: '19.0',
  },
  IFD2: {
    LensMake: 'Apple',
    LensModel: 'iPhone 17 Pro Max back triple camera 6.765mm f/1.78',
    FocalLength: '6765/1000',
    FNumber: '178/100',
  },
};

/**
 * A capture time, so the file reads as a photo taken recently rather than one with no date.
 *
 * Nothing wrote a date before, which left the most conspicuous gap in the set: a JPEG carrying a
 * camera model and no DateTimeOriginal is a file someone edited, which is exactly the inference
 * this is meant to avoid.
 *
 * Jittered a few hours back rather than "now": fifty files all stamped the same second is its own
 * pattern, and a photo timestamped the instant it was downloaded is not one either.
 */
function captureStamp() {
  const d = new Date(Date.now() - Math.floor(Math.random() * 6 * 3600 * 1000) - 600 * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p2(d.getMonth() + 1)}:${p2(d.getDate())} `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function isAvailable() {
  // Always available — uses sharp (pure Node.js, no external binaries)
  return true;
}

/**
 * Process a single image through the iOS spoof pipeline:
 * 1. Convert to progressive JPEG at quality 88 (mimics iPhone camera output)
 * 2. Strip ALL existing metadata
 * 3. Inject iPhone 16 Pro EXIF
 *
 * @param {string} inputPath — path to source image file
 * @returns {{ filePath: string, filename: string, cleanup: () => void }}
 */
async function spoofImage(inputPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iosspoof-'));
  const rand = Math.floor(Math.random() * 90000) + 10000;
  const outName = `IMG_${rand}.jpg`;
  const outPath = path.join(tmpDir, outName);

  try {
    // Built per image, so each file gets its own capture time rather than a shared one.
    const when = captureStamp();
    const exifBuf = buildExifBuffer({
      ...IPHONE_EXIF,
      IFD0: { ...IPHONE_EXIF.IFD0, DateTime: when },
      IFD2: { ...IPHONE_EXIF.IFD2, DateTimeOriginal: when, DateTimeDigitized: when },
    });

    await sharp(inputPath)
      .rotate() // auto-rotate based on existing EXIF before stripping
      .jpeg({
        quality: 97,
        progressive: true,
        chromaSubsampling: '4:4:4', // no chroma subsampling — preserves color detail
        mozjpeg: true,
      })
      .withExif(exifBuf)
      .toFile(outPath);

    return {
      filePath: outPath,
      filename: outName,
      cleanup: () => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      },
    };
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

/**
 * Build a minimal EXIF buffer that sharp can use via .withExif()
 * sharp.withExif() expects a plain object keyed by IFD name → tag name → value
 */
function buildExifBuffer(exifData) {
  // sharp >= 0.33 accepts { IFD0: { Make: '...', ... }, IFD2: { ... } }
  return exifData;
}

/**
 * Process multiple images. Returns array of spoofed file info.
 * Caller must call cleanup() on each item when done.
 */
async function spoofBatch(filePaths) {
  const results = [];
  const usedNames = new Set();

  for (const inputPath of filePaths) {
    try {
      const result = await spoofImage(inputPath);
      // Ensure unique filenames
      while (usedNames.has(result.filename)) {
        const rand = Math.floor(Math.random() * 90000) + 10000;
        const newName = `IMG_${rand}.jpg`;
        const newPath = path.join(path.dirname(result.filePath), newName);
        fs.renameSync(result.filePath, newPath);
        result.filePath = newPath;
        result.filename = newName;
      }
      usedNames.add(result.filename);
      results.push(result);
    } catch {
      results.push(null);
    }
  }

  return results;
}

module.exports = {
  isAvailable,
  spoofImage,
  spoofBatch,
};
