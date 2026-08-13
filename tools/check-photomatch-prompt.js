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
// eslint-disable-next-line no-new-func
const buildMatchInstruction = new Function(
  `const NUDE_LINE = ${nudeLine ? nudeLine[1] : "''"}; ${body}; return buildMatchInstruction;`,
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
check('her likeness wins any conflict outright', /Sacrifice image 2's likeness entirely to keep hers/.test(p));

// --- the makeup line that CAUSED the second half of the complaint ------------------------------------
check('the unconditional "keep bold/dark lips" order is gone', !/makeup \(keep bold\/dark lips\)/.test(p));
check('makeup now comes from HER references', /MAKEUP: exactly as Chloe wears it in image 1/.test(p));
check('bold shades are protected only IF she wears them', /If image 1 show a bold or dark lip, keep it/.test(p));
check('and adding makeup she does not wear is refused outright',
  /Do NOT add makeup she is not wearing/.test(p));
check('makeup may never be taken from the source photo', /never take her makeup from image 2/.test(p));

// --- tattoos, which the Gemini route has always blocked ---------------------------------------------
check('the stand-in\'s ink does not travel', /any tattoo, ink or skin marking/.test(p));
check('and hers is the only ink allowed', /Chloe has only the tattoos visible in image 1/.test(p));

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
check('and there is headroom left for the appended chips', BUDGET - worst.length > 250);

// --- it must read as a REBUILD, not a face swap (owner, 2026-08-13) ---------------------------------
// "It's like a faceswap but we want to recreate the same image with our model." It was: the prompt
// said FACE five times and gave the body one clause at the end, so the model swapped a face onto
// the stand-in's body. It was doing what it was asked.
check('the wrong answer is named outright', /A result where the body is hers from image 2 and only the face changed is WRONG/.test(p));
check('it is told not to edit the source at all', /REBUILD, DO NOT EDIT/.test(p));
check('and that the stand-in is not in the output', /She does not appear in the output at all/.test(p));
check('the body is named part by part, not as one word',
  /neck, shoulders, arms, hands, torso, waist, hips, legs, height and build/.test(p));
check('NO BLENDING covers the body too, not just the face', /not her face and not her body/.test(p));
check('the final lock leads with the PERSON', /the PERSON in the output is Chloe/.test(p));
check('and discards the stand-in face AND figure', /discard her completely, face and figure alike/.test(p));
// The balance is the actual bug. Counted, not eyeballed.
const faceWords = (p.match(/face/gi) || []).length;
const bodyWords = (p.match(/body|figure|torso|hips|legs|shoulders|build/gi) || []).length;
check(`the prompt no longer talks only about the face (${faceWords} face / ${bodyWords} body)`, bodyWords >= faceWords);

// --- the cap is Seedream's, not Nano's --------------------------------------------------------------
check('Nano gets its own budget', src.includes('const NANO2_PROMPT_BUDGET = 8000;'));
check('and the trim picks by engine', src.includes("const budget = engine === 'nano2' ? NANO2_PROMPT_BUDGET : SEEDREAM_PROMPT_BUDGET;"));
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

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
