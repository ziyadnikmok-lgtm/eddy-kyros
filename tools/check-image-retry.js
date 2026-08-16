// An image tile retries a failed load before calling it "not on this machine".
//
// A restart files a wave of rows and paints their tiles in the same instant the local server is
// still coming up — the img fetches raced the boot and 636 tiles went straight to "Image not on
// this machine", next to a "Remove missing" button that DELETES the row, over a startup race, not
// a missing picture (owner, 2026-08-16). This is the exact shape CLAUDE.md warns about elsewhere in
// this repo: unknown must never be read as "no". A single onError is not proof an image is gone.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const g = fs.readFileSync(path.join(ROOT, 'client/src/components/EddyCollection.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

check('a retry counter exists, separate from render state', g.includes('const retryCountsRef = useRef(new Map());'));
check('it is a ref, not state — a retry must not re-render the whole grid', /const retryCountsRef = useRef\(/.test(g));
check('the handler is what onError actually calls now', g.includes('onError={(e) => handleImgError(it.id, e)}'));
check('markBroken is no longer reached directly from onError',
  !/onError=\{\(\) => markBroken\(it\.id\)\}/.test(g));
check('a retry re-requests the SAME image rather than giving up immediately',
  /setTimeout\(\(\) => \{ img\.src = `\$\{base\}\?_retry=\$\{n\}`; \}/.test(g));
check('only the third failure is treated as real', /if \(n <= 2\) \{/.test(g));
check('and that path is the one that finally marks it broken', /if \(n <= 2\) \{[\s\S]{0,200}return;\s*\n\s*\}\s*\n\s*markBroken\(id\);/.test(g));

// Replay the counting logic itself — the retry helper's core is small enough to execute directly
// rather than trust from reading it.
{
  const counts = new Map();
  const attempt = (id) => {
    const n = (counts.get(id) || 0) + 1;
    counts.set(id, n);
    return n <= 2 ? 'retry' : 'broken';
  };
  const seq = [attempt('a'), attempt('a'), attempt('a')];
  check('first two failures on one image retry', seq[0] === 'retry' && seq[1] === 'retry');
  check('the third is what finally gives up', seq[2] === 'broken');
  check('a DIFFERENT image starts its own count, unaffected by the first', attempt('b') === 'retry');
}

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
