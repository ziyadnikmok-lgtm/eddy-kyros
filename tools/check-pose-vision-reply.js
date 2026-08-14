// One vision call, two answers — and the parse that must never turn a bad reply into a bad label.
//
// /classify-pose-view answered with a single word for two years. Adding the mirror-selfie question
// to the same call is free (the image is already uploaded, the round trip is already paid for), but
// it changes the reply shape, and the OLD parse was `.replace(/[^a-z]/g, '')` — which works only for
// one word. The moment a second word arrives, "back yes" collapses to "backyes", matches nothing,
// and silently falls back to "front". That would have mislabelled every back and close-up pose in
// the library the day the feature shipped, while looking perfectly fine on front poses.
//
// So the assertions here are mostly about DEGRADATION: a model that ignores the format, an older
// server that never heard of the question, a reply that is empty. Every one of those must cost a
// missing tag and nothing else — never a wrong view, never a tag that was not asked for.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const route = read('server/routes/eddyVision.js');

// Lift the parser out of the route rather than re-implementing it — a second copy would drift from
// the one that actually runs.
const fnStart = route.indexOf('function parseViewAndMirror');
const fnEnd = route.indexOf('\n}\n', fnStart) + 3;
// eslint-disable-next-line no-new-func
const parse = new Function(`${route.slice(fnStart, fnEnd)}; return parseViewAndMirror;`)();

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };
const is = (text, view, mirror) => { const r = parse(text); return r.view === view && r.mirror === mirror; };

// --- 1. the format the prompt asks for -----------------------------------------------------------
check('"front no"', is('front no', 'front', false));
check('"front yes"', is('front yes', 'front', true));
check('"back no"', is('back no', 'back', false));
check('"back yes" — a mirror selfie shot from behind, the case a 4th view value cannot express',
  is('back yes', 'back', true));
check('"closeup yes"', is('closeup yes', 'closeup', true));

// --- 2. sloppy but recognisable --------------------------------------------------------------------
check('case is ignored', is('CLOSEUP  YES', 'closeup', true));
check('extra whitespace is ignored', is('  back    no  ', 'back', false));
check('a newline between them', is('front\nyes', 'front', true));
check('trailing punctuation', is('front, yes.', 'front', true));
check('a period-separated reply', is('back.no', 'back', false));

// --- 3. THE REGRESSION: the old parse silently broke these -------------------------------------------
// `.replace(/[^a-z]/g,'')` turns each of these into one unrecognised blob and answers "front".
const oldParse = (t) => { const w = String(t || '').trim().toLowerCase().replace(/[^a-z]/g, ''); return ['front', 'back', 'closeup'].includes(w) ? w : 'front'; };
check('OLD parse got "back yes" wrong', oldParse('back yes') === 'front');
check('OLD parse got "closeup yes" wrong', oldParse('closeup yes') === 'front');
check('new parse gets "back yes" right', parse('back yes').view === 'back');
check('new parse gets "closeup yes" right', parse('closeup yes').view === 'closeup');

// --- 4. degradation — every one of these must cost a tag and NOTHING else -------------------------------
check('one token only: view kept, no tag', is('closeup', 'closeup', false));
check('one token only, front', is('front', 'front', false));
check('empty reply behaves as it always did', is('', 'front', false));
check('null reply', is(null, 'front', false));
check('undefined reply', is(undefined, 'front', false));
check('whitespace only', is('   ', 'front', false));

// A model that ignores the format is not answering the mirror question, and a "yes" sitting loose
// in prose is not consent to tag the card.
check('prose reply does not become a tag', is('I think it is front', 'front', false));
check('prose reply containing yes does not become a tag', is('yes it looks like a front view', 'front', false));
check('a bare "yes" with no view is not a tag', is('yes', 'front', false));
check('an unrecognised first word falls back exactly as before', is('side yes', 'front', false));
check('an unrecognised second word is not a yes', is('front maybe', 'front', false));
check('"true" is not "yes" — the prompt asks for yes/no', is('front true', 'front', false));

// --- 5. the rules are actually wired into the prompt ------------------------------------------------
check('MIRROR_RULE exists', route.includes('const MIRROR_RULE = ['));
check('and is sent with the view rule', /VIEW_RULE,\s*\n\s*MIRROR_RULE,/.test(route));
check('the reply format is spelled out for the model', route.includes('the view word, then yes or no'));
check('the tie-break is no, matching VIEW_RULE\'s tie-break of front',
  route.includes("When genuinely unsure, answer \"no\"."));
check('a mirror merely present in the room is excluded', route.includes('A mirror merely visible somewhere in the room is "no".'));
check('reflective non-mirrors are excluded', /water, a window, sunglasses/.test(route));
check('the route returns both fields', route.includes('data: { view, mirror }'));
check('and documents the new shape', route.includes("-> { view: 'front' | 'back' | 'closeup', mirror: boolean }"));

// --- 6. the client only tags when the server actually answered ----------------------------------------
// An older server build has no `mirror` field. Reading it as `?? false` would stamp an empty tags
// array — marking the card ANSWERED and stopping a newer build from ever asking. It has to stay
// unanswered instead, which is why the client tests for a boolean rather than truthiness.
const col = read('client/src/components/EddyCollection.jsx');
check('the client only writes tags when mirror is a boolean',
  col.includes("if (typeof mirror === 'boolean') prompt = mergePoseTags(prompt, mirror ? ['mirror selfie'] : []);"));
check('it reads both response shapes, like view does', col.includes('r?.mirror ?? r?.data?.mirror'));
check('view and tags are merged separately, not rewritten together',
  col.includes('mergePoseView(it.prompt, view)') && col.includes('mergePoseTags(prompt,'));
check('one store write, not two', (col.match(/await store\.updateItem\(it\.id, \{ prompt \}\);/g) || []).length === 1);

// --- 7. the bulk pass picks up cards that have a view but no tag ------------------------------------------
check('the bulk target filter includes tag-less cards',
  (col.match(/!hasPoseView\(i\.prompt\) \|\| !hasPoseTags\(i\.prompt\)/g) || []).length === 2);
check('and cards with both are still skipped', !col.includes('!hasPoseView(i.prompt) && !hasPoseTags(i.prompt)'));

// Replay the filter over realistic rows: only the ones genuinely missing an answer should be picked.
const hasView = (p) => /"view"\s*:\s*"(front|back|closeup)"/.test(p);
const hasTags = (p) => /"tags"\s*:\s*\[/.test(p);
const rows = [
  { id: 'both', prompt: '{"pose_action":{"view":"front","tags":[]}}' },
  { id: 'view only', prompt: '{"pose_action":{"view":"front"}}' },
  { id: 'tags only', prompt: '{"pose_action":{"tags":["mirror selfie"]}}' },
  { id: 'neither', prompt: '{"pose_action":{"description":"x"}}' },
];
const picked = rows.filter((r) => !hasView(r.prompt) || !hasTags(r.prompt)).map((r) => r.id);
check('a fully answered card is not re-charged for', !picked.includes('both'));
check('a card missing only the tag IS picked up', picked.includes('view only'));
check('a card missing only the view is too', picked.includes('tags only'));
check('and one missing both', picked.includes('neither'));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
