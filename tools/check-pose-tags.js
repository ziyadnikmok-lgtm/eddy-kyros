// Pose TAGS — the second label family, and the guarantee that it did not disturb the first.
//
// "Mirror selfie" arrived as a request for "one extra label" (owner, 2026-08-14). The dangerous
// implementation is a fourth value in POSE_VIEWS: `view` answers which side of the GARMENT the
// camera sees, and Max Outfit, smartMatch and the prompt's body clause all read that answer. A
// mirror selfie can be shot facing the mirror or turned away from it, so folding it into `view`
// makes every mirror pose forfeit its front/back answer and start getting the wrong side of the
// outfit described.
//
// So the load-bearing assertion in this file is not that tags work. It is that adding one changes
// NOTHING about the view.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
// Normalised to LF: on a CRLF checkout the evaluated module body below is fine, but every other
// suite here reads this way and a lone exception is the one that breaks on someone else's laptop.
const srcText = fs.readFileSync(path.join(ROOT, 'client/src/lib/poseText.js'), 'utf8').replace(/\r\n/g, '\n');
const body = srcText.replace(/^export /gm, '');
// eslint-disable-next-line no-new-func
const mod = new Function(`${body}; return { readPoseTags, hasPoseTags, mergePoseTags, POSE_TAGS, readPoseView, hasPoseView, mergePoseView, readPoseDescription, poseSentence };`)();
const { readPoseTags, hasPoseTags, mergePoseTags, POSE_TAGS, readPoseView, hasPoseView, readPoseDescription } = mod;

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- fixtures: the two storage shapes that exist for real ------------------------------------
// Clean JSON, and the CSV/Sheets import shape whose quotes were never un-escaped (~30 of 60 real
// saved poses were in that second shape — see tryParsePoseJson).
const clean = JSON.stringify({
  reference_priority: { priority: 'highest' },
  subject: { features: 'Subtle smirk with a direct gaze' },
  pose_action: { description: 'Standing with one hip cocked, hand in her hair', view: 'front' },
});
const csvShaped = `"${JSON.stringify({
  pose_action: { description: 'Turned away, looking back over her shoulder', view: 'back' },
}).replace(/"/g, '""')}"`;
const prose = 'She leans against the wall, arms crossed.';
const noPoseAction = JSON.stringify({ subject: { features: 'a face' } });

// --- 1. the vocabulary is a single source ------------------------------------------------------
check('POSE_TAGS ships with mirror selfie', POSE_TAGS.includes('mirror selfie'));
check('and it is the whole vocabulary for now', POSE_TAGS.length === 1);

// --- 2. reading ---------------------------------------------------------------------------------
check('a card with no tags reads as []', eq(readPoseTags(clean), []));
check('and reports hasPoseTags false', hasPoseTags(clean) === false);
check('a plain-prose card reads as []', eq(readPoseTags(prose), []));
check('a plain-prose card is not "tagged"', hasPoseTags(prose) === false);
check('empty text is safe', eq(readPoseTags(''), []) && hasPoseTags('') === false);
check('null is safe', eq(readPoseTags(null), []) && hasPoseTags(null) === false);

// --- 3. writing, and the round trip ------------------------------------------------------------
const tagged = mergePoseTags(clean, ['mirror selfie']);
check('a merged tag reads back', eq(readPoseTags(tagged), ['mirror selfie']));
check('and now reports hasPoseTags true', hasPoseTags(tagged) === true);

// The empty array is a REAL answer — "we asked, it is not one" — and must be distinguishable from
// never having asked, or the AI pass re-charges for the same card on every run.
const answeredNo = mergePoseTags(clean, []);
check('an empty array is stored, not skipped', hasPoseTags(answeredNo) === true);
check('and reads back as no tags', eq(readPoseTags(answeredNo), []));
check('which is NOT the same as never asked', hasPoseTags(clean) === false && hasPoseTags(answeredNo) === true);

// --- 4. the CSV-garbled shape is handled, and repaired ------------------------------------------
const csvTagged = mergePoseTags(csvShaped, ['mirror selfie']);
check('a CSV-escaped card can be tagged', eq(readPoseTags(csvTagged), ['mirror selfie']));
check('and is written back as clean JSON', csvTagged.startsWith('{'));
check('its description survives the repair',
  readPoseDescription(csvTagged) === 'Turned away, looking back over her shoulder');

// --- 5. normalisation ---------------------------------------------------------------------------
check('case is normalised', eq(readPoseTags(mergePoseTags(clean, ['MIRROR SELFIE'])), ['mirror selfie']));
check('whitespace is normalised', eq(readPoseTags(mergePoseTags(clean, ['  mirror   selfie '])), ['mirror selfie']));
check('duplicates collapse', eq(readPoseTags(mergePoseTags(clean, ['mirror selfie', 'Mirror Selfie'])), ['mirror selfie']));
// A tag outside the vocabulary would render no chip in the filter UI, so it could be set and then
// never be selectable or clearable again.
check('an unknown tag is dropped, not stored', eq(readPoseTags(mergePoseTags(clean, ['bed'])), []));
check('a non-array is treated as no tags', eq(readPoseTags(mergePoseTags(clean, 'mirror selfie')), []));
check('nulls inside the array do not throw', eq(readPoseTags(mergePoseTags(clean, [null, 'mirror selfie'])), ['mirror selfie']));

// --- 6. it refuses to invent structure ---------------------------------------------------------
check('a prose card is returned untouched', mergePoseTags(prose, ['mirror selfie']) === prose);
check('a card with no pose_action is returned untouched', mergePoseTags(noPoseAction, ['mirror selfie']) === noPoseAction);
check('and neither becomes tagged as a side effect',
  hasPoseTags(mergePoseTags(prose, ['mirror selfie'])) === false
  && hasPoseTags(mergePoseTags(noPoseAction, ['mirror selfie'])) === false);

// --- 7. THE ONE THAT MATTERS: view is untouched -------------------------------------------------
// If this ever goes red, Max Outfit is handing back shots a front garment.
for (const [name, card] of [['front card', clean], ['back card', csvShaped]]) {
  const before = readPoseView(card);
  const after = mergePoseTags(card, ['mirror selfie']);
  check(`${name}: view survives a tag merge (${before})`, readPoseView(after) === before);
  check(`${name}: and stays explicitly labelled`, hasPoseView(after) === hasPoseView(card));
  check(`${name}: description survives too`, readPoseDescription(after) === readPoseDescription(card));
}
check('mirror selfie is NOT a view value', readPoseView(mergePoseTags(clean, ['mirror selfie'])) === 'front');
check('the view vocabulary was not widened', !/POSE_VIEWS = new Set\(\[[^\]]*mirror/.test(srcText));

// A pose can be back-facing AND a mirror selfie at the same time — the whole reason tags are
// separate. This is the combination a fourth view value makes unrepresentable.
const backMirror = mergePoseTags(csvShaped, ['mirror selfie']);
check('back + mirror selfie can both be true at once',
  readPoseView(backMirror) === 'back' && readPoseTags(backMirror).includes('mirror selfie'));

// --- 8. tags and views do not fight over the same card ------------------------------------------
const both = mergePoseTags(mod.mergePoseView(clean, 'closeup'), ['mirror selfie']);
check('setting a view then a tag keeps both',
  readPoseView(both) === 'closeup' && eq(readPoseTags(both), ['mirror selfie']));
const reversed = mod.mergePoseView(mergePoseTags(clean, ['mirror selfie']), 'back');
check('and the other order works too',
  readPoseView(reversed) === 'back' && eq(readPoseTags(reversed), ['mirror selfie']));
check('re-tagging clears the old set rather than appending',
  eq(readPoseTags(mergePoseTags(tagged, [])), []));

// --- 9. the per-card chip -----------------------------------------------------------------------
const col = fs.readFileSync(path.join(ROOT, 'client/src/components/EddyCollection.jsx'), 'utf8').replace(/\r\n/g, '\n');
check('the chip exists on the pose card', col.includes("onClick={() => setPoseTag(it, 'mirror selfie')}"));
check('it is visually separate from the three view buttons',
  col.includes('border-l border-white/[0.08]') && col.includes('bg-fuchsia-500/25'));
check('the view buttons kept their own colour', col.includes('bg-blue-500/25 text-blue-200'));
check('setPoseTag writes through mergePoseTags, not a row field',
  /const setPoseTag = useCallback[\s\S]{0,400}mergePoseTags\(it\.prompt,/.test(col));
check('a card with no readable text is refused rather than silently no-op',
  /const setPoseTag = useCallback[\s\S]{0,500}no readable pose text yet/.test(col));

// Clicking the active chip clears it — replayed against the real merge so the assertion tracks the
// function rather than the JSX. Clearing must write [], not drop the key: [] is "asked, not one",
// and it is what stops the paid pass re-asking about a card corrected by hand.
const toggle = (text, tag) => {
  const cur = readPoseTags(text);
  return mergePoseTags(text, cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]);
};
const on = toggle(clean, 'mirror selfie');
const off = toggle(on, 'mirror selfie');
check('first click tags it', readPoseTags(on).includes('mirror selfie'));
check('second click clears it', eq(readPoseTags(off), []));
check('and the cleared card still counts as ANSWERED', hasPoseTags(off) === true);
check('toggling does not disturb the view', readPoseView(off) === readPoseView(clean));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
