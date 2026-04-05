const sharp = require('sharp');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// iPhone 16 Pro EXIF data as an Exif buffer
// We build a minimal EXIF IFD with Make, Model, LensMake, LensModel, FocalLength, FNumber
// For simplicity, we use sharp's withExifMerge which writes EXIF tags

const IPHONE_EXIF = {
  IFD0: {
    Make: 'Apple',
    Model: 'iPhone 16 Pro',
    Software: '18.0',
  },
  IFD2: {
    LensMake: 'Apple',
    LensModel: 'iPhone 16 Pro back triple camera 6.765mm f/1.78',
    FocalLength: '6765/1000',
    FNumber: '178/100',
  },
};

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
    // Build minimal EXIF buffer with iPhone metadata
    const exifBuf = buildExifBuffer(IPHONE_EXIF);

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
