// Adding an API key must not depend on the network being up.
//
// POST /api/keys verifies the key against Google before storing it, which is right — it catches a
// truncated paste before it becomes a batch of failed renders. But fetch() throws a bare
// `TypeError: fetch failed` for a dropped connection, a DNS miss, a VPN or a proxy, and that went
// straight to the error handler as a 500 TYPE_ERROR. The key was never saved.
//
// The owner hit this on a MacBook with a key that had already generated images from another machine
// an hour earlier (2026-08-16). The message named neither the cause nor anything to do about it.
//
// THE DISTINCTION THIS PINS: Google ANSWERING "this key is invalid" is evidence and must still
// reject. Google being unreachable is not evidence of anything, so the key is stored and the answer
// says plainly that it went in unverified — which the next generation confirms or denies anyway.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const keys = read('server/routes/keys.js');
const page = read('client/src/pages/ApiKeysPage.jsx');

// --- a connection failure is caught, and named -------------------------------------------------
check('the validation fetch is wrapped', /try \{\s*response = await withTimeout\(/.test(keys));
check('a connection failure gets its own code', keys.includes("'GEMINI_UNREACHABLE'"));
check('with a message naming what to check',
  /Could not reach Google to verify the key — check your connection, VPN or proxy/.test(keys));
// The underlying `fetch failed` is kept for the log; the user gets the readable one.
check('the original cause is preserved for the log', keys.includes('unreachable.cause = err?.message;'));

// --- offline saves, refused does not -------------------------------------------------------------
check('an unreachable Google still saves the key', /if \(err\?\.code !== 'GEMINI_UNREACHABLE'\) throw err;/.test(keys));
check('and the save is marked unverified', keys.includes('The key was saved without being verified.'));
check('the response carries that state', keys.includes('data: { ...result, verified, warning }'));
// A real refusal is proof and must still block the save — otherwise a typo is stored silently and
// only shows up as a batch of failures later.
check('an INVALID key is still rejected', keys.includes("throw new AppError(message, 401, 'INVALID_API_KEY')"));
check('the rethrow happens BEFORE the key is stored',
  keys.indexOf("if (err?.code !== 'GEMINI_UNREACHABLE') throw err;") < keys.indexOf('apiKeyManager.addKey(name, apiKey)'));

// --- and the page says which happened --------------------------------------------------------------
check('the page reads the warning back', page.includes("const warning = (added?.data ?? added)?.warning;"));
check('and shows it instead of a plain success', page.includes("if (warning) notify(warning, 'error');"));

// --- the shape of the bug, recorded ------------------------------------------------------------------
check('the reason is written down beside the fix',
  /Google being unreachable is not/.test(keys));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
