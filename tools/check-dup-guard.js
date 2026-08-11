// Skipping a recipe already generated -- and never skipping one the owner explicitly asked for.
//
// The seed is RANDOM, so a "duplicate" is a second picture from the same recipe, not the same
// picture. Skipping is therefore a judgement call, and the cases that must never be skipped are a
// Regenerate and a retry: both are explicit asks for an image that does not exist yet.
const fs = require('fs');
const gen = fs.readFileSync('D:/Kyros/app/client/src/pages/EddyGeneratePage.jsx', 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- where it sits -------------------------------------------------------------------------------
check('the guard runs inside run(), before anything is dispatched', (() => {
  const i = gen.indexOf('const { fresh, skipped } = splitBySeen(');
  const j = gen.indexOf('await runPool(');
  return i > -1 && j > i;
})());
check('it reads the Library to build the seen set', gen.includes('buildSeenKeys(await libraryStore.listItems())'));
check('it trims the batch BEFORE the confirm gate, so the price quoted is the price paid', (() => {
  const guard = gen.indexOf('const { fresh, skipped } = splitBySeen(');
  const confirm = gen.indexOf('Start this run?');
  return guard > -1 && confirm > guard;
})());
check('a retry is never deduped — those images do not exist yet',
  gen.includes('const isRetry = Array.isArray(only) && only.length > 0;'));
check('and the reason is written down', /Regenerate and a retry are explicit asks/.test(gen));

// --- what it says --------------------------------------------------------------------------------
check('the message says RECIPE, not "identical image"', gen.includes('already generated from this recipe'));
check('the saving is named', gen.includes('Saved $'));
check('an override is always offered', gen.includes('Make them anyway'));
check('the override is remembered across runs', gen.includes("localStorage.getItem('kyros.skipDupes')"));
check('and it is visible when it is off, so a surprise bill has a reason on screen',
  gen.includes('Duplicate skipping is off'));
check('skipping everything is reported rather than looking like a no-op',
  gen.includes('Every one of those recipes has been generated already'));

// --- the fallback that was NOT built ---------------------------------------------------------------
// The spec wanted old prompt-only rows to dedupe by prompt hash. buildPrompt takes no base-photo
// input, so two DIFFERENT base photos with the same pose and outfit produce the identical prompt
// string -- and a multi-base run (the normal way this page is used) would have skipped every base
// after the first. splitBySeen still supports promptFor for a caller that can key it safely; this
// one deliberately does not pass it.
check('the guard does not dedupe by prompt — see the multi-base false positive below',
  !/promptFor:/.test(gen));
check('and the reason is recorded at the call site, so it is not "fixed" back in',
  /carries no base photo/.test(gen));

// --- replay the decision -----------------------------------------------------------------------
const decide = (isRetry, planned, seenKeys) => {
  if (isRetry) return { fresh: planned, skipped: [] };
  return {
    fresh: planned.filter((c) => !seenKeys.has(c.key)),
    skipped: planned.filter((c) => seenKeys.has(c.key)),
  };
};
const seen = new Set(['K1', 'K3']);
const planned = [{ key: 'K1' }, { key: 'K2' }, { key: 'K3' }, { key: 'K4' }];
check('two of four are skipped', decide(false, planned, seen).skipped.length === 2);
check('the other two run', decide(false, planned, seen).fresh.length === 2);
check('a RETRY runs everything, including keys already seen', decide(true, planned, seen).fresh.length === 4);
check('an empty seen set runs everything', decide(false, planned, new Set()).fresh.length === 4);
check('nothing is lost between the two lists',
  decide(false, planned, seen).fresh.length + decide(false, planned, seen).skipped.length === planned.length);

// --- the multi-base case, against the real key builder ----------------------------------------------
const srcText = fs.readFileSync('D:/Kyros/app/client/src/lib/provenance.js', 'utf8');
// eslint-disable-next-line no-new-func
const { comboKey, buildSeenKeys, splitBySeen } =
  new Function(`${srcText.replace(/^export /gm, '')}; return { comboKey, buildSeenKeys, splitBySeen };`)();

const opts = { engine: 'seedream', resolution: '2K' };
const twoBases = [
  { basePhotoId: 'grace-1', poseId: 'p1', outfitId: 'o1' },
  { basePhotoId: 'grace-2', poseId: 'p1', outfitId: 'o1' },   // same recipe, DIFFERENT photo
];
const libraryAfterFirst = [{ comboKey: comboKey({ ...twoBases[0], ...opts }) }];
const split = splitBySeen(twoBases, buildSeenKeys(libraryAfterFirst), opts);
check('a second base photo with the same pose and outfit still generates', split.fresh.length === 1);
check('and it is the one not yet made', split.fresh[0].basePhotoId === 'grace-2');

// The same run through a prompt-hash index -- the false positive, kept as the reason the fallback
// is absent. Both combos share one prompt, so the second base would have been skipped.
const promptOnly = buildSeenKeys([{ prompt: 'red dress, standing by the pool' }]);
const wrong = splitBySeen(twoBases, promptOnly, { ...opts, promptFor: () => 'red dress, standing by the pool' });
check('prompt-hash dedupe WOULD have skipped both bases — this is why it is not used',
  wrong.fresh.length === 0);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
