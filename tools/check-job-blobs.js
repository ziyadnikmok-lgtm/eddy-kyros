// The queue must not put base64 images in the database.
//
// This one runs the real code against a real temp directory rather than reading source, because the
// thing being claimed is a SIZE — "a 300-job batch stores one copy of the base photo, not 300" — and
// only running it proves that. KYROS_BLOB_DIR keeps it away from better-sqlite3, which cannot load
// under plain node (it is built for Electron's ABI).
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyros-blobs-'));
process.env.KYROS_BLOB_DIR = dir;
const blobs = require(path.join(__dirname, '..', 'server', 'services', 'jobBlobs'));

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };
const files = () => fs.readdirSync(dir).filter((f) => !f.endsWith('.tmp'));

// Stand-ins for a base photo, an outfit and two poses. Distinct bytes, so distinct hashes.
// The seed goes in as a full 32-bit value, not folded into a byte: `(i * 31 + seed) & 0xff` makes
// seeds 256 apart produce identical buffers, so 300 "different" poses were only 256 distinct ones
// and the dedupe looked broken when it was the fixture that was wrong.
const img = (seed, size) => {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(seed >>> 0, 0);
  for (let i = 4; i < size; i += 1) b[i] = (i * 31 + seed) & 0xff;
  return `data:image/png;base64,${b.toString('base64')}`;
};
const BASE = img(1, 40_000);
const OUTFIT = img(2, 40_000);

// --- a reference replaces the bytes ---------------------------------------------------------------
const refs = blobs.store([BASE, OUTFIT]);
check('store returns references, not data URLs', refs.every((r) => /^blob:[a-f0-9]{64}\.png$/.test(r)));
check('the row shrinks to a few dozen bytes', JSON.stringify(refs).length < 200);
check('both pictures were written', files().length === 2);

// --- and the bytes come back EXACTLY ---------------------------------------------------------------
// A lossy round trip would send a corrupted image to a paid API and charge for the result.
const back = blobs.load(refs);
check('load returns the original data URL, byte for byte', back[0] === BASE && back[1] === OUTFIT);

// --- the point of the whole file: a batch stores one copy ---------------------------------------------
// 300 jobs, each with the same base + same outfit + its own pose.
const before = files().length;
let inlineBytes = 0;
for (let i = 0; i < 300; i += 1) {
  const pose = img(1000 + i, 40_000);
  inlineBytes += JSON.stringify({ images: [BASE, OUTFIT, pose] }).length;
  blobs.store([BASE, OUTFIT, pose]);
}
const added = files().length - before;
check('300 jobs added 300 files, not 900 — the shared base and outfit were stored once', added === 300);

const onDisk = files().reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
const savedPct = Math.round((1 - onDisk / inlineBytes) * 100);
console.log(`       inline in the database: ${(inlineBytes / 1048576).toFixed(1)} MB`
  + `  ->  on disk: ${(onDisk / 1048576).toFixed(1)} MB  (${savedPct}% less)`);
check('the saving is real, not marginal', savedPct >= 60);

// --- things that are not data URLs are left alone -------------------------------------------------------
const passthrough = blobs.store(['https://example.com/a.png', refs[0], null, 5]);
check('an http URL passes through untouched', passthrough[0] === 'https://example.com/a.png');
check('store is safe to call twice — a reference stays a reference', passthrough[1] === refs[0]);
check('non-strings survive', passthrough[2] === null && passthrough[3] === 5);
check('load leaves an http URL alone', blobs.load(['https://example.com/a.png'])[0] === 'https://example.com/a.png');

// --- a missing blob must be LOUD -----------------------------------------------------------------------
// Quietly dropping it would send an edit with 2 of its 3 inputs: that does not fail, it renders a
// confidently wrong picture and bills for it.
fs.rmSync(path.join(dir, refs[0].slice('blob:'.length)));
let threw = false;
try { blobs.load(refs); } catch { threw = true; }
check('a missing blob throws rather than silently dropping an input image', threw);

// --- sweep collects what nothing references --------------------------------------------------------------
const keep = blobs.store([OUTFIT])[0].slice('blob:'.length);
const { removed } = blobs.sweep(new Set([keep]));
check('sweep removed the unreferenced files', removed > 0);
check('and kept the referenced one', fs.existsSync(path.join(dir, keep)));
check('sweep left nothing but what was named', files().length === 1);

// refsIn is what the queue hands sweep — it must read the same shape store writes.
check('refsIn finds the references in a payload',
  JSON.stringify(blobs.refsIn({ images: [`blob:${keep}`, 'https://x/y.png'] })) === JSON.stringify([keep]));
check('refsIn on a payload with no images is empty', blobs.refsIn({}).length === 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
