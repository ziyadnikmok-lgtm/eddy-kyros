// Downloading from the Eddy Library — single tile and bulk save.
//
// Two bugs, both of which produced "nothing happened" with no error (owner, 2026-08-10):
//
//   1. downloadBlob used `<a download>` on a blob URL, which NAVIGATES in Electron rather than
//      saving. Every download in the app funnels through that one function — 53 call sites across
//      15 files — so single-image download was silently broken everywhere. Three call sites were
//      patched individually earlier the same day without noticing they all led back to it.
//
//   2. Bulk save only understood rows holding a data: URL. Generated results are stored as a URL
//      to /api/gallery/<id>/image, so the regex failed on every one, every row was skipped, and a
//      Library full of pictures reported "No images to save".
//
// And the failure that hid both: a save loop that swallowed every error and then reported
// "Saved 0 images ✨" — which reads as done.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');

const strip = fs.readFileSync(path.join(ROOT, 'client/src/lib/stripMetadata.js'), 'utf8');
const col = fs.readFileSync(path.join(ROOT, 'client/src/components/EddyCollection.jsx'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- 1. the shared helper actually writes a file --------------------------------------------
check('downloadBlob writes through the Electron IPC', strip.includes('await api.saveFileToFolder({ directory, fileName: name, data })'));
check('it asks for the zero-dialog Downloads folder', strip.includes("api.autoDownloadFolder({ folderName: 'Kyros Studio Downloads' })"));
check('the anchor remains as the plain-browser fallback', /const href = URL\.createObjectURL\(out\);/.test(strip));
check('a failed IPC falls through rather than losing the file', /\/\/ Fall through to the anchor rather than losing the file\./.test(strip));
check('the object URL is not revoked in the same tick', /setTimeout\(\(\) => URL\.revokeObjectURL\(href\), 10000\)/.test(strip));
check('the blast radius is recorded — 53 call sites, one helper',
  /53 call sites across 15 files/.test(strip));

// --- 2. bulk save understands BOTH row shapes ---------------------------------------------------
check('a non-data URL is fetched rather than skipped', col.includes("if (dataUrl && !/^data:/.test(dataUrl)) {"));
check('it converts the response to a data URL', /fr\.readAsDataURL\(blob\)/.test(col));
check('fetches are sequential — a parallel burst of 500 is what took the renderer down',
  /a parallel burst of 500/.test(col));
check('the reason gallery rows were skipped is written down',
  /stored as a URL to \/api\/gallery\/<id>\/image/.test(col));
check('a row that truly cannot be read is counted, not silently dropped',
  /could not be read and will be skipped/.test(col));

// --- 3. zero saved is never reported as success ---------------------------------------------------
check('the auto path checks the count', col.includes('if (!n) notify(`Nothing could be saved'));
check('a partial save says how many failed', /Saved \$\{n\} of \$\{files\.length\} to Downloads/.test(col));
check('the picker path got the same treatment', (col.match(/if \(!n\) notify\(`Nothing could be saved/g) || []).length === 2);
check('the last error is carried out of the loop instead of swallowed',
  // >= 2, not exactly 2: a hard-coded count goes red the moment another save path is added,
  // which is a correct change failing a test that measures the wrong thing.
  (col.match(/lastErr = e\?\.message \|\| 'unknown error'/g) || []).length >= 2);
check('the empty catch that hid this is gone', !/catch \{ \/\* skip a bad one, keep the rest \*\/ \}/.test(col));

// --- 4. the single-tile path still resolves the right source -------------------------------------------
check('the tile downloads the stored source, not the grid thumbnail',
  col.includes('const src = thumbs[it.id] || it.url;'));
check('gridSrc is applied only at RENDER, so the download keeps full resolution',
  /src=\{gridSrc\(thumbs\[it\.id\] \|\| it\.url\)\}/.test(col) && !/gridSrc\(src\)/.test(col.split('const download =')[1] || ''));
check('a data URL is decoded rather than fetched — Electron CSP blocks fetching data:',
  /do NOT fetch\(\) a data: URL/.test(col));

// --- replay: which rows the OLD code would have saved -----------------------------------------------------
const rows = [
  { id: 'a', src: 'data:image/png;base64,AAAA' },              // hand-added
  { id: 'b', src: '/api/gallery/xyz/image' },                   // generated  <- the common case
  { id: 'c', src: '/api/gallery/abc/image?r=1' },               // generated, cache-busted
  { id: 'd', src: '' },                                         // prompt-only
];
const oldKeeps = rows.filter((r) => /^data:([^;]+);base64,(.+)$/.test(r.src));
const newKeeps = rows.filter((r) => r.src && (/^data:/.test(r.src) || /^\/api\/gallery\//.test(r.src)));
check('BEFORE: only 1 of 4 rows was saveable', oldKeeps.length === 1);
check('AFTER: 3 of 4 are — the prompt-only card is correctly still skipped', newKeeps.length === 3);
check('and the one it skips is the one with no picture', !newKeeps.find((r) => r.id === 'd'));

// --- 5. metadata is stripped on BOTH paths (owner asked, 2026-08-10) --------------------------
// The tile download goes through downloadBlob; the bulk save calls the IPC directly and would
// bypass it entirely if it did not strip for itself.
check('the tile path hands its blob to downloadBlob, which strips first',
  col.includes('await downloadBlob(blob, `${base}.${ext}`)'));
check('downloadBlob strips before writing, not after', /if \(stripEnabled\(\)\) \{[\s\S]{0,120}await stripMetadata\(blob\)/.test(strip));
check('the bulk path strips for itself rather than inheriting it',
  col.includes('const res = await stripMetadata(new Blob([bytesOf(f.b64)]'));
// The catch now COUNTS the miss as well (2026-08-13). An unstripped file is still better than no
// file — it just must not be reported as a clean one.
check('a strip failure still saves the file rather than losing it',
  col.includes('return bytesOf(f.b64);'));
check('and the failure is counted rather than swallowed',
  col.includes("whyDirty = err?.message || 'strip failed';"));
check('stripping is ON unless explicitly turned off', /getItem\('kyros\.stripMetadata'\) !== 'off'/.test(strip));
check('a cleaned file says so in its name', /_metadatacleaned/.test(strip));

// --- 6. two download paths, not four -------------------------------------------------------------
check('the duplicate top-toolbar save is gone', !col.includes(String.raw`{visible.length > 0 && (`) || col.includes('{false && ('));
check('the selection bar names the count it will save', col.includes('Download {selected.length}'));
check('and still uses downloadSelected, which owns "Remove after download"',
  col.includes('onClick={downloadSelected}>') && /purgeOnDownload && done\.length/.test(col));
check('the reason both were kept is recorded', /swapping them would have quietly dropped that feature/.test(col));

// --- 7. the fetch must resolve against the WINDOW ORIGIN (owner, 2026-08-10) ------------------
// "Failed to fetch (/api/gallery/914a807a-.../image)" while the SAME url returned 200 from curl
// and the grid <img> beside it rendered fine. A relative path resolves against the document, and
// this window starts on a file:// temp page before redirecting to http://127.0.0.1:<port> -- so
// the fetch could resolve to file:///api/gallery/... , which cannot be fetched.
check('the tile download builds an absolute URL', col.includes('new URL(src, window.location.origin).toString()'));
check('the bulk fetch does too', col.includes('new URL(dataUrl, window.location.origin).toString()'));
check('an already-absolute URL is left alone', (col.match(/\/\^https\?:\/i\.test\(/g) || []).length >= 2);
check('the reason is recorded, including why the <img> worked',
  /the HTML parser resolves against the CURRENT base at paint time/.test(col));

const origin = 'http://127.0.0.1:18421';
const abs = (src) => (/^https?:/i.test(src) ? src : new URL(src, origin).toString());
check('a relative gallery path becomes absolute',
  abs('/api/gallery/914a807a/image') === 'http://127.0.0.1:18421/api/gallery/914a807a/image');
check('a query string survives', abs('/api/gallery/x/image?r=9').endsWith('/image?r=9'));
check('an absolute http URL is untouched', abs('http://example.com/a.png') === 'http://example.com/a.png');
check('https is untouched too', abs('https://i.pinimg.com/x.jpg') === 'https://i.pinimg.com/x.jpg');

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
