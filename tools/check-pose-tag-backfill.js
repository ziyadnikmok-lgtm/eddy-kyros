// The free mirror-selfie pass — what it tags, and more importantly what it refuses to.
//
// The trade this makes is the same one poseViewBackfill made: do not pay a vision call to answer
// something the saved description already says. That is only a good trade if the reading is right,
// so the assertions that matter here are the NEGATIVE ones — "mirrored", a mirror merely present in
// the room, a reflection in water. A false positive costs a wrongly-tagged pose that then gets
// drawn by a randomiser asking for mirror selfies, and nothing ever flags it.
//
// The other load-bearing rule: a card this pass is SILENT about must be left with no tags array at
// all, so the AI pass still sees it. Stamping [] here would mark it answered and the paid pass
// would skip it forever.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// Both modules are ESM; evaluate the pure functions rather than importing.
// eslint-disable-next-line no-new-func
const text = new Function(`${read('client/src/lib/poseText.js').replace(/^export /gm, '')}; return { readPoseDescription, hasPoseTags, mergePoseTags, readPoseTags, readPoseView };`)();
// eslint-disable-next-line no-new-func
const bf = new Function(`${read('client/src/lib/poseTagBackfill.js').replace(/^export /gm, '')}; return { planPoseTagBackfill, readsAsMirrorSelfie };`)();
const { readsAsMirrorSelfie, planPoseTagBackfill } = bf;

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- 1. the phrasings that DO mean it ------------------------------------------------------------
for (const s of [
  'She is taking a mirror selfie in her bedroom.',
  'A mirror-selfie, phone held at chest height.',
  'Standing in front of the bathroom mirror, snapping a selfie.',
  'A selfie taken in the full-length mirror.',
  'She faces the mirror, one hand on her hip.',
  'Turned towards the mirror with her back arched.',
  'Holding her phone up to the mirror, head tilted.',
  'The mirror catches her phone and her half-smile.',
  'Reflected in the wardrobe mirror, looking down at the screen.',
]) check(`reads as one: "${s.slice(0, 46)}…"`, readsAsMirrorSelfie(s) === true);

// --- 2. the ones that only LOOK like it ----------------------------------------------------------
// Each of these is a false positive a bare /mirror/i would have produced.
for (const s of [
  'Her pose is mirrored from the reference image.',
  'She is mirroring the stance in the photo beside her.',
  'A smoked-mirror wall runs behind the sofa.',              // mirror present, not shot into
  'Sunlight glints off the mirrored sunglasses she wears.',
  'Her reflection ripples in the surface of the pool.',      // reflection, not a mirror
  // "her reflection" with no mirror named is EXACTLY the judgement call this pass declines to make.
  // It is not a miss — it falls through to the AI pass, which is the cheap, designed answer.
  'Her reflection shows a relaxed, confident posture.',
  'Standing by a window, the city reflected in the glass.',
  'She holds her phone loosely at her side, looking away.',  // phone, no mirror
  'A close-up of her face against a plain grey wall.',
]) check(`correctly NOT one: "${s.slice(0, 46)}…"`, readsAsMirrorSelfie(s) === false);

check('empty description is not a match', readsAsMirrorSelfie('') === false);
check('null is not a match', readsAsMirrorSelfie(null) === false);

// --- 3. the plan over a realistic mixed library -----------------------------------------------------
const card = (id, description, extra = {}) => ({
  id,
  prompt: JSON.stringify({ pose_action: { description, view: 'front', ...extra } }),
});
const cards = [
  card('a', 'Taking a mirror selfie, phone at chest height.'),         // -> tagged
  card('b', 'Seated on the edge of the bed, looking at the camera.'),  // -> silent
  card('c', 'Her pose is mirrored from the reference.'),               // -> silent (not a match)
  card('d', 'In front of the hallway mirror, hip cocked.'),            // -> tagged
  card('e', 'Standing by the window.', { tags: [] }),                  // -> already (answered no)
  card('f', 'A mirror selfie in the gym.', { tags: ['mirror selfie'] }),// -> already (answered yes)
  { id: 'g', prompt: '{ this is not json' },                           // -> unreadable
  { id: 'h', prompt: '' },                                             // -> silent (empty card)
];
const { patches, stats } = planPoseTagBackfill(cards, text);

check('every card is accounted for', stats.total === 8);
check('two are tagged for free', stats.matched === 2);
check('and they are the right two', patches.has('a') && patches.has('d'));
check('two were already answered and are left alone', stats.already === 2);
check('a broken card is counted, not crashed on', stats.unreadable === 1);
check('the rest are silent', stats.silent === 3);
check('the buckets add up', stats.matched + stats.already + stats.unreadable + stats.silent === stats.total);

// --- 4. what a patch actually contains ---------------------------------------------------------------
const pa = patches.get('a');
check('the patch carries a prompt, not a tags field',
  typeof pa.prompt === 'string' && pa.tags === undefined);
check('and it reads back as tagged', text.readPoseTags(pa.prompt).includes('mirror selfie'));
check('the view is untouched by the backfill', text.readPoseView(pa.prompt) === 'front');
check('the description is untouched too',
  text.readPoseDescription(pa.prompt) === 'Taking a mirror selfie, phone at chest height.');

// --- 5. THE RULE: silence must stay unanswered ------------------------------------------------------
// If a silent card were stamped [], hasPoseTags would go true and the AI pass — which targets
// !hasPoseTags — would never look at it. The free pass would have permanently hidden every mirror
// selfie whose description does not say so.
check('a silent card gets NO patch', !patches.has('b') && !patches.has('c') && !patches.has('h'));
check('so it still reads as unanswered', text.hasPoseTags(cards[1].prompt) === false);
check('an unreadable card gets no patch either', !patches.has('g'));

// --- 6. it is a pure planner ------------------------------------------------------------------------
check('the input rows are not mutated',
  cards[0].prompt === JSON.stringify({ pose_action: { description: 'Taking a mirror selfie, phone at chest height.', view: 'front' } }));
check('an empty library is fine', planPoseTagBackfill([], text).stats.total === 0);
check('a null library is fine', planPoseTagBackfill(null, text).stats.total === 0);
check('running it twice is idempotent — the second pass finds nothing new', (() => {
  const applied = cards.map((c) => (patches.has(c.id) ? { ...c, prompt: patches.get(c.id).prompt } : c));
  return planPoseTagBackfill(applied, text).stats.matched === 0;
})());

// --- 7. VERIFIED AGAINST THE REAL LIBRARY (2026-08-14) ----------------------------------------------
// The fixtures above were invented. These are not: all 60 pose images in the owner's library were
// exported and looked at one by one, and exactly 8 are mirror selfies — 004, 018, 035, 036, 044,
// 045, 050, 058. Run against their real saved descriptions the matcher scored 8 caught, 0 missed,
// 0 false positives, 52 correctly skipped. These are the sentences that proved it, kept verbatim so
// a future tweak to the patterns has to stay right about the data it was tuned on.
//
// Same method poseViewBackfill's rule was settled by: "checked against the real 60-pose library,
// every image reviewed by eye".
const REAL_YES = [
  // 004 — back view AND a mirror selfie. Nothing else in the fixtures proves the two coexist in the
  // owner's actual data, which is the whole argument for tags not being a fourth view value.
  'She is kneeling on the bed on all fours with her hips elevated and her back arched deeply, supporting her weight on her forearms which are placed flat on the mattress, while she holds her phone in her right hand to take a mirror selfie with her head slightly tilted towards the camera.',
  // 018 — the phrase is split across "hold a phone for a mirror selfie".
  'Sitting on the floor with her legs spread wide and knees bent upward, she leans forward slightly while supporting herself with her right arm extended back and hand flat on the carpet, her left arm bent at the elbow to hold a phone for a mirror selfie, with her feet resting on the floor and her gaze directed towards the phone screen.',
  // 035
  'Sitting in a deep wide straddle stretch on the floor with both legs fully stretched and spread wide to the side, one hand holding a phone up for a mirror selfie, holding phone at belly button level height.',
  // 036
  'Standing and taking a mirror selfie, one leg raised high with knee bent sharply and angled outward to the side, thigh opened away from the body, foot prominently displayed in the foreground.',
  // 044 / 045 — "mirror selfie pose", and "toward the mirror" with no phone mentioned at all.
  'Lying on her side in mirror selfie pose with lower body twisted strongly toward the mirror, legs fully extended in paralel and stacked on top of each other, hips pushed far back.',
  'Lying on her side in a mirror selfie pose but with hips and lower body twisted and pushed back toward the mirror, ass and hamstrings prominently displayed and taking up the majority of the lower frame.',
  // 050
  'Taking a mirror selfie in a deep wide frog-style squat position, feet flat on the floor, knees bent and pushed wide apart, legs spread open, hips lowered close to the ground, torso upright and facing the mirror directly.',
  // 058 — also back view.
  'On all fours on the bed positioned side-on to a large mirror, taking a mirror selfie. Knees planted into the mattress and set apart. Back arches deeply downward with chest and shoulders dropping low.',
];
for (const [i, d] of REAL_YES.entries()) check(`real library, mirror selfie #${i + 1} of 8`, readsAsMirrorSelfie(d) === true);

// The dangerous ones. Every one of these says "selfie", and 039 says "holding the phone" as well —
// they are ordinary arm's-length selfies, confirmed by eye. This is exactly why the matcher demands
// \bmirror\b AND an indicator rather than treating "selfie" or "phone" as sufficient: a matcher
// keyed on either word alone tags all four, and nothing would ever have flagged it.
const REAL_NO = [
  'Close-up selfie, head tilted, one hand raised near her mouth with long nails, tongue extended licking her fingers, looking directly at the camera',
  'Taking a selfie from above, head tilted all the way back looking up into the camera, one hand covering her eyes, mouth wide open with tongue extended fully outward',
  'Taking a high-angle selfie with arm extended forward holding the phone, body angled to show her backside, ass prominently visible and pushed out, standing or slightly bent forward',
  'Standing directly over the camera with legs slightly apart, the camera is right under her on the ground, she is standing on the viewers face as POV, one foot placed prominently in the corner',
];
for (const [i, d] of REAL_NO.entries()) check(`real library, selfie but NOT a mirror selfie #${i + 1} of 4`, readsAsMirrorSelfie(d) === false);
check('a naive "selfie OR phone" matcher would have got three of these wrong',
  REAL_NO.filter((d) => /\bselfie\b|\bphone\b/i.test(d)).length === 3);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
