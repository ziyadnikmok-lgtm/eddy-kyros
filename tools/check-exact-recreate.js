// EXACT RECREATE must actually beat the bust chip.
//
// Owner, 2026-08-19: "exact recreate is not doing exact recreate" — the SECOND report. The first
// (2026-08-17) was fixed by moving the lock last, and it regressed because position was never the
// real problem.
//
// Measured from the queue, job 6998637f, with the images it actually sent:
//   SOURCE  extreme close-up, face filling the frame, cropped well above the chest
//   OUTPUT  pulled back to a three-quarter shot showing chest and a tank top not in the source
// The prompt was 4,417 chars against NB2's 8,000 cap, so nothing was trimmed and the lock WAS
// present. It lost to two paragraphs that order a re-frame whenever a bust chip is on.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// The REAL builder, lifted out of the page — a stand-in here would let this pass while the app
// shipped something else.
const nudeLine = /const NUDE_LINE = (`[\s\S]*?`|'[^']*');/.exec(src);
const lightingLine = /const LIGHTING_LINE = ('[^']*');/.exec(src);
const fnStart = src.indexOf('export function buildMatchInstruction');
const fnEnd = src.indexOf('\n}\n', fnStart) + 3;
const build = new Function(
  `const NUDE_LINE = ${nudeLine ? nudeLine[1] : "''"};
   const LIGHTING_LINE = ${lightingLine ? lightingLine[1] : "''"};
   ${src.slice(fnStart, fnEnd).replace('export function', 'function')}; return buildMatchInstruction;`,
)();

// The owner's actual settings on the run that failed: exact recreate on, blurred source, her
// biggest bust chip on, three identity references.
const BUILD_TEXT = (/{ value: 'verylarge',[\s\S]*?text: '([^']*)'/.exec(src) || [])[1] || '';
const BASE = {
  characterName: 'Grace', refCount: 3, masterPrompt: '', exactRecreate: true, varyBackground: false,
  allowExpressionChange: false, allowHairChange: false, allowBodyChange: false, allowLightingChange: false,
  faceless: false, wantsNude: false, addGenericNudeLine: false, sourceFaceBlurred: true,
  budget: 8000, buildText: BUILD_TEXT,
};
check('the bust chip text was found in the page', BUILD_TEXT.length > 40);

const withChip = build(BASE);
const at = (s, needle) => s.indexOf(needle);

// --- the ruling itself --------------------------------------------------------------------------
check('the lock is present', withChip.includes('EXACT RECREATE'));
check('and it now names the CROP, not just the framing', /EXACT RECREATE[^]*?framing, crop, camera angle/.test(withChip));
// This is the whole fix: the two instructions conflicted and nothing said which won.
check('it says the crop outranks her figure', withChip.includes('The crop outranks her figure'));
check('and forbids the specific thing that happened — widening to reveal her chest',
  /widening, zooming out or re-angling the shot to bring it into view is WRONG/.test(withChip));
check('while leaving her figure to apply where the shot DOES show it',
  withChip.includes('Her figure applies only where the original framing already shows it'));

// --- it has to come after what it overrules -----------------------------------------------------
check('the ruling comes after the bust chip', at(withChip, 'The crop outranks') > at(withChip, BUILD_TEXT.slice(0, 30)));
check('and after the identity lock that says the outfit stretches to fit her',
  at(withChip, 'The crop outranks') > at(withChip, 'FINAL — HIGHEST PRIORITY'));

// --- and must not fire where there is no conflict -----------------------------------------------
const noChip = build({ ...BASE, buildText: '' });
check('no bust chip, no ruling — nothing to settle', !noChip.includes('The crop outranks her figure'));
check('but the lock itself still stands', noChip.includes('EXACT RECREATE'));
const off = build({ ...BASE, exactRecreate: false });
check('exact recreate off leaves the figure free', !off.includes('The crop outranks her figure'));
// A body preset means the figure is DELIBERATELY not from her references — the ruling still has to
// fire, because the chip is exactly what re-frames the shot.
const preset = build({ ...BASE, buildText: '', allowBodyChange: true });
check('a body preset gets the ruling too', preset.includes('The crop outranks her figure'));

// --- Seedream's short form carries the same ruling ----------------------------------------------
const tight = build({ ...BASE, budget: 3000 });
check('the short lock names the crop', /EXACT RECREATE: [^]*?framing, crop, pose/.test(tight));
check('and still forbids the widen', tight.includes('Never widen or re-angle the crop to bring her figure into view'));
check('the short form stays short enough to fit', tight.length <= 3000);

// --- identity is untouched: that is the point of the page ---------------------------------------
check('her face still comes from her references', withChip.includes('match exactly: face, head shape, jaw'));
check('and the figure instruction is still there for shots that show her',
  withChip.includes(BUILD_TEXT.slice(0, 30)));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
