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
// getActiveKey THROWS when no key is set rather than returning null. Read without a try, that throw
// skipped the check under it, reached the outer catch as an ordinary submit failure, and after three
// attempts handed the job to Seedream — so with NO Gemini key every NB2 job ran on WaveSpeed while
// the tab looked healthy. The one outcome the terminal list exists to prevent.
check('a throwing key lookup cannot leak into the fallback path',
  /try \{\s*apiKey = apiKeys\.getActiveKey\?\.\(\) \|\| null;\s*\} catch \(keyErr\) \{/.test(rec));
check('and it fails the job with the reason', rec.includes('Photo Match NB2 needs a Gemini API key — ${keyErr.message}'));
check('key errors are terminal, so a key problem never moves work to another account',
  rec.includes("'NO_ACTIVE_KEY', 'KEY_CORRUPTED'"));
// Vertex returns null rather than throwing: auth is a service account and there is no key string.
// The bypass calls Google directly and cannot use those credentials — reported as "no key" it would
// send someone hunting for a key they already have.
check('Vertex is named as its own case, not reported as a missing key',
  rec.includes('apiKeys.shouldUseVertexBackend?.()') && /Vertex credentials are selected/.test(rec));
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

// --- three tries, then Seedream ---------------------------------------------------------------------
// A content guard that refuses a picture refuses it every time, so retrying the same engine forever
// turns a refusal into a hole in the batch. Seedream draws that line somewhere else.
const jq = read('server/services/jobQueue.js');
check('the bypass gets a fixed number of tries', /const NB2_ATTEMPTS = (\d+);/.test(rec));
check('and then the job is handed to Seedream', rec.includes("jobQueue.switchEngine(job.id, 'seedream5', { tag: 'fallback', patch: FALLBACK_PATCH })"));
check('only after the tries are spent', rec.includes("engine === 'nanobypass' && job.attempts >= NB2_ATTEMPTS"));

// The swap must be one-way. switchEngine rewrites payload.model, and engineOf reads payload.model,
// so a fallen-back job cannot be routed to the bypass again — no loop.
check('switchEngine rewrites the model, which is what engineOf reads',
  jq.includes('payload.model = model;') && rec.includes("const model = job.payload?.model;"));
check('and refuses if the provider already has it — that would be a second charge',
  /function switchEngine[\s\S]*?if \(row\.task_id\) return false;/.test(jq));
check('the new engine gets a fresh attempt budget', /function switchEngine[\s\S]*?attempts = 0/.test(jq));

// A configuration problem fails the same way on every engine, so swapping is a wasted call.
check('terminal failures do not trigger a pointless swap', rec.includes('isTerminalForFallback(err)'));
check('a bad payload is terminal', rec.includes("'VALIDATION_ERROR', 'GEMINI_KEY_REQUIRED'"));
// The subtle one: Seedream bills a DIFFERENT key, so a dead Gemini key WOULD fall back successfully
// — and then every NB2 job runs on Seedream while the tab looks healthy. Fail visibly instead.
check('a rejected Gemini key fails visibly rather than hiding behind Seedream',
  rec.includes('err?.status === 401') && /every NB2 job would quietly\s*\*? *run on Seedream/.test(rec));
// A content refusal is NOT terminal: that is the case worth swapping for.
check('a content refusal still gets the other engine', !rec.includes('NANO_BYPASS_NO_IMAGE\', \'VALIDATION_ERROR'));
// Rate limits are refunded before this is reached, so they cannot eat the budget of a good job.
check('a rate limit is refunded before the count is consulted',
  rec.indexOf('requeueUnsent(job.id, { refundAttempt: true })') < rec.indexOf('job.attempts >= NB2_ATTEMPTS'));

// --- and the page must not lie about which engine made the picture --------------------------------------
const gq = read('client/src/lib/generationQueue.js');
const jobsRoute = read('server/routes/jobs.js');
// The route strips `payload` on purpose (it holds the source images), so reading job.payload.model
// on the client would have been silently dead — undefined every time, and the tile would keep the
// engine it asked for. The model and tags are surfaced explicitly instead.
check('the API surfaces which model ran', jobsRoute.includes('model: job.payload?.model || null,'));
check('and the tags, which carry the fallback marker', jobsRoute.includes('tags: job.tags || [],'));
check('the queue reads the surfaced field, not the stripped payload',
  gq.includes('model: job.model,') && !gq.includes('model: job.payload?.model,'));
check('and whether it fell back', gq.includes("fellBack: (job.tags || []).includes('fallback'),"));
check('the page reads the engine back rather than assuming', pm.includes("const ranOn = data.model === 'seedream5'"));
check('the tile records what ran, not what was asked for', pm.includes('engine: ranOn,'));
check('and marks the swap', pm.includes("job.fellBack ? ' (fallback)' : ''"));
check('the gallery entry says fallback too', pm.includes('fellBack ? `${engineLabel} (fallback)` : engineLabel'));

// One notification per RUN. On a 200-image batch with the bypass down, per-picture is 200 toasts.
check('the warning fires once per run', pm.includes('warnedFallback.current = true;'));
// Declared above the function that reads it — the use-before-define this file has been bitten by.
check('and its ref is declared before the code that uses it',
  pm.indexOf('const warnedFallback = useRef(false);') < pm.indexOf('const runOne = async (source'));

// The message states a number, so the number has to be the real one.
const serverAttempts = (rec.match(/const NB2_ATTEMPTS = (\d+);/) || [])[1];
const clientAttempts = (pm.match(/const NB2_ATTEMPTS = (\d+);/) || [])[1];
check(`the count in the message matches the server's (${serverAttempts})`, serverAttempts && serverAttempts === clientAttempts);
check('no phantom identifier in the message', !pm.includes('NB2_ATTEMPTS_LABEL'));

// --- the four things a review caught, pinned so they cannot come back -----------------------------
//
// 1. DOUBLE CHARGE. By the time _saveResult runs, the provider has produced the picture and billed
//    for it. Left inside the outer try, a disk or gallery error there reads as "the send failed" —
//    so the job is requeued, and for a bypass job handed to Seedream: one image, two providers,
//    two bills, and an error nobody would connect to a full disk.
check('a save failure cannot re-render an already-paid picture',
  /try \{\s*await _saveResult\(job, sub\.done\.images\);\s*\} catch \(saveErr\) \{/.test(rec));
check('and it fails the job with a reason that says what happened',
  rec.includes('Generated, but could not be saved:'));

// 2. A dead Gemini key arrives as 400 INVALID_ARGUMENT, not 401. Checking only 401 meant the exact
//    case the terminal list was written for slipped through — every job burning three attempts and
//    then quietly running on Seedream while the tab looked healthy.
check('a revoked key (400, not 401) is recognised as terminal', /api key not valid\|api_key_invalid/.test(rec));
check('but an ordinary 400 still gets the other engine', rec.includes("err?.status === 400 &&"));

// 3. A refunded attempt never grows, so a rate-limited job could never reach the fallback — and
//    Gemini reports a spent daily quota as 429 for hours. That made the commonest reason the bypass
//    "cannot finish" the one case the fallback could not serve.
check('rate limits are counted so a quota wall still reaches the fallback',
  rec.includes('const rateLimitHits = new Map();') && rec.includes('hits >= NB2_RATE_LIMIT_TOLERANCE'));
check('and the counter is released when the job leaves', rec.includes('rateLimitHits.delete(job.id);'));
check('the global pause limitation is written down rather than left to be rediscovered',
  /KNOWN LIMITATION: this clock is global/.test(rec));

// 4. liteJob is the PERSISTED shape and drops anything not named. Without this the fallback marker
//    lasted until the next reload, after which a Seedream picture sat on the NB2 panel looking like
//    an ordinary run.
check('the fallback marker survives a reload', pm.includes('fellBack: !!j.fellBack,'));
// 5. And the money follows the engine that actually ran.
check('a fallen-back image is priced as Seedream, not as the bypass', pm.includes('const spent = ranOn === \'nb2\''));
check('the session total uses it', pm.includes('setSessionSpend((s) => s + spent);'));

// 6. And the fallback is stated BEFORE the run. The badge on a finished tile only tells you once
//    the money is spent; the engine row is where a different engine at a different price belongs.
check('the NB2 tab says it fails over to Seedream, up front', /Fails over to.*Seedream 5\.0 Pro \(WaveSpeed\)/s.test(pm));
check('and names the number of tries from the shared constant', pm.includes('after {NB2_ATTEMPTS} failed'));
// CHANGED 2026-08-16: a fallback renders at 2K whatever is set above, so the note must quote the 2K
// rate rather than the current resolution's — quoting the cheaper one understates the bill.
check('and quotes the price it would actually cost', pm.includes("seedreamCost('2K', imagesPerJob).toFixed(3)"));
check('only on the NB2 tab', /\{isNB2 && \(\s*<p className="mb-2 text-\[0\.625rem\] leading-relaxed text-amber-300\/80">/.test(pm));

// 7. The two tabs must not share a results panel. Shared, NB2 opened full of Photo Match SD's
//    history — tiles reading SEEDREAM and NANO 2 on a page whose only engine is the bypass.
check('each tab keeps its own results panel', pm.includes("nb2: createPageStore('photomatch-nb2-results-v1')"));
check('and the SD tab keeps the key it had, so no panel empties on upgrade',
  pm.includes("sd: createPageStore('photomatch-results-v1')"));
check('the panel is selected by variant', pm.includes("const resultsStore = RESULT_STORES[isNB2 ? 'nb2' : 'sd'];"));

// 8. A tile priced from the LIVE controls quotes whatever the engine and resolution are NOW — so a
//    Seedream fallback showed the bypass's rate, and moving the resolution toggle repriced work
//    that was already finished and paid for.
check('a tile records what it actually cost', pm.includes('cost: spent,'));
check('and renders that, not the current controls', pm.includes('job.cost.toFixed(3)'));
check('which survives a reload', pm.includes("cost: typeof j.cost === 'number' ? j.cost : null,"));
check('no tile still reads the live price', !/job\.status === 'done' && <span[^>]*>\$\{costPerJob/.test(pm));

// --- 9. THE IMAGES ARE LABELLED WHERE THEY SIT -------------------------------------------------------
//
// Sent as one undifferentiated pile followed by a wall of text, Gemini has nothing tying 'images 1-3
// = Grace' in the prompt to the bytes it actually received — so it does the obvious thing with an
// edit request and edits the most salient photo, which is the scene. Out comes the stand-in's body
// and hair with a face invented from nowhere, identity references ignored (owner, 2026-08-16: 'wtf
// didnt use my model i select').
//
// Verified against the live API on two real photos: unlabelled REFUSED outright (IMAGE_OTHER);
// labelled put the woman from image 1 into image 2's car, same pose, same outfit, right face.
check('the bypass labels the identity images', svc.includes('IDENTITY REFERENCE PHOTOS'));
check('and the scene photo separately', svc.includes('SCENE PHOTOGRAPH'));
check('the labels sit BEFORE their images, not all at the end',
  svc.indexOf('IDENTITY REFERENCE PHOTOS') < svc.indexOf('images.slice(0, n)'));
// Positional only: the caller's prompt states every rule about identity, and repeating them would
// be two briefs in one request — the exact failure raw mode exists to avoid.
check('the labels state position, not rules', !/must look exactly like|Copy from/.test(svc));
check('the count travels from the page', pm.includes('identityCount: charRefs.length,'));
check('through the queue payload', gq.includes('identityCount },'));
check('and into the bypass', rec.includes('identityCount: Number(job.payload?.identityCount) || 0,'));
// A job with no count behaves exactly as before, so nothing that predates this changes.
check('no count means the old flat layout', svc.includes('for (const img of images) parts.push(asPart(img));'));

// --- a fallback always renders at 2K -----------------------------------------------------------------
// The job is already billed at Seedream's rate and the gap between its 1K and 2K is a few cents,
// while the gap in the picture is not. A fallback is also the run you were least likely to get at all.
check('the fallback patches the payload', rec.includes("const FALLBACK_PATCH = { resolution: '2K' };"));
check('and both fallback paths use it', (rec.match(/patch: FALLBACK_PATCH/g) || []).length === 2);
check('switchEngine can carry a patch', jq.includes('function switchEngine(id, model, { tag = null, patch = null } = {})'));
check('which is applied to the payload', jq.includes('Object.assign(payload, patch);'));
check('and the page quotes the 2K rate, not the current setting',
  pm.includes("seedreamCost('2K', imagesPerJob).toFixed(3)"));

// --- blurring is automatic, including the faces the first pass misses ----------------------------------
// A sharp rival face in the source is the single most reliable way to lose the character, and the
// conservative first pass misses turned and tilted faces — those used to sit there with an amber
// badge until someone noticed and pressed 'Blur all faces'.
check('a missed face triggers the aggressive pass automatically',
  pm.includes('if (!out.blurred) out = await autoBlurFace(dataUrl, { aggressive: true });'));
check('and it is the SAME code the button ran, not a second detector', /the existing retry, taken automatically/.test(pm));

// --- it must not hand back what we sent -------------------------------------------------------------
//
// An edit model can satisfy 'reproduce this photograph exactly' the lazy way: by returning the
// photograph. That is the worst possible shape of failure — the job succeeds, the picture files, the
// tile goes green, and what you have is your own source photo with the blurred face still in it,
// sitting in the library under the character's name (owner, 2026-08-16).
check('an echoed input is caught', svc.includes('NANO_BYPASS_ECHO'));
check('by comparing the output against every input', svc.includes('for (const p of parts) {'));
// Byte-identical is the whole test: a genuine render is never bit-for-bit one of its inputs, even an
// exact recreate, so this cannot fire on good work.
check('on exact bytes, so a real render can never trip it', svc.includes("digest('hex') === outHash"));
// Thrown, not returned — the queue counts it as a failed attempt, retries, and eventually hands the
// job to Seedream, which is what you want from an engine that has decided to echo.
check('and thrown, so the queue retries and then falls back',
  svc.includes("throw new AppError('Nano Bypass returned one of the input images"));

// The blurred photo is what gets SENT, not the original — auto-blur replaces it in place.
check('the source sent is the blurred copy', pm.includes('dataUrl = out.dataUrl;') && pm.includes('const sourceImg = parseDataUrl(source.dataUrl);'));
// And an unfinished tile must not read as a finished result that came back unchanged.
check('an in-progress tile is labelled as the source', pm.includes('Your source · rendering'));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
