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
  page.includes("if (maxNano && engine !== 'nano2' && engine !== 'nb2') setEngine('nano2');"));
check('and 2K follows either one', page.includes("if (engine === 'nano2' || engine === 'nb2') setResolution('2K');"));

// --- one path, not a copy -------------------------------------------------------------------------
check('it goes through the same queue call as everything else', page.includes("const model = body.model === 'nb2' ? 'nb2' : body.model === 'nano2' ? 'nano2' : 'seedream5';"));
check('the page never talks to the bypass itself', !page.includes('nanoBypass') && !page.includes('generativelanguage'));
check('the queue carries the model through', queue.includes('payload: { images, prompt, aspectRatio, resolution, model, provider, identityCount }'));
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
check('and no client-side Seedream fallback', !nb2Branch.includes('usedFallback = true;'));
check('the reason is written down', /queue already does both, and better/.test(page));
check('an empty result is still a failure rather than a blank tile', nb2Branch.includes("throw new Error('Nano Banana 2 (bypass) returned no image')"));
// The WaveSpeed branch keeps ITS retry and fallback — that one is not on the queue's bypass path.
check('the WaveSpeed branch is untouched', page.includes('data = await withEngineRetry(callNano2, { attempts: NANO2_ATTEMPTS });'));

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
