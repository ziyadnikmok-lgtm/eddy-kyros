const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// AIO tools directory — contains cjpeg-static.exe, exiftool.exe.exe
const AIO_DIR = path.resolve('C:/Users/X/Pictures/AIOFM/PICTOOLS/AIO');
const CJPEG = path.join(AIO_DIR, 'cjpeg-static.exe');
const EXIFTOOL = path.join(AIO_DIR, 'exiftool.exe.exe');

const EXIF_ARGS = [
  '-overwrite_original',
  '-Make=Apple',
  '-Model=iPhone 16 Pro',
  '-LensMake=Apple',
  '-LensModel=iPhone 16 Pro back triple camera 6.765mm f/1.78',
  '-FocalLength=6.8 mm',
  '-FNumber=1.8',
];

let _available = null;

function isAvailable() {
  if (_available !== null) return _available;
  _available = fs.existsSync(CJPEG) && fs.existsSync(EXIFTOOL);
  return _available;
}

/**
 * Process a single image through the iOS spoof pipeline:
 * 1. Compress with mozjpeg (quality 88, progressive)
 * 2. Strip ALL metadata
 * 3. Inject iPhone 16 Pro EXIF
 *
 * @param {string} inputPath — path to source image file
 * @returns {{ filePath: string, filename: string, cleanup: () => void }}
 */
async function spoofImage(inputPath) {
  if (!isAvailable()) {
    throw new Error('iOS spoof tools not available');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iosspoof-'));
  const rand = Math.floor(Math.random() * 90000) + 10000;
  const outName = `IMG_${rand}.jpg`;
  const outPath = path.join(tmpDir, outName);

  try {
    // Step 1: Compress with mozjpeg
    const { stdout } = await execFileAsync(CJPEG, [
      '-quality', '88',
      '-sample', '2x2',
      '-optimize',
      '-progressive',
      inputPath,
    ], { maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' });

    fs.writeFileSync(outPath, stdout);

    // Step 2: Strip all metadata
    await execFileAsync(EXIFTOOL, ['-overwrite_original', '-all=', outPath]);

    // Step 3: Inject iPhone 16 Pro metadata
    await execFileAsync(EXIFTOOL, [...EXIF_ARGS, outPath]);

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
      // If one image fails, skip it and continue
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
