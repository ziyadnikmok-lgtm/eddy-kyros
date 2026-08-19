// A pair character puts TWO named women in ONE photograph — and does not disturb the single.
//
// Two halves, and the first matters more:
//
//   1. THE SINGLE-CHARACTER PROMPT MUST NOT DRIFT. Every Photo Match run anyone has ever done uses
//      it, the pair path is new, and adding plural forms to fifteen shared sentences is exactly the
//      kind of change that alters the common case by one word nobody notices. The hashes in
//      fixtures-photomatch-prompt.json were taken from the builder BEFORE pairs existed. They are a
//      pin, not a snapshot to re-bless: if one breaks, the single-character prompt changed, and
//      that either was not intended or needs its own decision.
//
//      RE-PINNED ONCE, 2026-08-18, and this is what a legitimate re-pin looks like: the owner
//      reported a character coming back with the wrong hair ("it didint use hair our model fo face
//      good etc") and gallery 1c2e8850 showed long straight blonde ombre where every reference is
//      dark and wavy. The prompt asked for "hair" — one word in a list, the same mistake the body
//      list had already been fixed for. It now names colour, length and texture. That is a
//      deliberate change to the single-character prompt, so the pin moved WITH it, on purpose,
//      once, with the reason written here. Anything that breaks these hashes without a line like
//      this one is the accident the pin exists to catch.
//
//      RE-PINNED AGAIN, 2026-08-19, exact and outfit only: "exact recreate is not doing exact
//      recreate", traced to the bust chip ordering a re-frame the lock never overruled. The lock
//      now names the CROP and settles that conflict. See check-exact-recreate.js, which carries
//      the measurement — the source photo sent and the widened shot that came back.
//
//      RE-PINNED 2026-08-19 (second time that day): a character with ONE reference photo was
//      getting a prompt byte-identical to a three-reference one apart from the numbering, so
//      "her body comes from image 1" was said about a face-only headshot that contains no body.
//      These fixtures are refCount 4, so what moved them is the plural/singular verb agreement
//      that came with it. See check-reference-count.js.
//
//   2. THE PAIR PROMPT MUST SAY THE THINGS THAT MAKE IT WORK. Naming two women is not enough —
//      the model takes its count from the scene and averages two reference sets into one face
//      unless told otherwise, and both failures look identical in the output ("it ignored the
//      twins"). Those instructions are asserted individually.
//
// Runs the REAL builder, lifted out of the page — no React, no bundler.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// Both module constants are lifted with the function, so this exercises the REAL text — a stand-in
// for LIGHTING_LINE would let this file pass while the app shipped something else.
const nudeLine = /const NUDE_LINE = (`[\s\S]*?`|'[^']*');/.exec(src);
const lightingLine = /const LIGHTING_LINE = ('[^']*');/.exec(src);
const fnStart = src.indexOf('export function buildMatchInstruction');
const fnEnd = src.indexOf('\n}\n', fnStart) + 3;
// eslint-disable-next-line no-new-func
const build = new Function(
  `const NUDE_LINE = ${nudeLine ? nudeLine[1] : "''"};
   const LIGHTING_LINE = ${lightingLine ? lightingLine[1] : "''"};
   ${src.slice(fnStart, fnEnd).replace('export function', 'function')}; return buildMatchInstruction;`,
)();

const BASE = {
  characterName: 'Chloe', refCount: 4, masterPrompt: '', exactRecreate: false, varyBackground: false,
  allowExpressionChange: false, allowHairChange: false, allowBodyChange: false, allowLightingChange: false,
  faceless: false, wantsNude: false, addGenericNudeLine: false, sourceFaceBlurred: false,
};

// --- 1. the single-character prompt is untouched -------------------------------------------------
const SINGLES = {
  plain: BASE,
  exact: { ...BASE, exactRecreate: true },
  outfit: { ...BASE, exactRecreate: true, outfitFromChar: true },
  nude: { ...BASE, wantsNude: true, addGenericNudeLine: true },
  faceless: { ...BASE, faceless: true },
  camera: { ...BASE, lookAtCamera: true },
  budget: { ...BASE, exactRecreate: true, outfitFromChar: true, lookAtCamera: true, masterPrompt: 'x'.repeat(200), budget: 3000 },
};
const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures-photomatch-prompt.json'), 'utf8'));
for (const [name, opts] of Object.entries(SINGLES)) {
  const got = crypto.createHash('sha256').update(build(opts)).digest('hex').slice(0, 16);
  check(`single-character prompt unchanged: ${name}`, got === pinned[name]);
}
check('no cast means no plural anywhere', !/EXACTLY (ONE|TWO|THREE) WOMEN/.test(build(BASE)));

// --- 2. the pair prompt ---------------------------------------------------------------------------
const CAST = [{ name: 'Arya', from: 1, to: 4 }, { name: 'Rosary', from: 5, to: 8 }];
const pairOpts = { ...BASE, refCount: 8, characterName: 'Arya & Rosary (folder)', cast: CAST };
const p = build({ ...pairOpts, exactRecreate: true });

check('both women are named', p.includes('Arya') && p.includes('Rosary'));
check('the FOLDER name never reaches the prompt', !p.includes('folder'));
check('each woman owns a stated range of image slots', p.includes('images 1-4 = Arya') && p.includes('images 5-8 = Rosary'));

// The count. Without it the model copies the scene's headcount and the second woman vanishes.
check('the output count is stated as a fixed fact', /EXACTLY TWO WOMEN IN THE OUTPUT/.test(p));
// Both source shapes, because the source is sometimes one woman and sometimes two.
check('a one-woman source is handled — she is removed and both stand in her place',
  /If image 9 shows one woman, she is removed and both of them stand in that scene/.test(p));
check('a two-woman source is handled — one each', /if it shows two, each becomes a different one of them/.test(p));

// The averaging failure: two reference sets in one request, one face out, used twice.
check('each woman is matched to HER OWN references, not the pool',
  /Match each woman to HER OWN reference images — never the other's, never an average/.test(p));
check('and it is restated in the tail, where Seedream weights hardest',
  /Arya and Rosary are two DIFFERENT women — different faces, never one face used twice/.test(p));

// Grammar is not cosmetic here: "she" fifteen times against two names is how you get one woman.
check('the pair prompt speaks in the plural', p.includes('they are not in the output') && p.includes('the people'));
check('no singular "her own reference images" where both women are the subject',
  !/(Every part of the people|render the people)[^.]*her own reference images/.test(p));

// Exact recreate vs a second body: demanding the identical crop while adding a woman is a
// contradiction, and a contradicted model drops one of them.
check('exact recreate lets the frame move for a pair', /widening the crop to fit them|Framing and pose may adjust/.test(p));
check('but the shot type still holds', /same angle, lens height and shot type/.test(p));
check('the single-character CAMERA lock is NOT used for a pair', !p.includes("reproduce image 9's exact shot"));

// --- 3. it fits, and the identity lock always survives ---------------------------------------------
// Over the cap ByteDance 422s and the whole batch dies before an image exists; the caller's backstop
// slices the TAIL, which is the identity lock. So every combination must fit by dropping.
const COMBOS = {
  plain: {},
  exact: { exactRecreate: true },
  nude: { wantsNude: true, addGenericNudeLine: true },
  faceless: { faceless: true },
  'outfit+eyes': { exactRecreate: true, outfitFromChar: true, lookAtCamera: true },
  everything: { exactRecreate: true, outfitFromChar: true, lookAtCamera: true, sourceFaceBlurred: true, masterPrompt: 'x'.repeat(200) },
};
for (const [name, opts] of Object.entries(COMBOS)) {
  const out = build({ ...pairOpts, budget: 3000, ...opts });
  check(`pair fits the 3000 cap: ${name} (${out.length})`, out.length <= 3000);
  check(`pair keeps its identity lock: ${name}`, out.includes('FINAL — HIGHEST PRIORITY'));
  check(`pair keeps its count rule: ${name}`, /EXACTLY TWO WOMEN/.test(out));
}

// Three is not a special case — the design is a cast, not a hard-coded pair.
const three = build({
  ...BASE, refCount: 9, cast: [{ name: 'A', from: 1, to: 3 }, { name: 'B', from: 4, to: 6 }, { name: 'C', from: 7, to: 9 }], budget: 3000, exactRecreate: true,
});
check('three women works and counts in words, not digits', /EXACTLY THREE WOMEN/.test(three) && three.length <= 3000);
check('and the last name is joined with "and", not a trailing comma', three.includes('A, B and C'));

// --- 4. the page wiring ----------------------------------------------------------------------------
// castOf/refsForCharacter are hooks closed over component state, so these are read from source —
// what matters is that the wiring exists and cannot silently regress to the single-character path.
check('a folder with subfolders resolves its refs from those subfolders',
  src.includes('const members = membersOf(id);') && src.includes('return members.flatMap((m) => ownItems(m.id).slice(0, per));'));
check('cast ranges are counted from the images ACTUALLY sent, not from the even split',
  src.includes('const n = ownItems(m.id).slice(0, per).length;'));
check('one usable member is treated as an ordinary character', src.includes('return cast.length > 1 ? cast : null;'));
check('a pair stays ONE entry in the run, so it is one render per source photo',
  src.includes('perChar.push({ id: cid, name, refs, cast: castOf(cid) });'));
check('the builder receives the cast', src.includes('cast: who.cast,'));
check('the picker tile shows a pair for what it is', src.includes('in one photo · '));
// The image budget: Seedream takes 10 and the source claims one, so the women split nine.
check('the nine identity slots are split between the women',
  src.includes('Math.floor(MAX_CHAR_IMAGES / members.length)'));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
