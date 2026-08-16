// HER BUILD — Eddy's brain, ported to Photo Match.
//
// THE DISTINCTION THAT MAKES IT WORK: a Body CHIP is a deliberate enlargement, so it sets
// allowBodyChange and STANDS DOWN the bust-preservation locks — right for "make her bigger than her
// photos", wrong for "this is what she looks like". A character whose references already show the
// target build was losing her strongest protection just to state a size she already had. So the
// build options never touch allowBodyChange: they ride WITH the locks, naming the size the locks are
// holding, which is the one thing a lock cannot do for itself.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const nudeLine = /const NUDE_LINE = (`[\s\S]*?`|'[^']*');/.exec(src);
const lightingLine = /const LIGHTING_LINE = ('[^']*');/.exec(src);
const backLine = /const BACK_VIEW_LINE = ([\s\S]*?);\n/.exec(src);
const fnStart = src.indexOf('export function buildMatchInstruction');
const fnEnd = src.indexOf('\n}\n', fnStart) + 3;
// eslint-disable-next-line no-new-func
const build = new Function(
  `const NUDE_LINE = ${nudeLine ? nudeLine[1] : "''"};
   const LIGHTING_LINE = ${lightingLine ? lightingLine[1] : "''"};
   const BACK_VIEW_LINE = ${backLine[1]};
   ${src.slice(fnStart, fnEnd).replace('export function', 'function')}; return buildMatchInstruction;`,
)();

const BASE = {
  characterName: 'Chloe', refCount: 4, masterPrompt: '', exactRecreate: false, varyBackground: false,
  allowExpressionChange: false, allowHairChange: false, allowBodyChange: false, allowLightingChange: false,
  faceless: false, wantsNude: false, addGenericNudeLine: false, sourceFaceBlurred: false,
};

// --- the options exist, with a front AND a back sentence -------------------------------------------
const opts = [...src.matchAll(/\{ value: '([a-z]+)', label: '([^']+)'/g)].map((m) => m[1]);
for (const v of ['auto', 'petite', 'medium', 'full', 'large', 'verylarge']) {
  check(`build option: ${v}`, opts.includes(v));
}
check('the default emits nothing at all', /\{ value: 'auto', label: '[^']+', text: '', backText: '' \}/.test(src));

// Every front line names the bust and, at the larger sizes, "deep natural cleavage" — none of which a
// shot from behind can show. Feeding it anyway leaves the model one way to comply: twist her toward
// the camera, destroying the pose. Suppressing it entirely is worse, because hips, waist and back
// width DO read from behind and are exactly what drifts toward the stand-in.
const backTexts = [...src.matchAll(/backText: '([^']+)'/g)].map((m) => m[1]).filter(Boolean);
check('every size has a back-view sentence', backTexts.length === 5);
check('and none of them mentions cleavage or bust', !backTexts.some((t) => /cleavage|bust/i.test(t)));

// --- it does NOT behave like a chip -----------------------------------------------------------------
// The invariant, asserted where it actually lives: a Body CHIP carries `bodyChange: true`, which is
// what ALL_PRESETS scans to raise allowBodyChange and stand the locks down. No build option carries
// it, so choosing a build can never disarm the protection it exists to name.
const buildBlock = src.slice(src.indexOf('const BUILD_OPTIONS = ['), src.indexOf('];', src.indexOf('const BUILD_OPTIONS = [')));
check('no build option carries bodyChange, so the locks stay up', !buildBlock.includes('bodyChange'));
check('while the Body chips do carry it', /\{ group: 'Body', bodyChange: true/.test(src));
check('and the reason is written down', /standing fact about the character, NOT a change/i.test(src));

// --- the default changes nothing ---------------------------------------------------------------------
// Pinned against hashes taken before any of this existed: "From her photos" must be exactly the
// behaviour that shipped before, because it is what every existing run uses.
const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures-photomatch-prompt.json'), 'utf8'));
const SINGLES = {
  plain: BASE,
  exact: { ...BASE, exactRecreate: true },
  outfit: { ...BASE, exactRecreate: true, outfitFromChar: true },
  nude: { ...BASE, wantsNude: true, addGenericNudeLine: true },
  faceless: { ...BASE, faceless: true },
  camera: { ...BASE, lookAtCamera: true },
  budget: { ...BASE, exactRecreate: true, outfitFromChar: true, lookAtCamera: true, masterPrompt: 'x'.repeat(200), budget: 3000 },
};
for (const [name, o] of Object.entries(SINGLES)) {
  check(`'From her photos' leaves ${name} byte-identical`,
    crypto.createHash('sha256').update(build(o)).digest('hex').slice(0, 16) === pinned[name]);
}

// --- a chosen build reaches the prompt, next to the lock ----------------------------------------------
const VL = 'She has a VERY LARGE, heavy, extremely full bust — big, weighty and rounded, sitting wide on her chest with deep natural cleavage between them — and a strongly curvy figure. That is her natural build, exactly as in her reference images, and it is preserved, not changed. Never render her smaller, flatter, perkier or more athletic than this.';
const withBuild = build({ ...BASE, exactRecreate: true, buildText: VL, budget: 3000 });
check('the build line is in the prompt', withBuild.includes('VERY LARGE'));
// It states the size the lock is about to hold, so the two must read as one statement rather than
// the lock arriving with nothing to hold on to.
check('and sits immediately before the identity lock',
  withBuild.indexOf(VL) < withBuild.indexOf('FINAL — HIGHEST PRIORITY')
  && withBuild.indexOf('FINAL — HIGHEST PRIORITY') - withBuild.indexOf(VL) < VL.length + 8);

// --- the clothed lock ----------------------------------------------------------------------------------
// The chips say "deep cleavage" and "straining the garment". Asked for a bigger bust in a dressed
// photo, a model very often complies by opening or removing the top — which with NSFW off is nobody's
// intent. Photo Match had the chips and none of this.
check('the clothed lock exists', src.includes('const CLOTHED_FIGURE_LOCK ='));
check('she stays dressed and the change shows as fabric', /stays FULLY DRESSED[\s\S]*fabric stretching and straining/.test(src));
check('cleavage is read as silhouette, never bare skin', /Read "cleavage" as the silhouette THROUGH the clothing/.test(src));
// AFTER the chips, or it loses to the very text it exists to bound: the chips are appended after the
// base prompt and Seedream weights the tail hardest.
check('appended after the chips', src.includes('if (allowBodyChange && !wantsNude) out = `${out}'));
check('and never when the request is nude — there is no garment to keep closed',
  src.includes('allowBodyChange && !wantsNude'));

// --- everything still fits, and the lock always survives -------------------------------------------------
const CAST = [{ name: 'Arya', from: 1, to: 4 }, { name: 'Rosary', from: 5, to: 8 }];
const BACK_VL = 'She has a strongly curvy figure with wide shapely hips and a narrow waist — that is her natural build, exactly as in her reference images, and it is preserved, not changed. Never render her slimmer or more athletic than this.';
const COMBOS = {
  'single + very large': { exactRecreate: true, buildText: VL },
  'single back': { faceless: true, backView: true, exactRecreate: true, buildText: BACK_VL },
  'pair + very large': { refCount: 8, cast: CAST, exactRecreate: true, buildText: VL },
  'pair, everything on': { refCount: 8, cast: CAST, exactRecreate: true, outfitFromChar: true, lookAtCamera: true, sourceFaceBlurred: true, masterPrompt: 'x'.repeat(200), buildText: VL },
};
for (const [name, o] of Object.entries(COMBOS)) {
  const out = build({ ...BASE, budget: 3000, ...o });
  check(`fits the 3000 cap: ${name} (${out.length})`, out.length <= 3000);
  // The build is the LAST thing dropped, and only in the one combination that still will not fit: a
  // build line without an identity lock is a correctly-proportioned stranger, while an identity lock
  // without a build line is her at whatever size her references show — the default behaviour anyway.
  check(`identity lock survives: ${name}`, out.includes('FINAL — HIGHEST PRIORITY'));
}

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
