// Blurring five hundred photos without freezing the window.
//
// THE MEASUREMENT THIS IS BUILT ON (2026-08-17, the real cascade at the real parameters over 25 of
// the owner's own photos): one photo costs ~945ms of sweep — median 918, worst 1633. JavaScript is
// single-threaded, so a Promise.all over a batch does NOT overlap that work; it runs one after
// another on the UI thread. Five hundred photos is therefore about EIGHT MINUTES of a window that
// does not repaint, does not scroll and does not answer a click.
//
// Owner, 2026-08-17: "500 can get blurred at once ... and it show if all face blurred". The cap was
// never the limiting factor — memory for 500 photos is only ~0.16 GB of base64 at typical sizes.
// The single thread was. Hence a worker pool, and hence this suite.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const pool = read('client/src/lib/facePool.js');
const worker = read('client/src/lib/faceWorker.js');
const page = read('client/src/pages/PhotoMatchSeedreamPage.jsx');
const det = read('client/src/lib/detectFacePico.js');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the cap, and the reason it could move ------------------------------------------------------
const MAX = Number(/const MAX_SOURCES = (\d+);/.exec(page)[1]);
check(`the cap is ${MAX}`, MAX === 500);
check('and the measurement behind it is recorded, not just the number',
  /~945ms of cascade sweep each, which on the main thread is EIGHT MINUTES frozen/.test(page));
check('including the memory figure, which is the worry it turned out NOT to be',
  /500 photos at a typical 239 KB is ~0\.16 GB/.test(page));

// --- the pool ------------------------------------------------------------------------------------
check('workers are sized from the machine, not hardcoded', pool.includes('Number(navigator?.hardwareConcurrency)'));
// One core stays free or the UI thread competes with the pool for it, which is what this fixes.
check('one core is left for the UI thread', pool.includes('Math.max(2, Math.min(MAX_WORKERS, cores - 1))'));
check('and there is a ceiling — past it they fight over cache, not wall-clock', pool.includes('const MAX_WORKERS = 8;'));
check('the pool is built once and kept', pool.includes('if (_pool) return _pool;'));
check('a machine with no worker support does not break the page', pool.includes('_broken = true;'));
check('results come back in the ORIGINAL order, not completion order', pool.includes('out[i] = res;'));
check('progress is reported per photo', pool.includes('onProgress?.(done, dataUrls.length);'));
// A worker that wedges must not hold the batch behind it forever.
check('a stuck worker times out rather than hanging the batch', pool.includes('const timer = setTimeout(() =>'));
check('and a timed-out photo resolves null, which means do-it-yourself', pool.includes('pool.pending.delete(id); resolve(null);'));
check('a dead worker frees its slot instead of stalling the queue', pool.includes('slot.worker.onerror = () => {'));

// --- one detector, two homes ---------------------------------------------------------------------
// A photo that lands on a worker and the same photo that falls back MUST get the same verdict.
check('the sweep is exported DOM-free', det.includes('export function sweepPlane(grey, w, h, aggressive = false)'));
check('the DOM path uses it', det.includes('const box = sweepPlane(grey, w, h, aggressive);'));
check('and the worker imports it rather than copying the cascade loop',
  worker.includes("from './detectFacePico'") && worker.includes('sweepPlane') && worker.includes('verifyLooseBox'));
check('the greyscale conversion is shared too', det.includes('export function greyscalePlane(rgba, w, h)'));
check('and the scan edge is one number', det.includes('export const SCAN_EDGE = 640;') && worker.includes('SCAN_EDGE / Math.max(bitmap.width, bitmap.height)'));

// --- the worker blurs as well as detects ----------------------------------------------------------
// Returning only the box would send every full-size photo back to the main thread to be decoded,
// painted and re-encoded — a second freeze at this scale, doing the work the pool just avoided.
check('the worker blurs too, not just detects', worker.includes('async function blurInto(bitmap, box)'));
check('with no DOM — OffscreenCanvas and createImageBitmap', worker.includes('new OffscreenCanvas(bitmap.width, bitmap.height)')
  && worker.includes('createImageBitmap(dataUrlToBlob(dataUrl))'));

// THE CSP TRAP. fetch('data:...') is subject to connect-src, and the server sends
// `connectSrc: ["'self'", 'https:']` with no data: — so the obvious one-liner throws on every
// photo, every result comes back ok:false, and the pool silently degrades to the main-thread
// fallback it exists to replace. That failure looks exactly like the feature working.
const server = read('server/index.js');
const csp = /connectSrc: \[([^\]]*)\]/.exec(server);
check('the CSP still has no data: in connect-src — the reason the decode is manual',
  csp && !/data:/.test(csp[1]));
check('so the worker decodes the data URL itself', worker.includes('function dataUrlToBlob(dataUrl)'));
check('and never fetches one', !worker.includes('fetch(dataUrl)'));
check('with the trap written down', /is subject to connect-src, and the server's CSP is/.test(worker));
check('and FileReaderSync to get a data URL back out', worker.includes('new FileReaderSync().readAsDataURL(blob)'));
check('the same JPEG quality blurRegion uses — the source is uploaded, not archived',
  worker.includes("{ type: 'image/jpeg', quality: 0.92 }") && read('client/src/lib/blurRegion.js').includes("toDataURL('image/jpeg', 0.92)"));
check('a failed worker photo reports ok:false rather than a silent pass-through', worker.includes("self.postMessage({ id, ok: false"));

// --- the page ---------------------------------------------------------------------------------------
check('intake runs the batch through the pool', page.includes('const useWorkers = poolAvailable() && take.length > 1;'));
check('Blur all faces does too — the button most likely to meet 500 photos',
  page.includes('const useWorkers = poolAvailable() && targets.length > 1;'));
// One photo is not worth the message round-trip, and the pool may not exist at all.
check('a single photo stays on the main thread', page.includes('take.length > 1'));
check('and anything the pool cannot take falls back rather than being skipped',
  page.includes('fallback: onMainThread') && page.includes('fallback: (url) => autoBlurFace(url),'));

// --- "it show if all face blurred" ------------------------------------------------------------------
// With fifty photos you could count amber rings. With five hundred you cannot, and that was the
// actual question.
check('a live count while it works', page.includes('Scanning faces — {scanning.done} of {scanning.total}'));
check('with the number of workers shown, so a slow machine explains itself', page.includes('{poolSize()} workers'));
check('and the total is stated when it finishes', page.includes('`All ${sources.length} face${sources.length === 1 ? \'\' : \'s\'} blurred`'));
check('the misses are counted, not left to be spotted', page.includes('${unblurredCount} with no face found'));
check('and can be isolated in one click', page.includes('Show the ${unblurredCount}') && page.includes('setShowUnblurredOnly'));
// The filter must never change what generates — only what is drawn.
check('the filter narrows the VIEW, never the queue',
  page.includes('(showUnblurredOnly && unblurredCount ? sources.filter((s) => !s.blurred) : sources).map'));
check('and it cannot strand you on an empty grid', page.includes('showUnblurredOnly && unblurredCount ?'));

// --- the second freeze, removed too ------------------------------------------------------------------
// The disk snapshot serialises every source. At 500 that is ~160 MB, and it ran on each individual
// state change while a batch was landing.
check('the source snapshot is debounced', page.includes("const t = setTimeout(() => store.set('sources', sources), 1000);"));
check('and cleaned up, so a burst writes once', page.includes('return () => clearTimeout(t);'));
check('the reason is written down', /at that size the\s+\* snapshot is ~160 MB/.test(page));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
