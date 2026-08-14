// The pose randomiser — "I write a number, choose the labels, click randomise" (owner, 2026-08-14).
//
// Two things here are easy to get wrong in ways nobody notices:
//
//   1. SCOPE. The draw must come from what the grid is showing, not the whole collection. Select all
//      is already scoped that way and says why beside itself: a button that picks items the grid is
//      not showing "would silently add poses from a folder you filtered out". A randomiser that
//      ignored the folder chip is that same bug with a shuffle in front of it — and far harder to
//      spot, because the output is supposed to look arbitrary.
//   2. SHORTFALL. Asking for 30 when 4 match must not quietly hand back 4. Silence there reads as
//      "there were only 4 all along".
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// eslint-disable-next-line no-new-func
const rnd = new Function(`${read('client/src/lib/poseRandomiser.js').replace(/^export /gm, '')}; return { eligiblePoses, drawPoses, describeDraw, chipCounts };`)();
// eslint-disable-next-line no-new-func
const text = new Function(`${read('client/src/lib/poseText.js').replace(/^export /gm, '')}; return { readPoseTags, readPoseView, POSE_TAGS };`)();
const { eligiblePoses, drawPoses, describeDraw, chipCounts } = rnd;
const { readPoseTags } = text;

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- fixtures ------------------------------------------------------------------------------------
const pose = (id, tags) => ({
  id,
  prompt: JSON.stringify({ pose_action: { description: `pose ${id}`, view: 'front', ...(tags ? { tags } : {}) } }),
});
// 6 mirror selfies, 4 tagged-but-not-mirror-capable (empty = answered no), 10 never asked.
const grid = [
  ...Array.from({ length: 6 }, (_, i) => pose(`m${i}`, ['mirror selfie'])),
  ...Array.from({ length: 4 }, (_, i) => pose(`n${i}`, [])),
  ...Array.from({ length: 10 }, (_, i) => pose(`u${i}`)),
];

// --- 1. eligibility: THE CHIPS ARE EXCLUSIONS -----------------------------------------------------
// "Choosing which label you don't want" (owner, 2026-08-14). Ticking a chip REMOVES those poses.
// The direction is the whole feature, and a flip would be invisible on a grid where most poses
// share a label — so every assertion below names which poses survive, not just how many.
const READ = { readTags: readPoseTags, readView: text.readPoseView };
const elig = (rows, sel) => eligiblePoses(rows, sel, READ);

check('nothing ticked leaves the whole grid eligible', elig(grid, {}).length === 20);
check('excluding a tag DROPS those poses', elig(grid, { tags: ['mirror selfie'] }).length === 14);
check('and none of the survivors carry it',
  !elig(grid, { tags: ['mirror selfie'] }).some((p) => p.id.startsWith('m')));
check('an answered-no pose SURVIVES a tag exclusion — it does not carry the tag',
  elig(grid, { tags: ['mirror selfie'] }).some((p) => p.id.startsWith('n')));
check('an unasked pose survives too', elig(grid, { tags: ['mirror selfie'] }).some((p) => p.id.startsWith('u')));
check('excluding an unknown tag removes nothing', elig(grid, { tags: ['bed'] }).length === 20);
check('an empty grid is fine', elig([], { tags: ['mirror selfie'] }).length === 0);
check('a null grid is fine', elig(null, {}).length === 0);
check('an omitted selection object leaves everything eligible', eligiblePoses(grid, undefined, READ).length === 20);

// --- 1b. views, and two exclusions together -----------------------------------------------------------
const viewed = (id, view, tags) => ({
  id,
  prompt: JSON.stringify({ pose_action: { description: id, view, ...(tags ? { tags } : {}) } }),
});
// 2 back mirror selfies (the real 004/058 shape), 1 front mirror selfie, and plain ones.
const mixed = [
  viewed('bm1', 'back', ['mirror selfie']),
  viewed('bm2', 'back', ['mirror selfie']),
  viewed('fm1', 'front', ['mirror selfie']),
  viewed('b1', 'back', []),
  viewed('f1', 'front', []),
  viewed('c1', 'closeup', []),
  { id: 'plain', prompt: 'just a sentence, no JSON at all' },
];
const ids = (rows) => rows.map((p) => p.id).join(',');

check('excluding a view drops exactly that view', ids(elig(mixed, { views: ['back'] })) === 'fm1,f1,c1,plain');
check('excluding two views drops both', ids(elig(mixed, { views: ['back', 'closeup'] })) === 'fm1,f1,plain');
check('an unlabelled card counts as front, so excluding front drops it too',
  !elig(mixed, { views: ['front'] }).some((p) => p.id === 'plain'));
check('excluding close-up leaves everything else', elig(mixed, { views: ['closeup'] }).length === 6);

// Across families: remove this AND also remove that. Unlike inclusion there is no subtlety here —
// but the arithmetic still has to account for overlap rather than double-counting it.
const noMirrorNoFront = elig(mixed, { views: ['front'], tags: ['mirror selfie'] });
check('excluding front AND mirror selfie leaves neither', ids(noMirrorNoFront) === 'b1,c1');
check('the overlap is not double-counted — 7 minus 5 distinct, not 7 minus 6',
  noMirrorNoFront.length === 2);
check('excluding everything leaves nothing rather than falling back to everything',
  elig(mixed, { views: ['front', 'back', 'closeup'] }).length === 0);
check('an empty family excludes nothing', elig(mixed, { views: [], tags: ['mirror selfie'] }).length === 4);

// The direction, stated as a property: adding an exclusion can only ever SHRINK the pool.
const grow = elig(mixed, { tags: ['mirror selfie'] }).length <= elig(mixed, {}).length
  && elig(mixed, { tags: ['mirror selfie'], views: ['back'] }).length <= elig(mixed, { tags: ['mirror selfie'] }).length;
check('every added exclusion shrinks or holds the pool — never grows it', grow);

// --- 1c. the number on each chip is what it COSTS you ------------------------------------------------------
const VOCAB = { tags: ['mirror selfie'], views: ['front', 'back', 'closeup'] };
const cc = (rows, sel) => chipCounts(rows, sel, READ, VOCAB);

const c0 = cc(mixed, {});
check('with nothing ticked, a chip costs what it would remove',
  c0.views.front === 3 && c0.views.back === 3 && c0.views.closeup === 1);
check('and the tag chip likewise', c0.tags['mirror selfie'] === 3);
check('the view costs add up to the whole grid', c0.views.front + c0.views.back + c0.views.closeup === mixed.length);

// OVERLAP is the reason this is a difference and not a count. With mirror selfies already gone,
// FRONT can only take the 2 front poses that are left, not all 3.
const cTag = cc(mixed, { tags: ['mirror selfie'] });
check('with mirror selfie excluded, front now costs only what remains', cTag.views.front === 2);
check('back likewise', cTag.views.back === 1);
check('close-up is untouched by that exclusion', cTag.views.closeup === 1);
check('each cost equals the pool difference it actually causes',
  cTag.views.front === elig(mixed, { tags: ['mirror selfie'] }).length
    - elig(mixed, { tags: ['mirror selfie'], views: ['front'] }).length);

// A TICKED chip reports what unticking would give back — one definition, both directions.
const cOn = cc(mixed, { views: ['back'] });
check('a ticked chip shows how many it would give back', cOn.views.back === 3);
check('and that matches the pool it would restore',
  cOn.views.back === elig(mixed, {}).length - elig(mixed, { views: ['back'] }).length);

check('costs respect the grid they are given — a folder filter is already applied',
  cc(mixed.filter((p) => p.id.startsWith('bm')), {}).views.back === 2);
check('an empty grid costs zero everywhere', cc([], {}).views.front === 0);
check('a chip outside the vocabulary is simply absent', cc(mixed, {}).tags.bed === undefined);

// --- 2. the draw --------------------------------------------------------------------------------------
const pool20 = elig(grid, {});
check('asking for 5 of 20 returns exactly 5', drawPoses(pool20, 5).length === 5);
check('every drawn id came from the pool',
  drawPoses(pool20, 5).every((id) => pool20.some((p) => p.id === id)));
check('a draw has no duplicates', new Set(drawPoses(pool20, 12)).size === 12);
check('asking for exactly the pool size returns all of it', drawPoses(pool20, 20).length === 20);

// The shortfall case — take everything, do not throw, do not pad.
check('asking for 30 of 20 returns 20', drawPoses(pool20, 30).length === 20);
const six = elig(grid, { tags: [] }).slice(0, 6);
check('asking for 30 when only 6 are eligible returns 6', drawPoses(six, 30).length === 6);

check('zero returns nothing', drawPoses(pool20, 0).length === 0);
check('a negative returns nothing rather than throwing', drawPoses(pool20, -5).length === 0);
check('a non-number returns nothing', drawPoses(pool20, 'twelve').length === 0);
check('an empty string returns nothing', drawPoses(pool20, '').length === 0);
check('a decimal floors rather than throwing', drawPoses(pool20, 5.9).length === 5);
check('a numeric string works — the input is type=number but yields a string', drawPoses(pool20, '7').length === 7);
check('an empty pool returns nothing', drawPoses([], 5).length === 0);
check('a null pool returns nothing', drawPoses(null, 5).length === 0);

// --- 3. it is actually random, and it does not disturb the grid ---------------------------------------------
// 200 draws of 10 from 20 producing one single distinct result would mean the shuffle is not
// shuffling. Not flaky in any meaningful sense — the odds of a genuine tie across 200 draws are
// effectively zero.
const seen = new Set();
for (let i = 0; i < 200; i += 1) seen.add(drawPoses(pool20, 10).join(','));
check(`repeat clicks give different draws (${seen.size} distinct in 200)`, seen.size > 1);

const before = pool20.map((p) => p.id).join(',');
drawPoses(pool20, 10);
check('the pool array is not reordered as a side effect', pool20.map((p) => p.id).join(',') === before);

// An injected rand proves the shuffle is a real Fisher-Yates rather than a slice of the head.
// rand()=0 always swaps with index 0, which rotates the array — the head must not survive intact.
const headFirst = drawPoses(pool20, 3, () => 0);
check('it is a shuffle, not a slice of the first N', headFirst.join(',') !== 'm0,m1,m2');

// --- 4. what the row says -----------------------------------------------------------------------------
const d1 = describeDraw(12, 20, 3);
check('a normal draw reports taking and pool', d1.taking === 12 && d1.poolSize === 20);
check('and is not flagged short', d1.short === false);
check('the cross product is stated — 12 poses x 3 outfits', d1.images === 36);

const d2 = describeDraw(30, 4, 2);
check('a shortfall is flagged', d2.short === true);
check('and reports what it will actually take', d2.taking === 4);
check('with the honest image count', d2.images === 8);

check('with no outfits picked the count still means something', describeDraw(5, 20, 0).images === 5);
check('an empty pool takes nothing', describeDraw(12, 0, 3).taking === 0);
check('a blank number is treated as zero, not NaN', describeDraw('', 20, 3).taking === 0);
check('a garbage number is treated as zero', describeDraw('abc', 20, 3).taking === 0);
check('a negative number cannot produce a negative image count', describeDraw(-5, 20, 3).images === 0);

// --- 5. the UI is wired the way the logic assumes ------------------------------------------------------
const page = read('client/src/pages/EddyGeneratePage.jsx');
check('the randomiser draws from `visible`, the same array Select all uses',
  page.includes('eligiblePoses(visible, { tags: randomTags, views: randomViews }'));
check('it is scoped to the pose slot only', page.includes("slot.key === 'pose' && openPickers.pose"));
check('the button REPLACES the picks rather than adding to them',
  page.includes('setPickedPoses(drawPoses(pool, randomCount))'));
check('the chips are generated from the shared vocabulary, not a local copy',
  page.includes('POSE_TAGS.map((tag)'));
check('the shortfall is shown, not swallowed', page.includes('taking all ${d.poolSize}'));
check('the image count is shown at the point of the click', page.includes('d.images > 0 &&'));
check('the button is disabled when there is nothing to draw', page.includes('disabled={!d.taking}'));
check('the randomiser row is a SIBLING of the header, not inside it',
  // The header's closing </div> must come before the row opens, or the controls land inside the
  // flex row they were deliberately moved out of.
  page.indexOf('{/* RANDOMISE (owner, 2026-08-14') > page.indexOf("{openPickers[slot.key] ? 'Hide' : 'Choose'}"));
check('and it sits above the picked list, not after it',
  page.indexOf('{/* RANDOMISE (owner, 2026-08-14') < page.indexOf('{/* THE PICKED LIST.'));
check('the count survives a tab switch', page.includes('randomCount: 12, randomTags: []'));
check('and is in the snapshot that persists it', /const snap = \{[^}]*randomCount, randomTags, randomViews \}/.test(page));
check('with both in the effect deps, or the snapshot never rewrites',
  /\}, \[baseImage[^\]]*randomCount, randomTags, randomViews\]\);/.test(page));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
