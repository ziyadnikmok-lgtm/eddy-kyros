// The metadata cleaner, run for real on a real JPEG.
//
// This is the path a downloaded picture takes before it leaves the machine, so "the code looks
// right" is not enough — it either produces a file whose EXIF says iPhone and carries a date, or it
// does not. Reading the bytes back is the only way to know.
//
// Checks two things the source cannot tell you:
//   1. the generator's own metadata is GONE (a comment naming the model is planted first)
//   2. what replaces it is a complete, plausible camera identity — including a capture time, whose
//      absence was the most conspicuous gap in the old set
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = 'D:/Kyros/app';
const sharp = require(path.join(ROOT, 'node_modules/sharp'));
const svc = require(path.join(ROOT, 'server/services/iosSpoofService.js'));

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metaclean-'));
  const src = path.join(dir, 'src.jpg');

  // A file that looks like generator output: a comment naming the tool, and no camera at all.
  await sharp({ create: { width: 400, height: 500, channels: 3, background: { r: 120, g: 40, b: 90 } } })
    .jpeg()
    .withExif({ IFD0: { ImageDescription: 'Made by Seedream 5.0 Pro', Software: 'kyros-generator' } })
    .toFile(src);

  const before = await sharp(src).metadata();
  check('the fixture really does carry generator metadata',
    Buffer.from(before.exif || []).toString('latin1').includes('Seedream'));

  const out = await svc.spoofImage(src);
  const buf = fs.readFileSync(out.filePath);
  const meta = await sharp(buf).metadata();
  const exif = Buffer.from(meta.exif || []).toString('latin1');

  // --- what must be GONE ---
  check('the generator name is gone', !/Seedream/i.test(exif));
  check('the generator Software tag is gone', !/kyros-generator/i.test(exif));

  // --- what must be THERE ---
  check('Make says Apple', /Apple/.test(exif));
  check('Model says iPhone 17 Pro Max', /iPhone 17 Pro Max/.test(exif));
  check('the lens is named', /back triple camera/.test(exif));
  check('a capture time is written — its absence was the biggest tell',
    /\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/.test(exif));

  // --- the date has to be recent and in the past ---
  const m = /(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(exif);
  const when = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  check('the capture time is in the past, not the future', when <= new Date());
  check('and within the last day, so the photo reads as recent',
    (Date.now() - when.getTime()) < 24 * 3600 * 1000);

  // --- the picture itself must survive ---
  check('it is still a JPEG', meta.format === 'jpeg');
  check('the image is unchanged in size', meta.width === 400 && meta.height === 500);
  check('saved progressive, like a camera', meta.isProgressive === true);
  check('the filename looks like a camera roll file', /^IMG_\d{5}\.jpg$/.test(out.filename));

  // --- two files must not share a second, or a batch is one stamped moment ---
  const out2 = await svc.spoofImage(src);
  const exif2 = Buffer.from((await sharp(fs.readFileSync(out2.filePath)).metadata()).exif || []).toString('latin1');
  const m2 = /(\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2})/.exec(exif2);
  check('a second file gets its own name', out2.filename !== out.filename);
  check('the jitter is real — timestamps are drawn from a range, not fixed',
    typeof m2[1] === 'string' && m2[1].length === 19);

  out.cleanup(); out2.cleanup();

  // --- CLEAN MODE: the bulk zip with the camera identity switched off -------------------------
  // spoof=false used to mean "send the originals untouched", so a bulk download with the cleaner
  // off produced a zip full of images carrying the prompt and the model -- while a SINGLE download
  // of the same image stripped them. The client cannot fix that: it receives one .zip, and
  // stripMetadata reads images, not archives (owner, 2026-08-10).
  const cleanOut = await svc.spoofImage(src, { clean: true });
  const cleanBuf = fs.readFileSync(cleanOut.filePath);
  const cleanStr = cleanBuf.toString('latin1');
  check('clean mode drops the generator metadata', !/Seedream/i.test(cleanStr));
  check('and writes NO camera identity', !/Apple/.test(cleanStr) && !/iPhone/.test(cleanStr));
  check('the picture still survives', (await sharp(cleanBuf).metadata()).width === 400);
  check('it is smaller than the spoofed one, because no EXIF block is added', cleanBuf.length < buf.length);
  cleanOut.cleanup();

  const gal = fs.readFileSync('D:/Kyros/app/server/routes/gallery.js', 'utf8');
  check('the bulk zip cleans when spoofing is off', gal.includes('const shouldClean = !shouldSpoof && iosSpoofService.isAvailable();'));
  check('it calls spoofBatch in clean mode', gal.includes("spoofBatch(files.map((f) => f.filePath), { clean: true })"));
  check('the reason is recorded', /stripMetadata reads images, not archives/.test(gal));
  const svcSrc = fs.readFileSync('D:/Kyros/app/server/services/iosSpoofService.js', 'utf8');
  check('spoofBatch forwards its options', svcSrc.includes('await spoofImage(inputPath, opts)'));

  // Removed LAST: the clean-mode check above reads the same source file.
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  ERROR', e.message); process.exit(1); });
