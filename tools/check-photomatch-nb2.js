// Photo Match NB2 — the same page on Nano Banana 2 through our bypass, on the queue.
//
// WHY IT IS A SECOND TAB AND NOT A SECOND FILE: Photo Match carries the twins cast, the back-view
// detection, the chips, the blur pipeline, the library destinations and a prompt builder tuned over
// months against real failures. A copied file means every one of those fixed twice from now on, and
// the two copies quietly disagreeing about which is right. So the first thing asserted here is that
// no copy exists — if someone forks the page later, this suite is what says so.
//
// WHY THE BYPASS MOVED OUT OF ITS ROUTE: the generation queue is server-side. A queue worker cannot
// POST to its own HTTP route, so as long as the bypass lived inside routes/nanoBypass.js it could
// only ever be reached by a browser holding the connection open — which Chromium caps at six.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const pm = read('client/src/pages/PhotoMatchSeedreamPage.jsx');
const nb2 = read('client/src/pages/PhotoMatchNB2Page.jsx');
const app = read('client/src/App.jsx');
const ctx = read('client/src/context/AppContext.jsx');
const svc = read('server/services/nanoBypassService.js');
const route = read('server/routes/nanoBypass.js');
const rec = read('server/services/generationReconciler.js');

// --- ONE brain, two tabs ---------------------------------------------------------------------------
check('NB2 is a thin wrapper, not a copy', nb2.length < 1200 && nb2.includes("variant=\"nb2\""));
check('and it renders the real page', nb2.includes("import PhotoMatchSeedreamPage from './PhotoMatchSeedreamPage'"));
check('the page takes a variant', pm.includes("export default function PhotoMatchSeedreamPage({ variant = 'sd' })"));
check('which defaults to the existing behaviour', pm.includes("const isNB2 = variant === 'nb2';"));
// The guard against a future fork: no second file carrying the prompt builder.
const pages = fs.readdirSync(path.join(ROOT, 'client/src/pages'));
const copies = pages.filter((f) => f !== 'PhotoMatchSeedreamPage.jsx'
  && /PhotoMatch/i.test(f)
  && read(`client/src/pages/${f}`).includes('buildMatchInstruction'));
check(`no duplicate of the prompt brain exists${copies.length ? ` (found ${copies.join(', ')})` : ''}`, copies.length === 0);

// Two tabs sharing one disk snapshot would fight over sources, characters and chips.
check('each tab keeps its own saved state', pm.includes("nb2: createPageStore('kyros-photo-match-nb2-state')"));
check('and the SD tab keeps the key it always had', pm.includes("sd: createPageStore('kyros-photo-match-seedream-state')"));

// --- the engine ---------------------------------------------------------------------------------------
check('NB2 has exactly one engine', pm.includes("const engine = isNB2 ? 'nb2' : engineSD;"));
check('and its toggle offers only the bypass', pm.includes("isNB2 ? [['nb2', 'Nano Banana 2 — bypass']]"));
check('the queue is told which model', pm.includes("model: isNB2 ? 'nb2' : engine === 'nano2' ? 'nano2' : 'seedream5',"));
check('and the reconciler reads it', rec.includes("if (model === 'nb2') return 'nanobypass';"));

// The 3,000 cap is ByteDance's. Applying it to a Gemini run would amputate a prompt for a limit that
// engine does not have — the same mistake that was already fixed once for WaveSpeed's nano2.
check('only Seedream gets the short budget', pm.includes("engine === 'seedream' ? SEEDREAM_PROMPT_BUDGET : NANO2_PROMPT_BUDGET"));
check('and the ByteDance cap is not applied to a Gemini run', !pm.includes("engine === 'nano2' ? NANO2_PROMPT_BUDGET : SEEDREAM_PROMPT_BUDGET"));

// Same model, different counter — quoting WaveSpeed's resale price on a direct run misstates the
// bill on the one control where spend is agreed.
check('NB2 is priced separately', pm.includes('const NB2_COST =') && pm.includes('NB2_COST[resolution]'));
check('a finished tile says which engine made it', pm.includes("job.engine === 'nb2' ? 'NB2'"));

// --- the service ---------------------------------------------------------------------------------------
check('the bypass is a service now', svc.includes('async function callGemini(') && svc.includes('function extractImageFromResponse('));
check('and the route imports it rather than keeping its own copy',
  route.includes("require('../services/nanoBypassService')") && !route.includes('async function callGemini('));
check('it goes straight to Google', svc.includes('generativelanguage.googleapis.com/v1beta/models/'));
// This IS the bypass: the last rung of the ladder sends no safetySettings at all.
check('safety starts at BLOCK_ONLY_HIGH', svc.includes("threshold: 'BLOCK_ONLY_HIGH'"));
check('and the last attempt drops safetySettings entirely', svc.includes('delete body.safetySettings;'));
check('the Gemini key is required, with a message that says where to add one',
  svc.includes('GEMINI_KEY_REQUIRED') && /add one under API Keys/.test(svc));

// RAW mode. The route's wrapped mode prepends "keep the original subject, POSE, background..." and
// calls every image a source to edit — the exact opposite of what Photo Match's prompt says, which
// is that image N is a scene whose person must be REPLACED. Two contradictory briefs in one request.
check('the queue path sends the prompt RAW', svc.includes('async function editRaw('));
check('images in the CALLER\'s order, then the prompt, and nothing else',
  svc.includes("parts.push({ text: String(prompt).trim() });"));
check('and the reason raw exists is written down', /two contradictory briefs|contradictory/i.test(svc));

// The result must file like any other job or the queue's saver silently drops it.
check('it returns the shape the queue files', svc.includes('return { images: [{ base64Data: b64, mimeType: \'image/png\' }] };'));

// --- the queue ------------------------------------------------------------------------------------------
check('the bypass completes in one step, through the existing done door', rec.includes('done: await nanoBypass.editRaw({'));
check('no key means a clear failure, not a crashed worker', rec.includes('Nano Bypass needs a Gemini API key'));
check('resolution is translated to the size the bypass speaks',
  rec.includes("imageSize: job.payload?.resolution === '1K' ? '1K' : '2K',"));
// A rate limit must be retried; a rejected payload must not. Without the status the queue cannot
// tell them apart and a busy minute quietly fails a batch.
check('an HTTP status is carried out of the bypass so 429 stays retryable', svc.includes('err.status = resp.status;'));

// --- the nav --------------------------------------------------------------------------------------------
// Pinterest Library shipped unclickable because its id was missing from VALID_PAGE_IDS: every click
// fell through to the default page. Each of these is one of those lists.
check('the page id is valid, or every click falls back to the default', ctx.includes("'photoMatchNB2'"));
check('it is lazy-loaded like every other page', app.includes("lazy(() => import('./pages/PhotoMatchNB2Page'))"));
check('it is in the page map', app.includes('photoMatchNB2: PhotoMatchNB2Page,'));
check('it has a nav entry', app.includes("{ id: 'photoMatchNB2', label: 'Photo Match NB2' },"));
check('an icon', app.includes('photoMatchNB2: IconCrosshairs,'));
check('a description', /photoMatchNB2: 'Photo Match NB2/.test(app));
// It renders the same component, so it needs the same layout treatment in both lists — one of them
// is the wide-results shell, the other suppresses the generation feed.
// Anchored to a whole line: the nav entry `{ id: 'photoMatchNB2', label: ... }` also contains
// "'photoMatchNB2'," and made this read 3 when the answer is 2.
check('and both layout lists include it', (app.match(/^ {2}'photoMatchNB2',$/gm) || []).length === 2);
check('its nav colour differs from Photo Match SD, so the tabs are tellable apart',
  /photoMatchNB2: \['#/.test(app) && !app.includes("photoMatchNB2: ['#f0abfc', '#a21caf']"));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
