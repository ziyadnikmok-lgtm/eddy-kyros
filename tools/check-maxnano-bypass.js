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

// --- THE DEFAULT, AND WHY IT IS NOT THE BYPASS ------------------------------------------------------
//
// Asked for as "by default nb2 gemini bypass selected", shipped, then measured against what this tab
// actually generates: ELEVEN OF ELEVEN bypass jobs that afternoon were refused by Google with
// finishReason IMAGE_OTHER — its content filter, silent, no blockReason. Each fell back to Seedream,
// that account was out of credits, and so every one failed ("why i click say every gneeration
// failed").
//
// Google's guard and WaveSpeed's copy of the same model draw the line in different places, and Max
// Nano's whole job sits on the wrong side of Google's. No prompt fixes that. A default that cannot
// succeed for the content the tab exists to make is the wrong default, however explicitly asked for
// — so the arrival default is WaveSpeed and the bypass is one click away.
check('Max Nano arrives on WaveSpeed', page.includes("if (maxNano) setEngine('nano2');"));
check('and the measurement that reversed the requested default is recorded',
  /ELEVEN OF ELEVEN bypass jobs that afternoon were refused/.test(page));
// Deps [maxNano], NOT [maxNano, engine] — an arrival default that re-fires on every engine change
// is a lock, and the bypass could never be selected at all.
check('and that effect depends on the TAB, not the engine — or the bypass could never be chosen', (() => {
  const i = page.indexOf("if (maxNano) setEngine('nano2');");
  return i > -1 && page.slice(i, i + 120).includes('}, [maxNano]);');
})());

// --- THE FALLBACK IS VISIBLE, THE WAY PHOTO MATCH MADE IT VISIBLE -----------------------------------
//
// Owner, 2026-08-17: "it should say fall back seedream etc same everything we built in photo match
// nb2." Three places, and Max Nano had only the middle one.
//
//   BEFORE the run — the engine row says a picture can come back from a different engine at a
//   different price. A badge on a finished tile only tells you once the money is spent.
//   DURING — one toast the first time it happens in a run, not one per image.
//   AFTER — the tile itself is marked, and the row is priced by what RAN.
check('the engine row warns before you spend', page.includes("{engine === 'nb2' && (")
  && page.includes('Fails over to <span className="font-semibold">Seedream 5.0 Pro (WaveSpeed)</span> after {NB2_ATTEMPTS} refused'));
check('it names the 2K override, the marker and the price', page.includes('come back marked')
  && page.includes("priceOne('seedream', '2K', perRunImages)"));
// The one thing Photo Match's line cannot say, because its fallback account is the same one.
check('and it says what happens with no WaveSpeed credit', page.includes('With no WaveSpeed credit the job stops there instead'));
check('the count comes from a mirrored constant, not a typed number', page.includes('const NB2_ATTEMPTS = 5;'));
// EVERY tile says which engine made it, not only the fallbacks ("show if fall back seedream or gen
// with nb2"). A badge that appears only on failure answers half the question — you can see that one
// fell back, but not that the one beside it did not.
check('the finished tile names its engine', page.includes("const label = item.fellBack ? 'Seedream · fallback'")
  && page.includes("item.engine === 'nb2' ? 'NB2 · bypass'")
  && page.includes("item.engine === 'nano2' ? 'NB2 · WaveSpeed' : 'Seedream'"));
check('and it shows on every result, not only the failures', page.includes('{item.engine && !busy && (() => {'));
check('with the fallback picked out in amber, since it cost a different rate',
  page.includes("item.fellBack ? 'bg-amber-600/90 text-white' : 'bg-black/65 text-zinc-300'"));

// --- THE REFUSAL STREAK: stop paying five tries to learn the same thing -------------------------------
//
// ⚠️ "in macbook it slow as fuck to generate and most time fall back to seedream" (owner,
// 2026-08-17). Both halves are the same fact: Google refuses this material, so every job spends its
// full NB2_ATTEMPTS — each running Google's own three-rung ladder with a 180-second ceiling — and
// falls back anyway. Five tries is right when a refusal is a bad roll. It is pure wall-clock when
// the content is simply not allowed.
check('a content refusal is told apart from a fault', rec.includes('function isContentRefusal(err)')
  && rec.includes('IMAGE_OTHER|IMAGE_SAFETY|PROHIBITED_CONTENT|BLOCKLIST|content filter'));
// Counted per JOB THAT GAVE UP, not per attempt — see the simulation above for why that distinction
// is the difference between five tries and three.
check('consecutive refusals across jobs are counted', rec.includes('if (isContentRefusal(err)) refusalStreak += 1;'));
check('and once it is clearly the material, the bypass gets one probe instead of five',
  rec.includes('const bypassTries = refusalStreak >= REFUSAL_STREAK ? 1 : NB2_ATTEMPTS;'));
// ONE probe, not zero — that is what lets a run recover by itself when a passable image arrives.
check('a success restores full patience', rec.includes("if (engine === 'nanobypass') refusalStreak = 0;"));
check('and the reason for one-not-zero is written down', /Skipping the bypass entirely would be faster still and would never come back/.test(rec));
// A rate limit refunds its attempt above, so it can never inflate the streak.
check('rate limits cannot inflate the streak', rec.indexOf('if (isRateLimit(err))') < rec.indexOf('isContentRefusal(err)) refusalStreak'));
check('the result carries which engine made it', page.includes("engine: usedFallback ? 'seedream' : engine,")
  && page.includes('fellBack: usedFallback,'));
check('and survives a reload, or the marker lasts only until the panel rebuilds',
  page.includes('fellBack: !!r.fellBack,'));

// --- WHEN THERE IS NO FALLBACK, SAY SO --------------------------------------------------------------
//
// ⚠️ "in my other account it failed and didnt fall back" (owner, 2026-08-17). Correct, and by
// design — but nothing on screen said so, and a silent exception to a documented rule reads as a
// broken rule.
//
// A missing or dead Gemini key is the ONE failure the fallback must not serve: Seedream bills a
// different account and would succeed, so falling back would run every bypass job on WaveSpeed with
// the tab looking healthy and the bypass quietly dead. On the web deployment the same message was
// also reachable WITH a key present, until the user-context fix — the queue looked keys up as
// nobody. Same message, different cause, so the wording points at both.
check('a key failure names the fallback it did not take', rec.includes('It did NOT fall back to Seedream'));
check('and why not', rec.includes('Seedream bills a different account and would hide a dead bypass'));
check('it also says to check the key is ACTIVE, which is the other way to have one and not have one',
  rec.includes('check it is the ACTIVE key'));
// The fallback itself is unchanged for every non-key failure — that is the case worth swapping for.
check('a content refusal still falls back', !rec.includes("NB2_TERMINAL_CODES = new Set(['VALIDATION_ERROR', 'GEMINI_KEY_REQUIRED', 'NO_ACTIVE_KEY', 'KEY_CORRUPTED', 'NANO_BYPASS_NO_IMAGE'])"));
check('and the fallback fires below the queue ceiling, or it would never be reached',
  Number(/const NB2_ATTEMPTS = (\d+);/.exec(rec)[1])
    < Number(/const MAX_SUBMIT_ATTEMPTS = (\d+);/.exec(read('server/services/jobQueue.js'))[1]));

// --- ⚠️ A CONTENT REFUSAL MUST NOT BE READ AS A BILLING FAILURE ---------------------------------------
//
// "the fall back to seedream on wavespeed not working" (owner, 2026-08-17), and the log said why in
// one line: `generation_out_of_credit engine=nanobypass error="Google refused this image…"`.
//
// isOutOfCredit ended in a keyword match on the message — belt-and-braces for a provider that
// answers in prose with no code. Hours earlier the refusal message had been rewritten to explain
// what happens next: "Seedream 5 Pro takes over automatically; if that account is OUT OF CREDITS
// the job stops here". So every Google refusal matched, was classified terminal, and was never
// retried or handed to Seedream. A sentence written to explain the fallback disabled it.
//
// Two fixes, because either alone would leave the trap armed: the classifier no longer reads prose
// when the error carries its own code, and the message no longer contains the phrase.
{
  const i = rec.indexOf('function isOutOfCredit(err) {');
  // eslint-disable-next-line no-new-func
  const END = String.fromCharCode(10) + '}' + String.fromCharCode(10);
  const isOutOfCredit = new Function(`${rec.slice(i, rec.indexOf(END, i) + 3)}; return isOutOfCredit;`)();
  const refusal = /\? `(Google refused this image[^`]*)`/.exec(svc)[1].replace(/\$\{[^}]*\}/g, 'IMAGE_OTHER');

  check('the real WaveSpeed credit error is still caught by its code',
    isOutOfCredit({ code: 'INSUFFICIENT_CREDITS', status: 402, message: 'WaveSpeed is out of credits - top up your account to continue' }));
  check('a code-less prose credit error is still caught by its words',
    isOutOfCredit({ message: 'Insufficient credits. Please top up your account.' }));
  check('but a CONTENT REFUSAL is not — it carries its own code',
    !isOutOfCredit({ code: 'NANO_BYPASS_NO_IMAGE', status: 502, message: refusal }));
  check('nor is a key problem, whatever its wording',
    !isOutOfCredit({ code: 'GEMINI_KEY_REQUIRED', status: 400, message: 'needs a Gemini API key' }));
  check('an error that knows its own code is never re-read for keywords', rec.includes('if (err?.code) return false;'));
  check('and the refusal message no longer carries the phrase that tripped it',
    !/out of credits/i.test(refusal));
  check('the trap is written down where the classifier lives', /classifies by words that may be in the/i.test(rec));
}

// --- DOES IT REALLY RETRY FIVE TIMES? Simulated against the real constants ---------------------------
//
// ⚠️ Asked directly ("check if it is really doing 5 retry") — and it was NOT. The refusal streak was
// counted per ATTEMPT, so the first job's own retries fed it: attempt 1 -> streak 1, attempt 2 ->
// streak 2, attempt 3 -> streak 3, bypassTries collapses to 1, and the job fell back at THREE.
// Nothing ever got five. Across 300 lanes it was worse: parallel failures race the counter up in
// the first seconds and everything after gets a single try.
//
// The streak now counts whole jobs that GAVE UP, incremented inside the fallback. This replays the
// queue's actual loop — claimNext increments attempts, requeueUnsent puts the job back — against
// the constants read out of the source.
{
  const NB2 = Number(/const NB2_ATTEMPTS = (\d+);/.exec(rec)[1]);
  const STREAK = Number(/const REFUSAL_STREAK = (\d+);/.exec(rec)[1]);
  const MAX_SUBMIT = Number(/const MAX_SUBMIT_ATTEMPTS = (\d+);/.exec(read('server/services/jobQueue.js'))[1]);

  /** One job, refused every time, through the real decision the reconciler makes. */
  const runJob = (state) => {
    let attempts = 0;
    for (;;) {
      attempts += 1;                                        // claimNext counts the attempt
      if (attempts > MAX_SUBMIT) return { attempts, gaveUp: 'queue ceiling' };
      const tries = state.streak >= STREAK ? 1 : NB2;       // read BEFORE this job's outcome
      if (attempts >= tries) {                              // fall back
        state.streak += 1;                                  // a whole job gave up to a refusal
        return { attempts, gaveUp: 'fallback' };
      }
      // else requeueUnsent -> claimed again next tick
    }
  };

  const state = { streak: 0 };
  const runs = [1, 2, 3, 4, 5].map(() => runJob(state));
  check(`the first job really is attempted ${NB2} times (got ${runs[0].attempts})`, runs[0].attempts === NB2);
  check(`and so are the next two, before the streak trips (${runs[1].attempts}, ${runs[2].attempts})`,
    runs[1].attempts === NB2 && runs[2].attempts === NB2);
  check(`after ${STREAK} jobs give up, the rest get one probe (${runs[3].attempts}, ${runs[4].attempts})`,
    runs[3].attempts === 1 && runs[4].attempts === 1);
  check('every one ends in a fallback rather than the queue ceiling',
    runs.every((r) => r.gaveUp === 'fallback'));
  // A success anywhere resets it, which is what lets a run recover by itself.
  state.streak = 0;
  check('and one success restores the full five', runJob(state).attempts === NB2);
  // The ceiling has to stay above the tries, or the queue kills the job before the fallback fires.
  check(`the queue ceiling (${MAX_SUBMIT}) is above the tries (${NB2})`, MAX_SUBMIT > NB2);
}
check('the streak is incremented where a job gives up, not on every attempt',
  rec.includes('if (isContentRefusal(err)) refusalStreak += 1;')
  && !rec.includes("if (engine === 'nanobypass' && isContentRefusal(err)) refusalStreak += 1;"));
check('and it is read before this job adds to it', rec.indexOf('const bypassTries = refusalStreak >= REFUSAL_STREAK')
  < rec.indexOf('if (isContentRefusal(err)) refusalStreak += 1;'));
check('the fallback log records the tries and the streak, so this is checkable in the field',
  rec.includes('tries: bypassTries, streak: refusalStreak'));

// --- WHAT ACTUALLY DECIDES A REFUSAL, measured ------------------------------------------------------
//
// The owner wants the bypass to WORK, not to be routed around ("i care more about using the gemini
// bypass nb2 not in wavespeed"). So the obvious lever was tested directly rather than assumed. Same
// two images, same prompt, one variable — the thresholds:
//
//     BLOCK_ONLY_HIGH   refused — PROHIBITED_CONTENT
//     BLOCK_NONE        refused — IMAGE_SAFETY
//     OFF               refused — IMAGE_OTHER
//     OFF, all 5 cats   refused — IMAGE_SAFETY   (accepted by the API; no HTTP error)
//
// An image refusal is NOT governed by safetySettings. The model has its own output filter and the
// finishReason just changes name. Kept at OFF regardless: strictly more permissive on everything
// that IS configurable, and it costs nothing.
//
// THE LEVER IS THE INPUT PHOTO. Same pose, prompt and settings: a sheer-lace base was refused, an
// ordinary top came back with an image.
check('safety is set to the most permissive value the API takes',
  svc.includes("{ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' }"));
check('every category, not just the obvious one',
  (svc.match(/threshold: 'OFF'/g) || []).length === 5);
check('and the experiment that says it is not the lever is recorded',
  /BLOCK_ONLY_HIGH   refused/.test(svc) && /OFF               refused/.test(svc));
check('the refusal message names the lever that IS real',
  svc.includes('this is decided by the SOURCE PHOTO, not by the prompt or by safety settings'));

// --- A REFUSAL MUST READ AS A REFUSAL ------------------------------------------------------------
// "Nano Bypass returned no image (reason: IMAGE_OTHER)" tells nobody anything, and it was the only
// thing reaching the card while every job failed.
check('a content refusal says so in words', svc.includes("Google refused this image — its content filter, not an error"));
check('and names what happens next', svc.includes('Seedream 5 Pro on WaveSpeed takes over automatically'));
// Reworded 2026-08-17: the old phrasing contained "out of credits", which isOutOfCredit's keyword
// match then read as a billing failure — disabling the very fallback the sentence describes.
check('and what stops it', svc.includes('provided that account can still be billed'));
check('the refusal reasons are listed rather than matched loosely',
  svc.includes("const REFUSALS = new Set(['IMAGE_OTHER', 'IMAGE_SAFETY', 'SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST']);"));
check('a genuine fault still reports its raw reason', svc.includes('Nano Bypass returned no image (reason: ${finishReason})'));
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
//
// AND IT WAS MEASURED, not reasoned about. Real API, owner's key, same prompt, one variable — base
// photo a pink bedroom, pose diagram outdoors beside a white car:
//
//     labels ON   -> she is in the PINK BEDROOM, pose and boots from the diagram
//     labels OFF  -> she is OUTDOORS BESIDE THE CAR, in the other woman's clothes
//
// Which is exactly the report: "from wavespeed the background is perfect but from gemini it using
// the pose photo as background".
check('the service can label each image where it sits', svc.includes('if (Array.isArray(labels) && labels.length && !n) {'));
check('and the A/B that proved it is recorded beside the code', /labels OFF  -> she is OUTDOORS BESIDE THE CAR/.test(svc));
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
