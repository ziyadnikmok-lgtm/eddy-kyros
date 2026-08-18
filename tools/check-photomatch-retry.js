// Retry a bad result with a DIFFERENT prompt, not the same one again.
//
// Owner, 2026-08-18: "when i select the result from the picture that are not good i need a retry
// bottum becuase sometimes they not good but it try a differnet prompt in photo match nb2".
// Regenerate re-sends the identical request — correct for a REFUSAL, useless for an ugly picture:
// the same words buy the same kind of ugly twice.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pm = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// Lift the real constant and the real function out of the page, so this tests the shipped text
// rather than a copy that can drift away from it.
const nudgesSrc = pm.match(/const RETRY_NUDGES = \[[\s\S]*?\n\];/);
const fnSrc = pm.match(/function withRetryNudge\(prompt, attempt, budget\) \{[\s\S]*?\n\}/);
check('the retry text is in the page', !!nudgesSrc);
check('and so is the builder', !!fnSrc);
const { RETRY_NUDGES, withRetryNudge } = new Function(
  `${nudgesSrc[0]}\n${fnSrc[0]}\nreturn { RETRY_NUDGES, withRetryNudge };`,
)();

// --- the point of the whole thing: a retry must not repeat itself ------------------------------
check('there are several different things to ask for', RETRY_NUDGES.length >= 4);
check('and they really are different', new Set(RETRY_NUDGES).size === RETRY_NUDGES.length);
const first4 = [1, 2, 3, 4].map((n) => withRetryNudge('BASE', n, 8000));
check('four presses ask four different questions', new Set(first4).size === 4);
check('the fifth cycles back rather than running out', withRetryNudge('BASE', 5, 8000) === first4[0]);
check('attempt numbering starts at 1, not 0', withRetryNudge('BASE', 1, 8000) === withRetryNudge('BASE', 0, 8000));

// --- every instruction above must survive ------------------------------------------------------
check('the original prompt is kept', withRetryNudge('KEEP EVERY WORD', 1, 8000).startsWith('KEEP EVERY WORD'));
check('and the retry block goes at the TAIL, where both engines weight hardest',
  withRetryNudge('KEEP EVERY WORD', 1, 8000).endsWith(RETRY_NUDGES[0]));
check('each one says the last attempt was rejected, so the model does not just repeat it',
  RETRY_NUDGES.every((n) => /previous attempt at this exact request was rejected/.test(n)));
check('and that the instructions above still stand',
  RETRY_NUDGES.every((n) => /Every instruction above still applies|instruction above still applies/.test(n)));
// The four failure modes these pictures actually have.
check('one is about her face matching the references', RETRY_NUDGES.some((n) => /bone structure.*jawline/s.test(n)));
check('one is about plastic skin', RETRY_NUDGES.some((n) => /pores.*plastic, waxy/s.test(n)));
check('one is about hands', RETRY_NUDGES.some((n) => /five per hand/.test(n)));
check('one is about flat light', RETRY_NUDGES.some((n) => /directional light/.test(n)));

// --- the budget: Seedream 422s on a long prompt and the whole job dies --------------------------
const budget = 3000;
const long = 'x'.repeat(4000);
const out = withRetryNudge(long, 2, budget);
check('an over-long prompt is brought back under the cap', out.length <= budget);
// If the nudge is what gets trimmed, a retry is just a repeat that cost money.
check('and it is the BASE text that gives, never the retry block', out.endsWith(RETRY_NUDGES[1]));
check('a prompt that already fits is not touched at all',
  withRetryNudge('short', 1, budget) === `short\n\n${RETRY_NUDGES[0]}`);
// Nano's budget is 8000; trimming its prompt to Seedream's 3000 threw away chips for nothing.
check('the cap is the ENGINE\'s, passed in rather than assumed',
  pm.includes('const budget = engine === \'seedream\' ? SEEDREAM_PROMPT_BUDGET : NANO2_PROMPT_BUDGET;\n      const built = promptFor(who, refs.length, src);'));

// --- wiring ------------------------------------------------------------------------------------
check('rerunJob can be asked to vary', pm.includes('const rerunJob = useCallback(async (job, { forceEngine = null, vary = false } = {}) => {'));
check('and only varies when asked — Regenerate still repeats the request exactly',
  pm.includes('const prompt = vary ? withRetryNudge(built, attempt, budget) : built;'));
check('the attempt count lives on the tile, so tile A and tile B do not share one counter',
  pm.includes("? { ...j, status: 'queued', error: null, retryN: vary ? attempt : (j.retryN || 0) } : j)));"));
check('the engine is in the deps, or a retry after switching engine uses the old cap',
  pm.includes('}, [sources, aspectRatio, charThumbs, notify, buildPromptFactory, engine, chars]);'));
// Every tile from an earlier session carries her NAME but no id — those said "this result predates
// re-running" and did nothing at all.
check('an older tile is matched by character name rather than refused',
  pm.includes("const who = { id: job.whoId || byName?.id || null, name: job.charName || byName?.name || '' };"));
check('and the name match ignores case and stray spaces',
  pm.includes("(c.name || '').trim().toLowerCase() === job.charName.trim().toLowerCase()"));
check('a character who is really gone says so by name',
  pm.includes('is no longer in your characters — re-run this one from a fresh match'));

// --- the buttons -------------------------------------------------------------------------------
check('the selection bar has a Retry', pm.includes('{retrying ? \'Retrying…\' : `Retry ${pickedJobs.size}`}'));
// Send falls back to "everything filed" with nothing ticked. Retry must NOT: that is money.
check('it appears only when something is ticked', pm.includes('{pickedJobs.size > 0 && (\n                    <Btn'));
check('and it acts on the ticked ones only',
  pm.includes('const picked = filedJobs.filter((j) => pickedJobs.has(j.id));'));
check('one failing retry does not abandon the others',
  pm.includes('await Promise.allSettled(picked.map((job) => rerunJob(job, { vary: true })));'));
check('a single tile can be retried without ticking anything',
  pm.includes('onClick={(e) => { e.stopPropagation(); rerunJob(job, { vary: true }); }}'));
check('and the tile shows which attempt the next press is', pm.includes('Retry{job.retryN ? ` ${job.retryN + 1}` : \'\'}'));

check('the count survives a reload, or the next press repeats a text that already failed',
  pm.includes('retryN: j.retryN || 0,'));

// --- HER HAIR (owner, 2026-08-18: 'it didint use hair our model fo face good etc') -------------
// Gallery 1c2e8850: long straight blonde ombre for a character whose every reference is dark and
// wavy. The prompt asked for 'hair' — one word in a list, the same mistake the body list already
// learned from.
check('hair names its attributes rather than being one word',
  pm.includes("allowHairChange ? null : 'hair — its exact colour, length, texture and parting'"));
check('and the tail lock says it too', pm.includes('hair at its own colour, length and texture'));
// A Hair preset deliberately overrides the references; the clause must still drop when one is on,
// or the two cancel and neither happens.
check('a hair preset still drops the whole clause', pm.includes('allowHairChange ? null :'));

// --- ONE FRAME, not a contact sheet -----------------------------------------------------------
// gallery 52cd1c0c (2026-08-18): three identity references came back as ONE wide image holding
// three near-identical panels of her. Nothing in the prompt ever said "one photograph".
const lockStart = pm.indexOf('function singleFrameLock(people) {');
const lockEnd = pm.indexOf("frames to produce.';", lockStart);
check('the single-frame lock is in the page', lockStart > -1 && lockEnd > lockStart);
const singleFrameLock = new Function(
  pm.slice(lockStart, pm.indexOf('}', lockEnd) + 1) + '; return singleFrameLock;',
)();
check('one character asks for exactly one woman', singleFrameLock(1).includes('exactly ONE woman'));
check('and a pair asks for exactly two', singleFrameLock(2).includes('exactly two women'));
check('a missing or zero count still means one',
  singleFrameLock(0).includes('exactly ONE woman') && singleFrameLock(undefined).includes('exactly ONE woman'));
check('it names the layouts that actually came back', singleFrameLock(1).includes('grid, collage, contact sheet'));
// THE lever: the model mirrored the reference count into the panel count.
check('and says the reference count is not a panel count',
  singleFrameLock(1).includes('number of reference images is NOT the number of people, panels or frames'));
check('it is appended dead last, after the chips and the figure lock',
  pm.indexOf('out = `${out}') < pm.indexOf('${frameLock}`;')
  && pm.indexOf('CLOTHED_FIGURE_LOCK}`;') < pm.indexOf('${frameLock}`;'));
// Appending it and THEN slicing to the budget would cut the very thing just appended: the trim
// takes from the end. Room is made out of the base first, the same way the retry nudge does it.
check('room is made for it out of the base rather than trimming it off',
  pm.includes('const room = budget - frameLock.length - 2;')
  && pm.includes('out = out.slice(0, Math.max(0, room));')
  && !pm.includes('out = out.slice(0, budget);'));

// --- which engine, while it is still running (owner: "it not showing if it is gemini no wavespeed")
check('a job records the engine it was sent to', pm.includes("status: 'running', runningOn: asked }"));
check('and switches it when the fallback fires', pm.includes("status: 'running', runningOn: 'seedream5', error: 'Google refused it"));
check('the tile names Google or WaveSpeed', pm.includes("{on === 'nb2' ? 'NB2 · Google' : on === 'nano2' ? 'Nano 2' : 'Seedream · WaveSpeed'}"));
check('a finished tile reads its ACTUAL engine, not the one asked for',
  pm.includes("const on = job.status === 'done' ? job.engine : job.runningOn;"));
check('and a fallback says so on the chip', pm.includes("job.status === 'done' && job.fellBack ? ' · fell back' : ''"));

// A duplicated chip rendered the character name twice on every tile.
check('the character name is drawn once per tile',
  (pm.match(/\{job\.charName && <span className="text-\[0\.625rem\] font-semibold text-rose-300">/g) || []).length === 1);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
