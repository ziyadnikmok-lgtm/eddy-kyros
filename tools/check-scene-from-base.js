// The room comes from the BASE photo, never from the pose diagram.
//
// ⚠️ OWNER, 2026-08-17: "in max nano it using the background of the pose image not of the base
// image wtf."
//
// The lock was never missing. THE SETTING COMES FROM IMAGE 1 AND NOTHING ELSE has been in this
// prompt for months, and so has the ban on furniture named in the pose DESCRIPTION. What was wrong
// is WHERE they sit. Measured over the real builder:
//
//     max nano       setting lock @54%   framing @80%   pose match @88%   final check @96%
//     eddy + outfit  setting lock @59%   framing @83%   pose match @90%   final check @97%
//
// The last things the model reads are CAMERA ANGLE — MATCH THE POSE DIAGRAM EXACTLY, FRAMING —
// THIS OVERRIDES EVERYTHING ABOUT THE SHOT, and POSE MATCH — TOP PRIORITY. Three consecutive
// absolutes pointing at the diagram, with nothing at the tail saying the ROOM is not part of what
// they point at — while the scene lock sits back in the middle where the weight is lowest.
//
// This file has learned the same lesson three times before: the bust lock, the framing line and the
// face lock each had to be restated at the end, and each comment says so. The scene was the one
// that had not been.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/EddyGeneratePage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// The REAL builder, lifted — a stand-in would let this pass while the app shipped something else.
const start = src.indexOf('function buildPrompt({');
const end = src.indexOf('\n}\n', start) + 3;
const scope = /const BACK_VIEW_BODY_SCOPE = (`[\s\S]*?`|'[^']*');/.exec(src);
// eslint-disable-next-line no-new-func
const build = new Function(`const BACK_VIEW_BODY_SCOPE = ${scope ? scope[1] : "''"};
  ${src.slice(start, end)}; return buildPrompt;`)();

const BASE = {
  instruction: '', outfitText: '', poseText: '', outfitIndex: 0, poseIndex: 0, faceIndex: 0,
  nsfw: false, wantsNude: false, wantsBody: false, undressChip: '', tweak: '', poseFaceless: false,
  lightingText: '', poseView: 'front', buildText: '', expressionText: '', lockOutfitToBase: true,
};
// A pose description that NAMES a room, because that is the shape that leaks.
const POSE = 'She is seated in a pink velvet armchair, torso leaning back, arms on the armrests.';
const MAXNANO = { ...BASE, poseText: POSE, poseIndex: 2, faceIndex: 3, buildText: 'She has a VERY LARGE, heavy bust.' };

// --- the three locks that were already there ------------------------------------------------------
const p = build(MAXNANO);
check('the setting is stated as coming from image 1', p.includes('THE SETTING COMES FROM IMAGE 1 AND NOTHING ELSE'));
check('the pose DESCRIPTION\'s furniture is banned from being built',
  p.includes('They are NOT part of the scene and must NOT be built'));
check('and re-pointed at image 1\'s own surfaces instead', p.includes("Put the same body position into image 1's own setting instead"));

// --- the one that was missing: the same rule at the TAIL --------------------------------------------
// Anchored on the clause every variant shares — the heading changes with where the clothes come
// from (image 1, the outfit, or nothing on a nude run).
const TAIL = 'AND THE CAMERA DOES NOT CHANGE THAT';
check('the room is restated after the pose block', p.includes(TAIL));
check('it names what the diagram supplies, and what it does not',
  p.includes('gives the body position, the camera and the crop — and NOTHING of its room, walls, floor, furniture, props, bedding, view or clothing'));
/**
 * THE LOAD-BEARING SENTENCE. Matching the diagram's crop and camera almost always reveals space
 * outside image 1's frame, and the model has to invent it. The only other room in the payload is
 * the diagram's, so that is what it reaches for.
 */
check('and it says whose space fills what the new framing reveals',
  p.includes("extend image 1's OWN room into it"));

// --- THE CLOTHES TOO, and for the same reason ----------------------------------------------------------
//
// ⚠️ Owner, 2026-08-17: "it using outfit of the pose image it not using only the pose from it" —
// their results showed her in the pose photos' grey gym set instead of the base photo's lace dress.
//
// The outfit lock was not missing either. Measured on the real builder: "Her CLOTHING comes from
// image 1" sits at 45% and "whatever the stand-in is wearing is IRRELEVANT" at 50% — the same dead
// middle the setting lock was in — while FRAMING (79%) and POSE MATCH (88%) point at the diagram.
// Same disease, same cure: say it in the tail sentence.
check('the tail line covers the clothes, not only the room', p.includes('THE ROOM AND THE CLOTHES'));
check('and bans clothing from the diagram explicitly', p.includes('bedding, view or clothing'));
check('naming where the clothes DO come from', p.includes('She wears what she wears in image 1 — not what the stand-in has on'));
// MEASURED after the rewording: room held twice, top and trousers held twice, and one of the two
// runs came back in the stand-in's white boots carrying her green bag. "Clothing" did not read as
// covering accessories, so they are named.
check('and accessories are named, because boots and a bag leaked when they were not',
  p.includes('that includes shoes, boots, bags, jewellery and anything she is holding'));
// It has to follow where the clothes actually come from, or the line becomes the contradiction it
// exists to prevent. Written per case, because splicing fragments produced "THE ROOM ARE IMAGE 1'S".
{
  const outfit = build({ ...MAXNANO, outfitIndex: 4, outfitText: 'black lace bodysuit', lockOutfitToBase: false });
  check('with an outfit chosen, the clothes come from the OUTFIT, not image 1',
    outfit.includes("THE ROOM IS IMAGE 1'S AND THE CLOTHES ARE THE OUTFIT'S")
    && outfit.includes('Her clothing comes from the outfit above, never from image 2.'));
  const nude = build({ ...MAXNANO, wantsNude: true });
  check('a nude run says nothing about clothing at all', nude.includes("THE ROOM IS IMAGE 1'S, AND THE CAMERA")
    && !nude.includes('or clothing'));
  check('and no case produces broken grammar', !nude.includes('THE ROOM ARE') && !outfit.includes('THE ROOM ARE'));
}

// --- THE THREE PHRASES THAT LICENSED THE LEAK -----------------------------------------------------
//
// ⚠️ Third report of the same symptom, this time with the full prompt pasted — every lock present
// and correct, and the room STILL coming from the pose photo. So the fault is not a missing rule;
// it is three phrases that grant one.
//
//   1. "image 2 supplies the shot, including where the camera is" — a photograph IS a shot. Read
//      plainly, that sentence hands the model image 2's picture.
//   2. "CAMERA ANGLE — MATCH THE POSE DIAGRAM EXACTLY" — with no statement that the camera is
//      re-staged in image 1's room, matching it exactly is most easily done by keeping image 2.
//   3. "FRAMING — THIS OVERRIDES EVERYTHING ABOUT THE SHOT" — the loud word is EVERYTHING, and it
//      sits at 79%, well after the setting lock at 55%. An override that outranks the room is
//      exactly how the room gets overridden.
//
// None of these were wrong about the SHOT. They were unscoped about the SCENE.
check('the diagram supplies the camera, not the photograph',
  p.includes('supplies ONLY the camera — where it stands, how far away it is and how much it frames. It does not supply the photograph.'));
check('the camera is explicitly re-staged inside the base photo room',
  p.includes("the camera, not the photograph — it is re-staged inside image 1's room"));
check('and the framing override is scoped to the shot alone',
  p.includes('THIS OVERRIDES EVERYTHING ABOUT THE SHOT, AND NOTHING ABOUT THE SCENE: it decides the crop and the distance, never the room, the clothes or who she is'));
check('the old unscoped phrasing is gone',
  !p.includes('supplies the shot, including where the camera is')
  && !src.includes('`FRAMING — THIS OVERRIDES EVERYTHING ABOUT THE SHOT: match'));

// --- POSITION IS THE WHOLE POINT ----------------------------------------------------------------------
const at = (out, needle) => out.indexOf(needle);
for (const [name, opts] of Object.entries({
  'max nano': MAXNANO,
  'max nano, back view': { ...MAXNANO, poseView: 'back' },
  'eddy + outfit': { ...MAXNANO, outfitIndex: 4, outfitText: 'black lace bodysuit' },
  'nude': { ...MAXNANO, wantsNude: true },
  'faceless': { ...MAXNANO, poseFaceless: true },
  'with a tweak': { ...MAXNANO, tweak: 'make the light warmer' },
  'custom lighting': { ...MAXNANO, lightingText: 'Warm golden hour light.' },
})) {
  const out = build(opts);
  const room = at(out, TAIL);
  check(`${name}: the tail room lock is present`, room > -1);
  // After CAMERA ANGLE and FRAMING — the two that point at the diagram and used to go unanswered.
  check(`${name}: it comes AFTER camera angle and framing`,
    room > at(out, 'CAMERA ANGLE') && room > at(out, 'FRAMING'));
  /**
   * BUT BEFORE POSE MATCH, and that order is the whole lesson of 2026-08-17.
   *
   * This file's rule is that the later line wins — it is why the bust lock, the framing line and the
   * face lock were each moved to the end. The room sentence went in AFTER pose match, so the last
   * thing the model read about the shot stopped being "trace the silhouette" and became "the room is
   * image 1's". Measured at the time: pose match 86%, room 89% — and the poses stopped being copied
   * exactly ("now it not copy the pose exactly the exact same").
   *
   * Both belong in the final fifth; the ORDER decides which is the last word, and for the shot that
   * has to be the pose.
   */
  check(`${name}: and BEFORE pose match, which stays the last word on the shot`,
    room < at(out, 'POSE MATCH'));
  // Before the identity check, which stays the last word on WHO she is.
  check(`${name}: and before the final identity check`, room < at(out, 'FINAL CHECK'));
  // 0.75, not 0.8, since 2026-08-18: there are now TWO absolute tails after it — the one-frame
  // lock (a run with several references was returning a contact sheet) and, on a re-generate, the
  // CORRECTION, which has to stay the genuinely last word. With both present the room line sits at
  // ~0.78. Still the last quarter, still after everything it has to beat, and the two assertions
  // above pin the ORDER, which is what actually matters.
  check(`${name}: it sits in the last quarter of the prompt (${(room / out.length).toFixed(2)})`,
    room / out.length > 0.75);
}

// --- THE EXPRESSION LINE WAS DESCRIBING THE STAND-IN'S FACE -------------------------------------------
//
// ⚠️ It read "copy the face she is making: <sentence>", and the sentence comes from the pose JSON's
// `subject.features` — FEATURES, not expression. What arrives is like "Attractive face looking
// straight at the camera with a soft confident expression, full glossy lips, heavy eye makeup".
// Half of that is the stand-in's FACE, and the prompt was telling the model to copy it while MAKEUP,
// the diagram ban and FINAL CHECK all said the opposite.
//
// Not fixed by stripping words out of free text — that works until it does not. The line scopes what
// may be read out of the sentence instead.
{
  const withExpr = build({ ...MAXNANO, expressionText: 'Attractive face, full glossy lips, heavy eye makeup' });
  check('the expression line is scoped to what the face is DOING',
    withExpr.includes('EXPRESSION — what her face is DOING, and nothing else:'));
  check('and appearance in that sentence is explicitly ignored',
    withExpr.includes('is describing the stand-in and is IGNORED'));
  check('naming where her features actually come from', withExpr.includes('Those come from image 3.'));
  // Position still matters: the face lock is the later line, so it wins by placement too.
  check('it stays before the final identity check',
    withExpr.indexOf('EXPRESSION —') < withExpr.indexOf('FINAL CHECK'));
  // No pose expression, no line — an empty one would be a rule about nothing.
  check('and no expression means no line at all', !build(MAXNANO).includes('EXPRESSION —'));
}

// --- THE POSE PICTURE MUST ACTUALLY BE SENT ----------------------------------------------------------
//
// "ALSO DO IT SEND THE FUCKING PICTURE OF THE POSE CAN YOU MAKE SURE IT RECREATE" (owner,
// 2026-08-17). It does — sendPoseImage defaults ON — but the value is SHARED and PERSISTED across
// every tab, so a text-only experiment run on Eddy follows you into Max Nano silently. And silence
// is the problem: EVERY "match the diagram" clause is gated on poseIndex, so with no picture the
// prompt stops asking for the camera, the crop and the silhouette altogether.
const gen = src;
check('Max Nano arrives with the pose photo on', gen.includes('if (maxNano) setSendPoseImage(true);'));
// Deps [maxNano], not [maxNano, sendPoseImage] — an arrival default that re-fires on every change
// is a lock, and the toggle could never be turned off at all.
check('on ARRIVAL only, so turning it off deliberately still sticks', (() => {
  const i = gen.indexOf('if (maxNano) setSendPoseImage(true);');
  return i > -1 && gen.slice(i, i + 130).includes('}, [maxNano]);');
})());
check('and turning it off with poses picked says what it costs',
  gen.includes('{!sendPoseImage && pickedPoses.length > 0 && (')
  && gen.includes('with no picture to trace'));
// The prompt half of the same fact, asserted on the real builder: no diagram, no diagram clauses.
{
  const noPic = build({ ...BASE, poseText: POSE, faceIndex: 3 });
  const withPic = build(MAXNANO);
  // Checked against the builder rather than assumed — and the first version of this assertion was
  // WRONG, which is the point of running it: the text-only branch has its own camera and pose-match
  // lines sourced from the sentence. What disappears is everything that points AT THE PICTURE.
  check('with no pose picture, nothing points at a diagram',
    !noPic.includes('MATCH THE POSE DIAGRAM EXACTLY')
    && !/[Mm]atch the pose diagram's crop EXACTLY/.test(noPic)
    && !noPic.includes('is a POSE DIAGRAM, not a person'));
  check('but the pose is still asked for, in words',
    noPic.includes('POSE MATCH') && noPic.includes('CAMERA ANGLE'));
  check('and with a picture, every diagram clause is there',
    withPic.includes('MATCH THE POSE DIAGRAM EXACTLY')
    && /[Mm]atch the pose diagram's crop EXACTLY/.test(withPic)
    && withPic.includes('POSE MATCH — TOP'));
  // The warning must describe THAT, not something stronger — it used to claim the camera and crop
  // were "not asked for at all", which the builder disproves.
  check('and the on-screen warning says what actually changes',
    gen.includes('asks for the camera and the position, but from the DESCRIPTION rather than the image'));
}

// --- and only when there IS a diagram to steal a room from --------------------------------------------
const textOnly = build({ ...BASE, poseText: POSE, faceIndex: 3 });
check('a text-only pose gets no diagram line, because there is no diagram',
  !textOnly.includes(TAIL));
check('but it still gets the setting lock and the furniture ban',
  textOnly.includes('THE SETTING COMES FROM IMAGE 1') && textOnly.includes('must NOT be built'));

// --- length, since two nearby comments worry about it ---------------------------------------------------
// The "~5.3k = a 422" figure they cite is MUAPI's limit. Eddy has not gone through Muapi since the
// WaveSpeed path was added, and wavespeedService says WaveSpeed documents no prompt-length cap.
check('WaveSpeed is documented as having no prompt cap — the reason that path exists',
  fs.readFileSync(path.join(ROOT, 'server/services/wavespeedService.js'), 'utf8')
    .includes('WaveSpeed documents no prompt-length cap'));
check(`the max nano prompt is a sane size (${build(MAXNANO).length} chars)`, build(MAXNANO).length < 9000);
check('and the measurement is recorded rather than the worry repeated', /neither 422s/.test(src));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
