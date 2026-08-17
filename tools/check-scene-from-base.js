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
  // After every instruction that points at the diagram — that is the entire reason it exists.
  check(`${name}: it comes AFTER framing and pose match`,
    room > at(out, 'FRAMING') && room > at(out, 'POSE MATCH'));
  // Before the identity check, which stays the last word on WHO she is.
  check(`${name}: and before the final identity check`, room < at(out, 'FINAL CHECK'));
  check(`${name}: it sits in the last fifth of the prompt`, room / out.length > 0.8);
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
