// The brief has to LEAD, or Gemini re-composes the shot.
//
// Owner, across three reports: "exact recreate is not doing exact recreate", "it not recreating the
// same pose exactly", "still not recreating the exact same". Two of those were answered by changing
// the prompt WORDING and neither stuck, because the fault was not in the words.
//
// Measured on the live API (2026-08-19) — same four images, same prompt text, only the part order
// varied, three renders:
//
//   prompt LAST   the camera pulls back and re-composes. Source was a tight close-up, arms crossed
//                 overhead; the output was a three-quarter portrait sharing almost no framing.
//   prompt FIRST  framing comes back exactly — same crop, same arms, same head tilt, same couch.
//   prompt BOTH   same as FIRST, and keeps the tail weighting the closing locks rely on.
//
// A brief that arrives after the images is read as commentary on pictures the model has already
// interpreted. No rewording fixes that; the order does.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const svc = fs.readFileSync(path.join(ROOT, 'server/services/nanoBypassService.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the prompt appears at both ends ------------------------------------------------------------
const pushes = [...svc.matchAll(/parts\.push\(\{ text: String\(prompt\)\.trim\(\) \}\);/g)];
check('the prompt is pushed exactly twice — once leading, once trailing', pushes.length === 2);

const first = svc.indexOf('parts.push({ text: String(prompt).trim() });');
const last = svc.lastIndexOf('parts.push({ text: String(prompt).trim() });');
const identityLabel = svc.indexOf('IDENTITY REFERENCE PHOTOS]');
const sceneLabel = svc.indexOf('SCENE PHOTOGRAPH]');
const partsInit = svc.indexOf('const parts = [];');

check('the first copy comes before any image or label', first > partsInit && first < identityLabel);
check('and before the scene label too', first < sceneLabel);
check('the second copy comes after both', last > identityLabel && last > sceneLabel);
check('they are not the same push', first !== last);

// --- the labels still bracket the right images ---------------------------------------------------
// These are what stop Gemini editing the scene photo instead of rendering her; the ordering change
// must not have disturbed them.
check('identity images follow their label', svc.indexOf('images.slice(0, n)') > identityLabel);
check('the scene image follows its label', svc.indexOf('images.slice(n)') > sceneLabel);
check('identity is introduced before the scene', identityLabel < sceneLabel);

// --- why, written where the next person will look ------------------------------------------------
check('the measurement is recorded, not just the change', /prompt LAST|prompt FIRST/.test(svc));
check('including that it is a transport bug, not a wording one',
  /transport-level bug rather than a wording one/.test(svc));
// The trailing copy is load-bearing: EXACT RECREATE and the one-frame lock both sit at the tail of
// the prompt text and were written assuming the tail is weighted.
check('the trailing copy is explained, so nobody deletes it to save tokens',
  /dropping the trailing[\s\S]{0,12}copy to save tokens would quietly weaken them/.test(svc));
// Honest about what it does NOT do — identity still drifts, measured in the same run.
check('and the limit is stated', /does NOT recover identity/.test(svc));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
