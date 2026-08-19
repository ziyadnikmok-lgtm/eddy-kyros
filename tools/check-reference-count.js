// One reference photo is a different job from three.
//
// Owner, 2026-08-19: "some character have 3 image character and some only 1 so this prompt need to
// adapt to it too on both sd and nb2". Measured before the change: apart from renumbering image 1
// to images 1-3, the two prompts were BYTE-IDENTICAL — every clause written as though a set exists.
//
// Two of them are actively wrong with a single photo:
//   "her body, figure and chest come from image 1 at their true size" — a face-only headshot has no
//   body in it, so the model fills the gap from the stand-in, which is the failure this page exists
//   to prevent. The UI already warns about it; the prompt never did.
//   "when in doubt copy images 1-3" — with one photo there is nothing to cross-check between.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const nudeLine = /const NUDE_LINE = (`[\s\S]*?`|'[^']*');/.exec(src);
const lightingLine = /const LIGHTING_LINE = ('[^']*');/.exec(src);
const fnStart = src.indexOf('export function buildMatchInstruction');
const fnEnd = src.indexOf('\n}\n', fnStart) + 3;
const build = new Function(
  `const NUDE_LINE = ${nudeLine ? nudeLine[1] : "''"};
   const LIGHTING_LINE = ${lightingLine ? lightingLine[1] : "''"};
   ${src.slice(fnStart, fnEnd).replace('export function', 'function')}; return buildMatchInstruction;`,
)();
const BASE = {
  characterName: 'Mia', masterPrompt: '', exactRecreate: true, varyBackground: false,
  allowExpressionChange: false, allowHairChange: false, allowBodyChange: false, allowLightingChange: false,
  faceless: false, wantsNude: false, addGenericNudeLine: false, sourceFaceBlurred: true, budget: 8000,
};
const one = build({ ...BASE, refCount: 1 });
const three = build({ ...BASE, refCount: 3 });

// --- the two are no longer the same prompt with different numbers --------------------------------
const norm = (s) => s.replace(/images 1-3/gi, 'REFS').replace(/image 1\b/gi, 'REFS')
  .replace(/image 4/g, 'SRC').replace(/image 2/g, 'SRC');
check('a 1-reference prompt now differs from a 3-reference one by more than numbering',
  norm(one) !== norm(three));

// --- one photo: it is the whole of the evidence --------------------------------------------------
check('it says this is the only photograph of her', one.includes('is the only photograph of Mia'));
// Its own paragraph, with a stable opener, so the budget loop can drop it whole rather than the
// clause riding inside the identity line where nothing could remove it.
const PARA = String.fromCharCode(10, 10);
check('it is a paragraph of its own', one.split(PARA).some((x) => x.startsWith('ONLY REFERENCE: ')));

// THE clause that matters: what the one photo does not show must not come from the stand-in.
check('what it does not show must NOT come from the source',
  one.includes('whatever it does not show of her, do NOT take from image 2'));
check('"when in doubt copy" tells it to follow the one photo, not to average',
  one.includes('it is the only record of her, so follow it rather than guessing'));

// --- several photos: deliberately UNCHANGED -----------------------------------------------------
// The multi-reference half was written and then removed: it cost ~200 characters to tell the model
// something it already does, and pushed the everyday Seedream prompt 155 over the 3,000 cap, which
// buys a dropped paragraph elsewhere. Only the single case has a real failure behind it.
check('a multi-reference prompt gets no extra text', !three.includes('ONLY photograph'));
check('and none of the single-photo wording leaks into it',
  !three.includes('only record of her') && !three.includes('never from the stand-in'));
check('the single wording does not carry the multi case either', !one.includes('SAME woman at different moments'));
check('why the multi half was dropped is written down', /not worth its characters|already does/.test(src));

// --- it has to READ properly: this is prompt text, not code ---------------------------------------
check('singular takes a singular verb', one.includes('image 1 wins.') && !one.includes('image 1 win.'));
check('plural keeps the plural', three.includes('images 1-3 win.'));
check('the marker opens it, so the drop list has something stable to match',
  one.includes('ONLY REFERENCE: image 1 is the only photograph'));
// The Seedream cap is 3,000 and this variant starts higher than the multi one — it has to fit.
check('the clause is short enough to fit', build({ ...BASE, refCount: 1, budget: 0 }).length < 3000);

// --- two references is still the multi case -------------------------------------------------------
const two = build({ ...BASE, refCount: 2 });
check('two references are treated as a set, not as a single', !two.includes('ONLY photograph'));
check('and keep the plural verb', two.includes('images 1-2 win.'));

// --- a pair character is untouched: it has its own per-woman rules --------------------------------
const pair = build({ ...BASE, refCount: 4, cast: [{ name: 'Mia' }, { name: 'Grace' }] });
check('a pair keeps its own wording, not this one',
  !pair.includes('ONLY photograph') && !pair.includes('SAME woman at different moments'));
check('and still matches each woman to her own references',
  pair.includes('Match each woman to HER OWN reference images'));

// --- budget: the addition must not push Seedream over its cap -------------------------------------
const BUDGET = Number(/const SEEDREAM_PROMPT_BUDGET = (\d+);/.exec(src)[1]);
const tight = build({ ...BASE, refCount: 1, budget: BUDGET });
check(`the single-reference prompt still fits Seedream (${tight.length})`, tight.length <= BUDGET);
check('and identity survives that squeeze', tight.includes('FINAL — HIGHEST PRIORITY'));

// --- both tabs share this builder, so both get it -------------------------------------------------
// PhotoMatchNB2Page renders the same component with variant='nb2'; there is one buildMatchInstruction.
check('there is exactly one builder for SD and NB2',
  (src.match(/export function buildMatchInstruction/g) || []).length === 1);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
