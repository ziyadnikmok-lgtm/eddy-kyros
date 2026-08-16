// Photo Match: several characters, each run against every source photo.
//
// The page took ONE character, so putting the same scene on three models meant three runs with a
// manual re-pick between each (owner, 2026-08-10). Now it is a cross product.
//
// The dangerous shape here is identity crossing: the prompt NAMES the character and states how
// many identity images it is sending, so one prompt reused across two women would name the wrong
// one — the same class of bug as Grace's face landing on Mia in Max Outfit this morning.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const g = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- state -------------------------------------------------------------------------------------
check('the selection is a list', g.includes('const [characterIds, setCharacterIds] = useState([]);'));
check('the single id survives as the head, so nothing downstream had to change',
  g.includes('const characterId = characterIds[0] ?? null;'));
check('tiles toggle instead of replacing', g.includes('onClick={() => toggleCharacter(c.id)}'));
check('a second tick ADDS rather than swaps',
  /cur\.includes\(id\) \? cur\.filter\(\(x\) => x !== id\) : \[\.\.\.cur, id\]/.test(g));

// --- persistence, including the upgrade path -------------------------------------------------------
check('the list is persisted', g.includes("store.set('characterIds', characterIds)"));
check('a stored single id from the old build still loads',
  g.includes('const ids = Array.isArray(charId) ? charId : [charId];'));

// --- identity must not cross ------------------------------------------------------------------------
check('refs are resolved per character, not once',
  g.includes('const refsForCharacter = useCallback((id) => {'));
// CHANGED 2026-08-16: promptFor gained the SOURCE photo. A prompt is no longer a property of the
// character alone -- a back-facing source and a front-facing one of the same woman need different
// instructions, because the face rules come out for a back shot. Still one prompt per character.
check('each character gets her OWN prompt', g.includes('const promptFor = (who, refCount, source) => {'));
check('the prompt names THAT character', g.includes('characterName: who.name,'));
check('and states HER ref count, not a shared one', /refCount,\s*\n\s*masterPrompt:/.test(g));
check('the run sends her own refs', g.includes('item.who.refs, ratioById.get(item.src.id), promptFor(item.who, item.who.refs.length, item.src))'));
check('masterPrompt is applied only where it is actually known',
  g.includes('masterPrompt: who.id === characterId ? charDetail?.masterPrompt : undefined,'));
check('and that limit is written down, not silent', /a silently-missing master prompt would look/.test(g));

// --- the cross product --------------------------------------------------------------------------------
check('every photo runs once per character',
  g.includes('const work = perChar.flatMap((who) => sources.map((src) => ({ src, who })));'));
check('job ids carry the character, or three results collide into one tile',
  g.includes('`${src.id}::${who.id}::${runStamp}`'));
// The run stamp arrived 2026-08-13, when the panel became a persistent queue: the id was stable
// across runs, so re-running the same photo for the same character produced a second tile carrying
// the FIRST tile's id.
check('and the RUN, so a re-run does not collide with its own earlier tile',
  g.includes('const runStamp = Date.now().toString(36);'));
check('the reason is recorded', /would see whichever finished last rather than all three/.test(g));

// --- a character with no usable photo ------------------------------------------------------------------
check('one unloadable character does not abort the batch', g.includes('unloadable.push(name || cid)'));
check('she is named rather than dropped in silence', /Skipped \$\{unloadable\.join\(', '\)\}/.test(g));
check('but a run with NO loadable character still refuses', g.includes('if (!perChar.length) { notify('));

// --- the price ------------------------------------------------------------------------------------------
check('the total multiplies by characters',
  g.includes('const runCount = Math.max(1, sources.length) * Math.max(1, characterIds.length);'));
check('the button quotes the multiplied count', g.includes('`Photo Match${runCount > 1 ? ` · ${runCount} images` : \'\'} · $${totalCost.toFixed(3)}`'));
check('the cost line spells out the multiplication', /\{characterIds\.length > 1 && <> × \{characterIds\.length\} characters<\/>\}/.test(g));

// --- the UI says whose is whose --------------------------------------------------------------------------
check('result tiles carry the character name', g.includes('{job.charName && <span'));
// CHANGED 2026-08-13: the name is now recorded on EVERY job, not only an ambiguous one. It stopped
// being a label and became the thing that decides which folder the picture is filed under when it
// is sent to a library — and a blank there sent Chloe's results into Grace's folder.
check('every job records whose it is', g.includes("charName: who.name || '',"));
check('and the reason it is no longer conditional', /it decides which folder the picture is filed under/.test(g));
check('the ref-count badge is replaced when several are ticked, not left lying',
  g.includes('? <Badge color="green">{characterIds.length} characters</Badge>'));

// --- replay the arithmetic -------------------------------------------------------------------------------
const plan = (photos, chars) => chars.flatMap((c) => photos.map((p) => `${p}::${c}`));
const r = plan(['p1', 'p2', 'p3'], ['grace', 'natalia']);
check('3 photos x 2 characters = 6 jobs', r.length === 6);
check('every job id is unique', new Set(r).size === 6);
check('each photo appears once per character', r.filter((x) => x.startsWith('p1::')).length === 2);
check('1 photo x 1 character is still 1 job', plan(['p1'], ['grace']).length === 1);
check('cost: 3 photos x 2 characters at $0.05 = $0.30',
  (Math.max(1, 3) * Math.max(1, 2) * 0.05).toFixed(2) === '0.30');

// --- how many render at once (owner, 2026-08-11) --------------------------------------------------
// "Only 4 at a time -- make it whatever WaveSpeed allows." The pool was 4; the REAL ceiling is 6,
// set by Chromium's sockets-per-host, and measured rather than assumed: 38,105 generation requests
// in app.log, max concurrent overlap 6, with Eddy configured for 12 lanes throughout.
check('the 4-lane cap is gone', !g.includes('const MAX_CONCURRENT_JOBS = 4;'));
// Reworded 2026-08-15: both lanes were pinned to Chromium's six-sockets-per-host, because a
// render held one for its whole duration. On the queue they match the server's MAX_INFLIGHT and
// the server does the limiting.
check('lanes are set per engine', /const LANES = \{ seedream: \d+, nano2: \d+ \};/.test(g));
check('and the pool uses them', g.includes('const lanes = LANES[engine] || LANES.seedream;'));
check('the pool never spawns more workers than there is work',
  g.includes('Math.min(lanes, queue.length)'));
check('the socket ceiling is written down, so nobody raises this expecting more',
  /Chromium allows 6 sockets per host/.test(g));
check('and the measurement behind it', /max concurrent overlap \*\*6\*\*/.test(g));
check('with the way past it named', /submit -> job id -> poll/.test(g));
check('a Pinterest-sized batch fits', g.includes('const MAX_SOURCES = 50;'));

// A pool of N over M items must run every item exactly once, whatever N is.
const drain = (items, lanes) => {
  const q = [...items];
  const seen = [];
  const workers = Array.from({ length: Math.min(lanes, q.length) }, () => {
    while (q.length) seen.push(q.shift());
    return null;
  });
  return { count: workers.length, seen };
};
check('12 lanes over 30 jobs runs all 30', drain(Array.from({ length: 30 }, (_, i) => i), 12).seen.length === 30);
check('and spawns 12 workers, not 30', drain(Array.from({ length: 30 }, (_, i) => i), 12).count === 12);
check('3 jobs spawn 3 workers, not 12', drain([1, 2, 3], 12).count === 3);
check('no job is run twice', new Set(drain(Array.from({ length: 30 }, (_, i) => i), 12).seen).size === 30);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
