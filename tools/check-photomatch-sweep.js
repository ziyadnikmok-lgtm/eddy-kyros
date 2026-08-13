// Every Photo Match prompt the UI can produce, checked against the rules that must never break.
//
// The page has eleven booleans. Eleven booleans is 2,048 prompts, and the ones that bite are always
// the combinations nobody thought to try by hand — faceless AND eyes-to-camera, nude AND her outfit,
// exact recreate AND a body chip. Building all of them takes milliseconds, so there is no reason to
// spot-check instead (owner asked for a deep audit, 2026-08-13).
//
// What it enforces, on EVERY one of them:
//   * it fits the budget it was given, so nothing gets sliced off the tail
//   * the identity lock is present — that is the paragraph that stops a face swap
//   * the lighting line is present — the owner asked for it on every prompt, verbatim
//   * no contradiction: the outfit cannot come from two places, a faceless result cannot be told
//     to look at the lens, and a nude result cannot be given an outfit
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
// Normalised to LF: on a CRLF checkout the `\n}\n` scan below finds nothing and the builder never
// lifts. Every suite here reads this way for the same reason.
const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// Lift the real builder. Both module constants come with it, so this is the text the app ships.
const nudeLine = /const NUDE_LINE = (`[\s\S]*?`|'[^']*');/.exec(src);
const lightingLine = /const LIGHTING_LINE = ('[^']*');/.exec(src);
const fnStart = src.indexOf('export function buildMatchInstruction');
const fnEnd = src.indexOf('\n}\n', fnStart) + 3;
// eslint-disable-next-line no-new-func
const build = new Function(
  `const NUDE_LINE = ${nudeLine ? nudeLine[1] : "'[nude]'"};
   const LIGHTING_LINE = ${lightingLine[1]};
   ${src.slice(fnStart, fnEnd).replace('export function', 'function')};
   return buildMatchInstruction;`,
)();

const BUDGET = Number(/const SEEDREAM_PROMPT_BUDGET = (\d+);/.exec(src)[1]);
const LIGHT = 'Lighting is soft and diffused';
const FLAGS = ['exactRecreate', 'varyBackground', 'allowExpressionChange', 'allowHairChange',
  'allowBodyChange', 'allowLightingChange', 'faceless', 'wantsNude', 'sourceFaceBlurred',
  'outfitFromChar', 'lookAtCamera'];

// --- the sweep -------------------------------------------------------------------------------------
const counts = { over: 0, noLock: 0, noLight: 0, clash: 0, threw: 0 };
const firstProblem = {};
for (let mask = 0; mask < (1 << FLAGS.length); mask += 1) {
  const opts = { characterName: 'Grace', refCount: 5, masterPrompt: 'x'.repeat(120), addGenericNudeLine: false, budget: BUDGET };
  FLAGS.forEach((flag, i) => { opts[flag] = Boolean(mask & (1 << i)); });
  const on = () => FLAGS.filter((k) => opts[k]).join(' + ') || '(none)';

  let out;
  try { out = build(opts); } catch (err) { counts.threw += 1; firstProblem.threw = firstProblem.threw || `${on()}: ${err.message}`; continue; }

  if (out.length > BUDGET) { counts.over += 1; firstProblem.over = firstProblem.over || `${on()} -> ${out.length}`; }
  if (!out.includes('FINAL — HIGHEST PRIORITY')) { counts.noLock += 1; firstProblem.noLock = firstProblem.noLock || on(); }
  if (!out.includes(LIGHT)) { counts.noLight += 1; firstProblem.noLight = firstProblem.noLight || on(); }

  const outfitFromScene = /From image 6:[^\n]*outfit/.test(out);
  const outfitFromHer = out.includes('OUTFIT: she wears HER OWN');
  const eyes = out.includes('EYES TO CAMERA');
  const clash = (outfitFromScene && outfitFromHer)
    || (opts.faceless && eyes)
    || (opts.wantsNude && (outfitFromScene || outfitFromHer));
  if (clash) { counts.clash += 1; firstProblem.clash = firstProblem.clash || on(); }
}

check(`all ${1 << FLAGS.length} combinations build without throwing${counts.threw ? ` — ${firstProblem.threw}` : ''}`, counts.threw === 0);
check(`none exceeds the ${BUDGET}-character budget${counts.over ? ` — ${firstProblem.over}` : ''}`, counts.over === 0);
check(`every one keeps the identity lock${counts.noLock ? ` — missing on ${firstProblem.noLock}` : ''}`, counts.noLock === 0);
check(`every one carries the lighting line${counts.noLight ? ` — missing on ${firstProblem.noLight}` : ''}`, counts.noLight === 0);
check(`no combination contradicts itself${counts.clash ? ` — ${firstProblem.clash}` : ''}`, counts.clash === 0);

// --- edges a sweep of booleans cannot reach -----------------------------------------------------------
const BASE = {
  characterName: 'Grace', refCount: 5, masterPrompt: '', exactRecreate: false, varyBackground: false,
  allowExpressionChange: false, allowHairChange: false, allowBodyChange: false, allowLightingChange: false,
  faceless: false, wantsNude: false, addGenericNudeLine: false, sourceFaceBlurred: true, budget: BUDGET,
};
for (const [name, opts] of [
  ['no character name', { characterName: '' }],
  ['a name containing a quote', { characterName: "O'Grace" }],
  ['a name containing a backtick', { characterName: 'Gr`ace' }],
  ['a name that looks like a template', { characterName: 'Gr${x}ace' }],
  ['zero references', { refCount: 0 }],
  ['twenty references', { refCount: 20 }],
  ['a 5,000-character master prompt', { masterPrompt: 'y'.repeat(5000) }],
  ['everything on at once', {
    exactRecreate: true, varyBackground: true, allowExpressionChange: true, allowHairChange: true,
    allowBodyChange: true, allowLightingChange: true, outfitFromChar: true, lookAtCamera: true,
    masterPrompt: 'z'.repeat(600),
  }],
  ['the nano budget', { budget: 8000, masterPrompt: 'q'.repeat(2000) }],
]) {
  const out = build({ ...BASE, ...opts });
  const o = { ...BASE, ...opts };
  check(`${name}: fits, locked, lit (${out.length})`,
    out.length <= o.budget && out.includes('FINAL — HIGHEST PRIORITY') && out.includes(LIGHT));
}

/**
 * The pathological case: so many chips that the caller's floor kicks in.
 *
 * The caller hands over `budget - chips`, floored at 600. Below the floor the builder cannot shrink
 * any further without cutting load-bearing text, so it sheds everything droppable and stops. What
 * matters then is that the caller's own slice still cannot reach the lock — and it cannot, because
 * the lock sits at the end of a base that is now far shorter than the cap. Only chips get cut, and
 * the page says so.
 */
const chips = 'CHIP. '.repeat(400).trim();
const floored = Math.max(600, BUDGET - chips.length - 8);
const shed = build({ ...BASE, exactRecreate: true, outfitFromChar: true, lookAtCamera: true, budget: floored });
const combined = `${shed}\n\n${chips}`;
const sliced = combined.length > BUDGET ? combined.slice(0, BUDGET) : combined;
check('below the floor it sheds rather than throwing', shed.length > 0);
check('and the base alone is well under the cap', shed.length < BUDGET);
check('so the identity lock survives the caller slice', sliced.includes('FINAL — HIGHEST PRIORITY'));
check('and so does the lighting line', sliced.includes(LIGHT));
check('only the chips are lost, which the page reports', combined.length > sliced.length);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
