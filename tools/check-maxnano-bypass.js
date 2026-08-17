// Max Nano can run Nano Banana 2 through the Gemini bypass, not only through WaveSpeed.
//
// Owner, 2026-08-17: "i want add option in max nano to use the gemini you already have the code so
// just select Gemini bypass, nano banana 2 and it send to it."
//
// Same model, one reseller fewer: the bypass calls Google's own API on the Gemini key, so the
// refusals are Google's rather than a reseller's on top and the bill lands on a different account.
// Every piece of it already existed — Photo Match NB2 has run this path since 2026-08-16 — so this
// is a route choice, not a new engine. What this suite protects is that it stays ONE path: the
// moment Eddy grows its own copy of the bypass call, the two drift.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const page = read('client/src/pages/EddyGeneratePage.jsx');
const queue = read('client/src/lib/generationQueue.js');
const rec = read('server/services/generationReconciler.js');
const svc = read('server/services/nanoBypassService.js');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the switch --------------------------------------------------------------------------------
check('Max Nano offers both routes', page.includes("[['nano2', 'NB2 · WaveSpeed'], ['nb2', 'NB2 · Gemini bypass']]"));
check('and Eddy still offers Seedream vs Nano Banana 2', page.includes("[['seedream', 'Seedream'], ['nano2', 'Nano Banana 2']]"));
// A switch that cannot change the outcome is worse than no switch — the rule Max Outfit taught.
check('Max Outfit still has no switch at all, because it is pinned to Seedream',
  page.includes('{!maxOutfit && (') && page.includes("if (maxOutfit) setEngine('seedream');"));
check('each option says where the bill lands', page.includes('billed to your Gemini key')
  && page.includes('billed to your WaveSpeed key'));

// --- the pin ------------------------------------------------------------------------------------
// engine is one shared, persisted value across every workspace, so a Seedream left over from an
// Eddy run would otherwise follow you into Max Nano and generate on the wrong model at the wrong
// price. Both nano routes are now valid there; anything else is pulled back.
check('Max Nano accepts either nano route and rejects the rest',
  page.includes("if (maxNano && engine !== 'nano2' && engine !== 'nb2') setEngine('nb2');"));
check('and 2K follows either one', page.includes("if (engine === 'nano2' || engine === 'nb2') setResolution('2K');"));

// --- one path, not a copy -------------------------------------------------------------------------
check('it goes through the same queue call as everything else', page.includes("const model = body.model === 'nb2' ? 'nb2' : body.model === 'nano2' ? 'nano2' : 'seedream5';"));
// It names the bypass in comments and builds labels FOR it, but never calls it: the request is an
// enqueue like every other engine's. So this looks for a CALL, not a mention.
check('the page never talks to the bypass itself',
  !/nanoBypass\.\w+\(/.test(page) && !page.includes('generativelanguage'));
check('the queue carries the model through', queue.includes('payload: { images, prompt, aspectRatio, resolution, model, provider, identityCount, labels }'));
check('and the reconciler knows the name', rec.includes("if (model === 'nb2') return 'nanobypass';"));
check('which reaches the bypass service', rec.includes('done: await nanoBypass.editRaw({'));
check('the service exists and takes raw images', svc.includes('async function editRaw({ apiKey, images, prompt'));

// --- no double retry, no double fallback ------------------------------------------------------------
// The queue already gives the bypass NB2_ATTEMPTS tries and then re-runs the job on Seedream 5 Pro
// from the server, where a rate limit can be recognised for what it is. A client-side retry would
// multiply that (4 x 3) and a client-side fallback would race the one the queue is running.
const nb2Branch = page.slice(page.indexOf("if (engine === 'nb2') {"), page.indexOf("} else if (engine === 'nano2') {"));
check('the bypass branch enqueues once', (nb2Branch.match(/await runEdit\(/g) || []).length === 1);
// The words appear in the branch's own comment explaining why they are absent, so these look for
// the CALL rather than the mention.
check('with no client retry wrapper', !/=\s*await withEngineRetry\(/.test(nb2Branch));
// It DOES read the queue's verdict back — that is not a client-side fallback, it is believing the
// server's answer about which engine ran. What it must not do is issue its own Seedream call.
check('and no client-side Seedream fallback call', !/runEdit\(\{[^}]*tags: \[\.\.\.eddyTags/.test(nb2Branch));
check('but it does read the queue verdict, so a fallback is labelled and priced honestly',
  nb2Branch.includes("if (data.fellBack || data.model === 'seedream5') {")
  && nb2Branch.includes("engineLabel = 'Seedream 5.0 Pro Edit (fallback)';"));
check('the reason is written down', /queue already does both, and better/.test(page));
check('an empty result is still a failure rather than a blank tile', nb2Branch.includes("throw new Error('Nano Banana 2 (bypass) returned no image')"));
// The WaveSpeed branch keeps ITS retry and fallback — that one is not on the queue's bypass path.
check('the WaveSpeed branch is untouched', page.includes('data = await withEngineRetry(callNano2, { attempts: NANO2_ATTEMPTS });'));

// --- THE DEFAULT ---------------------------------------------------------------------------------
// Owner, 2026-08-17: "by default nb2 gemini bypass selected". On ARRIVAL only, so choosing WaveSpeed
// while you are on the tab sticks for the session — the same shape as Eddy-arrives-on-Seedream.
check('Max Nano arrives on the bypass', page.includes("if (maxNano) setEngine('nb2');"));
// Deps [maxNano], NOT [maxNano, engine] — an arrival default that re-fires on every engine change
// is a lock, and you could never switch to WaveSpeed at all.
check('and that effect depends on the TAB, not the engine — or it could never be changed', (() => {
  const i = page.indexOf("if (maxNano) setEngine('nb2');");
  return i > -1 && page.slice(i, i + 120).includes('}, [maxNano]);');
})());
check('a separate guard still rejects anything that is not a Nano Banana route',
  page.includes("if (maxNano && engine !== 'nano2' && engine !== 'nb2') setEngine('nb2');"));

// --- A LABEL PER IMAGE, which is what fixes the wrong-room bug on this API ---------------------------
//
// ⚠️ Owner, 2026-08-17: "it still using ... make sure it using the pose from the pose image not
// fcking background etc" — after the prompt-side fix.
//
// The prompt names the images ("image 2 is a POSE DIAGRAM, not a person") and on WaveSpeed that is
// enough. On Google's API it is not, and nanoBypassService's own comment already said why: sent as
// an undifferentiated pile followed by a wall of text, nothing ties a number in the prose to the
// bytes that arrived, so it edits whichever photo is most salient. A pose diagram IS a full
// photograph of a room and a person — and so is the base photo.
check('the service can label each image where it sits', svc.includes('if (Array.isArray(labels) && labels.length && !n) {'));
check('with the position stated, not the rules restated', svc.includes('parts.push({ text: `[Image ${i + 1} — ${label}]` });'));
check('Eddy sends one label per image', page.includes('const labels = payload.map((_, i) => {'));
check('built from the SAME indices the prompt uses, so the two cannot disagree',
  page.includes('if (at === poseIndex)') && page.includes('if (at === faceIndex)') && page.includes('if (at === outfitIndex)'));
check('and the pose diagram is told what it is NOT',
  page.includes('Its room, walls, floor, furniture and props are NOT the scene'));
check('while image 1 is told it IS the scene',
  page.includes('THE SUBJECT AND THE SETTING — she is the woman to render, and this room is the scene'));
check('the label travels through the queue', queue.includes('payload: { images, prompt, aspectRatio, resolution, model, provider, identityCount, labels },'));
check('and the reconciler hands it to the bypass', rec.includes('labels: Array.isArray(job.payload?.labels) ? job.payload.labels : null,'));
// identityCount and labels are two answers to the same question; running both would double-label.
check('labels and identityCount are mutually exclusive', svc.includes('labels.length && !n'));

// --- identityCount is deliberately NOT sent ----------------------------------------------------------
// That option makes the bypass label leading images "the person" and the rest "the scene", which is
// Photo Match's shape. Eddy's images are base photo, pose diagram, face close-up, outfit — identity
// is not a leading block, and its prompt already names every image by number.
check('Eddy sends no identityCount', !nb2Branch.includes('identityCount'));
check('and the service treats its absence as "no labels, just images"',
  svc.includes('const n = Math.max(0, Math.min(Number(identityCount) || 0, images.length - 1));')
  && svc.includes('} else {\n    for (const img of images) parts.push(asPart(img));'));
check('the reason is recorded on the page', /identity is not a leading block/.test(page));

// --- money and lanes --------------------------------------------------------------------------------
check('the bypass is priced like the model it is', page.includes("((engine === 'nano2' || engine === 'nb2')"));
check('and uses the queue-backed lane count, not the browser one',
  page.includes("const parallelFor = (engine) => ((engine === 'nano2' || engine === 'nb2') ? NANO2_PARALLEL_REQUESTS : PARALLEL_REQUESTS);"));
check('a finished picture names the route that made it', page.includes("engine === 'nb2' ? 'Nano Banana 2 (Gemini bypass)'"));
check('and a fallback still says Seedream', page.includes("const who = (engine === 'nano2' || engine === 'nb2') && !usedFallback ? 'Nano Banana 2' : 'Seedream';"));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
