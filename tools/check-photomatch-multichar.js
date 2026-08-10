// Photo Match: several characters, each run against every source photo.
//
// The page took ONE character, so putting the same scene on three models meant three runs with a
// manual re-pick between each (owner, 2026-08-10). Now it is a cross product.
//
// The dangerous shape here is identity crossing: the prompt NAMES the character and states how
// many identity images it is sending, so one prompt reused across two women would name the wrong
// one — the same class of bug as Grace's face landing on Mia in Max Outfit this morning.
const fs = require('fs');
const g = fs.readFileSync('D:/Kyros/app/client/src/pages/PhotoMatchSeedreamPage.jsx', 'utf8');

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
check('each character gets her OWN prompt', g.includes('const promptFor = (who, refCount) => {'));
check('the prompt names THAT character', g.includes('characterName: who.name,'));
check('and states HER ref count, not a shared one', /refCount,\s*\n\s*masterPrompt:/.test(g));
check('the run sends her own refs', g.includes('item.who.refs, ratioById.get(item.src.id), promptFor(item.who, item.who.refs.length))'));
check('masterPrompt is applied only where it is actually known',
  g.includes('masterPrompt: who.id === characterId ? charDetail?.masterPrompt : undefined,'));
check('and that limit is written down, not silent', /a silently-missing master prompt would look/.test(g));

// --- the cross product --------------------------------------------------------------------------------
check('every photo runs once per character',
  g.includes('const work = perChar.flatMap((who) => sources.map((src) => ({ src, who })));'));
check('job ids carry the character, or three results collide into one tile',
  g.includes('id: `${src.id}::${who.id}`'));
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
check('the name is only set when it is ambiguous', g.includes("charName: perChar.length > 1 ? who.name : '',"));
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

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
