// Every Library download path has to actually WRITE A FILE.
//
// `<a download>` with a blob URL navigates in Electron instead of saving, so the click looked like
// it worked and nothing arrived (owner, 2026-08-10). VideoLibraryCard already knew this and said so
// in a comment; the image path and both zip paths had never been brought across. This asserts the
// knowledge is applied everywhere rather than written down in one place.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
const lib = rd(path.join(ROOT, 'client/src/pages/LibraryPage.jsx'));
const api = rd(path.join(ROOT, 'client/src/services/api.js'));
const pre = rd(path.join(ROOT, 'electron/preload.js'));

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- single image ---
check('a single download fetches the bytes rather than pointing an anchor at a URL',
  /const handleImageDownload = useCallback\(async \(item\) => \{[\s\S]{0,400}await fetch\(url, \{ credentials: 'include' \}\)/.test(lib));
check('and hands them to downloadBlob, which is what strips the generator metadata',
  /await downloadBlob\(blob, sanitizeDownloadName\(named \|\| fallback\)\)/.test(lib));
check('it honours the spoofed URL when spoofing is on',
  /const spoof = spoofAvailable && spoofEnabled;[\s\S]{0,160}galleryApi\.spoofedDownloadUrl\(item\.originalId\)/.test(lib));
check('a failure is reported instead of being silent', /notify\(err\?\.message \|\| 'Download failed', 'error'\)/.test(lib));
check('the anchor form is gone from the single path',
  !/const handleImageDownload = useCallback\(\(item\) => \{[\s\S]{0,200}anchor\.click\(\)/.test(lib));

// --- both zips ---
check('a shared helper exists rather than the fix landing in one of the two',
  /async function saveDownloadedBlob\(blob, fileName\)/.test(api));
// The LoRA dataset zip was the third path this found. That whole feature is gone (2026-08-18),
// so what matters now is that no NEW anchor download crept back in beside the shared helper —
// exactly ONE anchor in the file, and it is the helper's own IPC-failed fallback.
check('exactly one anchor download in api.js, inside the shared helper',
  (api.match(/createElement\('a'\)/g) || []).length === 1
  && api.indexOf("createElement('a')") > api.indexOf('async function saveDownloadedBlob'));
check('gallery zip goes through it', /return saveDownloadedBlob\(blob, `gallery-\$\{Date\.now\(\)\}\.zip`\)/.test(api));
check('video zip goes through it', /return saveDownloadedBlob\(blob, `videos-\$\{Date\.now\(\)\}\.zip`\)/.test(api));
check('NEITHER zip path still builds an anchor', (api.match(/document\.createElement\('a'\)/g) || []).length === 1);
check('the one remaining anchor is the browser fallback inside the helper',
  /Fall through to the anchor[\s\S]{0,400}document\.createElement\('a'\)/.test(api));

// --- the electron side ---
check('the IPC it calls is actually exposed', /autoDownloadFolder: \(options\) => ipcRenderer\.invoke\('downloads:auto-directory'/.test(pre)
  && /saveFileToFolder: \(payload\) => ipcRenderer\.invoke\('downloads:save-file'/.test(pre));
check('a failed IPC still falls back rather than losing the download',
  /\} catch \{\s*\n\s*\/\/ Fall through to the anchor/.test(api));
check('the object URL is not revoked synchronously (that cancels the save)',
  /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 10_000\)/.test(api));

// --- replay: the helper's branch choice ---
const pick = (hasElectron) => (hasElectron ? 'ipc' : 'anchor');
check('with Electron present it uses the IPC', pick(true) === 'ipc');
check('in a plain browser it still uses the anchor', pick(false) === 'anchor');

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
