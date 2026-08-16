// What Photo Match (Seedream) actually asks the model for.
//
// Owner, 2026-08-11: "it copies the face of the source photo and adds makeup." Both were in the
// prompt. The Seedream builder was cut down to fit ByteDance's undocumented length cap and it lost
// the identity rules the Gemini route has carried for months -- and the line that replaced them,
// `makeup (keep bold/dark lips)`, was an unconditional order to paint dark lipstick on a character
// who may wear none. We were asking for the bug.
//
// This runs the REAL builder over real flag combinations. A grep would only prove the words are in
// the file; what matters is what comes out the other end, and that it still fits the cap.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// Lift the builder and the one constant it reads out of the page — no React, no bundler.
const nudeLine = /const NUDE_LINE = (`[\s\S]*?`|'[^']*');/.exec(src);
const fnStart = src.indexOf('export function buildMatchInstruction');
const fnEnd = src.indexOf('\n}\n', fnStart) + 3;
const body = src.slice(fnStart, fnEnd).replace('export function', 'function');
// The builder reads two module constants. Both are lifted with it, so this runs the REAL text —
// injecting a stand-in for LIGHTING_LINE would let the file pass while the app shipped something
// else entirely.
const lightingLine = /const LIGHTING_LINE = ('[^']*');/.exec(src);
// eslint-disable-next-line no-new-func
const buildMatchInstruction = new Function(
  `const NUDE_LINE = ${nudeLine ? nudeLine[1] : "''"};
   const LIGHTING_LINE = ${lightingLine ? lightingLine[1] : "''"};
   ${body}; return buildMatchInstruction;`,
)();

const BASE = {
  characterName: 'Chloe', refCount: 1, masterPrompt: '', exactRecreate: false, varyBackground: false,
  allowExpressionChange: false, allowHairChange: false, allowBodyChange: false, allowLightingChange: false,
  faceless: false, wantsNude: false, addGenericNudeLine: false, sourceFaceBlurred: true,
};
const p = buildMatchInstruction(BASE);

// --- the two symptoms ---------------------------------------------------------------------------
check('the model is told not to BLEND the two faces — an averaged face IS "it copied the source"',
  /NO BLENDING/.test(p) && /do not mix, merge or average/.test(p));
check('the output face is claimed as 100% hers, not a midpoint', /100% image 1, not a midpoint/.test(p));
check('the source face is forbidden part by part, not just described as "scene only"',
  /FORBIDDEN from image 2:/.test(p) && /facial structure, eyes, nose, mouth, jaw/.test(p));
check('her likeness wins any conflict outright', /discard her entirely, face and figure alike, and when in doubt copy image 1/.test(p));

// --- the makeup line that CAUSED the second half of the complaint ------------------------------------
check('the unconditional "keep bold/dark lips" order is gone', !/makeup \(keep bold\/dark lips\)/.test(p));
check('makeup now comes from HER references', /MAKEUP: exactly as in image 1 — lips, eyes, lashes, brows/.test(p));
check('bold shades are protected only IF she wears them', /Keep a bold or dark lip if she wears one/.test(p));
check('and adding makeup she does not wear is refused outright',
  /do not ADD makeup she is not wearing/.test(p));
check('makeup may never be taken from the source photo', /never take it from image 2/.test(p));

// --- tattoos, which the Gemini route has always blocked ---------------------------------------------
check('the stand-in\'s ink does not travel', /any tattoo, ink or skin marking/.test(p));
// CHANGED 2026-08-16: the rule is ABSOLUTE now, not a comparison. It used to say 'she has only the
// tattoos visible in her reference images', which is a PERMISSION — it tells the model tattoos are
// part of her whenever a reference happens to show one, and leaves the door open to inventing a
// plausible one. The owner does not want them at all ('we never wanna have tattos'), and an
// absolute is also far harder to talk a model out of than a comparison between two photographs.
check("no tattoos at all — not the source's, not hers, not invented",
  /NO TATTOOS: [^]*?clean unmarked skin/.test(p) && /Never copy one from[^]*?or invent one/.test(p));

// --- THE CONSTRAINT THAT CAUSED THE CUT ---------------------------------------------------------------
// Measured on the live model: 420 chars works, 5,386 returns "The text length cannot exceed the
// maximum limit" -- a 422 that kills the whole batch before an image exists. Every rule added here
// has to survive inside the budget, on the WORST case, or this fix trades one bug for a dead page.
const BUDGET = Number(/const SEEDREAM_PROMPT_BUDGET = (\d+);/.exec(src)[1]);
check('the budget is still declared', BUDGET === 3000);
const worst = buildMatchInstruction({
  ...BASE, refCount: 4, exactRecreate: true, varyBackground: true, wantsNude: true,
  addGenericNudeLine: true, masterPrompt: 'x'.repeat(200),
});
check(`the everyday prompt fits (${p.length} chars)`, p.length <= BUDGET);
check(`the worst case still fits (${worst.length} chars)`, worst.length <= BUDGET);
// CHANGED 2026-08-16: this was `BUDGET - worst.length > 250`, a fixed margin standing in for "the
// chips will fit". That was never the mechanism — promptFor passes the builder a REDUCED budget
// (BUDGET minus the chip text) and the builder drops whole paragraphs to fit inside it. The margin
// only ever worked while the prompt happened to be short enough, and it went red when the skin
// instruction landed even though nothing was actually at risk. Asserted against the real behaviour
// now: give it a chips-sized reduction and the two together must still fit.
const CHIPS = 'x'.repeat(400);
const withChips = buildMatchInstruction({
  ...BASE, refCount: 4, exactRecreate: true, varyBackground: true, wantsNude: true,
  addGenericNudeLine: true, masterPrompt: 'x'.repeat(200), budget: BUDGET - CHIPS.length - 8,
});
check(`the builder makes room for the chips when told to (${withChips.length} + ${CHIPS.length})`,
  withChips.length + CHIPS.length + 2 <= BUDGET);

// --- it must read as a REBUILD, not a face swap (owner, 2026-08-13) ---------------------------------
// "It's like a faceswap but we want to recreate the same image with our model." It was: the prompt
// said FACE five times and gave the body one clause at the end, so the model swapped a face onto
// the stand-in's body. It was doing what it was asked.
check('the wrong answer is named outright', /A body from image 2 with only the face changed is WRONG/.test(p));
check('it is told not to edit the source at all', /REBUILD, DO NOT EDIT/.test(p));
check('and that the stand-in is not in the output', /she is not in the output/.test(p));
check('the body is named part by part, not as one word',
  /neck, shoulders, arms, hands, torso, waist, hips, legs, height and build/.test(p));
check('NO BLENDING covers the body too, not just the face', /not her face and not her body/.test(p));
check('the final lock leads with rendering her from scratch', /render the person from scratch as Chloe/.test(p));
check('and discards the stand-in face AND figure', /discard her entirely, face and figure alike/.test(p));
// The balance is the actual bug. Counted, not eyeballed.
const faceWords = (p.match(/face/gi) || []).length;
const bodyWords = (p.match(/body|figure|torso|hips|legs|shoulders|build/gi) || []).length;
check(`the prompt no longer talks only about the face (${faceWords} face / ${bodyWords} body)`, bodyWords >= faceWords);

// --- the cap is Seedream's, not Nano's --------------------------------------------------------------
check('Nano gets its own budget', src.includes('const NANO2_PROMPT_BUDGET = 8000;'));
// CHANGED 2026-08-16: phrased by the engine that HAS the cap rather than the one that does not.
// The 3,000 limit is ByteDance's, and Seedream is the only engine behind ByteDance — both Nano
// paths (WaveSpeed and the Gemini bypass) are uncapped, so naming Seedream is the durable form.
check('and the trim picks by engine', src.includes("const budget = engine === 'seedream' ? SEEDREAM_PROMPT_BUDGET : NANO2_PROMPT_BUDGET;"));
check('the reason is recorded — WaveSpeed documents no cap for nano',
  /WaveSpeed documents no prompt-length cap/.test(src));
check('and the trim notice no longer blames Seedream on a Nano run',
  src.includes('the model rejects longer prompts'));

// --- the flags still do what they say ----------------------------------------------------------------
const faceless = buildMatchInstruction({ ...BASE, faceless: true });
check('faceless drops the makeup line — there is no face to make up', !/MAKEUP:/.test(faceless));
check('but still forbids the source identity', /FORBIDDEN from image 2:/.test(faceless));
check('and still refuses to blend', /NO BLENDING/.test(faceless));
check('faceless keeps her face OUT rather than promising a likeness',
  /her face is intentionally OUT of the shot/.test(faceless) && !/MUST be recognisably/.test(faceless));

const bodyFree = buildMatchInstruction({ ...BASE, allowBodyChange: true });
check('a body chip stops the prompt pinning her body — or the two would cancel',
  !/body shape/.test(bodyFree.split('FORBIDDEN from')[1] || ''));
check('a body chip does NOT loosen the face', /NO BLENDING/.test(bodyFree));

const multi = buildMatchInstruction({ ...BASE, refCount: 4 });
check('several references are addressed as a range', /images 1-4 = Chloe/.test(multi));
check('and the source index moves with them', /image 5 = a photograph of a DIFFERENT woman/.test(multi));

// --- the ordering Seedream actually weights -----------------------------------------------------------
// The tail carries the most weight, which is why the locks live at the end.
check('the identity lock is in the last third of the prompt', p.lastIndexOf('FINAL — HIGHEST PRIORITY') > p.length * 0.6);
check('the no-blend rule sits near it', p.lastIndexOf('NO BLENDING') > p.length * 0.5);

// --- where the results are filed (owner, 2026-08-12) ------------------------------------------------
// "Let me choose between normal library and base library before I press generate." The two are
// separate IndexedDB collections behind the tabs of the same name.
check('both destinations are offered', src.includes("{ value: 'eddy-library', label: 'Library' }")
  && src.includes("{ value: 'eddy-base', label: 'Base Library' }"));
check('the picker is in the Settings box, before Generate', src.includes('label="Send results to"'));
check('the choice is remembered between runs', src.includes("localStorage.getItem('kyros.photoMatch.dest')"));
check('and defaults to Library, where every previous match went', src.includes(": 'eddy-library';"));
check('an unknown saved value falls back rather than filing nowhere',
  src.includes('DESTINATIONS.some((d) => d.value === saved)'));
check('the result is filed into the CHOSEN store, not always the Library',
  src.includes('await destStore.ensureFolder(') && src.includes('await destStore.addItems(['));
check('her folder is made in that same collection', !src.includes('libraryStore.ensureFolder'));
check('the storage-full message names where it failed to file', src.includes('but not in ${destLabel}'));
check('and the handler still recognises that message',
  src.includes("includes('is in the gallery but not in ')"));
check('the page says where the next run will land', src.includes('Files into'));

// --- whose outfit (owner, 2026-08-13) ----------------------------------------------------------------
// "I need the option to choose between keeping the outfit from the model in the base image, or the
// outfit from the source photo." The default is the scene's, which is what Photo Match has always
// done; the other half of the job is keeping the scene and the pose while she wears her own.
const hers = buildMatchInstruction({ ...BASE, outfitFromChar: true });
check('by default the outfit still comes from the scene', /From image 2: background, pose, hands\/props, outfit/.test(p));
check('and is NOT claimed as part of her identity', !/the exact clothing she is wearing/.test(p));

check('with the option on, the outfit leaves the scene list',
  /From image 2: background, pose, hands\/props, expression/.test(hers) && !/hands\/props, outfit/.test(hers));
check('and joins what must be matched from her references', /the exact clothing she is wearing/.test(hers));
check('it is said outright as well, since it reverses the page default', /OUTFIT: she wears HER OWN clothing/.test(hers));
check('the scene photo is told its outfit does not appear', /that outfit is not in the output/.test(hers));
check('and everything else still comes from the scene', /Everything else still comes from image 2/.test(hers));
check('the source garment is added to the FORBIDDEN list', /skin tone, body shape, its clothing/.test(hers));

// The tail lock explains a tight garment as correct — which is nonsense when the garment is hers.
check('the bust lock stops blaming the scene outfit', /her own outfit sits on her exactly as it does there/.test(hers));
// One reference reads "image 1", several read "images 1-5" — accept either.
check('and still keeps her true proportions', /come from images? 1(-\d)? at their true size/.test(hers));

// Exact recreate promises the source outfit; it must not promise it when she brings her own.
const exactHers = buildMatchInstruction({ ...BASE, exactRecreate: true, outfitFromChar: true });
check('exact recreate drops "outfit" from what it reproduces', !/same background, pose, props, framing, lighting, outfit/.test(exactHers));
check('and says which outfit she wears instead', /wearing HER outfit from image 1 rather than the one in image 2/.test(exactHers));

// Nude wins over both — there is no garment either way.
const nude = buildMatchInstruction({ ...BASE, outfitFromChar: true, wantsNude: true });
check('nude ignores the outfit choice entirely', !/OUTFIT: she wears HER OWN clothing/.test(nude));
check('and the control is hidden rather than left doing nothing', src.includes('{!nsfw && ('));
check('the reason that guard uses nsfw and not wantsNude is recorded',
  /does not exist at render time/.test(src));

check(`both variants fit the budget (scene ${p.length}, hers ${hers.length})`,
  p.length <= BUDGET && hers.length <= BUDGET && exactHers.length <= BUDGET);
check('the page says which one is in force', src.includes('she wears HER outfit from her reference photos'));

// --- the house lighting line, on every prompt (owner, 2026-08-13) ------------------------------------
const LIGHT = 'Lighting: Lighting is soft and diffused lighting, glowing naturally on her skin';
check('it is there, verbatim', p.includes(LIGHT));
for (const [name, opts] of [['faceless', { faceless: true }], ['nude', { wantsNude: true }],
  ['exact recreate', { exactRecreate: true }], ['her outfit', { outfitFromChar: true }],
  ['eyes to camera', { lookAtCamera: true }]]) {
  check(`and on the ${name} variant too`, buildMatchInstruction({ ...BASE, ...opts }).includes(LIGHT));
}
check('it sits BEFORE the chips, so a Lighting chip still wins by position',
  /Deliberately placed BEFORE the chips/.test(src));
check('the wording is a constant, not retyped per branch', src.includes('const LIGHTING_LINE ='));

// --- eyes to camera ------------------------------------------------------------------------------------
const eyes = buildMatchInstruction({ ...BASE, lookAtCamera: true });
check('off by default', !/EYES TO CAMERA/.test(p));
check('on, it says where she looks', /EYES TO CAMERA: she looks straight into the lens/.test(eyes));
check('the pose is explicitly kept — only the head turns', /Keep the pose and body angle from image 2/.test(eyes));
check('and the scene stops supplying the expression, or the two cancel',
  !/hands\/props, outfit, expression/.test(eyes) && /hands\/props, outfit, lighting/.test(eyes));
check('never on a faceless result', !/EYES TO CAMERA/.test(buildMatchInstruction({ ...BASE, faceless: true, lookAtCamera: true })));
check('and the toggle is hidden there too', src.includes('{!faceless && <Toggle checked={lookAtCamera}'));

// --- still fighting the face swap ------------------------------------------------------------------------
check('the instruction names the MECHANISM, not just the outcome',
  /Do NOT reuse the pixels of the woman in image 2 or repaint a face onto her/.test(p));
check('and the final lock says render from scratch', /render the person from scratch as Chloe/.test(p));

// --- the prompt fits by DROPPING, never by slicing the tail -------------------------------------------------
// The tail is the identity lock. Measured 2026-08-13: the longest prompt was 3,094 against a 3,000
// cap, so a plain slice would have cut that lock in half.
const worstOpts = { ...BASE, refCount: 5, exactRecreate: true, varyBackground: true, outfitFromChar: true,
  lookAtCamera: true, masterPrompt: 'x'.repeat(200) };
const unbounded = buildMatchInstruction(worstOpts);
const fitted = buildMatchInstruction({ ...worstOpts, budget: 3000 });
check(`the worst case really does exceed the cap unbounded (${unbounded.length})`, unbounded.length > 3000);
check(`and fits once a budget is given (${fitted.length})`, fitted.length <= 3000);
check('the identity lock SURVIVES the fit', /FINAL — HIGHEST PRIORITY/.test(fitted));
check('so does the lighting line', fitted.includes(LIGHT));
check('so does eyes to camera', /EYES TO CAMERA/.test(fitted));
check('what came out is the boilerplate, whole', !/Photorealistic —/.test(fitted));
// A budget below what the load-bearing paragraphs alone cost cannot be met by dropping — there is
// nothing left that is safe to drop. It sheds everything optional, keeps the lock, and leaves the
// remainder to the caller's slice. Asserting `<= 2400` here would be asserting the impossible.
check('a tight budget sheds everything optional and still keeps the lock', (() => {
  const tiny = buildMatchInstruction({ ...worstOpts, budget: 2200 });
  return /FINAL — HIGHEST PRIORITY/.test(tiny)
    && !/Photorealistic —/.test(tiny)
    && !tiny.includes('CAMERA: reproduce')   // NOT /CAMERA:/ — that also matches EYES TO CAMERA:
    && !/^Chloe: x/m.test(tiny)
    && tiny.length < unbounded.length;
})());
check('the caller passes its real budget, minus the chips it appends after',
  src.includes('budget: Math.max(600, (engine === ') && src.includes('- extra.trim().length - 8)'));

// --- exact recreate is the DEFAULT (owner, 2026-08-15: "exact recreate always toggle on") --------
// Off, the prompt tells the model "a new photo of her in that scene, NOT a retouch" — loose on
// purpose, because that looseness is what stops a faceswap, and the cost is a rebuilt scene rather
// than a preserved one. On, the same rebuild applies to the PERSON while the scene is pinned.
check('exactRecreate defaults ON', /exactRecreate: true/.test(src));
check('and it is not silently overridden by a stored value — only sources/characterIds/extra persist',
  src.includes("store.get('sources', []), store.get('characterIds', null), store.get('extra', '')")
  && !/store\.set\('exactRecreate'/.test(src));

const onParts = buildMatchInstruction({ characterName: 'Grace', refCount: 5, masterPrompt: '', sourceFaceBlurred: true, exactRecreate: true, budget: 3000 });
const offParts = buildMatchInstruction({ characterName: 'Grace', refCount: 5, masterPrompt: '', sourceFaceBlurred: true, exactRecreate: false, budget: 3000 });
check('ON pins the scene explicitly', /Reproduce image \d+ exactly — same background, pose, props, framing, lighting, outfit/.test(onParts));
check('and drops the looser "not a retouch" line that replaces it', !/not a retouch of image/.test(onParts));
check('OFF still carries the looser line, so the toggle really is the difference', /not a retouch of image/.test(offParts));
// The anti-faceswap rebuild must survive BOTH ways — pinning the scene must never pin the person.
check('the person is still rebuilt from scratch with exact recreate on', /REBUILD, DO NOT EDIT/.test(onParts));
check('and the identity lock is still there', onParts.includes('FINAL — HIGHEST PRIORITY'));

// --- the blur flag must describe THIS photo, not the switch --------------------------------------
//
// blurSource is 'try to blur'. The detector misses turned and partly-hidden faces — the amber
// 'FACE - TAP' badge is exactly that — so runs with the switch on still ship sharp faces regularly.
// Reading the switch announced a blur that was not there AND said nothing about the real, well-lit
// face still in the frame, which is the one the model then kept (owner, 2026-08-16).
check('the flag comes from the photo, not the toggle', src.includes('sourceFaceBlurred: !!source?.blurred,'));
check('the old page-level read is gone', !src.includes('sourceFaceBlurred: blurSource,'));
const unblurred = buildMatchInstruction({ ...BASE, sourceFaceBlurred: false });
const blurred = buildMatchInstruction({ ...BASE, sourceFaceBlurred: true });
check('an unblurred source is named as carrying a rival face', /belongs to a DIFFERENT woman/.test(unblurred));
check('and it is not claimed to be blurred', !/deliberately blurred/.test(unblurred));
check('a blurred source still gets the blur note', /deliberately blurred/.test(blurred));
check('and is not also told there is a visible face', !/belongs to a DIFFERENT woman./.test(blurred.split('deliberately blurred')[1] || ''));
// A faceless run says the face is out of shot entirely, so neither line applies.
check('a faceless run gets neither', (() => {
  const f = buildMatchInstruction({ ...BASE, faceless: true, sourceFaceBlurred: false });
  return !/belongs to a DIFFERENT woman/.test(f) && !/deliberately blurred/.test(f);
})());

// --- her BODY, not only her face -------------------------------------------------------------------
// The original failure this page was built around: a faceswap onto the stand-in's body.
check('the identity list names the whole body, part by part',
  /torso, waist, hips, legs, height and build/.test(unblurred));
check("the stand-in's body shape is forbidden", /body shape/.test(unblurred));
check('no blending of bodies, not just faces', /not her face and not her body/.test(unblurred));
check('and the final lock says whole body', /face, hair, skin and whole body/.test(unblurred));

// --- quality: 2K by default, and a POSITIVE skin instruction ---------------------------------------
//
// The old line was 'Photorealistic — real pores, hair strands, fabric, slight asymmetry; no plastic
// or CGI look' — mostly a list of things NOT to do. A negative leaves the model to choose what to do
// instead, and what it chooses is the smooth, evenly-lit, retouched look that reads as AI at a
// glance (owner, 2026-08-16: 'scale up the quality of skin and image').
check('the skin instruction names what to render, not only what to avoid',
  /SKIN AND DETAIL: real pore texture, stray hairs, uneven specular/.test(src));
check('including the specular detail that separates a photo from a render',
  /shiny where oily, matte elsewhere, never one even sheen/.test(src));
check('and blemishes are kept rather than retouched', /Keep freckles, moles and uneven tone/.test(src));
check('2K is the default resolution', /const _cache = {[^}]*resolution: '2K'/.test(src));

// It stays the FIRST thing dropped at the cap — it improves a picture that is already of the right
// woman, and the identity lock decides whether she is. So it must be short enough to survive an
// ordinary run, which is what made the first attempt useless: at 640 characters it was dropped every
// single time.
check('the droppable marker follows the paragraph name',
  src.includes("const droppable = ['SKIN AND DETAIL',"));
check('and it is short enough to survive a normal run', (() => {
  const start = src.indexOf('parts.push(`SKIN AND DETAIL:');
  if (start < 0) return false;
  const end = src.indexOf('`);', start);
  return end > start && (end - start) < 300;
})());

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
