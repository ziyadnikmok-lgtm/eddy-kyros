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
const rnd = new Function(`${read('client/src/lib/poseRandomiser.js').replace(/^export /gm, '')}; return { eligiblePoses, drawPoses, describeDraw };`)();
// eslint-disable-next-line no-new-func
const text = new Function(`${read('client/src/lib/poseText.js').replace(/^export /gm, '')}; return { readPoseTags, readPoseView, POSE_TAGS };`)();
const { eligiblePoses, drawPoses, describeDraw } = rnd;
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

// --- 1. eligibility ---------------------------------------------------------------------------------
const READ = { readTags: readPoseTags, readView: text.readPoseView };
const elig = (rows, sel) => eligiblePoses(rows, sel, READ);

check('nothing selected draws from everything on screen', elig(grid, {}).length === 20);
check('a tag narrows to just those poses', elig(grid, { tags: ['mirror selfie'] }).length === 6);
check('and it is the right six', elig(grid, { tags: ['mirror selfie'] }).every((p) => p.id.startsWith('m')));
check('an answered-no pose is excluded when a tag is selected',
  !elig(grid, { tags: ['mirror selfie'] }).some((p) => p.id.startsWith('n')));
check('an unasked pose is excluded too',
  !elig(grid, { tags: ['mirror selfie'] }).some((p) => p.id.startsWith('u')));
check('but unasked poses ARE included with no tag selected',
  elig(grid, {}).some((p) => p.id.startsWith('u')));
check('an unknown tag matches nothing rather than everything', elig(grid, { tags: ['bed'] }).length === 0);
check('an empty grid is fine', elig([], { tags: ['mirror selfie'] }).length === 0);
check('a null grid is fine', elig(null, {}).length === 0);
check('an omitted selection object is fine', eligiblePoses(grid, undefined, READ).length === 20);

// Union WITHIN a family: "the labels of poses i want" is any-of. An AND across two tags would
// return nothing almost every time, which reads as a broken button.
const twoTags = [pose('a', ['mirror selfie']), pose('b', ['bed']), pose('c', ['mirror selfie', 'bed'])];
const readAny = (p) => { try { return JSON.parse(p).pose_action.tags || []; } catch { return []; } };
check('two selected tags are a UNION, not an intersection',
  eligiblePoses(twoTags, { tags: ['mirror selfie', 'bed'] }, { readTags: readAny }).length === 3);

// --- 1b. views, and how the two families combine -----------------------------------------------------
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
check('a view narrows to that view', elig(mixed, { views: ['back'] }).map((p) => p.id).join(',') === 'bm1,bm2,b1');
check('two views are a UNION — a pose has only one, so an AND could never match',
  elig(mixed, { views: ['back', 'closeup'] }).length === 4);
check('close-up is selectable on its own', elig(mixed, { views: ['closeup'] }).map((p) => p.id).join(',') === 'c1');
check('an unlabelled card counts as front, matching the rest of the app',
  elig(mixed, { views: ['front'] }).some((p) => p.id === 'plain'));

// THE ONE THAT MATTERS: across families it is AND. In one OR bucket this would return 6 of 7 —
// "everything back plus everything mirror" — which is close to no filter and looks broken.
const backMirror = elig(mixed, { views: ['back'], tags: ['mirror selfie'] });
check('back + mirror selfie is an INTERSECTION, not a union', backMirror.length === 2);
check('and it is exactly the back-facing mirror selfies', backMirror.map((p) => p.id).join(',') === 'bm1,bm2');
check('front + mirror selfie picks the other one', elig(mixed, { views: ['front'], tags: ['mirror selfie'] }).map((p) => p.id).join(',') === 'fm1');
check('a combination with no members returns empty rather than falling back to everything',
  elig(mixed, { views: ['closeup'], tags: ['mirror selfie'] }).length === 0);
check('an empty family is not a filter',
  elig(mixed, { views: [], tags: ['mirror selfie'] }).length === 3);

// --- 2. the draw --------------------------------------------------------------------------------------
const pool20 = elig(grid, {});
check('asking for 5 of 20 returns exactly 5', drawPoses(pool20, 5).length === 5);
check('every drawn id came from the pool',
  drawPoses(pool20, 5).every((id) => pool20.some((p) => p.id === id)));
check('a draw has no duplicates', new Set(drawPoses(pool20, 12)).size === 12);
check('asking for exactly the pool size returns all of it', drawPoses(pool20, 20).length === 20);

// The shortfall case — take everything, do not throw, do not pad.
check('asking for 30 of 20 returns 20', drawPoses(pool20, 30).length === 20);
const six = elig(grid, { tags: ['mirror selfie'] });
check('asking for 30 mirror selfies when 6 exist returns 6', drawPoses(six, 30).length === 6);

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
