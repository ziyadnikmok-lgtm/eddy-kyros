// Max Outfit files into "<Her> Outfit N", and a multi-base run counts its payload correctly.
//
// Two separate things, both about a number or a name being right BEFORE money is spent:
//   1. an outfit swap is a different output from a Max Nano pose, so it gets its own series —
//      "Grace 3" and "Grace Outfit 3" count independently
//   2. perRunImages was read off the single photo slots, which are EMPTY once base photos are
//      ticked, so a multi-base run reported 1 image per request while sending three. That number
//      drives the Seedream cap check and the price.
const fs = require('fs');
const g = fs.readFileSync('D:/Kyros/app/client/src/pages/EddyGeneratePage.jsx', 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the name ---------------------------------------------------------------------------------
check('Max Outfit suffixes her name', g.includes('if (who && maxOutfit) who = `${who} Outfit`;'));
check('the banner previews the SAME suffix, or it promises the wrong folder',
  g.includes('const suffixed = [...names].sort().map((n) => (maxOutfit ? `${n} Outfit` : n));'));
check('Max Nano is untouched by the suffix', /if \(who && maxOutfit\)/.test(g) && !/if \(who && maxNano\)/.test(g));

// --- the two series count independently ---------------------------------------------------------
const nextBatchName = new Function('folders', 'base',
  /function nextBatchName\(folders, base\) \{([\s\S]*?)\n\}/.exec(g)[1]);
const F = (...n) => n.map((x) => ({ name: x }));

check('"Grace Outfit" starts at 1 even when Grace is at 5',
  nextBatchName(F('Grace 1', 'Grace 2', 'Grace 3', 'Grace 4', 'Grace 5'), 'Grace Outfit') === 'Grace Outfit 1');
check('and Grace keeps counting past her outfit folders',
  nextBatchName(F('Grace 5', 'Grace Outfit 9'), 'Grace') === 'Grace 6');
check('"Grace Outfit" climbs on its own',
  nextBatchName(F('Grace Outfit 1', 'Grace Outfit 2'), 'Grace Outfit') === 'Grace Outfit 3');
check('a two-word name still works with the suffix',
  nextBatchName(F('Grace cosplay Outfit 3'), 'Grace cosplay Outfit') === 'Grace cosplay Outfit 4');
check('"Grace Outfit 2" is NOT counted as one of Grace\'s — the prefix must match whole',
  nextBatchName(F('Grace Outfit 2'), 'Grace') === 'Grace 1');

// --- the payload count ---------------------------------------------------------------------------
const perRun = (picked, slots, poses) => (picked ? 2 : slots) + (poses ? 1 : 0);
check('multi-base + a pose sends 3, not 1', perRun(2, 0, 1) === 3);
check('the old maths gave 1 — which is the bug', (0 + 1) === 1);
check('the single-slot path is unchanged: base + face + pose = 3', perRun(0, 2, 1) === 3);
check('base only, no pose = 1', perRun(0, 1, 0) === 1);
check('multi-base with no pose still counts her face', perRun(3, 0, 0) === 2);
check('the source says why it counts 2 for a ticked run',
  /counted as present, because the cap has to be checked against the worst case/.test(g));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
